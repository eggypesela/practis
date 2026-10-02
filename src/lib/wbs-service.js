// WBS tree rules (module 7, plan part 7.1; PRD §4.4, §5.1).
//
// THE BOUNDARY THIS FILE ENFORCES
//
// PRD §4.4: "the test is the contract, not a size threshold."
//
//   add / split / rename / reparent a line, SAME total contract value
//        → internal replanning. Allowed directly; write `change_log` with
//          `contract_value_delta = 0`. No BCR.
//   anything that moves contract value
//        → external change. Needs a full BCR, which does not exist yet (part 7.6).
//
// So `assertInternalReplanning()` refuses ANY non-zero delta — one rupiah included.
// There is no tolerance and no "small change" carve-out, because a threshold is
// exactly what the PRD rejected: it would let a genuine scope change through
// because it happened to be small.
//
// VERSIONS ARE IMMUTABLE, AND SUPERSEDED ROWS KEEP THEIR STATUS
//
// A rename/split/reparent INSERTS a copy at `version + 1` and points the old row at
// it via `superseded_by`. Two views read this table and disagree about versions:
//
//   * `v_evm_period` joins per NODE, so it must still see superseded versions —
//     dropping them would erase earned value from the month it was reported.
//   * `v_descoped_lines` has no version filter, so a second ACTIVE version would
//     make a de-scoped line report twice.
//
// Resolution: the old row's `status` is left alone (so nothing is hidden) and it is
// closed for editing (`superseded_by IS NOT NULL` → refuse). Each version exists
// once, in exactly one state, so neither view double-counts. If the service ever
// UPDATEd a name in place, every historic progress row would silently re-label
// itself — which is the bug this whole file exists to prevent.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');

// PRD §4.4 — the only two statuses this screen may set. `de_scoped` is reachable
// only through an approved BCR (plan decisions 3A; part 7.7), because a de-scope
// drops contract value and therefore needs change control.
const USER_STATUSES = ['active', 'completed'];

// `change_log.action` CHECK constraint members. `de_scope` is deliberately NOT one
// of them (that is a bcr_register.change_type), so passing it here aborts at the DB.
const ACTIONS = ['add_line', 'split_line', 'rename_line', 'reparent', 'restructure'];

class WbsError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = 'WbsError';
    this.status = status;
  }
}

// The PRD's change-control test, in one place.
function assertInternalReplanning(delta, what) {
  const n = delta === '' || delta == null ? 0 : Number(delta);
  if (!Number.isFinite(n)) throw new WbsError(`"${delta}" is not a number.`, 400);
  if (Math.trunc(n) !== n) throw new WbsError('Contract value must be whole rupiah.', 400);
  if (n !== 0) {
    // Decision 1A / PRD §4.4: contract-value changes are external changes and need
    // a full BCR. Part 7.6 builds that path; until then this is a hard refusal,
    // which is the honest behaviour — silently accepting it would be the bug.
    throw new WbsError(
      `${what} changes the contract value by ${n}. ` +
      'Work outside the contract needs an approved BCR — it cannot be added here.', 403);
  }
}

// The node, or a refusal that names the reason.
function loadNode(projectId, id) {
  const n = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!n) throw new WbsError('That WBS line does not exist in this project.', 404);
  if (n.superseded_by !== null) {
    // Deliberately NOT a silent redirect to the current version: an edit aimed at
    // a historical row is a mistake worth surfacing.
    throw new WbsError(
      `That line was replaced by version ${n.version + 1}. Edit the current version instead.`, 403);
  }
  return n;
}

function loadParent(projectId, parentId) {
  if (parentId === '' || parentId == null) return null;
  const p = Number(parentId);
  if (!Number.isFinite(p)) throw new WbsError('Unknown parent line.', 400);
  const row = db.prepare('SELECT id FROM wbs_nodes WHERE id = ? AND project_id = ?').get(p, projectId);
  if (!row) throw new WbsError('That parent line does not exist in this project.', 400);
  return p;
}

// ---------------------------------------------------------------------------
// the tree
// ---------------------------------------------------------------------------

