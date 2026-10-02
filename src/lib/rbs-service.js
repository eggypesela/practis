// Resource load (module 7, plan part 7.3; PRD §5.1).
//
// WHAT THIS FILE IS FOR
//
// The resource plan says what a line of work will consume: this many days of a
// carpenter at this rate, that many tonnes of steel at that price. Part 7.4 then
// checks the PRD's named invariant — sum of the resource plan = the account total =
// the budget — so the total stored here has to be exact.
//
// TWO RULES CARRY MONEY
//
//   1. `total_amount` IS RATE x UNITS, MATERIALISED AT WRITE TIME. Every other
//      money column in this system is a whole-rupiah INTEGER, enforced by the
//      ledger triggers. A resource total that were a float would break the
//      reconciliation downstream where nobody would look for it, so the product is
//      rounded once, here, and stored. Tests assert Number.isInteger, not merely a
//      close-enough value (RB7.1–RB7.3).
//
//   2. A LOAD BELONGS TO A LINE OF WORK AND A RESOURCE. `wbs_node_id` and
//      `rbs_code` are both REQUIRED (decision 2A): a load with neither belongs to no
//      line and no resource and can never be reconciled against anything. The cost
//      account is deliberately OPTIONAL — assigning money to an account is the Cost
//      Controller's call and commonly comes after the plan is agreed.
//
// WHY VERSIONING, AND WHY THE DATABASE ALSO ENFORCES IT
//
// Editing a rate inserts a NEW row at version+1 instead of overwriting, matching
// `wbs_nodes` and `cbs_plan`: the old figure stays readable, so a plan change is a
// fact rather than a disappearance.
//
// That only works if a version cannot be duplicated — and it could.
// `rbs_load`'s inline UNIQUE lists `transaction_account_id`, which is usually NULL,
// and SQLite treats NULLs as distinct: two identical rows inserted happily. So the
// duplicate guard is an INDEX (migration 013, following `cbs_plan`'s
// `COALESCE` pattern), not just this file's check. This file's check exists to give
// the user a readable message instead of a constraint error.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');

class RbsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RbsError';
    this.status = status;
  }
}

const MAX_UNITS = 1e12;   // beyond this the plan is a typo, not a plan

// Whole rupiah, always. `Math.round` on the product, then verified — the
// verification is not paranoia, it is the invariant this part exists to protect.
function totalFor(rate, units) {
  const r = Number(rate);
  const u = Number(units);
  if (!Number.isFinite(r) || !Number.isFinite(u)) {
    throw new RbsError('Rate and units must both be numbers.', 400);
  }
  if (r < 0 || u < 0) throw new RbsError('Rate and units cannot be negative.', 400);
  if (u > MAX_UNITS) throw new RbsError('That is not a plausible quantity.', 400);

  const total = Math.round(r * u);
  if (!Number.isInteger(total)) {
    // Unreachable with the rounding above, and kept deliberately: if anyone ever
    // "simplifies" it away, the reconciliation breaks silently.
    throw new RbsError('The plan total must be a whole number of rupiah.', 500);
  }
  return total;
}

const line = (projectId, nodeId) => {
  const n = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(nodeId, projectId);
  if (!n) throw new RbsError('That WBS line does not exist in this project.', 404);
  if (n.superseded_by !== null) {
    throw new RbsError(
      `That line was replaced by version ${n.version + 1}. Load resources against the current version.`, 403);
  }
  return n;
};

const resource = (code) => {
  const r = db.prepare('SELECT * FROM rbs_code WHERE code = ?').get(code);
  if (!r) {
    throw new RbsError(`"${code}" is not a resource in the RBS list. Add it under Setup → RBS codes first.`, 400);
  }
  if (r.active !== 1) throw new RbsError(`"${code}" (${r.name}) has been deactivated and cannot be loaded.`, 400);
  return r;
};

const account = (id) => {
  if (id === null || id === undefined || id === '' || Number(id) === 0) return null;   // optional by design
  const a = db.prepare('SELECT * FROM transaction_accounts WHERE id = ?').get(Number(id));
  if (!a) throw new RbsError('That cost account does not exist.', 400);
  return a;
};

