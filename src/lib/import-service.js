// TS-04 ledger import service: stage → preview → confirm.
//
// Lifecycle (TECH-SPEC §6.2, TS-24):
//   stage()   multipart CSV → parse → map → validate → persist batch + staging
//             rows. NEVER writes accounting_ledger.
//   preview() read-only counts: total / new / duplicate / invalid.
//   confirm() commits the staged valid rows to accounting_ledger in ONE
//             transaction, skipping duplicates (dedupe key, R2-27). Idempotent:
//             confirming a confirmed batch is a no-op, not a re-import.
//
// Invariants:
//   * the DB is the floor — trg_ledger_money_integrity_insert rejects any row
//     that is not whole-rupiah, one-sided, amount = debit - credit;
//   * a duplicate is SKIPPED, never overwritten (import never touches existing
//     tagged lines — PRD v1.3);
//   * a row that fails validation is quarantined with its reason, per row, so
//     the operator sees row 47 of 200 instead of a silent whole-file failure.
//
// Staging rows live in import_batches.staging_json (migration 004): the
// validated insert objects plus per-row quarantine reasons. That is what
// preview reads and confirm commits — the CSV is not re-parsed at confirm time.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../db/db');
const csv = require('./csv');
const { mapRow, REQUIRED, normHeader } = require('./import-map');

const IMPORT_DIR = process.env.PRACTIS_IMPORTS
  || path.join(__dirname, '..', '..', 'data', 'imports');

// ---- lookup caches -----------------------------------------------------------
// Legacy codes → our row ids. Loaded once per stage() call so a 57k-row file
// does not do 57k queries.

function loadLookups() {
  const byCode = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all()) m.set(String(r.code).trim(), r);
    return m;
  };
  // import-map's mapRow expects resolver FUNCTIONS (code → row | undefined), so
  // the maps are wrapped here rather than handed over raw.
  const proj = byCode('SELECT id, code FROM projects');
  const coa = byCode('SELECT id, code FROM chart_of_accounts');
  const cf = byCode('SELECT id, code FROM cashflow_categories');
  const ta = byCode('SELECT id, code FROM transaction_accounts');
  return {
    projectByCode: (c) => proj.get(c),
    chartByCode: (c) => coa.get(c),
    cashflowByCode: (c) => cf.get(c),
    txByCode: (c) => ta.get(c),
  };
}

// ---- header handling ---------------------------------------------------------

// Build { normalizedName: index } from the header row and verify every REQUIRED
// column is present. Missing required column = whole-file error (nothing to map).
function buildHeaders(headerRow) {
  const headers = {};
  headerRow.forEach((h, i) => {
    const n = normHeader(h);
    if (n !== '' && headers[n] == null) headers[n] = i;
  });
  const missing = REQUIRED.filter((c) => headers[normHeader(c)] == null);
  if (missing.length) {
    throw new Error(`missing required column(s): ${missing.join(', ')}`);
  }
  return headers;
}

// ---- staging rows ------------------------------------------------------------

// Convert one parsed CSV row (array of cells) into a staging entry: either a
// valid ledger insert object or a quarantine record with reasons.
function stageRow(cells, headers, lookup, opts) {
  const mapped = mapRow(cells, headers, lookup);
  if (!mapped.ok) return { ok: false, errors: mapped.errors };

  const row = mapped.row;
  // batch identity + the columns the mapper deliberately leaves to the router
  row.import_batch_id = opts.batchId;
  row.project_id = row.project_id ?? opts.defaultProjectId ?? null;
  row.partner_type = null;
  row.partner_id = null;
  row.cost_checked = 0;
  row.cost_checked_by = null;
  row.cost_checked_at = null;
  row.cash_advance_id = null;
  return { ok: true, row };
}

// ---- dedupe ------------------------------------------------------------------
// The DB's idx_ledger_import_dedupe is the authority. Preview must predict it
// exactly, so the fingerprint mirrors the index expression:
//   COALESCE(transaction_id,'') | COALESCE(document_no,'') | COALESCE(date,'') | amount | COALESCE(project_id,0)
//   WHERE source = 'import'

