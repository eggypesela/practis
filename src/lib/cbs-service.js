// Cost baseline (module 7, plan part 7.4; PRD §5.1, §6).
//
// WHAT THIS FILE IS FOR
//
// The baseline is the approved plan expressed as MONEY PER MONTH. It is what
// `v_evm_period.pv` reads, so it is the denominator of every SPI in the product.
//
// THE ONE INVARIANT THE PRD NAMES (§6)
//
//   Σ monthly buckets = the account total = the RBS total
//
// Three statements of the same figure, and the PRD asks the APPLICATION to enforce
// that they agree — which means the check happens BEFORE the write, inside the
// transaction, so a bad spread never exists even momentarily.
//
// WHAT WAS ALSO NEEDED, AND WHY IT IS NOT IN HERE
//
// Two ways of writing two rows for one bucket were measured to double PV silently
// (3,000,000 -> 6,000,000): a superseded version, and an account-total row beside
// per-WBS rows. Both are now impossible — 014 makes the view read the current version
// only, 015 refuses an untagged baseline row — because BOTH are rules a service check
// cannot keep. A rule that lives only here dies at `db/seed-smoke.sql`, and this module
// exists to be the code path that writes those rows.
//
// What stays here is the aggregation rule, because it spans two tables and needs a
// message a person can act on, which is exactly what the PRD asks the app to do.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');

class CbsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CbsError';
    this.status = status;
  }
}

const MAX_AMOUNT = 1e15;   // beyond this it is a typo, not a budget

const month = (m) => {
  const s = String(m || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new CbsError(`"${s || '(blank)'}" is not a month. Use YYYY-MM, e.g. 2026-03.`, 400);
  }
  return s;
};
const monthIndex = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + (mo - 1);
};

function amountOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CbsError('A bucket amount must be a number.', 400);
  if (!Number.isInteger(n)) throw new CbsError('Bucket amounts are whole rupiah.', 400);
  if (n < 0) throw new CbsError('A bucket amount cannot be negative.', 400);
  if (n > MAX_AMOUNT) throw new CbsError('That amount is not plausible for a project.', 400);
  return n;
}

const line = (projectId, nodeId) => {
  const n = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(nodeId, projectId);
  if (!n) throw new CbsError('That WBS line does not exist in this project.', 404);
  if (n.superseded_by !== null) {
    throw new CbsError(`The budget must be spread against a live line; this is version ${n.version}.`, 403);
  }
  return n;
};

const accountOf = (id) => {
  const a = db.prepare('SELECT * FROM transaction_accounts WHERE id = ?').get(Number(id));
  if (!a) throw new CbsError('That cost account does not exist.', 400);
  return a;
};

// --- the invariant, asked per account --------------------------------------
//
// The account total is the sum of the line's RESOURCE PLAN for that account, because
// the resource plan is where a cost is built up from rate x quantity. A budget with no
// resource plan behind it has nothing to reconcile against, and the PRD treats the two
// as the same figure.
function resourceTotalFor(projectId, accountId) {
  const row = db.prepare(`SELECT COALESCE(SUM(r.total_amount), 0) AS s FROM rbs_load r
    WHERE r.project_id = ? AND r.transaction_account_id = ?
      AND r.version = (
        SELECT COALESCE(MAX(r2.version), 1) FROM rbs_load r2
        WHERE r2.project_id = r.project_id AND r2.wbs_node_id = r.wbs_node_id
          AND r2.rbs_code = r.rbs_code
          AND COALESCE(r2.transaction_account_id, 0) = COALESCE(r.transaction_account_id, 0))`)
    .get(projectId, accountId);
  return row.s;
}

// The CURRENT baseline version of every bucket, as a reusable predicate.
//
// This is not a nicety. `cbs_plan` keeps every version so an old figure stays readable,
// so a plan that counts rows rather than current versions reports money that has been
// replaced. Measured: after one legitimate re-spread the raw sum read 10,000,000 where
// the budget was 8,000,000 — and because that total fed the invariant check, the
// re-spread was ROLLED BACK and the stored baseline silently kept the old figures while
// the user saw "they must agree". Migration 014 fixed exactly this in the views; the
// same rule has to hold wherever the number is computed, including here.
const CURRENT = `c.version = (
  SELECT MAX(c2.version) FROM cbs_plan c2
  WHERE c2.project_id = c.project_id AND c2.transaction_account_id = c.transaction_account_id
    AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
    AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`;

