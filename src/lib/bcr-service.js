// Baseline freeze + the BCR change-control workflow (module 7, plan part 7.6;
// PRD §4.2 step 4, §4.4 lines 195–214).
//
// WHY THIS FILE EXISTS
//
// Part 7.5 built ONE mutation path for a baseline (`applyBaselineChange`). This part is
// the workflow that decides WHEN it may be used, and by whom. It is deliberately thin:
// it polices people and states, and hands the arithmetic to 7.5 exactly once, at
// approval. Nothing here writes `cbs_plan` itself — a second writer is how the two
// readers of the baseline (the view and the reconciliation) would start disagreeing.
//
// THREE RULES THAT COME STRAIGHT FROM THE PRD, AND NONE ARE OBVIOUS FROM THE SCHEMA:
//
//   1. **An Administrator does NOT approve baselines** (§4.2 step 4, restated at line
//      280). Everywhere else in this app an Administrator passes every `has(...)` check
//      BY DESIGN, so the obvious implementation (`canApproveBaseline = has('project_manager')`)
//      silently grants it. The capability is `hasExact` (7.4) and the same test is
//      repeated here at the SERVICE, because a route guard is one line that a later
//      refactor can drop while the data keeps changing.
//   2. **The initiator cannot approve their own BCR** (separation of duties; the
//      `self_approved` pattern in approvals-service.js is the precedent). Kept a HARD
//      refusal, unlike a register record: a BCR is an external change to an approved
//      contract position, and there is no "typed reason" escape from that.
//   3. **A change is prospective** (§4.4, line 211, EIA-748 G-30). Enforced by 7.5, but
//      the workflow refuses to even RECORD a request with no effective month — a BCR
//      without one cannot be applied prospectively, and defaulting it to "now" would
//      silently rewrite whichever month it landed in.
//
// THE CHECK CONSTRAINTS ARE NOT ENOUGH. `bcr_register.status` constrains the VALUES, not
// the TRANSITIONS: nothing stops `approved -> draft`, so the service polices the moves.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const { rolesOf, capabilities } = require('../lib/permissions');
const base = require('./baseline-service');
const wbs = require('./wbs-service');

class BcrError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BcrError';
    this.status = status;
  }
}

const CHANGE_TYPES = ['add_scope', 'de_scope', 'modify', 'budget_only'];
const TYPE_LABEL = {
  add_scope: 'Add scope (not in the contract)',
  de_scope: 'De-scope (remove work)',
  modify: 'Modify existing scope',
  budget_only: 'Budget only (same scope)',
};

// The legal moves. An empty list is a terminal state — which is what makes "an approved
// BCR cannot be re-approved or reopened" a rule rather than a hope.
const ALLOWED = {
  draft:    ['verified', 'approved', 'rejected', 'withdrawn'],
  verified: ['approved', 'rejected', 'withdrawn'],
  approved: [],
  rejected: [],
  withdrawn: [],
};

// Who may READ the register. Everyone signed in: the register is the audit trail, and a
// change to an approved position is exactly the sort of thing a Viewer must be able to
// see. It is the writing that is restricted.
const VIEWER_ONLY = new Set(['viewer', 'human_capital']);

const isViewerOnly = (roles) => roles.length > 0 && roles.every((r) => VIEWER_ONLY.has(r));

const month = (m) => {
  const s = String(m || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new BcrError(`"${s || '(blank)'}" is not a month. Use YYYY-MM, e.g. 2026-07.`, 400);
  }
  return s;
};

const amountOf = (v, what = 'The cost impact') => {
  const n = Number(v === '' || v === null || v === undefined ? 0 : v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BcrError(`${what} must be a whole number of rupiah.`, 400);
  }
  return n;
};

const line = (projectId, id) => {
  const n = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(id, projectId);
  if (!n) throw new BcrError('That work line does not exist in this project.', 404);
  return n;
};

// --- reads -------------------------------------------------------------------

const byId = (projectId, id) =>
  db.prepare('SELECT * FROM bcr_register WHERE id = ? AND project_id = ?').get(id, projectId);

