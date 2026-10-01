// Role enforcement (TECH-SPEC §5, §6.1).
//
// Until now every route was authenticate-only. Module 5 is the first place the
// spec demands real separation of duties: the person who ENTERS an Expense
// Report line (Project Admin) must not be the person who CHECKS it (Cost
// Controller), and the check is final. That rule cannot live in a hidden button
// — hidden buttons are usability, never security — so the guard sits here and
// the routes call it.
//
// Roles come from `user_roles`. project_id IS NULL means a global grant; a
// scoped grant (project_id set) applies only in that project. v1 grants globally
// (project setup UI is not built yet), so both shapes are read.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');

// Every role code held by a user, global or otherwise.
function rolesOf(userId) {
  return db.prepare(`SELECT DISTINCT role_code FROM user_roles WHERE user_id = ?`)
    .all(userId).map((r) => r.role_code);
}

// Only the GLOBAL grants (`project_id IS NULL`). A scoped grant is a per-project
// assignment, not a portfolio-wide role — so it is deliberately excluded here.
// This is the distinction that makes "project_manager, unassigned" resolve to
// nothing rather than to every project.
function globalRoleCodes(userId) {
  return db.prepare(
    `SELECT DISTINCT role_code FROM user_roles WHERE user_id = ? AND project_id IS NULL`)
    .all(userId).map((r) => r.role_code);
}

// Effective permissions for a request. An Administrator holds every role: they
// are the system owner, and without this an operator locked out of their own
// install would have to fix the database by hand.
function capabilities(user) {
  if (!user) return { roles: [], isAdmin: false, can: {} };
  const roles = rolesOf(user.id);
  const isAdmin = user.is_system_admin === 1;
  const has = (...codes) => isAdmin || codes.some((c) => roles.includes(c));
  const canEnterExpense = has('project_admin', 'project_manager');
  const canCheckExpense = has('cost_controller', 'project_controller');
  const canReconcile = has('finance', 'cost_controller', 'project_controller');
  const canOpenAdvance = has('project_admin', 'project_manager', 'finance');
  // --- Ledger side (audit 2026-09-30, blockers B1–B4) -----------------------
  // Before these existed, POST /ledger/entry, POST /ledger/:id/reverse,
  // POST /queue/tag and the two import endpoints were authenticate-only, so a
  // read-only Viewer could write money (proven in docs/AUDIT-2026-09-30.md).
  // The ledger is the book of record: entering and correcting are deliberately
  // different grants, and correcting is deliberately the narrower one.
  const canWriteLedger = has('finance');
  // Who may post a reversal. Decision 2A (the owner, 2026-09-30): Finance + Cost
  // Controller ONLY. A reversal is one-shot and irreversible
  // (`idx_ledger_one_reversal`), so the set stays as small as the organisation
  // tolerates — deliberately NOT project_manager, NOT project_admin, NOT viewer.
  const canCorrectLedger = has('finance', 'cost_controller');
  // The checker's job: marking imported cost as checked is what promotes a line
  // into v_cbs_actual, i.e. into the cost report.
  const canTagCost = has('cost_controller', 'project_controller');
  const canImportLedger = has('finance');
  return {
    roles,
    isAdmin,
    // Who may ENTER Expense Report detail.
    canEnterExpense,
    // Who may CHECK it — deliberately disjoint from the enter set.
    canCheckExpense,
    // Who may see the reconciliation screen (Finance vs detail). Not the Project
    // Admin: they see their own project's detail, not Finance's settlement view.
    canReconcile,
    // Who may open a Cash Advance pot.
    canOpenAdvance,
    // Who may open the Cash Advance / Expense Report screens AT ALL. This is the
    // union of the three families above, and it has to exist as its own flag:
    // gating the pages on `canReconcile` locked the Project Admin out of the very
    // screen that carries the ENTER form, so the workflow could not be started by
    // the person whose job it is to start it.
    canViewExpense: canEnterExpense || canCheckExpense || canReconcile,
    // --- Ledger side --------------------------------------------------------
    canWriteLedger,
    canCorrectLedger,
    canTagCost,
    canImportLedger,
    // Page visibility is a SEPARATE question from action permission. A Viewer
    // reading the ledger is fine; a Viewer being shown an entry form it cannot
    // submit is not. Page flags are the union of the actions that screen offers.
    canViewLedger: canWriteLedger || canCorrectLedger || canImportLedger || canTagCost,
  };
}