function fingerprint(row) {
  return [
    row.transaction_id ?? '',
    row.document_no ?? '',
    row.date ?? '',
    row.amount ?? 0,
    row.project_id ?? 0,
  ].join('\u0000');
}

// Fingerprints already committed to the ledger by earlier imports, plus any
// duplicate inside this same file (first occurrence wins).
function committedFingerprints(projectId) {
  const set = new Set();
  const stmt = db.prepare(`
    SELECT transaction_id, document_no, date, amount, project_id
    FROM accounting_ledger WHERE source = 'import'`);
  for (const r of stmt.all()) {
    set.add(fingerprint({
      transaction_id: r.transaction_id, document_no: r.document_no,
      date: r.date, amount: r.amount, project_id: r.project_id,
    }));
  }
  return set;
}

// ---- stage -------------------------------------------------------------------

// Stage a whole CSV buffer. Returns the batch summary; writes only to
// import_batches (never to accounting_ledger).
//
//   opts: { filename, projectId, actorId, buffer|text }
function stage(opts) {
  const text = opts.text != null ? opts.text : opts.buffer.toString('utf8');
  const parsed = csv.parse(text);                 // throws: size/NUL/quote errors
  const headers = buildHeaders(parsed.headers);   // throws: missing required cols

  const lookup = loadLookups();
  const batchId = db.prepare(`
    INSERT INTO import_batches
      (profile_id, project_id, filename, original_name, row_count, status,
       uploaded_by, imported_by, staging_json)
    VALUES (NULL, ?, ?, ?, ?, 'staged', ?, ?, NULL)`)
    .run(opts.projectId ?? null, opts.filename ?? null, opts.filename ?? null,
         parsed.rows.length, opts.actorId ?? null, opts.actorId ?? null)
    .lastInsertRowid;

  // persist the original file (audit evidence, TS-24) under a random name
  let filePath = null;
  if (opts.buffer != null) {
    fs.mkdirSync(IMPORT_DIR, { recursive: true });
    filePath = path.join(IMPORT_DIR, `${batchId}-${crypto.randomBytes(8).toString('hex')}.csv`);
    fs.writeFileSync(filePath, opts.buffer);
  }

  const committed = committedFingerprints(opts.projectId ?? null);
  const seen = new Set();
  const valid = [];
  const invalid = [];

  parsed.rows.forEach((cells, idx) => {
    const lineNo = idx + 2;                       // +1 header, +1 1-based
    const staged = stageRow(cells, headers, lookup, {
      batchId, defaultProjectId: opts.projectId,
    });
    if (!staged.ok) {
      invalid.push({ line: lineNo, transaction_id: cells[0] ?? null, errors: staged.errors });
      return;
    }
    const fp = fingerprint(staged.row);
    if (committed.has(fp) || seen.has(fp)) {
      invalid.push({ line: lineNo, transaction_id: staged.row.transaction_id,
        errors: ['duplicate — already imported (skipped, never overwritten)'] });
      staged.row._duplicate = true;
      // keep it out of valid; counted as skipped in preview
      invalid[invalid.length - 1].duplicate = true;
      return;
    }
    seen.add(fp);
    valid.push(staged.row);
  });

  const staging = { headers: Object.keys(headers), rows: valid, invalid };
  db.prepare(`UPDATE import_batches SET staging_json = ?, file_path = ?, skipped_count = ?
              WHERE id = ?`)
    .run(JSON.stringify(staging), filePath, invalid.length, batchId);

  return {
    batchId,
    rowCount: parsed.rows.length,
    newCount: valid.length,
    skipped: invalid.filter((i) => i.duplicate).length,
    invalid: invalid.filter((i) => !i.duplicate),
    filePath,
  };
}

// ---- preview -----------------------------------------------------------------

function readBatch(batchId) {
  const b = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(batchId);
  if (!b) return null;
  if (!b.staging_json) return { ...b, staging: null };
  return { ...b, staging: JSON.parse(b.staging_json) };
}