// The current (highest) version of a bucket. `COALESCE(...,0)` mirrors the index
// so a NULL account compares as one value rather than many.
function currentVersion({ projectId, wbsNodeId, rbsCode, accountId }) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(version), 0) AS v FROM rbs_load
    WHERE project_id = ? AND wbs_node_id = ? AND rbs_code = ?
      AND COALESCE(transaction_account_id, 0) = COALESCE(?, 0)`).get(projectId, wbsNodeId, rbsCode, accountId);
  return row.v;
}

const versionAt = ({ projectId, wbsNodeId, rbsCode, accountId, version }) => db.prepare(`
  SELECT * FROM rbs_load
  WHERE project_id = ? AND wbs_node_id = ? AND rbs_code = ?
    AND COALESCE(transaction_account_id, 0) = COALESCE(?, 0) AND version = ?`)
  .get(projectId, wbsNodeId, rbsCode, accountId, version);

// A plan line, first time. Two identical live rows would double the line's plan —
// anything but an empty replacement plan is treated as an EDIT (see editLoad).
function addLoad({ projectId, actorId, wbsNodeId, rbsCode, accountId = null,
                   description = null, rate, units, unitLabel = null }) {
  const nodeId = Number(wbsNodeId);
  const acc = account(accountId);
  const res = resource(String(rbsCode || '').trim());
  line(projectId, nodeId);

  // A superseded line still names its own project, so `line()` alone would allow a
  // write against history; this keeps the whole bucket on live lines only.

  const existing = currentVersion({ projectId, wbsNodeId: nodeId, rbsCode: res.code, accountId: acc ? acc.id : null });
  if (existing > 0) {
    return editLoad({ projectId, actorId, wbsNodeId: nodeId, rbsCode: res.code,
      accountId: acc ? acc.id : null, description, rate, units, unitLabel });
  }

  const total = totalFor(rate, units);
  const run = db.transaction(() => {
    const info = db.prepare(`INSERT INTO rbs_load
        (project_id, wbs_node_id, rbs_code, transaction_account_id, description,
         rate, units, unit_label, total_amount, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(projectId, nodeId, res.code, acc ? acc.id : null, description,
        Math.round(Number(rate)), Number(units), unitLabel, total);
    q.audit('rbs_load', info.lastInsertRowid, 'create', actorId, null, {
      wbs_node_id: nodeId, rbs_code: res.code, transaction_account_id: acc ? acc.id : null,
      rate: Math.round(Number(rate)), units: Number(units), total_amount: total, version: 1,
    });
    return info.lastInsertRowid;
  });
  return { id: run(), version: 1, total_amount: total, created: true };
}

// An edit VERSIONS the row. The previous figure stays readable at its own version,
// so "the rate was 250,000 last week" remains an answerable question.
function editLoad({ projectId, actorId, wbsNodeId, rbsCode, accountId = null,
                    description = null, rate, units, unitLabel = null }) {
  const nodeId = Number(wbsNodeId);
  const acc = account(accountId);
  const res = resource(String(rbsCode || '').trim());
  line(projectId, nodeId);

  const prevVersion = currentVersion({ projectId, wbsNodeId: nodeId, rbsCode: res.code, accountId: acc ? acc.id : null });
  if (prevVersion === 0) throw new RbsError('There is no plan line to edit; add it first.', 404);
  const prev = versionAt({ projectId, wbsNodeId: nodeId, rbsCode: res.code, accountId: acc ? acc.id : null, version: prevVersion });

  const total = totalFor(rate, units);
  const run = db.transaction(() => {
    const info = db.prepare(`INSERT INTO rbs_load
        (project_id, wbs_node_id, rbs_code, transaction_account_id, description,
         rate, units, unit_label, total_amount, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, nodeId, res.code, acc ? acc.id : null, description ?? prev.description,
        Math.round(Number(rate)), Number(units), unitLabel ?? prev.unit_label, total, prevVersion + 1);
    // The before/after are recorded so the change is auditable, not merely visible.
    q.audit('rbs_load', info.lastInsertRowid, 'update', actorId,
      { version: prevVersion, rate: prev.rate, units: prev.units, total_amount: prev.total_amount },
      { version: prevVersion + 1, rate: Math.round(Number(rate)), units: Number(units), total_amount: total });
    return info.lastInsertRowid;
  });
  return { id: run(), version: prevVersion + 1, total_amount: total, created: false };
}

// Latest version per bucket — what the screen shows and what part 7.4 will sum.
function loadFor(projectId) {
  return db.prepare(`
    SELECT r.*, n.wbs_code, n.name AS wbs_name, c.code AS rbs_name_code, c.name AS rbs_name,
           ta.code AS account_code, ta.name AS account_name,
           rc.name AS category_name
    FROM rbs_load r
    JOIN wbs_nodes n ON n.id = r.wbs_node_id
    LEFT JOIN rbs_code c ON c.code = r.rbs_code
    LEFT JOIN transaction_accounts ta ON ta.id = r.transaction_account_id
    LEFT JOIN resource_categories rc ON rc.id = c.resource_category_id
    WHERE r.project_id = ?
      AND r.version = (
        SELECT COALESCE(MAX(r2.version), 1) FROM rbs_load r2
        WHERE r2.project_id = r.project_id AND r2.wbs_node_id = r.wbs_node_id
          AND r2.rbs_code = r.rbs_code
          AND COALESCE(r2.transaction_account_id, 0) = COALESCE(r.transaction_account_id, 0))
    ORDER BY n.sort_order, n.wbs_code, r.rbs_code`).all(projectId);
}

// Every version of one bucket, newest first — the change history of a plan line.
const history = (projectId, wbsNodeId, rbsCode, accountId = null) => db.prepare(`
  SELECT * FROM rbs_load
  WHERE project_id = ? AND wbs_node_id = ? AND rbs_code = ?
    AND COALESCE(transaction_account_id, 0) = COALESCE(?, 0)
  ORDER BY version DESC`).all(projectId, wbsNodeId, rbsCode, accountId);

// The plan total for a project — the number part 7.4 reconciles against the budget.
const planTotal = (projectId) => loadFor(projectId)
  .reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

const resourceList = () => db.prepare(`
  SELECT c.code, c.name, rc.name AS category_name FROM rbs_code c
  LEFT JOIN resource_categories rc ON rc.id = c.resource_category_id
  WHERE c.active = 1 ORDER BY c.code`).all();

module.exports = {
  RbsError, totalFor, addLoad, editLoad, loadFor, history, planTotal,
  currentVersion, versionAt, resourceList, MAX_UNITS,
};
