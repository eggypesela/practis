// Forecast / EAC (module 8, plan part 8.4; PRD §4.4 step 1).
//
// PRD §4.4 step 1: "Project Controller updates `c_wbs_forecast`; Cost Controller updates
// `c_cbs_forecast` (auto EAC from CPI + manual override)."
//
// TWO NUMBERS, DELIBERATELY NOT THE SAME ONE
//
// The product has to answer "what will this finally cost?" for two different readers, and
// the schema has always allowed both:
//
//   * the SYSTEM estimate (`eac()`), derived from how efficiently cost has earned value so
//     far — `EAC = BAC / CPI`, `ETC = EAC - AC`. Nobody types it; it moves by itself as
//     reality arrives.
//   * the HUMAN forecast (a `cbs_plan` row with `plan_type='forecast'`), which is what the
//     Cost Controller believes, month by month. Its own schema comment (R2-24) describes
//     exactly this: "user starts it as a DUPLICATE of the execution plan, then EDITS it
//     period by period against actuals to produce the forecast (ETC/EAC)".
//
// The screen shows BOTH ("the system works out X; a human forecast Y"), never one silently
// replacing the other. That is the whole reason `is_manual_override` exists as a column
// rather than the write path simply overwriting `amount`.
//
// A forecast NEVER touches the baseline. Changing the approved plan is what a BCR is for,
// and module 7 built that (`applyBaselineChange`, prospective and atomic). Every function
// here writes only `plan_type='forecast'` rows.
//
// HONESTY RULE (the 018/019 rule, carried into the UI)
//
// `v_evm_period.cpi_cum` is NULL unless there is earned value AND actual cost — migration
// 018 made "no measurement" a blank rather than a false zero, and 019 kept the rule for the
// cumulative columns. This service refuses to "help" when CPI is missing:
//
//   * it does NOT fall back to `EAC = BAC`, which would present a project that has never
//     been measured as perfectly on budget;
//   * it does NOT divide by zero;
//   * it returns `eac: null` plus a `reason` the caller renders.
//
// The reason is a sentence, not a code, because the caller renders it verbatim and the
// distinction matters to the reader: "nothing has been spent yet" and "nothing has been
// measured yet" are different situations with different next actions.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const cbs = require('./cbs-service');

class ForecastError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ForecastError';
    this.status = status;
  }
}

// 'YYYY-MM', the only shape `cbs_plan.period_month` holds.
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthOf(v) {
  const s = String(v ?? '').trim();
  if (!MONTH_RE.test(s)) {
    throw new ForecastError('Give the month as YYYY-MM, for example 2026-03.', 400);
  }
  return s;
}

// Whole rupiah, non-negative, integer. The same shape `cbs-service.amountOf` enforces for a
// baseline bucket — a forecast is money in the same column, so it obeys the same rules.
function amountOf(v) {
  const s = String(v ?? '').trim().replace(/[,\s]/g, '');
  if (s === '') throw new ForecastError('Give the forecast amount for the month.', 400);
  if (!/^\d{1,15}$/.test(s)) {
    throw new ForecastError('A forecast amount is a whole number of rupiah, with no minus sign '
      + 'and no decimals (amounts are stored as integer rupiah throughout).', 400);
  }
  return Number(s);
}

function project(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(projectId));
  if (!p) throw new ForecastError('That project does not exist.', 404);
  return p;
}

// ---------------------------------------------------------------------------
// The system estimate, from cumulative CPI
// ---------------------------------------------------------------------------

