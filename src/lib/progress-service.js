// Progress from milestone ticks (module 7, plan part 7.2; PRD §5.1).
//
// WHAT THIS FILE IS FOR
//
// Ticking milestones is how a Project Controller says "this much of the line is
// done". The number that comes out feeds `ev` in `v_evm_period`, so getting the
// semantics wrong makes every SPI and CPI figure wrong while looking healthy.
//
// THE SEMANTICS ARE DICTATED BY THE VIEW — AND THEY ARE "PER PERIOD", NOT "TO DATE"
//
// `v_evm_period` computes earned value like this:
//
//     SUM(ba * wp.pct_complete / 100.0)   grouped by (project, period_month)
//
// It sums ONLY the rows of the period it is reporting. It never accumulates
// earlier periods. So for the view's arithmetic to mean anything:
//
//   * `pct_complete` is the percentage earned IN THAT PERIOD.
//   * PV comes from `cbs_plan` buckets, which are also per-month (their SUM is
//     the account total).
//   * AC comes from `v_cbs_actual`, per-month.
//
// All three are therefore period amounts, SPI = EV/PV compares like with like, and
// summing the periods gives the project totals. If `pct_complete` were cumulative
// instead, EV would be "earned to date" while PV and AC stayed monthly, and every
// SPI would be inflated by construction — a wrong number that looks like a number.
//
// A MILESTONE IS TICKED ONCE, SO A TICK MUST BE CONVERTED TO A PERIOD INCREMENT
//
// Milestones have no period of their own: `ticked` is 0 or 1, forever. But progress
// is reported per period. So the increment for period P is
//
//     (everything ticked as of P) - (everything already reported before P)
//
// where "already reported" is the SUM of the earlier rows' `pct_complete`, because
// those rows are increments and their sum is the cumulative figure. That is why
// this file can reconstruct the previous position without storing a second copy.
//
// Worked through, with the four equal 25% defaults:
//
//   tick 1 of 4 in 2026-06   → prior 0    → 25   (MP7.6)
//   tick 2 of 4 in 2026-06   → prior 0    → 50   (MP7.7, same period: updated)
//   tick 3 of 4 in 2026-07   → prior 50   → 25   (MP7.7, later period: new row)
//   nothing ticked           → prior 0    → 0    (a row saying "nothing done")
//
// The last line matters: a MISSING row and a ZERO row are different facts —
// "nobody has reported" versus "reported as nothing done". They are easy to
// confuse and impossible to tell apart afterwards, so the zero row is written.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');

// PRD §5.1 / decision 4A: a weight set may total LESS than 100 (a line then tops
// out below 100% — the honest report), but never MORE, because that would make
// "% complete" exceed 100 and `wbs_progress.pct_complete` is CHECKed to 0..100.
const MAX_WEIGHT_TOTAL = 100;

class ProgressError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProgressError';
    this.status = status;
  }
}

// The percentage of a line implied by its milestone set. Pure, so the arithmetic
// is testable without a database — and the arithmetic is the point.
function pctFromMilestones(rows) {
  const total = (rows || []).reduce(
    (sum, m) => sum + (m.ticked ? Number(m.pct_weight) || 0 : 0), 0);
  // The clamp is not cosmetic: `wbs_progress.pct_complete` has
  // CHECK (BETWEEN 0 AND 100), so an over-100 weight set would otherwise surface
  // as a database error at write time instead of a correct number here.
  return Math.min(100, Math.round(total * 100) / 100);
}

const weightTotal = (weights) =>
  Math.round(weights.reduce((s, w) => s + (Number(w) || 0), 0) * 100) / 100;

// Refuse a set that could exceed 100. Called BEFORE anything is written, and
// shared by the setter and the defaults builder so the rule lives once.
function assertWeightsUsable(weights) {
  for (const w of weights) {
    const n = Number(w);
    if (!Number.isFinite(n)) throw new ProgressError(`"${w}" is not a weight.`, 400);
    if (n < 0) throw new ProgressError('A milestone weight cannot be negative.', 400);
  }
  const total = weightTotal(weights);
  if (total > MAX_WEIGHT_TOTAL) {
    throw new ProgressError(
      `These weights total ${total}%, which is more than 100%. A line can never be more than `
      + '100% complete. Weights totalling LESS than 100% are allowed — the line simply tops '
      + 'out below 100%.', 400);
  }
  return total;
}

function loadNode(projectId, nodeId) {
  const n = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(nodeId, projectId);
  if (!n) throw new ProgressError('That WBS line does not exist in this project.', 404);
  if (n.superseded_by !== null) {
    throw new ProgressError(
      `That line was replaced by version ${n.version + 1}. Report progress on the current version.`, 403);
  }
  return n;
}

const validPeriod = (p) => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

const milestones = (nodeId) => db.prepare(
  'SELECT * FROM progress_milestones WHERE wbs_node_id = ? ORDER BY seq').all(nodeId);