// The whole tree including superseded versions, flat, in tree order. The view is
// responsible for the indent, so the ordering has to be exact here: depth-first by
// (sort_order, code) with children under their parent rather than a plain sort.
function tree(projectId) {
  const rows = db.prepare(`
    SELECT n.*, m.ticked, m.total, m.ticked_weight
    FROM wbs_nodes n
    LEFT JOIN (
      SELECT wbs_node_id, SUM(ticked) AS ticked, COUNT(*) AS total,
             SUM(CASE WHEN ticked = 1 THEN pct_weight ELSE 0 END) AS ticked_weight
      FROM progress_milestones GROUP BY wbs_node_id
    ) m ON m.wbs_node_id = n.id
    WHERE n.project_id = ?
    ORDER BY n.sort_order, n.wbs_code, n.version`).all(projectId);

  // Only the CURRENT version of each line is shown as the tree; superseded rows are
  // kept in `history` so the count of versions is visible without cluttering the
  // tree. Nothing is hidden from the database — only from this one screen.
  const current = rows.filter((r) => r.superseded_by === null);
  const byParent = new Map();
  for (const r of current) {
    const key = r.parent_id === null ? 'root' : String(r.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  const out = [];
  const walk = (key, depth) => {
    for (const r of byParent.get(key) || []) {
      out.push({ ...r, depth });
      walk(String(r.id), depth + 1);
    }
  };
  walk('root', 0);
  // Any line whose parent is missing (should be impossible) is appended rather than
  // dropped, so a tree glitch can never make work disappear from the screen.
  const seen = new Set(out.map((r) => r.id));
  for (const r of current) if (!seen.has(r.id)) out.push({ ...r, depth: 0, orphan: true });

  const versions = new Map();
  for (const r of rows) versions.set(r.wbs_code, (versions.get(r.wbs_code) || 0) + 1);

  return { lines: out, versions, counts: { total: current.length, all: rows.length } };
}

function milestones(nodeId) {
  return db.prepare(
    'SELECT * FROM progress_milestones WHERE wbs_node_id = ? ORDER BY seq').all(nodeId);
}

function changeHistory(projectId, limit = 50) {
  return db.prepare(`
    SELECT c.*, u.email AS actor_email, w.wbs_code, w.name AS wbs_name
    FROM change_log c
    LEFT JOIN users u ON u.id = c.actor_id
    LEFT JOIN wbs_nodes w ON w.id = c.wbs_node_id
    WHERE c.project_id = ?
    ORDER BY c.id DESC LIMIT ?`).all(projectId, limit);
}

// ---------------------------------------------------------------------------
// mutations — each one is one transaction, because a change with no change_log
// row is exactly the state the PRD forbids
// ---------------------------------------------------------------------------

function logChange(nodeId, action, reason, delta, actorId, projectId) {
  if (!ACTIONS.includes(action)) throw new WbsError(`Unknown change action "${action}".`, 500);
  db.prepare(`INSERT INTO change_log
      (project_id, wbs_node_id, action, reason, contract_value_delta, actor_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, nodeId, action, reason ?? null, delta, actorId);
}

function addLine({ projectId, actorId, wbs_code, name, parentId, delta, reason }) {
  assertInternalReplanning(delta, 'Adding this line');
  const code = String(wbs_code || '').trim();
  const label = String(name || '').trim();
  if (!code) throw new WbsError('A WBS code is required.', 400);
  if (!label) throw new WbsError('A line name is required.', 400);
  const parent = loadParent(projectId, parentId);

  // The code must come from the company-standard menu (PRD §5.1). Checking it here
  // gives a readable refusal instead of an FK error — and `wbs_code` is the master
  // list the Administrator owns, so a new code is a master-data act.
  const master = db.prepare('SELECT code, name FROM wbs_code WHERE code = ?').get(code);
  if (!master) {
    throw new WbsError(
      `"${code}" is not in the company WBS menu. An Administrator adds it under Master data first.`, 400);
  }

  const existing = db.prepare(
    'SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?').get(projectId, code);
  if (existing) throw new WbsError(`Line ${code} already exists in this project.`, 400);

  const nextSort = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM wbs_nodes WHERE project_id = ?')
    .get(projectId).n;

  const run = db.transaction(() => {
    const info = db.prepare(`INSERT INTO wbs_nodes
        (project_id, wbs_code, name, parent_id, sort_order, status, is_control_account, version)
        VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`).run(
      projectId, code, label, parent, nextSort, parent === null ? 1 : 0);
    const id = info.lastInsertRowid;
    logChange(id, 'add_line', reason, 0, actorId, projectId);
    q.audit('wbs_node', id, 'create', actorId, null,
      { wbs_code: code, name: label, parent_id: parent, contract_value_delta: 0 });
    return id;
  });
  return run();
}

// Rename / reparent / split all share one shape: insert the next version carrying
// the change, then mark the old row superseded. `patch` is a subset of the columns
// a version may carry forward.
function versionLine({ projectId, actorId, nodeId, patch, action, reason, delta }) {
  assertInternalReplanning(delta, action === 'rename_line' ? 'Renaming this line' : 'This change');
  const old = loadNode(projectId, nodeId);

  const next = {
    wbs_code: patch.wbs_code !== undefined ? String(patch.wbs_code).trim() : old.wbs_code,
    name: patch.name !== undefined ? String(patch.name).trim() : old.name,
    parent_id: patch.parent_id !== undefined ? loadParent(projectId, patch.parent_id) : old.parent_id,
    start_date: old.start_date,
    end_date: old.end_date,
  };
  if (!next.name) throw new WbsError('A line name is required.', 400);
  if (!next.wbs_code) throw new WbsError('A WBS code is required.', 400);
  // A line cannot become its own ancestor.
  if (next.parent_id === old.id) throw new WbsError('A line cannot be its own parent.', 400);

  const run = db.transaction(() => {
    const info = db.prepare(`INSERT INTO wbs_nodes
        (project_id, wbs_code, name, parent_id, sort_order, start_date, end_date,
         baseline_start, baseline_end, status, is_control_account, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, next.wbs_code, next.name, next.parent_id, old.sort_order,
      next.start_date, next.end_date, old.baseline_start, old.baseline_end,
      old.status, old.is_control_account, old.version + 1);
    const newId = info.lastInsertRowid;

    db.prepare('UPDATE wbs_nodes SET superseded_by = ? WHERE id = ?').run(newId, old.id);

    // The milestone set carries forward, unticked. Progress does NOT move: it stays
    // on the node it was reported against, so history keeps its own numbers.
    for (const m of milestones(old.id)) {
      db.prepare(`INSERT INTO progress_milestones
          (wbs_node_id, seq, name, pct_weight, planned_date, ticked, ticked_at, ticked_by, note)
          VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)`).run(
        newId, m.seq, m.name, m.pct_weight, m.planned_date, m.note);
    }

    logChange(newId, action, reason, 0, actorId, projectId);
    q.audit('wbs_node', newId, 'update', actorId,
      { id: old.id, version: old.version, name: old.name, parent_id: old.parent_id },
      { id: newId, version: old.version + 1, name: next.name, parent_id: next.parent_id,
        supersedes: old.id, contract_value_delta: 0 });
    return newId;
  });
  return run();
}

const renameLine = (o) => versionLine({ ...o, action: 'rename_line' });
const reparentLine = (o) => versionLine({ ...o, action: 'reparent' });

// Split: shorten this line's end date and add a sibling carrying the removed span.
// One action, two rows, one change_log entry per row — so the pair reads as one act.
function splitLine({ projectId, actorId, nodeId, newCode, newName, endDate, reason, delta }) {
  assertInternalReplanning(delta, 'Splitting this line');
  const old = loadNode(projectId, nodeId);
  const code = String(newCode || '').trim();
  const label = String(newName || '').trim();
  if (!code) throw new WbsError('The split needs a code for the new line.', 400);
  if (!label) throw new WbsError('The split needs a name for the new line.', 400);
  if (db.prepare('SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?').get(projectId, code)) {
    throw new WbsError(`Line ${code} already exists in this project.`, 400);
  }

  const run = db.transaction(() => {
    // 1. version the original with the shortened span
    const info = db.prepare(`INSERT INTO wbs_nodes
        (project_id, wbs_code, name, parent_id, sort_order, start_date, end_date,
         baseline_start, baseline_end, status, is_control_account, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, old.wbs_code, old.name, old.parent_id, old.sort_order,
      old.start_date, endDate, old.baseline_start, old.baseline_end,
      old.status, old.is_control_account, old.version + 1);
    const shortenedId = info.lastInsertRowid;
    db.prepare('UPDATE wbs_nodes SET superseded_by = ? WHERE id = ?').run(shortenedId, old.id);
    logChange(shortenedId, 'split_line', reason, 0, actorId, projectId);

    // 2. the new sibling carrying the removed span
    const sib = db.prepare(`INSERT INTO wbs_nodes
        (project_id, wbs_code, name, parent_id, sort_order, start_date, end_date,
         status, is_control_account, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, 1)`).run(
      projectId, code, label, old.parent_id, old.sort_order + 1,
      endDate, old.end_date);
    logChange(sib.lastInsertRowid, 'split_line', reason, 0, actorId, projectId);

    return { shortenedId, newLineId: sib.lastInsertRowid };
  });
  return run();
}

// Only `active` ↔ `completed` here. `de_scoped` is a BCR-only transition.
function setStatus({ projectId, actorId, nodeId, status, reason }) {
  const node = loadNode(projectId, nodeId);
  if (!USER_STATUSES.includes(status)) {
    throw new WbsError(
      status === 'de_scoped'
        ? 'Removing scope drops contract value, so it needs an approved BCR — not this screen.'
        : `"${status}" is not a status this screen may set.`, 403);
  }
  if (node.status === status) throw new WbsError(`That line is already ${status}.`, 400);

  const run = db.transaction(() => {
    db.prepare('UPDATE wbs_nodes SET status = ? WHERE id = ?').run(status, nodeId);
    // A status change is not a replanning act and has no change_log action of its
    // own, so it is recorded in the audit trail only.
    q.audit('wbs_node', nodeId, 'update', actorId, { status: node.status }, { status });
  });
  run();
  return node;
}

module.exports = {
  WbsError, USER_STATUSES, assertInternalReplanning,
  tree, milestones, changeHistory,
  addLine, renameLine, reparentLine, splitLine, setStatus,
};
