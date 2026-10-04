// Chart data for the project dashboard (module 8, plan part 8.6).
//
// PRD §5.4: "EVM S-curves (project dashboard): PV from baseline (CBS monthly buckets), EV from
// ticks×CBS (internal, not BAST), AC from ledger actuals. Calendar-rendered."
//
// WHY THE NUMBERS ARE BUILT HERE, IN NODE, AND NOT IN THE PAGE SCRIPT
//
// The charts are drawn by Chart.js, which runs in the browser and paints a <canvas>. **A canvas
// cannot be asserted on in this environment** — headless Chrome is unreliable on this 2 GB
// no-swap host, and a test that drove a browser to read pixels would be both flaky and unreadable.
// If the arithmetic lived in the page script, this part would therefore ship a chart nobody had
// ever checked.
//
// So the arithmetic lives here and this module is PURE: no DOM, no request, no Chart.js. It takes
// a project id and returns a plain object. The view serialises that object into a
// <script type="application/json"> block (the pattern views/project-new.ejs:8 already uses for
// `terms-by-client`) and a small nonce'd script hands it to Chart.js. **The browser script contains
// no figures at all** — it reads the JSON and configures the library. DB8.6 asserts that, so the
// separation cannot rot into "some numbers drifted back into the view".
//
// WHERE EVERY NUMBER COMES FROM — and what is NOT re-derived
//
// `v_evm_period` is the single home of the EVM maths: it merges the baseline (PV), the WBS
// progress ticks (EV) and the cost actuals (AC) onto one month grid and computes the running
// totals. **This module reads that view and never recomputes it.** The rule this product has been
// bitten by four times now (013/014/015, 018, 019, 022) is that a figure derived in two places
// eventually disagrees with itself, and a dashboard that disagrees with the report under it is
// worse than no dashboard.
//
// The "as at" month comes from `forecast-service.latestCumulative()` — the SAME helper the
// forecast and variance screens use. That is deliberate: three screens now show EVM figures, and
// if they each decided independently which month was "current" they would eventually disagree.
'use strict';

const db = require('../db/db');
const cbs = require('./cbs-service');
const forecast = require('./forecast-service');

// The three series, in the order PRD §5.4 names them. The colours are fixed here rather than in
// the view so the legend, the chart and the table underneath cannot drift apart, and so a test can
// assert that the series it read out of the JSON is the series the page labels.
const SERIES = [
  { key: 'pv', label: 'Planned (PV)', colour: '#6b7280' },
  { key: 'ev', label: 'Earned (EV)', colour: '#15803d' },
  { key: 'ac', label: 'Actual (AC)', colour: '#b91c1c' },
];

function project(projectId) {
  const p = db.prepare('SELECT id, code, name, status FROM projects WHERE id = ?')
    .get(Number(projectId));
  if (!p) {
    const err = new Error('That project does not exist.');
    err.status = 404;
    throw err;
  }
  return p;
}

// The month grid, cumulative figures per month, read straight from v_evm_period.
function grid(projectId) {
  return db.prepare(`SELECT period_month, pv, ev, ac, pv_cum, ev_cum, ac_cum, spi_cum, cpi_cum
    FROM v_evm_period WHERE project_id = ? ORDER BY period_month`).all(Number(projectId));
}

// A month in which something HAPPENED, judged on the per-period figures: planned spend, earned
// value or cost. This is the right test for the bars, which draw one month on its own — a month
// with three zeroes has no bar to draw.
const isMeasured = (r) => r.pv !== 0 || r.ev !== 0 || r.ac !== 0;

// A month the project has REACHED, judged on the CUMULATIVE figures. Deliberately a different
// test from `isMeasured`, and the difference is not cosmetic:
//
// A project whose budget is spread from March, with no progress ticked and no cost booked yet,
// has a non-zero `pv_cum` (100,000 in March, 200,000 in April, ...) but every PER-PERIOD test that
// looked for earned or actual value would say "nothing measured". This function first used
// `isMeasured` and therefore told such a project "nothing has been measured against the budget",
// while the budget, the plan and the calendar were all sitting right there — a flatly wrong
// sentence, and the exact failure mode this module keeps guarding against: a blank that says the
// wrong thing. DB8.3 caught it.
const reached = (r) => r.pv_cum !== 0 || r.ev_cum !== 0 || r.ac_cum !== 0;

/**
 * The S-curve: three cumulative series on one calendar axis.
 *
 * Returns a plain, serialisable object. `labels` are the months the chart draws; each dataset's
 * `data` is aligned to `labels` by index — the alignment is done here, once, so the view cannot
 * mis-pair a value with a month.
 *
 * EMPTY STATES ARE RETURNED, NOT FAKED. There are three genuinely different reasons a dashboard
 * can have nothing to draw, and each gets its own sentence, because the thing the reader should
 * go and do is different in each case:
 *
 *   - no cost baseline at all      → "set the budget" (the common case on a new project)
 *   - a baseline but nothing measured → "record progress and book cost"
 *   - measured, but all three series zero → the grid exists and is empty of facts
 *
 * A flat line at zero would answer none of those, and is the shape of a bug rather than a fact.
 */