// The latest month that actually carries a measurement, with its cumulative index.
//
// NOT "the newest row with a cpi_cum", which is what this first said and was wrong. Migration
// 019 builds one row per project per month across the union of pv/ev/ac months, and the
// cumulative columns CARRY FORWARD: a project with a January-to-December baseline measured only
// to March has a non-null `cpi_cum` in every month to December, all carrying the March value.
// Taking the newest such row labels the estimate "as at 2026-12" — which tells a reader the
// project has been measured through December. It has not, and for a book of record that is the
// dangerous direction to be wrong in.
//
// So the "as at" month is the latest month in which the cumulative figures were actually moved
// by data: earned value or actual cost recorded in that period. Those are the two measured
// quantities; `pv` is the plan and moves by being planned, not by being observed. A month where
// cost was booked in December is included — its index genuinely changed then.
function latestCumulative(projectId) {
  return db.prepare(`SELECT period_month, pv_cum, ev_cum, ac_cum, cpi_cum, spi_cum
    FROM v_evm_period
    WHERE project_id = ? AND cpi_cum IS NOT NULL AND (ev <> 0 OR ac <> 0)
    ORDER BY period_month DESC LIMIT 1`).get(Number(projectId)) || null;
}

// The newest cumulative figures whether or not CPI exists — used for the "why is it blank"
// sentence, which needs to distinguish "no cost booked" from "no progress measured".
function latestAnyCumulative(projectId) {
  const row = db.prepare(`SELECT period_month, pv_cum, ev_cum, ac_cum, cpi_cum
    FROM v_evm_period
    WHERE project_id = ?
    ORDER BY period_month DESC LIMIT 1`).get(Number(projectId));
  // A project with no rows at all in the grid has nothing measured.
  return row || { period_month: null, pv_cum: 0, ev_cum: 0, ac_cum: 0, cpi_cum: null };
}

// The estimate at completion.
//
// Returns `{ bac, ac_cum, ev_cum, pv_cum, cpi_cum, cpi_month, eac, etc, vac, over, reason }`.
// `eac` is `null` — never a number — when it cannot honestly be worked out, and `reason`
// then says why in words the screen can print.
function eac(projectId) {
  project(projectId);
  const bac = cbs.baselineTotal(projectId);
  const cum = latestAnyCumulative(projectId);

  const out = {
    bac,
    ac_cum: cum.ac_cum || 0,
    ev_cum: cum.ev_cum || 0,
    pv_cum: cum.pv_cum || 0,
    cpi_cum: null,
    cpi_month: null,
    eac: null,
    etc: null,
    vac: null,
    over: null,
    reason: null,
  };

  if (!bac) {
    out.reason = 'This project has no approved cost baseline yet, so there is nothing to '
      + 'complete and no estimate can be made. Set the budget first.';
    return out;
  }

  const measured = latestCumulative(projectId);
  if (!measured) {
    // Say WHICH measurement is missing. "Nothing spent" and "nothing earned" both produce a
    // blank CPI but they are different problems, and the reader can only act on the second.
    if (cum.ac_cum === 0 && cum.ev_cum === 0) {
      out.reason = 'Nothing has been spent and no progress has been measured yet, so there is '
        + 'no cost performance to project from.';
    } else if (cum.ev_cum === 0) {
      out.reason = 'No progress has been measured against the budget yet, so earned value is '
        + 'zero and cost performance cannot be worked out. Record progress against the work '
        + 'lines first.';
    } else if (cum.ac_cum === 0) {
      out.reason = 'Progress has been measured but no cost has been booked against this project '
        + 'yet, so cost performance cannot be worked out.';
    } else {
      out.reason = 'Cost performance cannot be worked out from the figures recorded so far.';
    }
    return out;
  }

  out.cpi_cum = measured.cpi_cum;
  out.cpi_month = measured.period_month;
  // Rounded to whole rupiah: this is an estimate, and printing an estimate to the rupiah
  // would imply a precision it does not have. The rounding is stated on the screen.
  //
  // COMPUTED FROM THE UNROUNDED RATIO, NOT from `cpi_cum`. `v_evm_period` rounds CPI to 4
  // decimal places (0.5882 rather than 0.588235...), and dividing by a rounded intermediate
  // carries that error straight into the estimate: BAC 1,000,000 with CPI 0.5882 gives
  // 1,700,102 instead of 1,700,000. That is only Rp 102 here, but the error is proportional to
  // the project, so on a Rp 300 billion contract it is roughly Rp 18 million of pure artifact
  // — a number nobody can act on, presented as if it were a finding.
  //
  // `BAC / (EV / AC)` is algebraically `BAC * AC / EV`, so this is the same figure with no
  // rounded intermediate. `cpi_cum` is still returned and still shown; it is a display value,
  // not an input to arithmetic. The test that caught this is VR8.6, and FC8.2's hand-computed
  // EAC of 400,000 (where the rounded and unrounded routes happen to agree) still holds.
  out.eac = Math.round((bac * measured.ac_cum) / measured.ev_cum);
  out.etc = out.eac - out.ac_cum;
  // Positive VAC means "expect to finish under budget", which is what the sign convention
  // in PRD §5.2 means by a natural sign. Stated on the screen so nobody "fixes" it.
  out.vac = bac - out.eac;
  out.over = out.eac > bac;
  return out;
}