const listFor = (projectId) => db.prepare(`SELECT b.*, u.full_name AS initiated_by_name,
    v.full_name AS verified_by_name, a.full_name AS approved_by_name, n.wbs_code, n.name AS wbs_name
  FROM bcr_register b
  LEFT JOIN users u ON u.id = b.initiated_by
  LEFT JOIN users v ON v.id = b.verified_by
  LEFT JOIN users a ON a.id = b.approved_by
  LEFT JOIN wbs_nodes n ON n.id = b.wbs_node_id
  WHERE b.project_id = ?
  ORDER BY b.id DESC`).all(projectId);

// PRD §4.4 line 200 / §7: "in-app alert if a BCR is pending > 3 days". The counting is
// here so the sidebar badge and the register cannot disagree about what "pending" is.
const pendingFor = (projectId) => db.prepare(`SELECT COUNT(*) AS n FROM bcr_register
  WHERE project_id = ? AND status IN ('draft','verified')`).get(projectId).n;

// PRD §4.4 line 200: pending longer than three days. Returns the register rows so the
// screen can mark them rather than only counting.
const staleFor = (projectId) => db.prepare(`SELECT * FROM bcr_register
  WHERE project_id = ? AND status IN ('draft','verified')
    AND julianday('now') - julianday(initiated_at) > 3
  ORDER BY initiated_at`).all(projectId);

// --- the freeze --------------------------------------------------------------

