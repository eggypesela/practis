// BAST acceptance register — business rules + transitions (module 8, plan part 8.9, PRD §4.2/§4.3).
//
// WHY THIS FILE EXISTS
// Part 8.8 built the revenue recognition screen, which reads ACCEPTED BAST certificates to get the
// POC basis. Measured after 8.8 landed: `acceptance_register` had ZERO WRITERS in `src/` — the
// revenue service only ever SELECTed from it. So the POC screen could truthfully say "no accepted
// certificate, 0%" and would say that forever, because there was no way to enter a BAST. This file
// is the missing input, not a new feature.
//
// PRD §4.3 states the rule this register exists to keep: "Progress % ≠ client acceptance %. WBS
// milestone ticks drive *internal* EVM %. BAST acceptance certificates drive *external*
// billing/revenue. POC revenue uses BAST%; EVM uses tick%. Both stored; never conflated."
// So nothing in this file writes `wbs_progress` or `progress_milestones`. Ever.
//
// THE WORKFLOW IS THE `status` COLUMN (owner decision A, 2026-10-04):
//
//     draft ──submit──> submitted ──accept──> accepted
//                            └────reject────> rejected
//
// There is deliberately NO second approval mechanism. The other registers (clients, suppliers) use
// `approvals-service.js`, which exists to enforce segregation of duties between whoever REGISTERS a
// record and whoever APPROVES it. A BAST already carries that separation structurally — the
// submitter is not the client, and the accept step is the client's sign-off being recorded by the
// PM. Bolting a second chain on would give one register two competing notions of "approved" that
// could disagree, which is worse than either alone.
//
// A certificate can therefore NEVER be created directly as `accepted`: that is what decision A
// means, and `record()` hard-codes the initial status to `draft` rather than trusting the form.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');

class AcceptanceError extends Error {
  constructor(message, status = 400, field = null) {
    super(message);
    this.name = 'AcceptanceError';
    this.status = status;
    // Which form field the message belongs beside, so the route can mark it rather than dumping a
    // generic banner the person has to match to a field themselves.
    this.field = field;
  }
}

const STATUSES = ['draft', 'submitted', 'accepted', 'rejected'];

// The only moves allowed. Anything not listed here is refused with a reason rather than written.
// Empty arrays are meaningful: `accepted` is terminal because the revenue basis was computed from
// it, and `rejected` is terminal because re-accepting a rejected certificate would mean the
// register disagrees with itself about what the client signed.
const TRANSITIONS = {
  draft: ['submitted'],
  submitted: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted — waiting for the client to accept',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function str(v, max = 200) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

// Dates are stored as TEXT 'YYYY-MM-DD' throughout this schema (see `document_date` etc.), so they
// are validated as that shape rather than as a JS Date — a Date round-trip would silently shift by
// the server's timezone, which is exactly the bug that makes an accepted_date land on the day
// before in Jakarta.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(v, field) {
  const s = str(v, 10);
  if (!s) return { value: null };
  if (!DATE_RE.test(s)) return { error: { field, message: 'Enter the date as YYYY-MM-DD.' } };
  const [y, m, d] = s.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Reject 2026-02-31: the Date object rolls it to 2026-03-03, so comparing the parts back catches
  // a date that looks right but does not exist.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return { error: { field, message: `${s} is not a real date.` } };
  }
  return { value: s };
}

