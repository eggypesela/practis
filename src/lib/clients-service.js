// Client register — business rules + transaction (module 6, plan task 6.3).
//
// WHAT THIS OWNS
// The `clients` row and its approval chain. The chain itself is the SHARED
// module (`approvals-service.js`) — this file must not re-implement the
// segregation-of-duties rule, or the control drifts from the project register.
//
// `payment_terms_days` — WHAT IT IS AND IS NOT
// The plan for this task says the column is "the default that v_aging due dates
// depend on, and a NULL here silently breaks the aging report". That is NOT
// what the code does, and the difference matters:
//
//   * `v_aging` buckets on FIXED 30/60/90/120-day offsets from `invoice_date`
//     (PRD §5.2: "Aging report view (30/60/90/120+ day buckets)"). It does not
//     read `payment_terms_days` at all.
//   * PRD §5.2 DOES specify "Due date = ledger date + payment terms (from
//     project register)" — a due-date column that does not exist yet.
//
// So the column is a stored business term that nothing consumes YET. Validating
// it is still right (a term of 0 or -5 days is meaningless data), but the aging
// report will NOT break because of a NULL here, and this file does not pretend
// otherwise. Wiring the real due-date column belongs to Module 8, where the
// aging report screen lives (plan line 772).

'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const approvals = require('./approvals-service');

// ---------------------------------------------------------------------------
// Validation. Returns { ok: true, row } or { ok: false, field, message }.
// ---------------------------------------------------------------------------

function str(v, max = 200) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

function intOrNull(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return NaN;
  return Number(s);
}

// Deliberately loose: enough to catch a typo, not so strict that it rejects a
// legal address. A wrong-but-well-formed address is the user's business.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input, { isUpdate = false } = {}) {
  const out = {};

  // The code is only ever set at registration. The edit view renders it
  // read-only AND disabled, so a browser does not submit it — requiring it here
  // would make every edit through the real UI fail. The UPDATE statement does
  // not name the column either, so a posted code is ignored, not honoured.
  if (!isUpdate) {
    const code = str(input.code, 40);
    if (!code) return { ok: false, field: 'code', message: 'A client code is required.' };
    out.code = code;
  }

  const name = str(input.name, 200);
  if (!name) return { ok: false, field: 'name', message: 'A client name is required.' };
  out.name = name;

  const email = str(input.email, 200);
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, field: 'email', message: 'That does not look like an email address.' };
  }
  out.email = email;

  // Optional FK: `industry_types` is seeded by an Administrator (PRD §4.1
  // step 1) and is EMPTY on a fresh install, so this must never be mandatory.
  const industryId = intOrNull(input.industry_id);
  if (Number.isNaN(industryId)) {
    return { ok: false, field: 'industry_id', message: 'The industry must be one of the listed types.' };
  }
  if (industryId !== null) {
    const hit = db.prepare('SELECT id FROM industry_types WHERE id = ?').get(industryId);
    if (!hit) return { ok: false, field: 'industry_id', message: 'That industry type does not exist.' };
  }
  out.industry_id = industryId;

  // A payment term is a number of days. 0 and negatives are meaningless: they
  // would mean "due the day it was issued" or "already overdue when issued".
  const terms = intOrNull(input.payment_terms_days);
  if (Number.isNaN(terms)) {
    return { ok: false, field: 'payment_terms_days', message: 'Payment terms must be a whole number of days.' };
  }
  if (terms !== null && terms <= 0) {
    return { ok: false, field: 'payment_terms_days', message: 'Payment terms must be a positive number of days.' };
  }
  out.payment_terms_days = terms;

  out.address = str(input.address, 500);
  out.correspondence_person = str(input.correspondence_person, 200);
  out.phone = str(input.phone, 50);
  out.description = str(input.description, 1000);

  if (isUpdate) {
    const active = input.active;
    out.active = (active === '0' || active === 0 || active === false) ? 0 : 1;
  }

  return { ok: true, row: out };
}

// Uniqueness is the DB's job (UNIQUE(code)); this exists so the caller can
// answer 409 with a sentence instead of a SQLITE_CONSTRAINT message.
function codeTaken(code, exceptId = null) {
  const target = String(code).toLowerCase();
  return q.clientsAll().some(
    (c) => c.code.toLowerCase() === target && (exceptId == null || c.id !== exceptId));
}

// ---------------------------------------------------------------------------
// Mutations. One transaction each: the row, the approval chain and the audit
// trail land together or not at all.
// ---------------------------------------------------------------------------

function createClient(input, actorId) {
  const v = validate(input);
  if (!v.ok) return v;
  if (codeTaken(v.row.code)) {
    return { ok: false, field: 'code', status: 409, message: `Client code ${v.row.code} is already in use.` };
  }

  const run = db.transaction(() => {
    const info = q.insertClient({ ...v.row, created_by: actorId });
    const id = info.lastInsertRowid;
    approvals.seedChain('client', id);

    const created = q.clientById(id);
    q.audit('client', id, 'create', actorId, null, created);
    approvals.notifyPending('client', created, actorId);
    return created;
  });

  return { ok: true, client: run() };
}

// Edit a client. Deliberately CANNOT change the code: it is the human key other
// rows and imports are recognised by, so it is set once at registration.
function updateClient(id, input, actorId) {
  const before = q.clientById(id);
  if (!before) return { ok: false, status: 404, field: 'id', message: 'That client does not exist.' };

  const v = validate(input, { isUpdate: true });
  if (!v.ok) return v;

  const run = db.transaction(() => {
    q.updateClient({ ...v.row, id });
    const after = q.clientById(id);
    q.audit('client', id, 'update', actorId, before, after);
    return after;
  });

  return { ok: true, client: run() };
}

// Approve. `reason` is required only when the actor created the client — the
// shared rule, so this register cannot drift from the project register.
function approveClient(id, actorId, reason) {
  const out = approvals.approveRecord({
    entityType: 'client', id, actorId, reason,
    fetchRecord: (cid) => q.clientById(cid),
  });
  if (!out.ok) return out;
  return { ok: true, client: out.record };
}

// The client's payment terms, used by the project registration form to offer a
// sensible default. Returns null when the client set none or was not chosen.
function defaultTermsFor(clientId) {
  if (clientId == null) return null;
  const c = q.clientById(clientId);
  return c ? c.payment_terms_days : null;
}

module.exports = {
  validate, codeTaken, defaultTermsFor,
  createClient, updateClient, approveClient,
  approvalState: approvals.approvalState,
};
