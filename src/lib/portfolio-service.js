// Portfolio dashboard service (module 8, plan part 8.7).
//
// PRD §5.4: "Portfolio dashboard (exec/Viewer): all projects, CPI/SPI traffic-light cards,
// current-month cashflow, portfolio-wide forecast."
// PRD §4.4: "Alert threshold: SPI or CPI < 0.95 for two consecutive periods (threshold tunable)".
// PRD §4.5, the 3-step close, quoted because every rule below is one of its rows:
//
//   | Operationally closed | excluded from live schedule |
//   | Financially closed   | excluded from live cashflow/forecast; shown in "settled" filter |
//   | Contractually closed | fully archived, still reportable |
//   "Closed projects remain in portfolio history totals forever."
//
// TWO THINGS THIS FILE IS DELIBERATELY PARANOID ABOUT, both measured on real data first:
//
//   1. A BLANK INDEX IS NOT ZERO. On the development database every row of v_evm_period has
//      spi_cum = NULL and cpi_cum = NULL — the project has cost booked but no baseline and no
//      progress, so no index can be computed. A tile that compared 0 against 0.95 would paint
//      that project RED and tell the owner it is in breach when the honest answer is "there is
//      nothing to measure yet". So `indexState()` distinguishes three states — not-measured,
//      within, breached — and the caller must render the first as grey.
//
//   2. THE THRESHOLD IS READ, NOT HARD-CODED. It comes from `app_settings` (migration 023 seeds
//      it), with 0.95 as the fallback so a missing row degrades instead of throwing. The page
//      STATES the number it used, because a green tile that cannot be checked is decoration.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const forecast = require('./forecast-service');

// The PRD's default, used only when the setting is absent or unreadable.
const DEFAULT_THRESHOLD = 0.95;