function validate(input) {
  const out = {};

  out.certificate_no = str(input.certificate_no, 60);
  out.description = str(input.description, 400);
  out.wbs_node_id = null;
  if (str(input.wbs_node_id)) {
    const n = Number(input.wbs_node_id);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, field: 'wbs_node_id', message: 'Choose a WBS line from the list.' };
    }
    out.wbs_node_id = n;
  }

  // The percentage IS the revenue basis, so it is required and bounded here as well as by the DB
  // CHECK (0–100). The CHECK is the floor; this names the field so the form can mark it.
  const rawPct = str(input.percentage_progress, 20);
  if (!rawPct) {
    return { ok: false, field: 'percentage_progress',
      message: 'The accepted percentage is required — it is what the revenue is calculated from.' };
  }
  if (!/^\d+(\.\d{1,4})?$/.test(rawPct)) {
    return { ok: false, field: 'percentage_progress',
      message: 'Enter the percentage as a number, for example 25 or 12.5.' };
  }
  const pct = Number(rawPct);
  if (pct <= 0) {
    return { ok: false, field: 'percentage_progress',
      message: 'A certificate of 0% would record nothing; leave it out instead.' };
  }
  if (pct > 100) {
    return { ok: false, field: 'percentage_progress',
      message: 'A certificate cannot exceed 100% of the work.' };
  }
  out.percentage_progress = pct;

  for (const f of ['document_date', 'handover_date', 'invoice_date']) {
    const r = dateOrNull(input[f], f);
    if (r.error) return { ok: false, ...r.error };
    out[f] = r.value;
  }

  return { ok: true, row: out };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function byId(id) {
  return db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(id) || null;
}

// Ordered by `sequence` — the column exists so the register reads in the order the certificates
// were issued, not the order they were typed in.
function list(projectId) {
  return db.prepare(`SELECT a.*, w.wbs_code, w.name AS wbs_name
      FROM acceptance_register a
      LEFT JOIN wbs_nodes w ON w.id = a.wbs_node_id
      WHERE a.project_id = ?
      ORDER BY COALESCE(a.sequence, 0), a.id`).all(projectId);
}

function nextSequence(projectId) {
  const r = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS m FROM acceptance_register WHERE project_id = ?')
    .get(projectId);
  return Number(r.m) + 1;
}

// The WBS lines the recording form offers. Only ACTIVE lines: a certificate is evidence of work
// being handed over, and a completed line has already been handed over — a new certificate against
// it would be a correction, which is a different act. Ordered by code so the list is predictable.
function wbsLines(projectId) {
  if (!projectId) return [];
  return db.prepare(`SELECT id, wbs_code, name FROM wbs_nodes
      WHERE project_id = ? AND status = 'active' ORDER BY wbs_code`).all(projectId);
}

// What the register header states, and what the revenue screen depends on. Kept here so the count
// shown on the register and the count used by the revenue basis come from ONE query — two
// implementations of "how much has the client accepted" would drift.
function summary(projectId) {
  const rows = db.prepare('SELECT * FROM acceptance_register WHERE project_id = ?').all(projectId);
  const by = { draft: 0, submitted: 0, accepted: 0, rejected: 0 };
  let acceptedPct = 0;
  for (const r of rows) {
    if (by[r.status] === undefined) continue;
    by[r.status] += 1;
    if (r.status === 'accepted') acceptedPct += Number(r.percentage_progress) || 0;
  }
  const rawPct = Math.round(acceptedPct * 100) / 100;
  return {
    rows,
    counts: by,
    acceptedPct: rawPct > 100 ? 100 : rawPct,
    rawAcceptedPct: rawPct,
    // Reported, never applied silently: a total above 100% means the register holds overlapping
    // certificates and a person needs to look. Same rule as 8.8's basis.
    overlapping: rawPct > 100,
  };
}

// ---------------------------------------------------------------------------
// The one transition path
// ---------------------------------------------------------------------------

/**
 * Move a certificate to `to`, enforcing the allowed moves, the project boundary, and the audit.
 *
 * ONE function for all three moves rather than three near-identical routes: the rules that matter
 * (is this move legal, is it this project's certificate, is it audited) are then stated once and
 * cannot drift between submit/accept/reject.
 *
 * `extra` carries what only some moves set — the acceptance date and who accepted.
 */