// THE PRD INVARIANT (§6): Σ monthly buckets = the account total = the RBS total.
//
// Deliberately a SEPARATE, standalone function that re-reads the table and is called
// both before the write and again inside the transaction afterwards. A check that only
// looked at the caller's inputs would pass while the table said something else — and a
// post-condition that trusts its own inputs is not a post-condition.
function assertReconciles(projectId, accountId, from = null) {
  const buckets = db.prepare(`SELECT COALESCE(SUM(c.amount), 0) AS s FROM cbs_plan c
    WHERE c.project_id = ? AND c.transaction_account_id = ? AND c.plan_type = 'baseline'
      AND ${CURRENT} ${from ? 'AND c.period_month >= ?' : ''}`)
    .get(...(from ? [projectId, accountId, from] : [projectId, accountId]));
  const rbs = resourceTotalFor(projectId, accountId);
  if (buckets.s !== rbs) {
    const fmt = (n) => Number(n).toLocaleString('en-US');
    throw new CbsError(
      `The monthly buckets for that account add up to ${fmt(buckets.s)} but the resource `
      + `plan for it is ${fmt(rbs)}. They must agree before the budget can be saved.`, 400);
  }
  return { buckets: buckets.s, rbs };
}

// How much of the account may still be spread, once the months before `from` are set
// aside. Used to say "the rest of the account is worth X" instead of only refusing.
const remainingFor = (projectId, accountId, from) => {
  const outside = db.prepare(`SELECT COALESCE(SUM(c.amount), 0) AS s FROM cbs_plan c
    WHERE c.project_id = ? AND c.transaction_account_id = ? AND c.plan_type = 'baseline'
      AND ${CURRENT} AND c.period_month < ?`).get(projectId, accountId, from).s;
  return resourceTotalFor(projectId, accountId) - outside;
};

// --- the write path ---------------------------------------------------------

