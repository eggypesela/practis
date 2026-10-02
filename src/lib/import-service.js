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
//     the operator sees row 47 of 200 instead of a silent whole-file failure;
//   * **a transaction group that does not balance to zero is quarantined in
//     full** (TECH-SPEC §8.4) — see the balance section below.
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
  row.reverses_ledger_id = null;   // an import never creates a reversal
  return { ok: true, row };
}

// ---- group balance (TECH-SPEC §8.4) -----------------------------------------
//
// §8.4: "Every imported transaction group balances to zero or is quarantined."
//
// WHAT A GROUP IS. The export is double-entry: one transaction writes two or
// more lines that must net to zero — a payable plus its cash leg, salary plus
// the bank credit. `transaction_id` is that grouping key (the mapper already
// stores it as both `transaction_id` and `document_no`). A 57k-row file
// therefore contains thousands of groups, and the rule has to be applied per
// group, which is why this cannot live in the per-row mapper.
//
// WHY THIS CHECK EXISTS AT ALL. Per-row validation cannot see it. Every
// individual line of a broken group is a perfectly legal row — one-sided,
// whole-rupiah, amount = debit − credit. The defect is only visible in the SUM,
// so without this the ledger silently absorbs a lone debit with no credit leg:
// the cost reports understate by that amount and nothing ever raises an error.
//
// THE MEASURE IS debit − credit, NOT amount. They are numerically identical here
// (amount = debit − credit by construction), but debit − credit is the actual
// double-entry statement and stays correct if `amount` ever diverges.
//
// WHAT COUNTS AS BALANCED. A well-formed double-entry group nets to zero.
//
// The one legitimate exception is a REVERSAL. A correcting entry is a SINGLE
// line that negates a line already in the ledger, so it cannot net to zero on
// its own — that is its whole purpose. Reversals are identified by
// `reverses_ledger_id`, which is the mechanism the schema actually provides:
// `accounting_ledger.type` has no reversal member (its CHECK allows only
// Income/Expense/Receivable/Payable/LPB/Dropping/Revenue), and
// ledger-correction.js builds a reversal as a swapped-side copy that carries the
// ORIGINAL's type. So a type-name test would be dead code that silently
// quarantined nothing — the exact failure mode this check exists to prevent.
function groupBalances(rows) {
  const drift = rows.reduce((a, r) => a + (r.debit ?? 0) - (r.credit ?? 0), 0);
  if (drift === 0) return true;
  // A cancellation is only legitimate when the WHOLE group is a reversal.
  if (rows.every((r) => r.reverses_ledger_id != null)) return true;
  return false;
}

// Given the staged valid rows, return the set of transaction_ids whose group
// does not balance. Pure: reads only, decides only.
function unbalancedGroups(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    const key = r.transaction_id ?? '';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }
  const bad = new Set();
  for (const [key, group] of byGroup) {
    if (!groupBalances(group)) bad.add(key);
  }
  return bad;
}

// Split the valid rows into those whose group balances (importable) and those
// whose group does not (quarantined, every line, with the drift reported so the
// operator can see the amount that is missing).
function partitionByGroupBalance(rows) {
  const unbalanced = unbalancedGroups(rows);
  if (unbalanced.size === 0) return { balanced: rows, quarantined: [] };

  const drift = new Map();
  for (const r of rows) {
    const key = r.transaction_id ?? '';
    if (!unbalanced.has(key)) continue;
    drift.set(key, (drift.get(key) ?? 0) + (r.debit ?? 0) - (r.credit ?? 0));
  }

  const balanced = [];
  const quarantined = [];
  for (const r of rows) {
    const key = r.transaction_id ?? '';
    if (!unbalanced.has(key)) { balanced.push(r); continue; }
    quarantined.push(r);
  }
  return { balanced, quarantined, drift, unbalanced };
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

  const staging = (() => {
    // ---- §8.4 group balance ------------------------------------------------
    // Applied AFTER dedupe, and to the DEDUPED set on purpose. If an earlier
    // import already absorbed one leg of a group, the remainder cannot net to
    // zero; quarantining it would make a full re-upload look broken when the
    // real state is "already imported". Dedupe is the correct answer there, so
    // duplicates are set aside as duplicates and only genuinely-new groups are
    // balance-checked.
    const part = partitionByGroupBalance(valid);
    for (const row of part.quarantined) {
      const key = row.transaction_id ?? '';
      const drift = part.drift.get(key) ?? 0;
      // Every LINE of the group is quarantined, each carrying the same reason —
      // the operator has to be able to see every line of the group that was
      // refused, not just the first one.
      invalid.push({
        transaction_id: row.transaction_id,
        group_unbalanced: true,
        drift,
        errors: [`transaction group '${row.transaction_id}' does not balance: ` +
          `debit − credit = ${drift} (TECH-SPEC §8.4 requires zero or quarantine). ` +
          `The whole group was refused, not just this line.`],
      });
    }

    // Report the quarantined groups once each, in a shape the UI can render as
    // "N transactions refused", alongside the per-line entries above.
    const unbalancedGroups = [...(part.unbalanced ?? [])].map((key) => ({
      transaction_id: key,
      lines: valid.filter((r) => (r.transaction_id ?? '') === key).length,
      drift: part.drift.get(key) ?? 0,
    }));

    return {
      headers: Object.keys(headers),
      rows: part.balanced,
      invalid,
      unbalanced_groups: unbalancedGroups,
    };
  })();
  db.prepare(`UPDATE import_batches SET staging_json = ?, file_path = ?, skipped_count = ?
              WHERE id = ?`)
    .run(JSON.stringify(staging), filePath, invalid.length, batchId);

  return {
    batchId,
    rowCount: parsed.rows.length,
    newCount: staging.rows.length,
    skipped: invalid.filter((i) => i.duplicate).length,
    invalid: invalid.filter((i) => !i.duplicate),
    unbalancedGroups: staging.unbalanced_groups,
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
    // §8.4: the transactions refused as a whole because they did not balance.
    // Reported separately from the per-line invalid rows because the fix is
    // different — the operator has to find the missing leg, not repair a row.
    unbalancedGroups: staging.unbalanced_groups ?? [],
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
 import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at,
 reverses_ledger_id)
 VALUES
 (@project_id, @transaction_id, @document_no, @reference_no, @account_code,
 @partner_type, @partner_id, @date, @effective_date, @type, @line_role, @in_cost_basis,
 @cost_category_id, @chart_of_account_id, @cashflow_category_id,
 @transaction_account_id, @wbs_node_id, @amount, @debit, @credit,
 @retainage_amount, @paid_amount, @currency, @description, @source,
 @import_batch_id, @cash_advance_id, @cost_checked, @cost_checked_by, @cost_checked_at,
 @reverses_ledger_id)`);

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

module.exports = { stage, preview, confirm, readBatch, fingerprint, buildHeaders, loadLookups, IMPORT_DIR,
  // §8.4 group balance — exported so the rule is unit-testable without a server,
  // and so the fixture test can assert the rule directly on the real export.
  groupBalances, unbalancedGroups, partitionByGroupBalance };
