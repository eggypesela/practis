// Approval workflow — shared by every register (module 6, plan task 6.5b).
//
// WHY THIS FILE EXISTS
// Task 6.2 built the approval chain inside the project service. Task 6.3 needs
// the SAME chain for clients, 6.4 for suppliers, 6.5 for master data. Copying
// the segregation-of-duties rule into each service is how a control quietly
// drifts: someone fixes the reason-length in one copy and not the others.
// So the rule lives here ONCE and every register calls it.
//
// APPROVAL IS DATA, NOT CODE (plan task 6.5b)
// PRD §4.1 gives each register a multi-actor chain. Decision 8A (the owner,
// 2026-09-30) chose the LIGHT variant for a solo-operator install. The
// difference between light and full is WHICH STEPS COUNT AS APPROVED, so it is
// a list here rather than `if (light) {...} else {...}` inside each service.
// Reverting to the full chain is a data change, not a refactor — and every step
// is RECORDED either way, so switching on the full chain loses no history.
//
// SEGREGATION OF DUTIES — the decision that makes a one-person install work
// The plan's 6.5b note says to keep "requester ≠ approver" enforced in all
// cases. Taken literally that DEADLOCKS this install: the same person creates
// and approves every record and there is no second user, so nothing would ever
// be approved. The owner's decision (2026-10-01) resolves it one way, for every
// register:
//
//     self-approval is ALLOWED, but only with a typed reason,
//     recorded in the audit trail.
//
// So the control is not "you may not approve your own" — it is "approving your
// own requires you to say why, on the record". Deliberate and attributable,
// never a rubber stamp.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');

// Which steps must be `approved` for a record to count as approved.
// LIGHT (decision 8A). The full PRD §4.1 chain would be:
//   project  : ['finance_verify', 'pm_verify', 'admin_approve']
//   client   : ['finance_verify', 'admin_approve']
//   supplier : ['procurement_verify', 'finance_verify', 'admin_approve']
const REQUIRED_STEPS = {
  project: ['pm_approve'],
  client: ['pm_approve'],
  supplier: ['pm_approve'],
};

// Every step the register RECORDS, required or not. `required_role` is advisory
// (who the step is aimed at); the authority to ACT comes from capabilities.
const RECORDED_STEPS = {
  project: [
    { step: 'finance_verify', required_role: 'finance' },
    { step: 'pm_verify', required_role: 'project_manager' },
    { step: 'admin_approve', required_role: 'administrator' },
    { step: 'pm_approve', required_role: 'project_manager' },
  ],
  client: [
    { step: 'finance_verify', required_role: 'finance' },
    { step: 'admin_approve', required_role: 'administrator' },
    { step: 'pm_approve', required_role: 'project_manager' },
  ],
  supplier: [
    { step: 'procurement_verify', required_role: 'procurement' },
    { step: 'finance_verify', required_role: 'finance' },
    { step: 'admin_approve', required_role: 'administrator' },
    { step: 'pm_approve', required_role: 'project_manager' },
  ],
};

// How the register is named in messages, and which column records the creator.
const REGISTERS = {
  project: { label: 'project', table: 'projects', codeColumn: 'code' },
  client: { label: 'client', table: 'clients', codeColumn: 'code' },
  supplier: { label: 'supplier', table: 'suppliers', codeColumn: 'code' },
};

// Who may approve, as an advisory role list — the real gate is the capability
// flag on the route (`canApproveProjects` / `canApproveClients`).
const APPROVER_ROLES = {
  project: ['project_manager'],
  client: ['project_manager'],
  supplier: ['project_manager'],
};

const MIN_REASON = 10;

// ---------------------------------------------------------------------------
// Segregation of duties. Returns null when allowed, else the reason to show.
// ---------------------------------------------------------------------------

// `record` is any row carrying `created_by`. Works for projects, clients and
// suppliers alike — the column has the same meaning in all three registers.
function checkSelfApproval({ record, actorId, reason }) {
  if (!record || record.created_by == null) return null;
  if (record.created_by !== actorId) return null;          // different person — the normal case
  if (String(reason || '').trim().length >= MIN_REASON) return null;
  return `You created this record, so approving it needs a written reason `
       + `(at least ${MIN_REASON} characters) for the audit trail.`;
}

