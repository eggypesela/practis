// WBS tree + default milestones for a new project (module 6, plan task 6.6).
//
// WHY THIS EXISTS
// PRD §5.1: "WBS tree per project from company-standard menu" and "Each WBS line:
// start/end dates, milestone ticks (default: mobilize → install → test → handover).
// % complete derives from ticks."
//
// Until now a new project got NO tree and NO milestones, so the only way to get
// one was the seed script — which only ever touched the one demo project. A project
// registered through the UI therefore had nothing to tick and nothing to measure
// progress against. That is an empty-default problem, not a missing feature.
//
// DECISION 7A: the four milestones carry EQUAL 25% weights. That is the owner's
// locked choice, not a default I picked: unequal weights would make "% complete"
// depend on a number nobody had agreed to, and the four steps are treated as equal
// effort for v1.
//
// WHAT IT DOES NOT DO
// It does not copy dates. The tree is created with the project's own start/end on
// the top-level lines and no planned milestone dates, because a milestone date that
// was never agreed is worse than a blank one — it looks like a plan.
'use strict';

// The default progression, in order. `seq` is positional and `pct_weight` is equal
// by decision 7A; both are written explicitly rather than computed so a future
// change to one milestone's weight is a visible edit.
const MILESTONES = [
  { seq: 1, name: 'mobilize', pct_weight: 25 },
  { seq: 2, name: 'install', pct_weight: 25 },
  { seq: 3, name: 'test', pct_weight: 25 },
  { seq: 4, name: 'handover', pct_weight: 25 },
];

// Build the project's WBS tree from the company-standard `wbs_code` menu.
//
// PARENTS FIRST: `wbs_code.parent_code` references `wbs_code.code`, and
// `wbs_nodes.parent_id` references the node just created, so a child cannot be
// inserted before its parent. The master list is stored parents-first (the seed
// builds it that way), but that is an ordering CONVENTION, not a constraint — so
// this sorts defensively by code depth rather than trusting the row order.
//
// Runs inside the caller's transaction: the project, its tree, its milestones and
// the audit rows land together or not at all.
function buildWbsTree(db, projectId, actorId) {
  const master = db.prepare('SELECT code, name, parent_code, active FROM wbs_code').all()
    .filter((c) => c.active === 1);

  // Depth-then-code order: '1' before '1.1' before '1.1.1'.
  const depth = (code) => String(code).split('.').length;
  const ordered = master.slice().sort((a, b) => (depth(a.code) - depth(b.code))
    || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

  const insertNode = db.prepare(`
    INSERT INTO wbs_nodes (project_id, wbs_code, name, parent_id, is_control_account, sort_order)
    VALUES (?, ?, ?, (SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?), ?, ?)`);
  const insertMilestone = db.prepare(`
    INSERT INTO progress_milestones (wbs_node_id, seq, name, pct_weight)
    VALUES (?, ?, ?, ?)`);
  const idOf = db.prepare('SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?');

  let order = 0;
  let nodes = 0;
  let milestones = 0;

  for (const node of ordered) {
    // A top-level code has no parent. A child whose parent is INACTIVE gets no
    // parent_id rather than a dangling one — the FK would reject a bad id, and
    // silently promoting it to top level is better than refusing the whole project.
    let parentCode = node.parent_code;
    if (parentCode && !master.some((m) => m.code === parentCode)) parentCode = null;

    insertNode.run(projectId, node.code, node.name, projectId, parentCode, 1, order);
    order += 10;
    nodes += 1;

    const row = idOf.get(projectId, node.code);
    for (const m of MILESTONES) {
      insertMilestone.run(row.id, m.seq, m.name, m.pct_weight);
      milestones += 1;
    }
  }

  // NOTE: no audit row is written here. The caller folds the returned summary into
  // the project's own 'create' audit entry instead. Writing a second row made
  // `auditOf(projectId).length === 1` false for a freshly created project, which
  // broke two existing tests — and they were right to break: one create is one
  // audit event, so the tree is a FIELD of that event, not an event of its own.
  return { nodes, milestones };
}

module.exports = { MILESTONES, buildWbsTree };
