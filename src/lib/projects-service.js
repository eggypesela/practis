// Project register — business rules + transaction (module 6, plan task 6.2).
//
// WHAT THIS OWNS
// The `projects` row, its approval chain in `approvals`, and the in-app
// notifications that tell people a decision is waiting. The route layer does
// HTTP; the rules live here so they are testable without a server.
//
// WHY APPROVAL IS DATA, NOT CODE (plan task 6.5b)
// PRD §4.1 describes a four-actor chain — PM starts → Finance verifies → PM
// verifies → Admin approves. Decision 8A (the owner, 2026-09-30) chose the
// LIGHT variant for a solo-operator install: **the PM approves.**
//
// The difference between those two is WHICH STEPS COUNT AS APPROVED, so it is
// expressed as a list here rather than as `if (light) {...} else {...}`
// branching inside the service. Reverting to the full chain is then a data
// change, not a refactor. Every step is still RECORDED either way, so the audit
// trail is identical and the full chain can be switched on without losing
// history.
//
// SEGREGATION OF DUTIES — the decision that makes a one-person install work
// A blanket "approver ≠ requester" rule would deadlock this install: the same
// person creates and approves every project, and there is no second user. The
// owner's decision (2026-10-01):
//
//     self-approval is ALLOWED, but only with a typed reason,
//     recorded in the audit trail.
//
// So the rule is not "you may not approve your own" — it is "approving your own
// requires you to say why, on the record". That keeps the control meaningful
// (it is a deliberate, attributable act, not a rubber stamp) without making the
// product unusable. It is enforced in `checkSelfApproval`, and the route passes
// the reason through.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');

const REVENUE_METHODS = ['milestone', 'poc', 'time_based', 'on_billing'];

// Which steps must be `approved` for the register to count the record approved.
// LIGHT (decision 8A). The full PRD chain would be:
//   ['finance_verify', 'pm_verify', 'admin_approve']
const REQUIRED_STEPS = {
  project: ['pm_approve'],
  client: ['pm_approve'],
  supplier: ['pm_approve'],
};

// Every step the register RECORDS, whether required or not. `required_role` is
// advisory (who it is aimed at); the authority to act comes from capabilities.
const RECORDED_STEPS = {
  project: [
    { step: 'finance_verify', required_role: 'finance' },
    { step: 'pm_verify', required_role: 'project_manager' },
    { step: 'admin_approve', required_role: 'administrator' },
    { step: 'pm_approve', required_role: 'project_manager' },
  ],
};

// ---------------------------------------------------------------------------
// Validation. Returns { ok: true, row } or { ok: false, field, message }.
// A sentence for the user, never a raw SQL error.
// ---------------------------------------------------------------------------

function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return NaN;
  return n;
}

function validate(input, { isUpdate = false } = {}) {
  const out = {};

  const code = String(input.code || '').trim();
  if (!isUpdate) {
    if (!code) return { ok: false, field: 'code', message: 'A project code is required.' };
    if (code.length > 40) return { ok: false, field: 'code', message: 'The project code is at most 40 characters.' };
    out.code = code;
  }

  const name = String(input.name || '').trim();
  if (!name) return { ok: false, field: 'name', message: 'A project name is required.' };
  out.name = name;

  // PRD §4.1 step 5 — the PM picks the revenue recognition method, and it must
  // be one of the four the schema allows. Validated here so the user gets a
  // sentence; the CHECK constraint stays as the floor.
  const revenue = String(input.revenue_method || '').trim();
  if (!revenue) {
    return { ok: false, field: 'revenue_method', message: 'A revenue recognition method is required.' };
  }
  if (!REVENUE_METHODS.includes(revenue)) {
    return { ok: false, field: 'revenue_method', message: `Revenue method must be one of: ${REVENUE_METHODS.join(', ')}.` };
  }
  out.revenue_method = revenue;

  // Whole rupiah. The ledger uses integers throughout (`amount = debit - credit`),
  // so a fractional contract value would be the only non-integer money in the system.
  const amount = intOrNull(input.contract_amount);
  if (Number.isNaN(amount)) {
    return { ok: false, field: 'contract_amount', message: 'The contract amount must be a whole number of rupiah.' };
  }
  if (amount !== null && amount < 0) {
    return { ok: false, field: 'contract_amount', message: 'The contract amount cannot be negative.' };
  }
  out.contract_amount = amount;

  // Nullable by design — a project is created "with no numbers" (PRD §4.1 step 6).
  const terms = intOrNull(input.payment_terms_days);
  if (Number.isNaN(terms)) {
    return { ok: false, field: 'payment_terms_days', message: 'Payment terms must be a whole number of days.' };
  }
  if (terms !== null && terms <= 0) {
    return { ok: false, field: 'payment_terms_days', message: 'Payment terms must be a positive number of days.' };
  }
  out.payment_terms_days = terms;

  const start = String(input.start_date || '').trim() || null;
  const end = String(input.end_date || '').trim() || null;
  if (start && end && end < start) {
    return { ok: false, field: 'end_date', message: 'The end date cannot fall before the start date.' };
  }
  out.start_date = start;
  out.end_date = end;

  // Optional: the reference tables are seeded by an Administrator (PRD §4.1
  // step 1) and are EMPTY on a fresh install, so these must not be mandatory.
  const industry = String(input.industry_type || '').trim() || null;
  out.industry_type = industry;

  const clientId = intOrNull(input.client_id);
  if (Number.isNaN(clientId)) {
    return { ok: false, field: 'client_id', message: 'The client must be an existing client.' };
  }
  if (clientId !== null) {
    const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!client) return { ok: false, field: 'client_id', message: 'That client does not exist.' };
  }
  out.client_id = clientId;

  if (isUpdate) {
    const status = String(input.status || 'active').trim();
    if (!['active', 'on_hold', 'closed'].includes(status)) {
      return { ok: false, field: 'status', message: 'Status must be active, on_hold or closed.' };
    }
    out.status = status;
  }

  return { ok: true, row: out };
}