// ---------------------------------------------------------------------------
// The monthly grid: baseline, the human forecast, and which is which
// ---------------------------------------------------------------------------

// Per (cost account, month): the approved baseline, the current forecast, and whether the
// forecast is a human override.
//
// GRAIN, decided from the data and recorded here: the override is one figure per
// (account, month), stored as a `cbs_plan` row with `plan_type='forecast'` and
// `wbs_node_id IS NULL`. The baseline is per (account, work line, month) — but the
// override does not need that grain to be useful ("what will this account cost in March?"),
// and `cbs_plan` permits a NULL work line for every plan type except `baseline` (the 015
// trigger only constrains `plan_type='baseline'`). Keeping the override coarser than the
// baseline is what lets the screen offer ONE box per account-month instead of a grid of
// boxes, and the reconciliation below still shows both sides in full.
//
// Versions: the reader takes the LATEST version of each bucket, the same rule migration 014
// established for the baseline and 019 relies on for the cumulative columns. A re-forecast
// supersedes rather than overwrites, so the previous human judgement stays readable.
function months(projectId) {
  project(projectId);
  const pid = Number(projectId);

  const base = db.prepare(`
    SELECT c.period_month             AS period_month,
           ta.id                      AS account_id,
           ta.code                    AS account_code,
           ta.name                    AS account_name,
           SUM(c.amount)              AS amount
    FROM cbs_plan c
    JOIN transaction_accounts ta ON ta.id = c.transaction_account_id
    WHERE c.project_id = ? AND c.plan_type = 'baseline'
      AND c.version = (
        SELECT MAX(c2.version) FROM cbs_plan c2
        WHERE c2.project_id = c.project_id
          AND c2.transaction_account_id = c.transaction_account_id
          AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
          AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)
    GROUP BY c.period_month, ta.id
    ORDER BY c.period_month, ta.code`).all(pid);

  const fore = db.prepare(`
    SELECT c.period_month, c.amount, c.is_manual_override, c.note, c.version,
           c.transaction_account_id AS account_id
    FROM cbs_plan c
    WHERE c.project_id = ? AND c.plan_type = 'forecast'
      AND c.version = (
        SELECT MAX(c3.version) FROM cbs_plan c3
        WHERE c3.project_id = c.project_id
          AND c3.transaction_account_id = c.transaction_account_id
          AND COALESCE(c3.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
          AND c3.plan_type = c.plan_type AND c3.period_month = c.period_month)`).all(pid);

  const over = new Map();
  for (const f of fore) over.set(`${f.account_id}|${f.period_month}`, f);

  const rows = [];
  const seen = new Set();
  for (const b of base) {
    const key = `${b.account_id}|${b.period_month}`;
    seen.add(key);
    const f = over.get(key) || null;
    // `is_manual_override` is the flag that decides. A cleared override keeps its row (so the
    // decision is still visible in history) but is stored with the flag 0, which puts the
    // baseline figure back in force without deleting anything.
    const isOverride = !!(f && f.is_manual_override);
    rows.push({
      period_month: b.period_month,
      account_id: b.account_id,
      account_code: b.account_code,
      account_name: b.account_name,
      baseline: b.amount,
      forecast: isOverride ? f.amount : b.amount,
      is_override: isOverride,
      delta: (isOverride ? f.amount : b.amount) - b.amount,
      note: f ? f.note : null,
      version: f ? f.version : null,
    });
  }

  // A month that was forecast but has no baseline bucket left (a de-scope removes baseline
  // rows). Keep it visible rather than dropping the human's entry on the floor.
  for (const f of fore) {
    const key = `${f.account_id}|${f.period_month}`;
    if (seen.has(key)) continue;
    const ta = db.prepare('SELECT id, code, name FROM transaction_accounts WHERE id = ?')
      .get(f.account_id);
    rows.push({
      period_month: f.period_month,
      account_id: f.account_id,
      account_code: ta ? ta.code : null,
      account_name: ta ? ta.name : null,
      baseline: 0,
      forecast: f.is_manual_override ? f.amount : 0,
      is_override: !!f.is_manual_override,
      delta: f.is_manual_override ? f.amount : 0,
      note: f.note,
      version: f.version,
    });
  }

  rows.sort((a, b) => (a.period_month < b.period_month ? -1
    : a.period_month > b.period_month ? 1
      : String(a.account_code).localeCompare(String(b.account_code))));
  return rows;
}

