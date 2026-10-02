// Baseline change (module 7, plan part 7.5; PRD §5.2, §5.5).
//
// WHAT THIS FILE IS FOR
//
// ONE function that changes an applied baseline, used by both the BCR workflow (part 7.6)
// and de-scope (part 7.7). Built before the freeze so the freeze has something to guard.
//
// Two properties make it the hinge of the whole module, and both are about not lying:
//
//   PROSPECTIVE — a change applies from its effective period FORWARD. Months before it
//   are left byte-identical. This is EIA-748 G-30: "cumulative values are never
//   retroactively adjusted". The reason is not tidiness: those months were already
//   REPORTED. Rewriting them would change a period whose SPI and CPI were published, and
//   no later report would explain why last month's numbers moved.
//
//   ATOMIC — either the whole new baseline is in place or nothing happened. A half-
//   applied baseline is the worst possible state: PV would be part old and part new, so
//   every subsequent SPI and CPI would be wrong in a way that no screen explains. So the
//   delete and the insert share one transaction, and a FAILED post-condition throws,
//   which rolls both back.
//
// THE POST-CONDITION RE-READS THE TABLE. It does not re-check the caller's inputs. A
// check that trusts its own inputs cannot catch a bad DELETE, which is exactly the
// failure mode that produces a half-applied baseline.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const { resourceTotalFor } = require('./cbs-service');

class BaselineError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BaselineError';
    this.status = status;
  }
}

const MAX_AMOUNT = 1e15;

const month = (m) => {
  const s = String(m || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) {
    throw new BaselineError(`"${s || '(blank)'}" is not a month. Use YYYY-MM, e.g. 2026-07.`, 400);
  }
  return s;
};

function amountOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BaselineError('A bucket amount must be a number.', 400);
  if (!Number.isInteger(n)) throw new BaselineError('Bucket amounts are whole rupiah.', 400);
  if (n < 0) throw new BaselineError('A bucket amount cannot be negative.', 400);
  if (n > MAX_AMOUNT) throw new BaselineError('That amount is not plausible for a project.', 400);
  return n;
}

// The current baseline, read from the table. Deliberately ALL versions (this is the
// archive, which exists precisely so the replaced figures stay readable), unlike the
// EVM view which reads only the current version.
function snapshot(projectId) {
  return db.prepare(`SELECT transaction_account_id, wbs_node_id, plan_type, version,
      period_month, amount
    FROM cbs_plan
    WHERE project_id = ? AND plan_type IN ('baseline','bcr')
    ORDER BY period_month, transaction_account_id, wbs_node_id, version`).all(projectId);
}

// Every account whose buckets are touched by a change effective at `from`: the ones the
// new rows name, plus the ones that already have rows from that month forward.
function touchedAccounts(projectId, from, rows) {
  const ids = new Set(rows.map((r) => r.transaction_account_id));
  for (const r of db.prepare(`SELECT DISTINCT transaction_account_id AS a FROM cbs_plan
      WHERE project_id = ? AND plan_type IN ('baseline','bcr') AND period_month >= ?`).all(projectId, from)) {
    ids.add(r.a);
  }
  return [...ids];
}

// Validate the incoming rows BEFORE anything is written, so the common mistakes get a
// readable message rather than a constraint error.
function validateRows(projectId, effectivePeriod, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new BaselineError('A baseline change needs at least one row.', 400);
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const period = month(r.period_month);
    // Prospective: a change may not touch a month before its effective period. The
    // service says so here; the DELETE below is scoped the same way, so the two cannot
    // disagree about which months are in play.
    if (period < effectivePeriod) {
      throw new BaselineError(
        `A change effective from ${effectivePeriod} cannot alter ${period}. Months already `
        + 'reported are never rewritten.', 400);
    }
    const accountId = Number(r.transaction_account_id);
    const acct = db.prepare('SELECT * FROM transaction_accounts WHERE id = ?').get(accountId);
    if (!acct) throw new BaselineError('That cost account does not exist.', 404);
    if (acct.active !== 1) throw new BaselineError(`${acct.code} is no longer an active account.`, 400);

    const nodeId = Number(r.wbs_node_id);
    // Required, not optional: migration 015 refuses an untagged baseline row at the
    // database, because the view's EV branch can only earn against WBS-tagged rows and an
    // untagged one would sit in PV forever.
    if (!nodeId) {
      throw new BaselineError(
        `Every baseline row must name a work line; ${acct.code} does not. The account `
        + 'total is worked out from the buckets, never stored as its own row.', 400);
    }
    const node = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(nodeId, projectId);
    if (!node) throw new BaselineError('That WBS line does not exist in this project.', 404);
    if (node.superseded_by !== null) {
      throw new BaselineError(`The budget belongs on a live line; ${node.wbs_code} is version ${node.version}.`, 403);
    }

    const key = `${accountId}|${nodeId}|${period}`;
    if (seen.has(key)) {
      throw new BaselineError(`Two rows for ${acct.code} on ${node.wbs_code} in ${period}. Give one figure each.`, 400);
    }
    seen.add(key);
    out.push({ transaction_account_id: accountId, wbs_node_id: nodeId, period_month: period, amount: amountOf(r.amount) });
  }
  return out;
}