function transition({ projectId, id, to, actorId, extra = {} }) {
  const row = byId(id);
  // The project check is part of the lookup, not a separate step: a certificate belonging to
  // another project must be indistinguishable from one that does not exist.
  if (!row || Number(row.project_id) !== Number(projectId)) {
    throw new AcceptanceError('That certificate is not in this project.', 404);
  }

  const allowed = TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) {
    // The message names the actual state and the legal next step, because "invalid transition" on
    // its own tells the person nothing about what to do instead.
    if (row.status === 'accepted') {
      throw new AcceptanceError(
        'This certificate has already been accepted. Its percentage is part of the revenue basis, '
        + 'so it cannot be changed. Record a new certificate instead.', 409);
    }
    if (row.status === 'rejected') {
      throw new AcceptanceError(
        'This certificate was rejected. Record a NEW certificate that supersedes it — a rejected '
        + 'certificate is kept as a record and cannot be revived.', 409);
    }
    throw new AcceptanceError(
      `A ${row.status} certificate cannot go straight to ${to}. Record it, then submit it first.`,
      409);
  }

  const run = db.transaction(() => {
    const after = { ...row, status: to, ...extra };
    // `accepted_date` is stamped by THIS action, never typed by the submitter: when something was
    // accepted is a fact about the acceptance, not about the submission.
    if (to === 'accepted' && !after.accepted_date) {
      after.accepted_date = new Date().toISOString().slice(0, 10);
    }
    db.prepare(`UPDATE acceptance_register SET status = @status, accepted_date = @accepted_date,
        invoice_date = @invoice_date WHERE id = @id`).run({
      id: row.id,
      status: to,
      accepted_date: after.accepted_date ?? null,
      invoice_date: after.invoice_date ?? row.invoice_date ?? null,
    });
    const updated = byId(row.id);
    q.audit('acceptance_register', row.id, to, actorId, row, updated);
    return updated;
  });

  return run();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a certificate. ALWAYS lands as `draft` — the posted status is ignored.
 *
 * This is decision A expressed in code: a certificate cannot be created as `accepted`, so the only
 * route to a revenue-bearing certificate is through the client's acceptance being recorded by
 * someone with the authority to record it.
 */
function record({ projectId, input, actorId }) {
  const v = validate(input);
  if (!v.ok) throw new AcceptanceError(v.message, 400, v.field);

  // A repeated certificate number is a WARNING, not a refusal. `certificate_no` has no UNIQUE
  // constraint (legacy data may legitimately repeat it, and a re-issue can carry the same number),
  // so refusing would block a real workflow. The caller decides what to do with the flag.
  const duplicate = v.row.certificate_no
    ? db.prepare('SELECT id, status FROM acceptance_register WHERE project_id = ? AND certificate_no = ?')
      .get(projectId, v.row.certificate_no)
    : null;

  const run = db.transaction(() => {
    const info = db.prepare(`INSERT INTO acceptance_register (project_id, wbs_node_id,
        certificate_no, sequence, description, percentage_progress, document_date, handover_date,
        invoice_date, status, created_by)
        VALUES (@project_id, @wbs_node_id, @certificate_no, @sequence, @description,
        @percentage_progress, @document_date, @handover_date, @invoice_date, 'draft', @created_by)`)
      .run({
        project_id: projectId,
        ...v.row,
        sequence: nextSequence(projectId),
        created_by: actorId,
      });
    const created = byId(Number(info.lastInsertRowid));
    q.audit('acceptance_register', created.id, 'create', actorId, null, created);
    return created;
  });

  const created = run();
  return { ok: true, certificate: created, duplicateOf: duplicate || null };
}

function submit({ projectId, id, actorId }) {
  return transition({ projectId, id, to: 'submitted', actorId });
}

function accept({ projectId, id, actorId, acceptedDate }) {
  // An explicit acceptance date is allowed (the client may have signed last week and the record is
  // only being entered now), but it must be a real date — and if none is given the transition
  // stamps today.
  let extra = {};
  if (str(acceptedDate)) {
    const r = dateOrNull(acceptedDate, 'accepted_date');
    if (r.error) throw new AcceptanceError(r.error.message, 400);
    extra = { accepted_date: r.value };
  }
  return transition({ projectId, id, to: 'accepted', actorId, extra });
}

function reject({ projectId, id, actorId }) {
  return transition({ projectId, id, to: 'rejected', actorId });
}

module.exports = {
  AcceptanceError, STATUSES, STATUS_LABELS, TRANSITIONS,
  list, byId, nextSequence, wbsLines, summary, record, submit, accept, reject, transition,
};