// ---------------------------------------------------------------------------
// Approval state
// ---------------------------------------------------------------------------

function approvalState(entityType, entityId) {
  const rows = q.approvalsFor(entityType, entityId);
  const required = REQUIRED_STEPS[entityType] || [];
  const approvedSteps = new Set(rows.filter((r) => r.status === 'approved').map((r) => r.step));
  const isApproved = required.length > 0 && required.every((s) => approvedSteps.has(s));
  return { rows, required, isApproved, approvedSteps };
}

// Record every step up front, all pending. The chain is visible from the moment
// of registration, and which steps are REQUIRED is data (above).
function seedChain(entityType, entityId) {
  for (const s of RECORDED_STEPS[entityType] || []) {
    q.insertApproval({
      entity_type: entityType, entity_id: entityId, step: s.step,
      required_role: s.required_role, status: 'pending', actor_id: null, comment: null,
    });
  }
}

// Who should be told a decision is waiting: role holders (global grants) plus
// every active Administrator, de-duplicated; never the person who just acted.
function approverIds(entityType, excludeUserId) {
  const ids = new Set();
  for (const role of APPROVER_ROLES[entityType] || []) {
    for (const uid of q.userIdsForRole(role)) ids.add(uid);
  }
  for (const uid of q.adminUserIds()) ids.add(uid);
  ids.delete(excludeUserId);
  return [...ids];
}

function notifyPending(entityType, record, actorId, projectId = null) {
  const label = REGISTERS[entityType].label;
  const code = record[REGISTERS[entityType].codeColumn];
  for (const uid of approverIds(entityType, actorId)) {
    q.insertNotification({
      user_id: uid,
      project_id: projectId,
      alert_type: 'approval_pending',
      severity: 'info',
      title: `${label.charAt(0).toUpperCase() + label.slice(1)} ${code} needs approval`,
      body: `${record.name || code} was registered and is waiting for approval.`,
      entity_type: entityType,
      entity_id: record.id,
    });
  }
}

// Mark a record approved. ONE transaction: the approval row, the audit event
// and the notification all land together or not at all.
//
// The caller is responsible for the capability check and for passing `reason`.
// Returns { ok, status, field, message } on refusal — the route turns that into
// a rendered page.
function approveRecord({ entityType, id, actorId, reason, fetchRecord }) {
  const record = fetchRecord(id);
  const label = REGISTERS[entityType].label;
  if (!record) {
    return { ok: false, status: 404, field: 'id', message: `That ${label} does not exist.` };
  }

  const state = approvalState(entityType, id);
  if (state.isApproved) {
    return { ok: false, status: 409, field: 'approval',
             message: `${record[REGISTERS[entityType].codeColumn]} is already approved.` };
  }

  const step = (REQUIRED_STEPS[entityType] || [])[0];
  if (!step) {
    return { ok: false, status: 500, field: 'approval',
             message: `No required approval step is configured for ${label}.` };
  }

  const sod = checkSelfApproval({ record, actorId, reason });
  if (sod) return { ok: false, status: 403, field: 'reason', message: sod };

  const trimmed = String(reason || '').trim() || null;

  const run = db.transaction(() => {
    q.setApprovalStatus('approved', actorId, trimmed, entityType, id, step);
    // The approval IS an audit event; the self-approval reason rides in `after`
    // so the trail answers "why was this allowed?" without a second query.
    q.audit(entityType, id, 'approve', actorId, null, {
      step,
      approved_at: new Date().toISOString(),
      self_approved: record.created_by === actorId,
      reason: trimmed,
    });
    return fetchRecord(id);
  });

  return { ok: true, record: run() };
}

module.exports = {
  REQUIRED_STEPS, RECORDED_STEPS, REGISTERS, APPROVER_ROLES, MIN_REASON,
  checkSelfApproval, approvalState, seedChain, approverIds, notifyPending, approveRecord,
};