// What has already been reported before period P. Rows are increments, so their
// sum is the cumulative figure at the end of the last period before P.
function reportedBefore(nodeId, period) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(pct_complete), 0) AS prior FROM wbs_progress
    WHERE wbs_node_id = ? AND period_month < ?`).get(nodeId, period);
  return row.prior;
}

// The increment to store for period P, given what is ticked right now.
function incrementFor(nodeId, period) {
  const cumNow = pctFromMilestones(milestones(nodeId));
  const prior = reportedBefore(nodeId, period);
  const inc = Math.round((cumNow - prior) * 100) / 100;
  // Never negative (unticking must not create negative progress) and never more
  // than the room left to 100 — the same ceiling the CHECK enforces, applied here
  // so the caller gets a number rather than an error.
  return Math.max(0, Math.min(100 - (prior >= 100 ? 100 : 0), inc));
}

function existingRow(nodeId, period) {
  return db.prepare(
    'SELECT * FROM wbs_progress WHERE wbs_node_id = ? AND period_month = ?').get(nodeId, period);
}

// Write the period's row. UNIQUE (wbs_node_id, period_month) means this is one row
// per line per period: a second report for the same period UPDATES it rather than
// adding one, which is what keeps the progress curve truthful (MP7.7).
function writePeriod({ projectId, actorId, nodeId, period, source = 'milestones' }) {
  if (!validPeriod(period)) {
    throw new ProgressError('A reporting period is required, as YYYY-MM.', 400);
  }
  loadNode(projectId, nodeId);

  const existing = existingRow(nodeId, period);
  if (existing && existing.frozen === 1) {
    // `frozen` is set by report generation (Module 8). Honoured here so the column
    // is not decorative: a frozen period is a published figure.
    throw new ProgressError(
      `Period ${period} is frozen and cannot be rewritten. Frozen figures are what was `
      + 'reported at the time.', 403);
  }

  const pct = incrementFor(nodeId, period);

  const run = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE wbs_progress
          SET pct_complete = ?, source = ?, reported_at = datetime('now'), reported_by = ?
          WHERE id = ?`).run(pct, source, actorId, existing.id);
      q.audit('wbs_progress', existing.id, 'update', actorId,
        { pct_complete: existing.pct_complete }, { pct_complete: pct, period_month: period });
      return existing.id;
    }
    const info = db.prepare(`INSERT INTO wbs_progress
        (wbs_node_id, period_month, pct_complete, source, reported_by)
        VALUES (?, ?, ?, ?, ?)`).run(nodeId, period, pct, source, actorId);
    q.audit('wbs_progress', info.lastInsertRowid, 'create', actorId, null,
      { wbs_node_id: nodeId, period_month: period, pct_complete: pct });
    return info.lastInsertRowid;
  });
  return { id: run(), pct_complete: pct, updated: !!existing };
}

// Tick or untick one milestone, then re-derive the period's figure.
function setMilestoneTick({ projectId, actorId, milestoneId, ticked, period, note }) {
  const m = db.prepare('SELECT * FROM progress_milestones WHERE id = ?').get(milestoneId);
  if (!m) throw new ProgressError('That milestone does not exist.', 404);
  loadNode(projectId, m.wbs_node_id);   // scopes the read to this project
  if (!validPeriod(period)) throw new ProgressError('A reporting period is required, as YYYY-MM.', 400);

  const existing = existingRow(m.wbs_node_id, period);
  if (existing && existing.frozen === 1) {
    throw new ProgressError(`Period ${period} is frozen and cannot be rewritten.`, 403);
  }

  const run = db.transaction(() => {
    db.prepare(`UPDATE progress_milestones
        SET ticked = ?, ticked_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
            ticked_by = CASE WHEN ? THEN ? ELSE NULL END, note = COALESCE(?, note)
        WHERE id = ?`).run(ticked ? 1 : 0, ticked ? 1 : 0, ticked ? 1 : 0, actorId, note ?? null, milestoneId);
    // The milestone table is in the audit trail; the DERIVED period figure is
    // written by writePeriod, so the two can never disagree.
    q.audit('progress_milestone', milestoneId, ticked ? 'tick' : 'untick', actorId,
      { ticked: m.ticked }, { ticked: ticked ? 1 : 0, period_month: period });
    return writePeriod({ projectId, actorId, nodeId: m.wbs_node_id, period });
  });
  return run();
}

// Replace a line's milestone weights. Kept here rather than in wbs-defaults.js so
// the >100 refusal and the tick arithmetic read the same rule.
function setMilestoneWeights({ projectId, actorId, nodeId, weights }) {
  loadNode(projectId, nodeId);
  const existing = milestones(nodeId);
  if (existing.length !== weights.length) {
    throw new ProgressError(
      `This line has ${existing.length} milestones; ${weights.length} weights were supplied.`, 400);
  }
  assertWeightsUsable(weights);
  const before = existing.map((m) => ({ seq: m.seq, pct_weight: m.pct_weight }));

  const run = db.transaction(() => {
    existing.forEach((m, i) => {
      db.prepare('UPDATE progress_milestones SET pct_weight = ? WHERE id = ?')
        .run(Number(weights[i]), m.id);
    });
    q.audit('wbs_node', nodeId, 'update', actorId,
      { milestone_weights: before },
      { milestone_weights: weights.map((w, i) => ({ seq: i + 1, pct_weight: Number(w) })) });
  });
  run();
}

const progressFor = (nodeId) => db.prepare(
  'SELECT * FROM wbs_progress WHERE wbs_node_id = ? ORDER BY period_month').all(nodeId);

module.exports = {
  ProgressError, MAX_WEIGHT_TOTAL,
  pctFromMilestones, assertWeightsUsable, weightTotal,
  milestones, progressFor, reportedBefore, incrementFor,
  writePeriod, setMilestoneTick, setMilestoneWeights,
};