// Read one numeric setting. Returns null (not the default) when absent/unparseable, so the caller
// can tell "the operator set 0.95" from "we fell back to 0.95" — the page says which.
function settingNumber(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

// The thresholds actually in force, plus where each came from, so the screen can state it.
function thresholds() {
  const spi = settingNumber('spi_breach_threshold');
  const cpi = settingNumber('cpi_breach_threshold');
  return {
    spi: spi === null ? DEFAULT_THRESHOLD : spi,
    cpi: cpi === null ? DEFAULT_THRESHOLD : cpi,
    fromSettings: spi !== null || cpi !== null,
  };
}

// One index value -> one state. THE CORE RULE OF THIS SCREEN.
//
//   null              -> 'not-measured'   grey.  Never green, never red.
//   value < threshold -> 'breached'       red
//   otherwise         -> 'within'         green
//
// A value of exactly 0 is NOT written as null by the view — see the probe note at the top: when
// there is no basis to compute an index the view emits NULL. A real 0 would be a genuine breach
// and is treated as one; that distinction is asserted in the tests, not assumed here.
function indexState(value, threshold) {
  if (value === null || value === undefined) return 'not-measured';
  return Number(value) < threshold ? 'breached' : 'within';
}

// A project's health from its LATEST MEASURED cumulative row.
//
// Decision 7.9A, restated because it is the thing most likely to be "corrected" by a later
// change: the CUMULATIVE columns are used, never the per-period ones. The per-period figures read
// "5.0, blank, blank, blank" down a year — a single large month early on — and are not a health
// indicator at all. `forecast.latestCumulative` already implements "latest month with a real
// measurement", the same helper the forecast and variance screens use, so all three screens
// cannot disagree about which month they are describing.
function health(projectId) {
  const t = thresholds();
  const cum = forecast.latestCumulative(projectId);
  if (!cum) {
    return {
      measured: false, month: null, spi: null, cpi: null,
      spiState: 'not-measured', cpiState: 'not-measured', threshold: t,
    };
  }
  return {
    measured: true,
    month: cum.period_month,
    spi: cum.spi_cum === null ? null : Number(cum.spi_cum),
    cpi: cum.cpi_cum === null ? null : Number(cum.cpi_cum),
    spiState: indexState(cum.spi_cum, t.spi),
    cpiState: indexState(cum.cpi_cum, t.cpi),
    threshold: t,
  };
}

// Which live lists a project has left, from the three close stamps (PRD §4.5).
//
// Faithful to the table rather than simplified to a single "closed" flag, because the steps mean
// genuinely different things: an operationally-closed project has finished its work but still owes
// and is owed money, so it must STAY in the cashflow totals while dropping out of the live
// schedule count. Collapsing the three into one boolean would throw that away, and PRD §4.5 says
// otherwise in a table.
function exclusion(project) {
  const op = !!project.close_operational_at;
  const fin = !!project.close_financial_at;
  const con = !!project.close_contractual_at;
  const steps = [];
  if (op) steps.push({ step: 'Operationally closed', left: 'the live schedule' });
  if (fin) steps.push({ step: 'Financially closed', left: 'live cashflow and forecast' });
  if (con) steps.push({ step: 'Contractually closed', left: 'everything live — archived' });
  return {
    operational: op,
    financial: fin,
    contractual: con,
    steps,
    // Out of the money totals once it is financially closed (PRD §4.5: cashflow), and out of the
    // schedule/progress count once operationally closed.
    outOfMoney: fin || con,
    outOfSchedule: op || con,
    fullyClosed: con,
  };
}

/**
 * The portfolio view model.
 *
 * @param {Array} projects the projects THIS USER MAY SEE. Passed in, never fetched here: the
 *   authorised set is `res.locals.projects`, resolved by the scope middleware from the user's
 *   roles. This page leaked every project's name in the 2026-09-30 audit by reading the whole
 *   table, so the service takes the list rather than being able to look one up.
 * @param {{includeClosed?: boolean}} opts
 */
function portfolio(projects, opts = {}) {
  const includeClosed = !!opts.includeClosed;
  const t = thresholds();

  const rows = projects.map((p) => {
    const ex = exclusion(p);
    const h = health(p.id);
    return {
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      contractAmount: Number(p.contract_amount) || 0,
      costToDate: Number(q.costToDate(p.id).n) || 0,
      exclusion: ex,
      health: h,
    };
  });

  // The LIVE sets. Two of them, because the close steps exclude from different places.
  const liveMoney = rows.filter((r) => !r.exclusion.outOfMoney);
  const liveSchedule = rows.filter((r) => !r.exclusion.outOfSchedule);
  const closed = rows.filter((r) => r.exclusion.steps.length > 0);

  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);

  // Which rows are actually on the screen. In the live view that is the money-live set (plus any
  // live-schedule project that is operationally but not financially closed, so the list never
  // silently loses a project the count includes); with the toggle on it is everything.
  const shown = includeClosed ? rows : liveMoney.concat(
    liveSchedule.filter((r) => !liveMoney.includes(r)),
  );

  // Two labelled figures, never one. "Live" and "including closed" — PRD §4.5 says closed projects
  // stay in the history totals forever, so the page must be able to show both rather than
  // pretending the closed ones do not exist.
  //
  // `shown` is a THIRD figure and it is not redundant: it is the sum of the rows actually
  // rendered, so the footer cannot disagree with the table above it. The first version of this
  // file had the live page print the all-projects total in its footer while showing live rows
  // only — two numbers on one screen meaning different things, which is exactly the class of
  // defect this module keeps finding.
  const totals = {
    live: {
      count: liveSchedule.length,
      contract: sum(liveMoney, 'contractAmount'),
      cost: sum(liveMoney, 'costToDate'),
    },
    all: {
      count: rows.length,
      contract: sum(rows, 'contractAmount'),
      cost: sum(rows, 'costToDate'),
    },
    shown: {
      count: shown.length,
      contract: sum(shown, 'contractAmount'),
      cost: sum(shown, 'costToDate'),
    },
  };

  // What the toggle would ADD, named per project with the step it left at. The plan requires the
  // switch to say which projects it is adding and why they were out; a bare count would be a
  // second number nobody can check.
  const added = {
    count: closed.length,
    contract: totals.all.contract - totals.live.contract,
    cost: totals.all.cost - totals.live.cost,
    names: closed.map((r) => ({
      id: r.id, name: r.name, steps: r.exclusion.steps,
    })),
  };

  return {
    rows: shown,
    totals,
    added,
    includeClosed,
    thresholds: t,
    closedCount: closed.length,
  };
}

module.exports = { portfolio, health, exclusion, thresholds, indexState, DEFAULT_THRESHOLD };