// What the two totals come to. `human_forecast` is the Cost Controller's number; `system`
// is the one the CPI produces. They are reported side by side, and the screen says which is
// which rather than picking a winner.
function totals(projectId) {
  const rows = months(projectId);
  const human = rows.reduce((s, r) => s + r.forecast, 0);
  const baseline = rows.reduce((s, r) => s + r.baseline, 0);
  const sys = eac(projectId);
  return {
    baseline,
    human_forecast: human,
    overrides: rows.filter((r) => r.is_override).length,
    system_eac: sys.eac,
    system_etc: sys.etc,
    system_vac: sys.vac,
    bac: sys.bac,
    ac_cum: sys.ac_cum,
    reason: sys.reason,
    // Only meaningful when the system estimate exists.
    human_vac: sys.eac === null ? null : sys.bac - human,
  };
}

// ---------------------------------------------------------------------------
// The write path — forecast rows only, never baseline rows
// ---------------------------------------------------------------------------

function accountOf(accountId) {
  const a = db.prepare('SELECT * FROM transaction_accounts WHERE id = ?').get(Number(accountId));
  if (!a) throw new ForecastError('That cost account does not exist.', 400);
  return a;
}

// The next version for this exact bucket. Version 1 is the first forecast; a re-forecast
// takes 2 and the previous figure stays readable at 1 (the 014 pattern).
function nextVersion(projectId, accountId, periodMonth) {
  return db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM cbs_plan
    WHERE project_id = ? AND transaction_account_id = ? AND wbs_node_id IS NULL
      AND plan_type = 'forecast' AND period_month = ?`)
    .get(projectId, accountId, periodMonth).v + 1;
}

// Record a human forecast for one account-month.
//
// The row written is ALWAYS `plan_type='forecast'`. There is no code path in this module
// that writes a `baseline` row, which is what makes "a forecast never moves the baseline"
// a property of the code rather than a promise — and FC8.6 checks it by counting and
// checksumming the baseline rows either side of a forecast write.
function setOverride({ projectId, accountId, periodMonth, amount, actorId, note = null }) {
  const p = project(projectId);
  const acct = accountOf(accountId);
  const m = monthOf(periodMonth);
  const value = amountOf(amount);

  const run = db.transaction(() => {
    const v = nextVersion(p.id, acct.id, m);
    const info = db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id,
        plan_type, version, period_month, amount, is_manual_override, note, created_by)
        VALUES (?, ?, NULL, 'forecast', ?, ?, ?, 1, ?, ?)`)
      .run(p.id, acct.id, v, m, value, note, actorId);

    // One audit row for the fact, the same shape the baseline write uses.
    q.audit('cbs_plan', info.lastInsertRowid, 'create', actorId, null, {
      transaction_account_id: acct.id, wbs_node_id: null, period_month: m,
      amount: value, version: v, plan_type: 'forecast', is_manual_override: 1,
    });
    return { id: info.lastInsertRowid, version: v };
  });

  const { id, version } = run();
  return { id, version, account: acct, period_month: m, amount: value };
}