// The separation-of-duties rule, as a named predicate so routes and tests read
// the same sentence. Returns null when allowed, else the reason to show.
function checkSoD({ line, actorId, caps }) {
  if (caps.canCheckExpense !== true) {
    return 'Only a Cost Controller can check an Expense Report line.';
  }
  if (line && line.created_by != null && line.created_by === actorId) {
    return 'Separation of duties: you entered this line, so you cannot also check it. '
         + 'Another Cost Controller must check it.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-project scope (PRD §2.3, plan task 0.9 / BOLA)
//
// Before this existed, `projectContext` resolved the project from a raw
// `?project=` query param with no authorization check, so ANY signed-in user
// could read and write ANY project by changing one number — and
// `user_roles.project_id`, the junction the PRD specifies for exactly this, was
// NULL in every row and read by zero code.
//
// ENFORCEMENT IS OFF BY DEFAULT (`SCOPE_ENFORCE=1` opts in). Decision 4A
// (the owner): backfill every account with its real project FIRST, then enforce —
// because enforcing "assigned only" against a table of NULLs would lock every
// existing account out of their own install. Until the gate is on, a
// project-scoped grant is a preference (which project opens by default), not a
// restriction. This is the deliberate v1 fallback recorded in the plan.
//
// Fail closed: if the scope tables cannot be read, a project-scoped user gets
// NOTHING, never everything. "Cannot verify" must not mean "grant".
// ---------------------------------------------------------------------------

// Roles that are organisation-wide by nature: they see every project.
// `viewer` is deliberately NOT here — "Viewer sees assigned dashboards"
// (PRD §2.3) is explicitly assignment-scoped.
const ORG_WIDE_ROLES = new Set(['administrator', 'finance', 'human_capital', 'procurement']);

// Identity of a signing-in user, for the ordering below: an Administrator is
// treated exactly as if they held the role `administrator`.
const isOrgWideByRole = (roles) => roles.some((r) => ORG_WIDE_ROLES.has(r));
const isOrgWide = (user, roles) => user?.is_system_admin === 1 || isOrgWideByRole(roles);

const ALL_PROJECTS = () => db.prepare('SELECT * FROM projects ORDER BY name').all();

// The projects a user may see. Ordering of the rules matters — it resolves the
// plan's "a project-scoped row grants only that project; a user with no rows
// falls back to their global role's default":
//
//   1. unknown user          → nothing (fail closed)
//   2. org-wide (or Admin)   → every project
//   3. has project-scoped grants → exactly those projects
//   4. non-admin holds ONLY a scoped role → nothing. A `project_manager` with no
//      project assignment is a half-finished configuration; granting the whole
//      portfolio is the opposite of what the scoped role means.
//   5. global role, no scoped grants → that role's default (today: every
//      project, i.e. the pre-scoping behaviour — so only roles 3 and 4 change
//      what an existing account sees once the gate is flipped).
function projectsFor(user) {
  if (!user || !user.id) return [];
  let roles = [];
  try {
    roles = rolesOf(user.id);
  } catch (err) {
    // Fail closed, and say why rather than silently narrowing to nothing.
    console.error('[scope] could not read roles — denying scope:', err.message);
    return [];
  }
  if (isOrgWide(user, roles)) return ALL_PROJECTS();

  const scopedIds = q.projectIdsForUser(user.id);
  if (scopedIds.length) {
    const want = new Set(scopedIds);
    return ALL_PROJECTS().filter((p) => want.has(p.id));
  }

  const globalRoles = globalRoleCodes(user.id);
  if (!globalRoles.length) return [];   // rule 4
  return ALL_PROJECTS();                // rule 5
}

function canAccessProject(user, projectId) {
  if (!user || !user.id || projectId == null) return false;
  return projectsFor(user).some((p) => p.id === Number(projectId));
}

// Human-readable reason for a scope refusal, so a 403 explains itself.
function scopeReason(user) {
  if (!user) return 'Sign in to see project data.';
  const scoped = q.projectIdsForUser(user.id);
  if (!scoped.length) {
    return 'Your account is not assigned to a project. Ask an Administrator to assign one.';
  }
  return 'Your account is not assigned to that project.';
}

module.exports = {
  rolesOf, capabilities, checkSoD,
  projectsFor, canAccessProject, scopeReason,
  ORG_WIDE_ROLES, isOrgWide, globalRoleCodes,
};