// THE POST-CONDITION. Re-read from the table, per touched account:
//
//   Σ current baseline buckets over ALL periods  ==  the account's resource plan
//
// Deliberately the WHOLE history, not just the months from the effective period forward.
// An over- or under-spread is a property of the account — money that PV never planned, or
// budget the plan never provided — and a per-period check cannot see either one whenever
// the imbalance sits in months the change did not touch. So the completed months are
// included, and the earlier ones are read from the table rather than assumed: the point of
// a post-condition is that it re-reads instead of re-checking the caller's inputs.
function assertChangeReconciles(projectId, from, rows) {
  const fmt = (n) => Number(n).toLocaleString('en-US');
  for (const accountId of touchedAccounts(projectId, from, rows)) {
    const acct = db.prepare('SELECT * FROM transaction_accounts WHERE id = ?').get(accountId);
    const row = db.prepare(`SELECT COALESCE(SUM(c.amount), 0) AS s FROM cbs_plan c
      WHERE c.project_id = ? AND c.transaction_account_id = ? AND c.plan_type = 'baseline'
        AND c.version = (
          SELECT MAX(c2.version) FROM cbs_plan c2
          WHERE c2.project_id = c.project_id
            AND c2.transaction_account_id = c.transaction_account_id
            AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
            AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`)
      .get(projectId, accountId);
    const planned = resourceTotalFor(projectId, accountId);
    if (row.s !== planned) {
      throw new BaselineError(
        `After the change, ${acct ? `${acct.code} ${acct.name}` : `account ${accountId}`} has `
        + `${fmt(row.s)} of budget against a resource plan of ${fmt(planned)}. The change was `
        + 'rolled back in full — the baseline is unchanged.', 409);
    }
  }
}

// --- the one mutation path ---------------------------------------------------