// Put the baseline figure back in force for one account-month, without deleting the
// history. Writes a NEW version carrying `is_manual_override = 0`; `months()` treats that as
// "not overridden", so the baseline speaks again, and the record of the earlier human entry
// survives at its own version.
function clearOverride({ projectId, accountId, periodMonth, actorId, note = null }) {
  const p = project(projectId);
  const acct = accountOf(accountId);
  const m = monthOf(periodMonth);

  const current = db.prepare(`SELECT * FROM cbs_plan
    WHERE project_id = ? AND transaction_account_id = ? AND wbs_node_id IS NULL
      AND plan_type = 'forecast' AND period_month = ?
      AND version = (SELECT COALESCE(MAX(version), 0) FROM cbs_plan
        WHERE project_id = ? AND transaction_account_id = ? AND wbs_node_id IS NULL
          AND plan_type = 'forecast' AND period_month = ?)`)
    .get(p.id, acct.id, m, p.id, acct.id, m);

  if (!current || !current.is_manual_override) {
    throw new ForecastError(
      `There is no forecast of your own on ${acct.code} ${acct.name} for ${m}, so there is `
      + 'nothing to hand back to the plan.', 400);
  }

  const baseline = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM cbs_plan
    WHERE project_id = ? AND transaction_account_id = ? AND plan_type = 'baseline'
      AND period_month = ?
      AND version = (SELECT MAX(c2.version) FROM cbs_plan c2
        WHERE c2.project_id = cbs_plan.project_id
          AND c2.transaction_account_id = cbs_plan.transaction_account_id
          AND COALESCE(c2.wbs_node_id, 0) = COALESCE(cbs_plan.wbs_node_id, 0)
          AND c2.plan_type = cbs_plan.plan_type
          AND c2.period_month = cbs_plan.period_month)`)
    .get(p.id, acct.id, m).s;

  const run = db.transaction(() => {
    const v = nextVersion(p.id, acct.id, m);
    const info = db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id,
        plan_type, version, period_month, amount, is_manual_override, note, created_by)
        VALUES (?, ?, NULL, 'forecast', ?, ?, ?, 0, ?, ?)`)
      .run(p.id, acct.id, v, m, baseline,
        note || `forecast handed back to the plan (was ${current.amount})`, actorId);

    q.audit('cbs_plan', info.lastInsertRowid, 'update', actorId,
      { amount: current.amount, is_manual_override: 1, version: current.version },
      { amount: baseline, is_manual_override: 0, version: v, plan_type: 'forecast' });
    return { id: info.lastInsertRowid, version: v };
  });

  const { id, version } = run();
  return { id, version, account: acct, period_month: m, amount: baseline };
}