// Uniqueness is the DB's job (UNIQUE(code)); this is so the caller can answer
// 409 with a sentence instead of a SQLITE_CONSTRAINT message.
function codeTaken(code, exceptId = null) {
  const hit = exceptId == null
    ? q.projects().find((p) => p.code.toLowerCase() === String(code).toLowerCase())
    : q.projects().find((p) => p.code.toLowerCase() === String(code).toLowerCase() && p.id !== exceptId);
  return !!hit;
}

// Attach the client's display name to a project row. `projects.client_id`
// references clients(id) and the register shows the client column, so without
// this the column renders blank even when a client was chosen.
function clientNameFor(clientId) {
  if (clientId == null) return null;
  const c = q.clients().find((x) => x.id === clientId);
  return c ? c.name : null;
}

// ---------------------------------------------------------------------------
// Segregation of duties (owner decision 2026-10-01)
// Returns null when allowed, else the reason to show the user.
// ---------------------------------------------------------------------------

function checkSelfApproval({ project, actorId, reason }) {
  if (!project || project.created_by == null) return null;
  if (project.created_by !== actorId) return null;          // different person — the normal case
  if (String(reason || '').trim().length >= 10) return null; // own work, but justified on the record
  return 'You created this project, so approving it needs a written reason (at least 10 characters) '
       + 'for the audit trail.';
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

// Who should be told a decision is waiting. Role holders (global grants) plus
// every active Administrator, de-duplicated; never the person who just acted.
function approverIds(excludeUserId) {
  const ids = new Set([...q.userIdsForRole('project_manager'), ...q.adminUserIds()]);
  ids.delete(excludeUserId);
  return [...ids];
}

function notifyPending(project, actorId, entityType) {
  for (const uid of approverIds(actorId)) {
    q.insertNotification({
      user_id: uid,
      project_id: project.id,
      alert_type: 'approval_pending',
      severity: 'info',
      title: `Project ${project.code} needs approval`,
      body: `${project.name} was registered and is waiting for approval.`,
      entity_type: entityType,
      entity_id: project.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Mutations. Each is one transaction: the projects row, the approval rows and
// the audit trail land together or not at all.
// ---------------------------------------------------------------------------

// Register a project (PRD §4.1 steps 1–6). Starts NOT baselined and NOT approved.
function createProject(input, actorId) {
  const v = validate(input);
  if (!v.ok) return v;
  if (codeTaken(v.row.code)) {
    return { ok: false, field: 'code', status: 409, message: `Project code ${v.row.code} is already in use.` };
  }

  const run = db.transaction(() => {
    const info = q.insertProject({ ...v.row, created_by: actorId });
    const id = info.lastInsertRowid;

    // Record EVERY step up front, all pending. The chain is visible from the
    // moment of registration, and which steps are REQUIRED is data (above), not
    // a decision baked in here.
    for (const s of RECORDED_STEPS.project) {
      q.insertApproval({
        entity_type: 'project', entity_id: id, step: s.step,
        required_role: s.required_role, status: 'pending', actor_id: null, comment: null,
      });
    }

    const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    q.audit('project', id, 'create', actorId, null, created);
    notifyPending(created, actorId, 'project');
    return created;
  });

  return { ok: true, project: run() };
}

// Edit a registered project. Deliberately CANNOT change the code (other rows
// reference it by id, but the code is what humans and imports key on) and
// cannot baseline it — baselining is Module 7's job via a BCR.
function updateProject(id, input, actorId) {
  const before = q.projectById(id);
  if (!before) return { ok: false, status: 404, field: 'id', message: 'That project does not exist.' };

  const v = validate(input, { isUpdate: true });
  if (!v.ok) return v;

  const run = db.transaction(() => {
    q.updateProject({ ...v.row, id });
    const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    q.audit('project', id, 'update', actorId, before, after);
    return after;
  });

  return { ok: true, project: run() };
}

// Approve. `reason` is only required when the actor created the project.
function approveProject(id, actorId, reason) {
  const project = q.projectById(id);
  if (!project) return { ok: false, status: 404, field: 'id', message: 'That project does not exist.' };

  const state = approvalState('project', id);
  if (state.isApproved) {
    return { ok: false, status: 409, field: 'approval', message: `${project.code} is already approved.` };
  }

  const sod = checkSelfApproval({ project, actorId, reason });
  if (sod) return { ok: false, status: 403, field: 'reason', message: sod };

  const run = db.transaction(() => {
    const step = REQUIRED_STEPS.project[0];   // 'pm_approve' under the LIGHT chain
    q.setApprovalStatus('approved', actorId, String(reason || '').trim() || null, 'project', id, step);
    const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    // The approval IS an audit event; the self-approval reason rides in `after`
    // so the trail answers "why was this allowed?" without a second query.
    q.audit('project', id, 'approve', actorId, null, {
      step, approved_at: new Date().toISOString(),
      self_approved: project.created_by === actorId,
      reason: String(reason || '').trim() || null,
    });
    return after;
  });

  return { ok: true, project: run() };
}

module.exports = {
  REVENUE_METHODS, REQUIRED_STEPS, RECORDED_STEPS,
  validate, codeTaken, checkSelfApproval, clientNameFor,
  approvalState, createProject, updateProject, approveProject, approverIds,
};
