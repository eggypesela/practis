// Supplier register — business rules + transaction (module 6, plan task 6.4).
//
// WHAT THIS OWNS
// The `suppliers` row and its approval chain. The chain itself is the SHARED
// module (`approvals-service.js`), which already carries the supplier
// REQUIRED_STEPS / RECORDED_STEPS / APPROVER_ROLES entries — this file must not
// re-implement the segregation-of-duties rule, or the supplier register drifts
// from the project and client registers.
//
// `approved_by` / `approved_at` — DELIBERATELY LEFT ALONE
// The `suppliers` table (like `clients`) carries legacy `approved_by` /
// `approved_at` columns. Nothing in `src/` reads or writes them. Approval is
// modelled in the `approvals` table, which records WHICH step was approved, by
// whom, when, and why — the legacy pair can only hold one name and one date, so
// filling it in as well would create a SECOND source of truth for the same fact
// and the two would drift. It is imported legacy data; it is not maintained.
//
// Deactivation, not deletion: a supplier referenced by ledger history must not
// disappear from the register (same rule as clients).

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

// Deliberately loose: enough to catch a typo, not so strict that it rejects a
// legal address. A wrong-but-well-formed address is the user's business.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input, { isUpdate = false } = {}) {
  const out = {};

  // Set once at registration. The edit view renders it read-only AND disabled,
  // so a browser does not submit it — requiring it here would make every edit
  // through the real UI fail. The UPDATE statement does not name the column
  // either, so a posted code is ignored, not honoured.
  if (!isUpdate) {
    const code = str(input.code, 40);
    if (!code) return { ok: false, field: 'code', message: 'A supplier code is required.' };
    out.code = code;
  }

  const name = str(input.name, 200);
  if (!name) return { ok: false, field: 'name', message: 'A supplier name is required.' };
  out.name = name;

  const email = str(input.email, 200);
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, field: 'email', message: 'That does not look like an email address.' };
  }
  out.email = email;

  // Free text, legacy `a_supplier_register.type`. No FK and no lookup table, so
  // a value outside any list the user has in mind is still legal data.
  out.supplier_type = str(input.supplier_type, 100);
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
  return q.suppliersAll().some(
    (s) => s.code.toLowerCase() === target && (exceptId == null || s.id !== exceptId));
}

// ---------------------------------------------------------------------------
// Mutations. One transaction each: the row, the approval chain and the audit
// trail land together or not at all.
// ---------------------------------------------------------------------------

function createSupplier(input, actorId) {
  const v = validate(input);
  if (!v.ok) return v;
  if (codeTaken(v.row.code)) {
    return { ok: false, field: 'code', status: 409, message: `Supplier code ${v.row.code} is already in use.` };
  }

  const run = db.transaction(() => {
    const info = q.insertSupplier({ ...v.row, created_by: actorId });
    const id = info.lastInsertRowid;
    approvals.seedChain('supplier', id);

    const created = q.supplierById(id);
    q.audit('supplier', id, 'create', actorId, null, created);
    approvals.notifyPending('supplier', created, actorId);
    return created;
  });

  return { ok: true, supplier: run() };
}

// Edit a supplier. Deliberately CANNOT change the code: it is the human key
// other rows and imports are recognised by, so it is set once at registration.
function updateSupplier(id, input, actorId) {
  const before = q.supplierById(id);
  if (!before) return { ok: false, status: 404, field: 'id', message: 'That supplier does not exist.' };

  const v = validate(input, { isUpdate: true });
  if (!v.ok) return v;

  const run = db.transaction(() => {
    q.updateSupplier({ ...v.row, id });
    const after = q.supplierById(id);
    q.audit('supplier', id, 'update', actorId, before, after);
    return after;
  });

  return { ok: true, supplier: run() };
}

// Approve. `reason` is required only when the actor created the supplier — the
// shared rule, so this register cannot drift from the project/client registers.
function approveSupplier(id, actorId, reason) {
  const out = approvals.approveRecord({
    entityType: 'supplier', id, actorId, reason,
    fetchRecord: (sid) => q.supplierById(sid),
  });
  if (!out.ok) return out;
  return { ok: true, supplier: out.record };
}

module.exports = {
  validate, codeTaken,
  createSupplier, updateSupplier, approveSupplier,
  approvalState: approvals.approvalState,
};