// A change that MOVES MONEY needs the resource plan to move with it.
//
// Since the post-condition is "Σ buckets == the account's resource plan", a change with
// an impact other than 0 can never reconcile on its own — the budget would be adjusted
// against a plan that still says the old figure, and the whole change would roll back.
// So a scope change states both halves, and they are written in ONE transaction: the
// resource plan and the budget can never be seen mid-move, one applied and the other not.
//
// `rbsRows` are the resource plan rows for the affected (work line, resource) pairs AFTER
// the change — the new rate x quantity, or a zero to retire a line. Only the effective
// period onwards is a concern for the buckets; the resource plan has no periods, so a row
// here replaces that bucket's current version.
function writeResourcePlan(projectId, rbsRows, actorId) {
  if (!rbsRows || !rbsRows.length) return 0;
  let n = 0;
  for (const r of rbsRows) {
    const nodeId = Number(r.wbs_node_id);
    const acctId = r.transaction_account_id == null ? null : Number(r.transaction_account_id);
    const code = String(r.rbs_code || '').trim();
    if (!nodeId || !code) {
      throw new BaselineError('A resource-plan row needs a work line and a resource code.', 400);
    }
    const node = db.prepare('SELECT * FROM wbs_nodes WHERE id = ? AND project_id = ?').get(nodeId, projectId);
    if (!node) throw new BaselineError('That WBS line does not exist in this project.', 404);

    const rate = Number(r.rate);
    const units = Number(r.units);
    if (!Number.isFinite(rate) || !Number.isFinite(units)) {
      throw new BaselineError('A resource-plan row needs a numeric rate and quantity.', 400);
    }
    const total = Math.round(rate * units);
    if (total < 0) throw new BaselineError('A resource-plan total cannot be negative.', 400);

    const next = db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rbs_load
      WHERE project_id = ? AND wbs_node_id = ? AND rbs_code = ?
        AND COALESCE(transaction_account_id, 0) = COALESCE(?, 0)`)
      .get(projectId, nodeId, code, acctId).v;
    const info = db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
        transaction_account_id, rate, units, unit_label, total_amount, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, nodeId, code, acctId, rate, units, r.unit_label || null, total, next);
    n += 1;
    q.audit('rbs_load', info.lastInsertRowid, 'create', actorId, null,
      { wbs_node_id: nodeId, rbs_code: code, total_amount: total, version: next,
        via: 'baseline_change' });
  }
  return n;
}

// Replace the baseline from `effectivePeriod` forward.
//
//   applyBaselineChange({ projectId, effectivePeriod, rows, actorId, reason,
//                        bcrId = null, impactCost = 0 })
//
// `rows` is the COMPLETE new set of buckets from `effectivePeriod` onward for every
// account the change touches — not a delta. The old rows from that month forward are
// removed, so the caller states the new truth rather than a diff of it. Past months are
// never read and never written.
function applyBaselineChange({ projectId, effectivePeriod, rows, actorId, reason = null,
                               bcrId = null, impactCost = 0, rbsRows = null }) {
  const from = month(effectivePeriod);
  if (!reason || !String(reason).trim()) {
    throw new BaselineError('A baseline change needs a reason. It is what explains the '
      + 'movement later.', 400);
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new BaselineError('That project does not exist.', 404);

  const clean = validateRows(projectId, from, rows);
  // Validate the resource half too, BEFORE the transaction, for the same reason.
  if (impactCost && (!rbsRows || !rbsRows.length)) {
    throw new BaselineError(
      'A change that moves money has to state the resource plan that supports it. Every '
      + 'budget bucket must be backed by rate x quantity, so the two move together.', 400);
  }

  const run = db.transaction(() => {
    // (a) Archive WHAT WAS THERE before changing anything. Taken inside the transaction,
    //     so an archive can never describe a state that was rolled back.
    const old = snapshot(projectId);
    const archivedTo = [];

    if (bcrId) {
      db.prepare(`UPDATE bcr_register SET old_baseline_json = ? WHERE id = ? AND project_id = ?`)
        .run(JSON.stringify(old), bcrId, projectId);
      archivedTo.push('bcr_register.old_baseline_json');
    }
    // Always audit too: a change must be explainable even when it did not come through a
    // BCR (part 7.7's de-scope is still a register entry, but the audit trail is the
    // durable record).
    q.audit('projects', projectId, 'baseline_change_archive', actorId,
      null, { effective_period: from, reason, rows_archived: old.length, bcr_id: bcrId });

    // (b) Move the resource plan first, in the SAME transaction. The post-condition at
    //     the end compares the buckets against this, so the two can never be committed
    //     one without the other.
    const rbsWritten = writeResourcePlan(projectId, rbsRows, actorId);

    // (c) Marker: capture the highest version per bucket BEFORE the delete.
    //
    //     The rows being removed are gone from the table afterwards, so a MAX(version)
    //     taken after the DELETE would restart at 1 and the archive would show two
    //     different figures both claiming to be v1. Reading it first keeps the numbering
    //     monotone per bucket ("v5 was June, v6 is the July change"), which is what makes
    //     the archive readable in order.
    const maxVersions = new Map();
    for (const r of db.prepare(`SELECT transaction_account_id, wbs_node_id, period_month,
        MAX(version) v FROM cbs_plan
        WHERE project_id = ? AND plan_type IN ('baseline','bcr')
        GROUP BY transaction_account_id, wbs_node_id, period_month`).all(projectId)) {
      maxVersions.set(`${r.transaction_account_id}|${r.wbs_node_id ?? 0}|${r.period_month}`, r.v);
    }

    // (d) Remove the rows being replaced — from the effective period FORWARD only.
    //     `bcr` rows are removed too: they are a proposal staged against the same bucket,
    //     and leaving them would put two current versions in play.
    const deleted = db.prepare(`DELETE FROM cbs_plan
      WHERE project_id = ? AND plan_type IN ('baseline','bcr') AND period_month >= ?`)
      .run(projectId, from).changes;

    // (e) Insert the new rows as 'baseline', continuing the bucket's version sequence.
    let inserted = 0;
    for (const r of clean) {
      const key = `${r.transaction_account_id}|${r.wbs_node_id ?? 0}|${r.period_month}`;
      const next = (maxVersions.get(key) || 0) + 1;

      const info = db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id,
          plan_type, version, period_month, amount, created_by)
          VALUES (?, ?, ?, 'baseline', ?, ?, ?, ?)`)
        .run(projectId, r.transaction_account_id, r.wbs_node_id, next, r.period_month, r.amount, actorId);
      inserted += 1;
      q.audit('cbs_plan', info.lastInsertRowid, 'create', actorId, null, {
        ...r, version: next, plan_type: 'baseline', via: 'baseline_change', bcr_id: bcrId,
      });
    }

    // (f) THE POST-CONDITION — re-read from the table, and throw to roll everything back
    //     if it does not hold. This is the line that makes "atomic" true rather than
    //     hoped for, and it is what catches a bad DELETE, or a resource plan written to
    //     the wrong account.
    assertChangeReconciles(projectId, from, clean);

    q.audit('projects', projectId, 'baseline_change', actorId,
      { effective_period: from, rows_removed: deleted },
      { effective_period: from, rows_written: inserted, rbs_written: rbsWritten,
        impact_cost: Number(impactCost) || 0, reason, bcr_id: bcrId, archived_to: archivedTo });

    return { effectivePeriod: from, removed: deleted, written: inserted, rbsWritten,
      archivedRows: old.length };
  });

  return run();
}