// Spread an account's budget across months.
//
// `months` is a list of { period_month, amount }. Validated and summed BEFORE anything
// is written, so an unbalanced spread is refused rather than stored and corrected.
function spreadBaseline({ projectId, accountId, wbsNodeId = null, months, actorId,
                          note = null, isManualOverride = 0 }) {
  const acct = accountOf(accountId);
  if (!Array.isArray(months) || months.length === 0) {
    throw new CbsError('Give at least one month to spread the budget over.', 400);
  }

  const rows = months.map((m) => ({
    period_month: month(m.period_month),
    amount: amountOf(m.amount),
  }));
  const dupes = rows.map((r) => r.period_month).filter((m, i, a) => a.indexOf(m) !== i);
  if (dupes.length) throw new CbsError(`Month ${dupes[0]} is listed twice. Give one figure per month.`, 400);

  // A budget line must hang off a work line — the same rule 015 enforces in the
  // database, checked here first so the user gets this message instead of a trigger.
  if (wbsNodeId === null || wbsNodeId === undefined || wbsNodeId === '') {
    throw new CbsError(
      'A budget must be spread against a work line. The account total is worked out '
      + 'from the buckets, never stored as its own row.', 400);
  }
  line(projectId, Number(wbsNodeId));

  const firstMonth = rows.map((r) => r.period_month).sort()[0];
  const sum = rows.reduce((s, r) => s + r.amount, 0);

  // THE PRD INVARIANT (§6), checked BEFORE anything is written: the buckets from
  // `firstMonth` onward must add up to EXACTLY the account's resource plan for those
  // months. Not "no more than" — equal. An under-spread budget is the same defect as an
  // over-spread one: `ev` would be able to earn against budget that PV never planned,
  // and every SPI would read too high.
  //
  // A consequence worth stating: the whole spread goes in at once. Months cannot be
  // added in a second submission, because after the first the account would no longer
  // reconcile — the second call would have nothing left to spend.
  const allowed = remainingFor(projectId, acct.id, firstMonth);
  if (sum !== allowed) {
    const fmt = (n) => Number(n).toLocaleString('en-US');
    throw new CbsError(
      sum > allowed
        ? `Those buckets add up to ${fmt(sum)}, but the resource plan for ${acct.code} ${acct.name} `
          + `has only ${fmt(allowed)} from ${firstMonth} onwards. They must be the same figure.`
        : `Those buckets add up to ${fmt(sum)}, but ${fmt(allowed)} is planned for ${acct.code} `
          + `${acct.name} from ${firstMonth} onwards. Every month of the plan has to be covered, `
          + `or the budget is short. Nothing was saved.`, 400);
  }

  const run = db.transaction(() => {
    // A re-spread supersedes rather than overwrites: the previous figure stays readable
    // at its own version (the view reads the current one — migration 014).
    const nextVersion = (bucket) => db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM cbs_plan
      WHERE project_id = ? AND transaction_account_id = ? AND COALESCE(wbs_node_id, 0) = COALESCE(?, 0)
        AND plan_type = 'baseline' AND period_month = ?`)
      .get(projectId, acct.id, wbsNodeId === null ? null : Number(wbsNodeId), bucket).v + 1;

    const written = [];
    for (const r of rows) {
      const v = nextVersion(r.period_month);
      const info = db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id,
          plan_type, version, period_month, amount, is_manual_override, note, created_by)
          VALUES (?, ?, ?, 'baseline', ?, ?, ?, ?, ?, ?)`)
        .run(projectId, acct.id, Number(wbsNodeId), v, r.period_month, r.amount,
          isManualOverride ? 1 : 0, note, actorId);
      q.audit('cbs_plan', info.lastInsertRowid, 'create', actorId, null, {
        transaction_account_id: acct.id, wbs_node_id: Number(wbsNodeId),
        period_month: r.period_month, amount: r.amount, version: v, plan_type: 'baseline',
      });
      written.push({ ...r, version: v });
    }

    // POST-CONDITION, re-read from the table. This is what catches a bad write, and it
    // is why the check is not merely the caller's sum again.
    assertReconciles(projectId, acct.id);
    return written;
  });

  return { rows: run(), account: acct };
}

// Straight-line spread of an amount across the working months of a WBS line.
//
// The PRD allows "direct entry OR auto-spread (straight-line over WBS duration, or
// milestone-weighted)". Milestone-weighted is NOT implemented: it must be refused with
// a message rather than quietly straight-lined, because a weighted spread produces
// different monthly figures (front-loaded or back-loaded) and silently substituting one
// for the other would make the PV curve wrong in a way the user never asked for.
function autoSpread({ projectId, nodeId, amount, method = 'straight' }) {
  if (method !== 'straight') {
    if (method === 'milestone') {
      throw new CbsError(
        'Spreading by milestone weight is not built yet. Use the straight-line spread, '
        + 'or enter each month yourself.', 400);
    }
    throw new CbsError(`"${method}" is not a spread method. Straight-line is the only one available.`, 400);
  }

  const n = line(projectId, Number(nodeId));
  const total = amountOf(amount);

  if (!n.start_date || !n.end_date) {
    throw new CbsError(
      `"${n.wbs_code} ${n.name}" has no start and end date, so there is nothing to spread `
      + 'over. Set the line\'s dates (or enter the months yourself).', 400);
  }
  if (n.end_date < n.start_date) {
    throw new CbsError(`"${n.wbs_code}" ends before it starts, so it cannot be spread.`, 400);
  }

  const first = month(n.start_date.slice(0, 7));
  const last = month(n.end_date.slice(0, 7));
  const count = monthIndex(last) - monthIndex(first) + 1;

  // Whole rupiah with no lost cents: hand out the remainder to the EARLIEST months, so
  // the total is exact and the drift is confined to the front of the curve.
  const base = Math.floor(total / count);
  const odd = total - base * count;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const [y, mo] = [Math.floor((monthIndex(first) + i) / 12), ((monthIndex(first) + i) % 12) + 1];
    rows.push({
      period_month: `${y}-${String(mo).padStart(2, '0')}`,
      amount: base + (i < odd ? 1 : 0),
    });
  }
  return { months: rows, total, line: n, count };
}