// Lock the baseline: from here on it may ONLY change through an approved BCR.
//
// The PRD calls this a one-time lock (§7 Q4). Freezing twice is refused rather than
// silently re-stamped, because `baseline_locked_by` is the record of who accepted the
// baseline — re-writing it would erase the person who actually did.
function freezeBaseline({ projectId, actorId, caps }) {
  if (!caps || caps.canApproveBaseline !== true) {
    throw new BcrError(
      'Approving a baseline is the Project Manager\u2019s decision. An Administrator does not '
      + 'approve baselines (PRD §4.2 step 4) — the baseline is the commitment the PM is '
      + 'accountable for.', 403);
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new BcrError('That project does not exist.', 404);
  if (project.baseline_locked === 1) {
    throw new BcrError(
      `${project.code} already has a frozen baseline, frozen `
      + `${project.baseline_locked_at ? `on ${project.baseline_locked_at}` : 'earlier'}. Raise a `
      + 'change request to change it.', 409);
  }

  // A lock over nothing is not a lock. Checking here means "frozen" always means there
  // is a budget behind it, so a later reader can trust the flag.
  const has = db.prepare(`SELECT COUNT(*) AS n FROM cbs_plan c
    WHERE c.project_id = ? AND c.plan_type = 'baseline' AND c.amount > 0
      AND c.version = (SELECT MAX(c2.version) FROM cbs_plan c2
        WHERE c2.project_id = c.project_id
          AND c2.transaction_account_id = c.transaction_account_id
          AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
          AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`)
    .get(projectId).n;
  if (has === 0) {
    throw new BcrError(
      'There is no budget to freeze yet. Spread the cost baseline first (Budget in the '
      + 'sidebar), then freeze it — a freeze over an empty baseline would lock nothing.', 400);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE projects SET baseline_locked = 1, baseline_locked_at = datetime('now'),
        baseline_locked_by = ? WHERE id = ?`).run(actorId, projectId);
    q.audit('projects', projectId, 'freeze_baseline', actorId,
      { baseline_locked: 0 }, { baseline_locked: 1, buckets: has });
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  });

  return run();
}

// --- the workflow ------------------------------------------------------------

// PRD §4.4 step 1: "Project/Cost Controller initiates BCR (what, why, $/period impact,
// schedule impact)."
function initiateBcr({ projectId, actorId, caps, changeType, wbsNodeId = null, title,
                       description = null, reason = null, impactCost = 0,
                       impactScheduleDays = null, effectivePeriod, proposedRows = [],
                       rbsRows = [] }) {
  if (!caps || caps.canInitiateBcr !== true) {
    throw new BcrError('Raising a change request is a Project Controller, Cost Controller or '
      + 'Project Manager task. A Viewer can read the register but not write to it.', 403);
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new BcrError('That project does not exist.', 404);

  // There must BE a frozen baseline to change. Before the freeze the baseline is still
  // being built and is edited directly — routing that through a change request would
  // mean asking permission to finish the plan.
  if (project.baseline_locked !== 1) {
    throw new BcrError(
      `${project.code} does not have a frozen baseline yet, so there is nothing to change. `
      + 'Finish the cost baseline and freeze it first.', 409);
  }

  const type = String(changeType || '').trim();
  if (!CHANGE_TYPES.includes(type)) {
    throw new BcrError(`"${type || '(blank)'}" is not a kind of change. Choose one of: `
      + `${CHANGE_TYPES.map((t) => TYPE_LABEL[t]).join(', ')}.`, 400);
  }

  const t = String(title || '').trim();
  if (!t) throw new BcrError('A change request needs a title — it is what the register shows.', 400);

  // The prospective rule starts here. A request with no effective month cannot be
  // applied forward-only, and assuming "now" would rewrite whichever month the
  // assumption landed in.
  const from = month(effectivePeriod);
  if (!String(reason || '').trim()) {
    throw new BcrError('A change request needs a reason. It is what explains the movement '
      + 'later, when the numbers have changed and nobody remembers why.', 400);
  }
  if (String(reason).trim().length > 1000) {
    throw new BcrError('That reason is too long — keep it under 1000 characters.', 400);
  }
  if (description && String(description).length > 2000) {
    throw new BcrError('That description is too long — keep it under 2000 characters.', 400);
  }

  const scoped = type === 'de_scope' || type === 'modify' || type === 'add_scope';
  let nodeId = null;
  if (wbsNodeId !== null && wbsNodeId !== undefined && wbsNodeId !== '') {
    nodeId = Number(wbsNodeId);
    line(projectId, nodeId);            // must be this project's line (BOLA)
  } else if (scoped) {
    throw new BcrError('A scope change has to name the work line it changes.', 400);
  }

  const cost = amountOf(impactCost, 'The cost impact');
  const days = (impactScheduleDays === null || impactScheduleDays === undefined
    || impactScheduleDays === '') ? null : Number(impactScheduleDays);
  if (days !== null && !Number.isInteger(days)) {
    throw new BcrError('The schedule impact must be a whole number of days.', 400);
  }

  // Validate the proposal the same way 7.5 will, but WITHOUT writing anything. Catching
  // it here means the request cannot be raised in a state that could never be approved.
  const proposed = normaliseProposal(projectId, from, proposedRows);
  const resource = normaliseResourceRows(projectId, rbsRows);

  // The same rule 7.5 enforces at approval, said early and in the same words: a change
  // that moves money has to state the plan that supports it, or the budget would be
  // adjusted against a resource plan still showing the old figure.
  //
  // A DE-SCOPE IS EXEMPT, and deliberately. Its proposals are DERIVED at approval from the
  // baseline itself (what remains once the line is taken out), so there is nothing for the
  // operator to state and nothing for Finance to check on this screen beyond the line, the
  // month and the reason. Requiring rows here would mean typing figures that 7.7 then
  // discards — and a figure typed into a form and quietly ignored is worse than no form
  // field at all. Part 7.7 writes the real impact back onto this row when it applies it, so
  // the register still ends up with the movement on it.
  if (type !== 'de_scope' && cost !== 0 && resource.length === 0) {
    throw new BcrError(
      'A change that moves money has to state the resource plan that supports it. Every '
      + 'budget bucket must be backed by rate x quantity, so the two move together. Either '
      + 'add the resource rows, or record a cost impact of 0 for a re-phasing.', 400);
  }

  const run = db.transaction(() => {
    const seq = db.prepare('SELECT COUNT(*) AS n FROM bcr_register WHERE project_id = ?')
      .get(projectId).n + 1;
    const info = db.prepare(`INSERT INTO bcr_register (bcr_no, project_id, change_type,
        wbs_node_id, title, description, reason, impact_cost, impact_schedule_days,
        effective_period, status, initiated_by, new_baseline_json, rbs_rows_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(`BCR-${String(seq).padStart(4, '0')}`, projectId, type, nodeId, t,
        description ? String(description).trim() : null, String(reason).trim(),
        cost, days, from, actorId,
        proposed.length ? JSON.stringify(proposed) : null,
        resource.length ? JSON.stringify(resource) : null);

    q.audit('bcr_register', info.lastInsertRowid, 'create', actorId, null,
      { change_type: type, effective_period: from, impact_cost: cost, rows: proposed.length,
        rbs_rows: resource.length });
    return byId(projectId, info.lastInsertRowid);
  });

  return run();
}

// Rows for the proposed baseline. Validation shared with initiate/verify so a request
// cannot be raised with figures that 7.5 would later refuse.
function normaliseProposal(projectId, from, rows) {
  if (!rows || !rows.length) return [];
  return base.validateProposalRows(projectId, from, rows);
}

function normaliseResourceRows(projectId, rows) {
  if (!rows || !rows.length) return [];
  return rows.map((r) => {
    const nodeId = Number(r.wbs_node_id);
    line(projectId, nodeId);
    const code = String(r.rbs_code || '').trim();
    if (!code) throw new BcrError('A resource-plan row needs a resource code.', 400);
    const rate = Number(r.rate);
    const units = Number(r.units);
    if (!Number.isFinite(rate) || rate < 0) throw new BcrError('A resource rate cannot be negative.', 400);
    if (!Number.isFinite(units) || units < 0) throw new BcrError('Resource units cannot be negative.', 400);
    return {
      wbs_node_id: nodeId,
      rbs_code: code,
      transaction_account_id: r.transaction_account_id == null || r.transaction_account_id === ''
        ? null : Number(r.transaction_account_id),
      rate, units,
      unit_label: r.unit_label ? String(r.unit_label).slice(0, 24) : null,
      description: r.description ? String(r.description).slice(0, 200) : null,
    };
  });
}

// Load a request and check it may move to `to`. Returns the row.
function loadForMove(projectId, bcrId, to) {
  const bcr = byId(projectId, bcrId);
  if (!bcr) throw new BcrError('That change request does not exist in this project.', 404);
  const allowed = ALLOWED[bcr.status] || [];
  if (!allowed.includes(to)) {
    throw new BcrError(
      `This request is ${bcr.status} and cannot be ${to}. ${allowed.length
        ? `From ${bcr.status} it can only be: ${allowed.join(', ')}.`
        : `A ${bcr.status} request is closed — raise a new one instead of reopening it.`}`, 409);
  }
  return bcr;
}

// PRD §4.4 step 2: "Finance verifies (money/period logic)."
function verifyBcr({ projectId, bcrId, actorId, caps, note = null }) {
  const bcr = loadForMove(projectId, bcrId, 'verified');
  // `rolesOf` takes an ID, not a user row (permissions.js line 20).
  const roles = rolesOf(actorId);

  // Same shape as the approval rule and for the same reason: a request is a proposal to
  // change an approved position, so whoever wrote it must not be the one who checks it.
  if (bcr.initiated_by === actorId) {
    throw new BcrError(
      'Separation of duties: you raised this request, so you cannot verify it. Verification '
      + 'is a second pair of eyes on the money and period logic.', 403);
  }
  if (isViewerOnly(roles)) {
    throw new BcrError('Verifying a change request is a Finance, Cost Controller, Project '
      + 'Controller or Project Manager task.', 403);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE bcr_register SET status = 'verified', verified_by = ?,
        decision_note = COALESCE(?, decision_note) WHERE id = ? AND project_id = ?`)
      .run(actorId, note ? String(note).slice(0, 500) : null, bcrId, projectId);
    q.audit('bcr_register', bcrId, 'verify', actorId, { status: bcr.status }, { status: 'verified' });
    return byId(projectId, bcrId);
  });

  return run();
}

// PRD §4.4 step 3+4: "PM approves (accepts scope/schedule consequence)" and "On approval
// -> baseline re-baselines (old numbers archived, new become PV)."
//
// THE ONE PLACE THE BASELINE MOVES. Everything above decides whether it may.
function approveBcr({ projectId, bcrId, actorId, caps, note = null }) {
  const bcr = loadForMove(projectId, bcrId, 'approved');

  // The SoD trap of this module, at the layer that matters. An Administrator holds no
  // `project_manager` role, so `canApproveBaseline` is false for them and this refuses —
  // exactly the PRD's "Admin does NOT approve baselines".
  if (!caps || caps.canApproveBaseline !== true) {
    throw new BcrError(
      'Approving a baseline change is the Project Manager\u2019s decision. The person who '
      + 'accepts the scope and schedule consequence has to be the PM, and an Administrator '
      + 'does not approve baselines (PRD §4.2 step 4).', 403);
  }
  if (bcr.initiated_by === actorId) {
    throw new BcrError(
      'Separation of duties: you raised this change request, so you cannot approve it. That '
      + 'would make one person both the author and the approver of a change to an approved '
      + 'contract position.', 403);
  }

  const from = month(bcr.effective_period);
  const proposed = bcr.new_baseline_json ? JSON.parse(bcr.new_baseline_json) : [];
  const resource = bcr.rbs_rows_json ? JSON.parse(bcr.rbs_rows_json) : [];
  const isDeScope = bcr.change_type === 'de_scope';

  // A de-scope derives its own figures from the baseline, so proposed rows on the request
  // would be a second, competing statement of what should happen. Refused rather than
  // silently ignored: which of the two won would depend on the order of two statements in
  // this function, and that is not something an operator could reason about.
  if (isDeScope && proposed.length) {
    throw new BcrError(
      `${bcr.bcr_no} is a de-scope, and a de-scope works out what remains from the baseline `
      + 'itself — it does not take proposed months. Withdraw it and raise it as the kind of '
      + 'change you actually mean.', 400);
  }
  if (isDeScope && bcr.wbs_node_id === null) {
    throw new BcrError(
      'A de-scope takes a specific line out of scope, and this request names none, so there is '
      + 'no way to know what to remove. Reject it and raise it again naming the work line.', 400);
  }

  // A money-moving request with no proposal would re-baseline nothing while claiming a
  // cost impact — the register would say the contract moved and the budget would not.
  if (!isDeScope && bcr.impact_cost !== 0 && proposed.length === 0) {
    throw new BcrError(
      `This request records a cost impact of ${Number(bcr.impact_cost).toLocaleString('en-US')} `
      + 'but states no new baseline rows, so approving it would move nothing. Add the proposed '
      + 'months first.', 400);
  }

  const run = db.transaction(() => {
    // 7.5 does the arithmetic and the archiving, in its own transaction, so approval
    // cannot leave a half-moved baseline behind. `bcrId` tells it to archive what was
    // there into this request.
    let applied = null;
    let deScoped = null;

    // THE DECISION IS RECORDED FIRST, then applied.
    //
    // The order is what lets a de-scope use the SAME gate as every other caller: `deScope`
    // re-reads the register and insists the request is approved, so if the stamp came after,
    // approval would have to bypass its own rule. Both statements are in this one
    // transaction, so "approved" and "applied" can never be observed apart — a reader either
    // sees the request still pending with the baseline untouched, or approved and moved.
    db.prepare(`UPDATE bcr_register SET status = 'approved', approved_by = ?,
        decided_at = datetime('now'), decision_note = COALESCE(?, decision_note)
        WHERE id = ? AND project_id = ?`)
      .run(actorId, note ? String(note).slice(0, 500) : null, bcrId, projectId);

    // A DE-SCOPE GOES THROUGH 7.5 LIKE EVERYTHING ELSE, but as its own branch.
    //
    // `deScope` works out and applies the remaining baseline itself, so running the generic
    // change below as well would move the money twice. It runs after the stamp above because
    // it enforces "approved" on itself — the same gate any other caller gets, not a bypass.
    // If it refuses, this whole transaction rolls back and the request is not approved either.
    if (isDeScope) {
      deScoped = wbs.deScope({
        projectId, actorId, nodeId: Number(bcr.wbs_node_id), period: from, bcrId,
        reason: bcr.reason,
      });
      // Write the movement back onto the register. It was 0 at raise (7.7 derives the figure,
      // so there is nothing for the operator to state), and a register that recorded a
      // de-scope as a 0 movement would understate every downstream report.
      db.prepare('UPDATE bcr_register SET impact_cost = ? WHERE id = ? AND project_id = ?')
        .run(-deScoped.budgetRemoved, bcrId, projectId);
    } else if (proposed.length) {
      applied = base.applyBaselineChange({
        projectId,
        effectivePeriod: from,
        rows: proposed,
        actorId,
        reason: bcr.reason || `BCR ${bcr.bcr_no}`,
        bcrId: bcr.id,
        impactCost: bcr.impact_cost,
        rbsRows: resource.length ? resource : null,
      });
    }

    q.audit('bcr_register', bcrId, 'approve', actorId, { status: bcr.status },
      { status: 'approved', effective_period: from, applied,
        de_scoped: deScoped ? { line: deScoped.node.wbs_code, budget_removed: deScoped.budgetRemoved } : null });

    // The caller reports on what happened, so the outcome is flattened here: a route (or a
    // test) should not have to know the row shape to say "BCR-0003 approved from 2026-08".
    const row = byId(projectId, bcrId);
    return { bcr_no: row.bcr_no, effective_period: from, status: row.status,
      applied, deScoped, bcr: row };
  });

  return run();
}

// A refusal is a DECISION, so it is recorded with who and why — but it must change
// nothing else. The strongest negative in the module: no baseline row may move.
function rejectBcr({ projectId, bcrId, actorId, caps, note = null }) {
  const bcr = loadForMove(projectId, bcrId, 'rejected');
  if (!String(note || '').trim()) {
    throw new BcrError('Say why the request is being rejected — the register keeps it, and '
      + 'the person who raised it sees it.', 400);
  }
  if (bcr.initiated_by === actorId && !caps?.canApproveBaseline) {
    // Whoever raised it may withdraw it (below), but not reject it: a rejection is a
    // decision on the request, and deciding on your own request is the thing SoD stops.
    throw new BcrError('Use withdraw to take back a request you raised yourself.', 409);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE bcr_register SET status = 'rejected', decided_at = datetime('now'),
        approved_by = ?, decision_note = ? WHERE id = ? AND project_id = ?`)
      .run(actorId, String(note).trim().slice(0, 500), bcrId, projectId);
    q.audit('bcr_register', bcrId, 'reject', actorId, { status: bcr.status },
      { status: 'rejected', note: String(note).trim().slice(0, 500) });
    return byId(projectId, bcrId);
  });

  return run();
}

// Withdrawing is the initiator's own act — the one move they may make on their own
// request, because it changes nothing and only closes their own proposal.
function withdrawBcr({ projectId, bcrId, actorId, note = null }) {
  const bcr = loadForMove(projectId, bcrId, 'withdrawn');
  if (bcr.initiated_by !== actorId) {
    throw new BcrError('Only the person who raised a request can withdraw it.', 403);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE bcr_register SET status = 'withdrawn', decided_at = datetime('now'),
        decision_note = COALESCE(?, decision_note) WHERE id = ? AND project_id = ?`)
      .run(note ? String(note).trim().slice(0, 500) : null, bcrId, projectId);
    q.audit('bcr_register', bcrId, 'withdraw', actorId, { status: bcr.status }, { status: 'withdrawn' });
    return byId(projectId, bcrId);
  });

  return run();
}

module.exports = {
  BcrError, CHANGE_TYPES, TYPE_LABEL, ALLOWED,
  freezeBaseline, initiateBcr, verifyBcr, approveBcr, rejectBcr, withdrawBcr,
  byId, listFor, pendingFor, staleFor,
};
