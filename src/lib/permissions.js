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

// Every role code held by a user, global or otherwise.
function rolesOf(userId) {
  return db.prepare(`SELECT DISTINCT role_code FROM user_roles WHERE user_id = ?`)
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
  return {
    roles,
    isAdmin,
    // Who may ENTER Expense Report detail.
    canEnterExpense: has('project_admin', 'project_manager'),
    // Who may CHECK it — deliberately disjoint from the enter set.
    canCheckExpense: has('cost_controller', 'project_controller'),
    // Who may open a Cash Advance pot.
    canOpenAdvance: has('project_admin', 'project_manager', 'finance'),
    // Who may see the reconciliation screen.
    canReconcile: has('finance', 'cost_controller', 'project_controller'),
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

module.exports = { rolesOf, capabilities, checkSoD };