function preview(batchId) {
  const b = readBatch(batchId);
  if (!b) return null;
  const staging = b.staging ?? { rows: [], invalid: [] };
  return {
    batchId: b.id,
    status: b.status,
    originalName: b.original_name,
    rowCount: b.row_count ?? 0,
    newCount: staging.rows.length,
    skippedCount: staging.invalid.filter((i) => i.duplicate).length,
    invalid: staging.invalid.filter((i) => !i.duplicate),
    confirmedAt: b.confirmed_at,
    expiresAt: b.expires_at,
  };
}

// ---- confirm -----------------------------------------------------------------

// Commit the staged valid rows. Idempotent per batch (TS-24): the first confirm
// flips status to 'confirmed'; a second call returns the recorded outcome
// without touching the ledger again.
function confirm(batchId, actorId) {
  const b = readBatch(batchId);
  if (!b) return { error: 'NOT_FOUND' };
  if (b.status === 'confirmed') {
    return {
      alreadyConfirmed: true, inserted: b.inserted_count ?? 0,
      skipped: b.skipped_count ?? 0, confirmedAt: b.confirmed_at,
    };
  }
  if (b.status === 'expired') return { error: 'EXPIRED' };
  if (!b.staging) return { error: 'NOT_STAGED' };

  const rows = b.staging.rows ?? [];
  const invalid = b.staging.invalid ?? [];

  // If every staged row is a duplicate, an import of nothing is the honest
  // outcome — the batch is still closed out as confirmed with 0 inserted.
  const insert = db.prepare(`
    INSERT INTO accounting_ledger
      (project_id, transaction_id, document_no, reference_no, account_code,
       partner_type, partner_id, date, effective_date, type, line_role, in_cost_basis,
       cost_category_id, chart_of_account_id, cashflow_category_id,
       transaction_account_id, wbs_node_id, amount, debit, credit,
       retainage_amount, paid_amount, currency, description, source,
       import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at)
    VALUES
      (@project_id, @transaction_id, @document_no, @reference_no, @account_code,
       @partner_type, @partner_id, @date, @effective_date, @type, @line_role, @in_cost_basis,
       @cost_category_id, @chart_of_account_id, @cashflow_category_id,
       @transaction_account_id, @wbs_node_id, @amount, @debit, @credit,
       @retainage_amount, @paid_amount, @currency, @description, @source,
       @import_batch_id, @cash_advance_id, @cost_checked, @cost_checked_by, @cost_checked_at)`);

  const audit = db.prepare(`
    INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json, outcome)
    VALUES ('import_batch', ?, 'import', ?, NULL, ?, 'success')`);

  let inserted = 0;
  const failed = [];

  const tx = db.transaction(() => {
    for (const row of rows) {
      const params = { ...row };
      delete params._duplicate;
      try {
        const r = insert.run(params);
        inserted++;
        // one create-audit row per imported ledger line, like manual entry
        db.prepare(`INSERT INTO audit_log (entity_type, entity_id, action, actor_id, after_json, outcome)
                    VALUES ('accounting_ledger', ?, 'create', ?, ?, 'success')`)
          .run(r.lastInsertRowid, actorId ?? null, JSON.stringify(params));
      } catch (err) {
        // a race between preview and confirm (or a genuinely bad row) — record
        // it against the batch rather than aborting the whole file
        failed.push({ transaction_id: row.transaction_id, error: err.message });
      }
    }

    db.prepare(`
      UPDATE import_batches
         SET status = 'confirmed', inserted_count = ?, skipped_count = ?,
             new_count = ?, error_json = ?, confirmed_at = datetime('now')
       WHERE id = ?`)
      .run(inserted, (b.skipped_count ?? 0) + failed.length, inserted,
           failed.length ? JSON.stringify({ failed }) : null, batchId);

    audit.run(batchId, actorId ?? null,
      JSON.stringify({ inserted, skipped: b.skipped_count ?? 0, failed: failed.length }));
  });

  tx();

  return {
    batchId,
    inserted,
    skipped: (b.skipped_count ?? 0) + failed.length,
    invalid: invalid.filter((i) => !i.duplicate),
    failed,
  };
}

module.exports = { stage, preview, confirm, readBatch, fingerprint, buildHeaders, loadLookups, IMPORT_DIR };