// ---------------------------------------------------------------------------
// Variance (module 8, plan part 8.5)
// ---------------------------------------------------------------------------
//
// SV, CV and VAC — the money answer to "are we ahead or behind, and by how much?", alongside the
// index SPI/CPI which answers it as a ratio.
//
// WHY THE COMPUTATION LIVES HERE AND NOT IN A NEW evm-service.js
//
// Decided from the code, and recorded: `VAC = BAC - EAC`, and EAC is `eac()` above. Putting
// variance in its own module would mean a second reader of the same cumulative figures, or an
// import that makes this module and that one mutually dependent. There is also no `evm-service.js`
// in the repo — `spi_cum`/`cpi_cum` have been read straight from `v_evm_period` by
// `progress-service` and `cbs-service` since 019. So variance goes where the other
// cumulative-EVM-derived figure already is: one writer, one reader, one place to change.
//
// WHERE THE ARITHMETIC ACTUALLY HAPPENS
//
// SV and CV are COLUMNS on `v_evm_period` (migration 022), not re-derived here — the rule this
// module has been bitten by three times (013/014/015, then 018, then 019): compute once, in one
// place, so two screens cannot disagree. This function does not do arithmetic on SV/CV at all; it
// reads them and adds the percentages and VAC.
//
// THE SIGN TRAP, and why the screen must state it
//
// `v_evm_period.cost_variance` is `AC - EV` (pinned by EV7.6) and therefore has the OPPOSITE sign
// to standard CV. Both are exposed here under names that say which is which, with the convention
// spelled out in `sign`, so a renderer cannot mix them up silently:
//
//   sv, sv_cum   EV - PV   positive = AHEAD of schedule
//   cv, cv_cum   EV - AC   positive = UNDER budget
//   vac          BAC - EAC positive = expected to finish UNDER budget
//   cost_variance AC - EV  positive = OVER budget  (kept for the ledger-side readers)
//
// PERCENTAGES
//
// Rp 500,000,000 of variance means something different on a Rp 2 mld contract and a Rp 500 mld
// one, so each variance carries a percentage: SV over the cumulative planned value (how far
// through the plan we should be), CV over the cumulative actual cost (what the overspend is
// measured against). Both are BLANK when their denominator is zero — the same honesty rule as the
// indexes: a percentage of nothing is not 0%, it is not a percentage.
function variance(projectId, opts = {}) {
  const p = project(projectId);
  const includeUnmeasured = opts.includeUnmeasured === true;

  const rows = db.prepare(`SELECT period_month, pv, ev, ac,
      pv_cum, ev_cum, ac_cum, spi, cpi, spi_cum, cpi_cum,
      cost_variance, sv, cv, sv_cum, cv_cum
    FROM v_evm_period WHERE project_id = ? ORDER BY period_month`).all(p.id);

  // A month nobody has measured yet has all three figures 0, so its variances are 0 — arithmetically
  // right and operationally empty. The trend table drops those by default (the reader gets a chart
  // of nothing but flat zeroes otherwise) and the service says how many it dropped, so the screen
  // can state the omission rather than leave a reader wondering where the months went.
  const months = includeUnmeasured
    ? rows
    : rows.filter((r) => r.pv !== 0 || r.ev !== 0 || r.ac !== 0);
  const omitted = rows.length - months.length;

  const pct = (num, den) => (den ? Math.round((num / den) * 10000) / 100 : null);

  const out = months.map((r) => ({
    period_month: r.period_month,
    pv: r.pv, ev: r.ev, ac: r.ac,
    pv_cum: r.pv_cum, ev_cum: r.ev_cum, ac_cum: r.ac_cum,
    spi: r.spi, cpi: r.cpi, spi_cum: r.spi_cum, cpi_cum: r.cpi_cum,
    sv: r.sv, cv: r.cv,
    sv_cum: r.sv_cum, cv_cum: r.cv_cum,
    sv_pct: pct(r.sv_cum, r.pv_cum),
    cv_pct: pct(r.cv_cum, r.ac_cum),
    // Kept under its own name and its own sign. A screen that wants the ledger-side figure can
    // read it; a screen that wants standard CV reads `cv`. They are never both called "cost
    // variance" on one page.
    cost_variance: r.cost_variance,
  }));

  // The latest MEASURED month drives the headline, the same rule as the forecast's "as at" date:
  // a carried-forward figure is not a measurement. Reuses `latestCumulative`, so the two screens
  // cannot disagree about which month is current.
  const measured = latestCumulative(p.id);
  const at = measured
    ? months.find((r) => r.period_month === measured.period_month) || null
    : null;

  const est = eac(p.id);

  return {
    project: p,
    months: out,
    omitted,
    counted: months.length,
    // The latest measured month's row, or null when nothing has been measured at all.
    at,
    // VAC travels with the estimate it came from, so a blank VAC and a stated reason cannot get
    // separated on the way to the screen.
    vac: est.vac,
    bac: est.bac,
    eac: est.eac,
    eac_month: est.cpi_month,
    reason: est.reason,
    // The convention, as data, so the view cannot render a sign without saying what it means.
    sign: {
      sv: 'positive means ahead of schedule',
      cv: 'positive means under budget',
      vac: 'positive means expected to finish under budget',
      cost_variance: 'positive means OVER budget — this is the ledger-side figure, opposite to CV',
    },
  };
}

module.exports = {
  ForecastError, eac, months, totals, setOverride, clearOverride,
  latestCumulative, latestAnyCumulative, variance,
};