// --- read side --------------------------------------------------------------

// An account's baseline buckets, oldest month first, with the line they hang off.
const buckets = (projectId, { accountId = null, from = null } = {}) => {
  const where = ['c.project_id = ?', "c.plan_type = 'baseline'", `c.version = (
    SELECT MAX(c2.version) FROM cbs_plan c2
    WHERE c2.project_id = c.project_id AND c2.transaction_account_id = c.transaction_account_id
      AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
      AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`];
  const args = [projectId];
  if (accountId) { where.push('c.transaction_account_id = ?'); args.push(Number(accountId)); }
  if (from) { where.push('c.period_month >= ?'); args.push(from); }

  return db.prepare(`SELECT c.*, ta.code AS account_code, ta.name AS account_name,
      n.wbs_code, n.name AS wbs_name
    FROM cbs_plan c
    JOIN transaction_accounts ta ON ta.id = c.transaction_account_id
    LEFT JOIN wbs_nodes n ON n.id = c.wbs_node_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.period_month, ta.code`).all(...args);
};

// Per-account reconciliation, for the screen: what the resource plan says against what
// has been spread. Every account with a resource plan appears, even with no buckets, so
// an unspread account is visible rather than absent.
const reconciliation = (projectId) => db.prepare(`
  WITH rbs AS (
    SELECT r.transaction_account_id AS account_id, SUM(r.total_amount) AS rbs_total
    FROM rbs_load r
    WHERE r.project_id = ?
      AND r.version = (
        SELECT COALESCE(MAX(r2.version), 1) FROM rbs_load r2
        WHERE r2.project_id = r.project_id AND r2.wbs_node_id = r.wbs_node_id
          AND r2.rbs_code = r.rbs_code
          AND COALESCE(r2.transaction_account_id, 0) = COALESCE(r.transaction_account_id, 0))
    GROUP BY r.transaction_account_id
  ), cur AS (
    SELECT c.* FROM cbs_plan c
    WHERE c.project_id = ? AND c.plan_type = 'baseline'
      AND c.version = (
        SELECT MAX(c2.version) FROM cbs_plan c2
        WHERE c2.project_id = c.project_id AND c2.transaction_account_id = c.transaction_account_id
          AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
          AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)
  ), bud AS (
    SELECT transaction_account_id AS account_id, SUM(amount) AS budget
    FROM cur WHERE transaction_account_id IS NOT NULL GROUP BY transaction_account_id
  )
  SELECT ta.id AS account_id, ta.code, ta.name,
         COALESCE(rbs.rbs_total, 0) AS rbs_total,
         COALESCE(bud.budget, 0)    AS budget
  FROM transaction_accounts ta
  LEFT JOIN rbs rbs ON rbs.account_id = ta.id
  LEFT JOIN bud      ON bud.account_id = ta.id
  WHERE rbs.rbs_total IS NOT NULL OR bud.budget IS NOT NULL
  ORDER BY ta.code`).all(projectId, projectId);

// The whole project's baseline: what PV will be, month by month.
const baselineTotal = (projectId) => db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM cbs_plan c
  WHERE c.project_id = ? AND c.plan_type = 'baseline'
    AND c.version = (
      SELECT MAX(c2.version) FROM cbs_plan c2
      WHERE c2.project_id = c.project_id AND c2.transaction_account_id = c.transaction_account_id
        AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
        AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`)
  .get(projectId).s;

const byMonth = (projectId) => db.prepare(`SELECT c.period_month, SUM(c.amount) AS amount FROM cbs_plan c
  WHERE c.project_id = ? AND c.plan_type = 'baseline'
    AND c.version = (
      SELECT MAX(c2.version) FROM cbs_plan c2
      WHERE c2.project_id = c.project_id AND c2.transaction_account_id = c.transaction_account_id
        AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
        AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)
  GROUP BY c.period_month ORDER BY c.period_month`).all(projectId);

module.exports = {
  CbsError, spreadBaseline, autoSpread, buckets, reconciliation, baselineTotal, byMonth,
  assertReconciles, resourceTotalFor, remainingFor, MAX_AMOUNT,
};