// --- the proposal side (used by part 7.6 before approval) --------------------

// Record a PROPOSED baseline on a change request without touching the live one.
//
// Kept separate from applyBaselineChange on purpose: the live baseline must not move
// until the change is approved (decision 1A — the PM's approval is what makes it
// effective). Until then the proposal is data on the request, which is why
// `bcr_register` carries `new_baseline_json` and `cbs_plan` is left alone.
function setProposedBaseline({ projectId, bcrId, rows, actorId }) {
  const bcr = db.prepare('SELECT * FROM bcr_register WHERE id = ? AND project_id = ?').get(bcrId, projectId);
  if (!bcr) throw new BaselineError('That change request does not exist in this project.', 404);
  if (bcr.status !== 'draft') {
    throw new BaselineError(`A proposal can only be set while the request is a draft; this one is ${bcr.status}.`, 409);
  }
  const clean = rows.map((r) => ({
    transaction_account_id: Number(r.transaction_account_id),
    wbs_node_id: r.wbs_node_id == null ? null : Number(r.wbs_node_id),
    period_month: month(r.period_month),
    amount: amountOf(r.amount),
  }));
  db.prepare('UPDATE bcr_register SET new_baseline_json = ? WHERE id = ? AND project_id = ?')
    .run(JSON.stringify(clean), bcrId, projectId);
  q.audit('bcr_register', bcrId, 'propose_baseline', actorId, null, { rows: clean.length });
  return clean;
}

const proposedBaseline = (bcrId) => {
  const bcr = db.prepare('SELECT new_baseline_json FROM bcr_register WHERE id = ?').get(bcrId);
  if (!bcr || !bcr.new_baseline_json) return null;
  return JSON.parse(bcr.new_baseline_json);
};

const archivedBaseline = (bcrId) => {
  const bcr = db.prepare('SELECT old_baseline_json FROM bcr_register WHERE id = ?').get(bcrId);
  if (!bcr || !bcr.old_baseline_json) return null;
  return JSON.parse(bcr.old_baseline_json);
};

module.exports = {
  BaselineError, applyBaselineChange, setProposedBaseline, proposedBaseline, archivedBaseline,
  snapshot, writeResourcePlan,
};