function scurve(projectId) {
  const p = project(projectId);
  const bac = cbs.baselineTotal(p.id);
  const rows = grid(p.id);

  // Months the project has REACHED — cumulative, not per-period. See `reached`: a project whose
  // budget has begun but which has earned nothing and spent nothing still has a planned-value
  // curve, and saying "nothing has been measured" about it would be wrong.
  const drawnMonths = rows.filter(reached);

  const out = {
    project: p,
    labels: [],
    datasets: [],
    series: SERIES,
    bac,
    yMax: 0,
    points: 0,
    emptyReason: null,
    // Filled from the same helper the forecast screen uses, so the two agree by construction.
    asAt: null,
    spiCum: null,
    cpiCum: null,
  };

  if (!bac) {
    // No baseline. Note this is checked FIRST and independently of `rows`: a project can have
    // cost in the ledger (so `rows` is non-empty) and still have nothing to compare against,
    // which is exactly the state the real development database is in. Reporting that as
    // "nothing recorded" would be false — there IS recorded cost, there is just no plan yet.
    out.emptyReason = rows.length
      ? 'This project has cost recorded against it but no approved cost baseline, so there is no '
        + 'planned-value curve to compare against. Set the budget and the S-curve will follow.'
      : 'This project has no approved cost baseline yet, so there is nothing to chart. Set the '
        + 'budget first.';
    return out;
  }

  if (!drawnMonths.length) {
    out.emptyReason = 'The budget is set but nothing has been measured against it yet. Record '
      + 'progress against the work lines and book cost, and the earned-value curve will appear.';
    return out;
  }

  // Every month from the first one the project reached onward. Starting the axis at the first
  // such month rather than at the project's first month keeps the chart about what happened; a
  // year of nothing in front of the first figure is noise.
  const first = drawnMonths[0].period_month;
  const drawn = rows.filter((r) => r.period_month >= first);

  out.labels = drawn.map((r) => r.period_month);
  out.datasets = SERIES.map((s) => ({
    label: s.label,
    key: s.key,
    colour: s.colour,
    // Cumulative, because an S-curve is a running total by definition. `*_cum` are columns on the
    // view (019), not sums taken here — the view already did that once, from base tables.
    data: drawn.map((r) => r[`${s.key}_cum`]),
  }));

  // The Y scale, stated so the page can print it (a reader can then check a point by hand) and
  // so it cannot be silently rescaled by an outlier the reader never sees. Rounded UP to a
  // readable step so the top gridline is not a ragged number.
  const peak = Math.max(...out.datasets.flatMap((d) => d.data), bac);
  const step = Math.pow(10, Math.max(0, String(Math.round(peak)).length - 1));
  out.yMax = Math.ceil(peak / step) * step;

  out.points = drawn.length;

  const latest = forecast.latestCumulative(p.id);
  if (latest) {
    out.asAt = latest.period_month;
    out.spiCum = latest.spi_cum;
    out.cpiCum = latest.cpi_cum;
  }

  return out;
}

/**
 * Per-period bars: planned vs earned vs actual for ONE month, not cumulative.
 *
 * This is the deliberate counterpart to the S-curve. The cumulative curve hides a bad month
 * inside a good history; the bars show that month on its own. Same source, same months, no
 * second computation — a bar and the curve above it are the same `pv`/`ev`/`ac` column values
 * read at different granularity.
 */
function bars(projectId, opts = {}) {
  const p = project(projectId);
  const rows = grid(p.id).filter(isMeasured);
  // Default to the most recent measured months — the bars are about "what has been happening",
  // not about the whole calendar.
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 6;
  const drawn = rows.slice(-limit);

  const peak = drawn.length
    ? Math.max(...drawn.map((r) => Math.max(r.pv, r.ev, r.ac)))
    : 0;
  const step = peak ? Math.pow(10, Math.max(0, String(Math.round(peak)).length - 1)) : 1;

  return {
    project: p,
    labels: drawn.map((r) => r.period_month),
    datasets: SERIES.map((s) => ({
      label: s.label,
      key: s.key,
      colour: s.colour,
      data: drawn.map((r) => r[s.key]),
    })),
    yMax: peak ? Math.ceil(peak / step) * step : 0,
    points: drawn.length,
    emptyReason: drawn.length ? null
      : 'No month has been measured yet, so there is nothing to compare period by period.',
  };
}

/** Both charts plus the headline tiles, for one render. */
function dashboard(projectId) {
  const p = project(projectId);
  const eac = forecast.eac(p.id);
  return { project: p, curve: scurve(p.id), bars: bars(p.id), eac };
}

module.exports = { scurve, bars, dashboard, grid, SERIES, isMeasured, reached };
