// VR8-series: variance — SV, CV and VAC (module 8, plan part 8.5).
// THIS IS PART 8.5'S GATE. Migration 022's new columns and forecast-service.variance() are the
// change under test.
//
// WHY THIS FILE EXISTS, AND WHAT IT IS REALLY DEFENDING
//
// The product now carries TWO figures that a reader would both call "cost variance", and they
// point in OPPOSITE directions:
//
//   v_evm_period.cost_variance = AC - EV   positive = OVER budget   (018; pinned by EV7.6)
//   v_evm_period.cv            = EV - AC   positive = UNDER budget  (022; standard EVM)
//
// Nothing else in the suite would catch a screen that rendered the wrong one under the label
// "Cost variance": both are plausible numbers of the right magnitude on a real project, and a
// test that only checked "the page shows a number" passes either way. VR8.5 therefore asserts the
// SIGN on a fixture whose shape is known — deliberately over budget, so the correct CV is
// NEGATIVE and the wrong one is positive — and pins that `cost_variance` is still exactly what
// EV7.6 says it is.
//
// The second thing this file defends is the single-computation rule. SV/CV are columns on the view
// (022), not arithmetic repeated in the service, because this module has already been bitten three
// times by a figure derived in two places (013/014/015, then 018, then 019). VR8.4 reads the view
// and the table independently and asserts they agree, and VR8.6 reads the service for one month
// and asserts it is byte-identical to the view's row.
//
// EVERY EXPECTED NUMBER IS WORKED OUT BY HAND IN A COMMENT.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3925;   // 3924 is forecast.test.js, 3926 will be the dashboard.
const PROJECT = 1;   // PRJ-2026 "Citarum Bridge".
const LINE = '3.1';  // Concrete works.
const ACCOUNT = '1.1.1';

const MONTHLY = 100_000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

let fx;
let cbs;
let fcs;
let progress;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-vr8-' });
  [cbs, fcs, progress] = fx.loadMany('src/lib/cbs-service.js', 'src/lib/forecast-service.js',
    'src/lib/progress-service.js');

  const node = line();
  const acct = account();
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, acct.id, MONTHLY, MONTHS.length, BAC);

  cbs.spreadBaseline({
    projectId: PROJECT, accountId: acct.id, wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });
});

after(() => { if (fx) fx.stop(); });

// ---- helpers ---------------------------------------------------------------

const line = () => fx.db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(PROJECT, LINE);
const account = () => fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
const viewRow = (month) => fx.db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(PROJECT, month);

function bookCost(amount, documentNo, month = '2026-03') {
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'vr8')`)
    .run(PROJECT, `${month}-15`, amount, amount, line().id, account().id, documentNo);
}

// Tick N of the line's four 25% milestones for one period.
function tick(n, month = '2026-03') {
  const ms = progress.milestones(line().id);
  const actor = fx.users.get('project_controller');
  for (let i = 0; i < n; i += 1) {
    progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: ms[i].id,
      ticked: true, period: month });
  }
}

// ---------------------------------------------------------------------------
// VR8.1 — the view carries the columns, with the standard-EVM signs
// ---------------------------------------------------------------------------

test('VR8.1 the view emits SV and CV per period and cumulative, with standard-EVM signs', () => {
  // Measure March: half the line complete, and deliberately MORE cost than value earned.
  //
  //   PV (March bucket)                            =   100,000
  //   EV = whole-line budget 1,000,000 x 50%       =   500,000
  //   AC = cost booked                             =   800,000
  //
  //   SV = EV - PV = 500,000 - 100,000             =  +400,000   AHEAD
  //   CV = EV - AC = 500,000 - 800,000             =  -300,000   OVER budget
  //   cost_variance = AC - EV                      =  +300,000   the same fact, opposite sign
  tick(2);
  bookCost(800_000, 'VR8-1');

  const r = viewRow('2026-03');
  assert.strictEqual(r.pv, 100_000, 'PV is March\u2019s bucket');
  assert.strictEqual(r.ev, 500_000, 'EV = 1,000,000 x 50%');
  assert.strictEqual(r.ac, 800_000, 'AC is what was booked');

  assert.strictEqual(r.sv, 400_000, 'SV = EV - PV; POSITIVE means ahead of schedule');
  assert.strictEqual(r.cv, -300_000, 'CV = EV - AC; NEGATIVE means over budget');
  // The two figures describe one situation and disagree in sign. That is the trap this file
  // exists for: a screen that mislabels one of them inverts the verdict.
  assert.strictEqual(r.cost_variance, 300_000,
    '018\u2019s cost_variance is still AC - EV, still exactly what EV7.6 pins \u2014 unchanged by 022');
  assert.strictEqual(r.cv, -r.cost_variance,
    'and the two are exact negatives of each other; if that stops being true, one of them moved');

  // Cumulative on the first month equals the period figures.
  assert.strictEqual(r.sv_cum, 400_000);
  assert.strictEqual(r.cv_cum, -300_000);
});

// ---------------------------------------------------------------------------
// VR8.2 — the cumulative columns accumulate, and each month's arithmetic is its own
// ---------------------------------------------------------------------------

test('VR8.2 the running totals add up month by month and the per-period figures do not', () => {
  // April: nothing new earned, 50,000 more spent.
  //
  //   April PV = 100,000 (the plan continues)   EV = 0   AC = 50,000
  //   April SV = 0 - 100,000 = -100,000   (behind THAT month)
  //   April CV = 0 - 50,000  =  -50,000   (overspent THAT month)
  //
  // Cumulative through April:
  //   PV = 200,000  EV = 500,000  AC = 850,000
  //   SV_cum = 500,000 - 200,000 = +300,000   (still ahead overall)
  //   CV_cum = 500,000 - 850,000 = -350,000   (further over budget)
  bookCost(50_000, 'VR8-2', '2026-04');

  const apr = viewRow('2026-04');
  assert.strictEqual(apr.pv, 100_000, 'April\u2019s own planned value');
  assert.strictEqual(apr.ev, 0, 'nothing was earned in April');
  assert.strictEqual(apr.ac, 50_000, 'and 50,000 was spent');
  assert.strictEqual(apr.sv, -100_000, 'April SV = 0 - 100,000');
  assert.strictEqual(apr.cv, -50_000, 'April CV = 0 - 50,000');

  assert.strictEqual(apr.pv_cum, 200_000, 'cumulative PV = March + April');
  assert.strictEqual(apr.ev_cum, 500_000, 'cumulative EV is unchanged \u2014 nothing was earned');
  assert.strictEqual(apr.ac_cum, 850_000, 'cumulative AC = 800,000 + 50,000');
  assert.strictEqual(apr.sv_cum, 300_000, 'SV_cum = 500,000 - 200,000');
  assert.strictEqual(apr.cv_cum, -350_000, 'CV_cum = 500,000 - 850,000');

  // The property that makes the cumulative column trustworthy: it is the running SUM of the
  // per-period figures, not a separately-derived number that happens to look similar. Checked
  // against the table rather than against another service call.
  const upTo = fx.db.prepare(`SELECT SUM(sv) s_sv, SUM(cv) s_cv FROM v_evm_period
    WHERE project_id = ? AND period_month <= '2026-04'`).get(PROJECT);
  assert.strictEqual(upTo.s_sv, apr.sv_cum, 'sum of the monthly SVs equals SV_cum');
  assert.strictEqual(upTo.s_cv, apr.cv_cum, 'sum of the monthly CVs equals CV_cum');

  // And the two scales must not contradict each other: a month can be behind while the project
  // is ahead. That is exactly the case here, and a test that only checked one scale would miss a
  // view that had accidentally wired the cumulative column to the monthly CTE.
  assert.ok(apr.sv < 0 && apr.sv_cum > 0,
    'April is behind for the month while the project is ahead overall \u2014 both facts stand');
});

// ---------------------------------------------------------------------------
// VR8.3 — percentages, and their blank rule
// ---------------------------------------------------------------------------

test('VR8.3 percentages are measured against the right base and are blank without one', () => {
  const v = fcs.variance(PROJECT);

  const apr = v.months.find((m) => m.period_month === '2026-04');
  // SV% against cumulative PV: 300,000 / 200,000 = 150%
  assert.strictEqual(apr.sv_pct, 150, 'SV% = SV_cum / PV_cum = 300,000 / 200,000');
  // CV% against cumulative AC (what the overspend is measured against):
  //   -350,000 / 850,000 = -41.176...%  -> rounded to 2dp
  assert.strictEqual(apr.cv_pct, -41.18, 'CV% = CV_cum / AC_cum = -350,000 / 850,000, 2dp');

  // March on its own: SV_cum 400,000 against PV_cum 100,000 = 400% — the project is four times
  // further ahead than the plan for that date, because half the whole line was completed in the
  // first month of a ten-month plan.
  const mar = v.months.find((m) => m.period_month === '2026-03');
  assert.strictEqual(mar.sv_pct, 400, 'March SV% = 400,000 / 100,000 = 400%');
  assert.strictEqual(mar.cv_pct, -37.5, 'March CV% = -300,000 / 800,000 = -37.5%');

  // Now the blank: a project whose plan exists but which has neither spent nor earned anything.
  const other = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status) VALUES ('VR8-EMPTY', 'Nothing measured', 1000000, 'IDR', 'active')`)
    .run().lastInsertRowid);
  const nodeId = Number(fx.db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name,
      sort_order, version) VALUES (?, '1', 'A line', 10, 1)`).run(other).lastInsertRowid);
  fx.db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id, plan_type,
      version, period_month, amount) VALUES (?, ?, ?, 'baseline', 1, '2026-05', 500000)`)
    .run(other, account().id, nodeId);

  const empty = fcs.variance(other);
  const may = empty.months.find((m) => m.period_month === '2026-05');
  assert.ok(may, 'the planned month is on the grid');
  // With PV 500,000 and EV 0 the SV denominator is NOT zero, so SV% is a real, honest -100%.
  assert.strictEqual(may.sv_pct, -100,
    'this project is behind by the whole planned value: SV_cum -500,000 / PV_cum 500,000');
  assert.strictEqual(may.cv_pct, null,
    'AC_cum is 0, so CV% has no denominator and is BLANK \u2014 not 0%, which would read as "no '
    + 'overspend" when in fact nothing has been spent at all');
});

// ---------------------------------------------------------------------------
// VR8.4 — the view is the single computation; nothing re-derives it
// ---------------------------------------------------------------------------

test('VR8.4 SV and CV are columns on the view, not arithmetic repeated in the service', () => {
  // Read the service's output and the view's raw rows and compare field by field. If the service
  // ever started re-deriving SV/CV, a rounding or COALESCE difference would show up here.
  const v = fcs.variance(PROJECT);
  for (const m of v.months) {
    const raw = viewRow(m.period_month);
    assert.strictEqual(m.sv, raw.sv, `${m.period_month}: service SV is the view's column`);
    assert.strictEqual(m.cv, raw.cv, `${m.period_month}: service CV is the view's column`);
    assert.strictEqual(m.sv_cum, raw.sv_cum, `${m.period_month}: SV_cum comes from the view`);
    assert.strictEqual(m.cv_cum, raw.cv_cum, `${m.period_month}: CV_cum comes from the view`);
    // And the identity the migration promises, checked on the actual figures.
    assert.strictEqual(m.sv, m.ev - m.pv, `${m.period_month}: SV = EV - PV`);
    assert.strictEqual(m.cv, m.ev - m.ac, `${m.period_month}: CV = EV - AC`);
  }

  // The migration must be additive: the columns that existed before are unchanged. EV7.6 pins
  // `cost_variance`, and 022 must not have moved it.
  const mar = viewRow('2026-03');
  assert.strictEqual(mar.cost_variance, mar.ac - mar.ev,
    'cost_variance is still AC - EV after 022 \u2014 the migration is additive');
  assert.strictEqual(mar.spi, 5, 'and SPI is untouched: EV/PV = 500,000/100,000');
  assert.strictEqual(mar.cpi, 0.625,
    'and CPI is untouched: EV/AC = 500,000/800,000 = 0.625 exactly (4dp leaves it alone)');
});

// ---------------------------------------------------------------------------
// VR8.5 — the sign convention, pinned to a known-shape example
// ---------------------------------------------------------------------------

test('VR8.5 over budget gives a NEGATIVE CV — the convention is pinned so it cannot be "fixed"', () => {
  // A project deliberately, unambiguously over budget: half the work done, twice the cost.
  //
  //   EV = 500,000   AC = 800,000   ->  CV = EV - AC = -300,000  (NEGATIVE = over budget)
  //
  // If somebody later "corrects" CV to AC - EV to match `cost_variance`, this assertion goes
  // positive and fails — which is the point. The name CV has one meaning in EVM and this pins it.
  const r = viewRow('2026-03');
  assert.strictEqual(r.ac > r.ev, true, 'precondition: more was spent than earned');
  assert.ok(r.cv < 0, 'over budget => CV NEGATIVE');
  assert.ok(r.cost_variance > 0,
    'and the ledger-side figure is POSITIVE for the same month \u2014 opposite signs, by design');

  // The service states the convention as data, so a view cannot render a sign without a meaning.
  const v = fcs.variance(PROJECT);
  assert.match(v.sign.cv, /positive means under budget/i, 'the CV convention is stated');
  assert.match(v.sign.sv, /positive means ahead/i, 'the SV convention is stated');
  assert.match(v.sign.cost_variance, /opposite/i,
    'and the ledger-side figure is flagged as opposite, so nobody renders it as CV');
});

// ---------------------------------------------------------------------------
// VR8.6 — VAC travels with the estimate, and is blank when the estimate is
// ---------------------------------------------------------------------------

test('VR8.6 VAC = BAC - EAC, and is BLANK with the reason when there is no EAC', () => {
  // From the figures so far: BAC 1,000,000, cumulative CPI = 500,000 / 850,000 = 0.588235...
  //   EAC = 1,000,000 / (500,000/850,000) = 1,000,000 x 850,000/500,000 = 1,700,000
  //   VAC = 1,000,000 - 1,700,000 = -700,000  (NEGATIVE = expected to finish OVER budget)
  //
  // EAC is rounded to whole rupiah in `eac()`; with an exact 1,700,000 here the rounding is a
  // no-op, which keeps the hand-computation exact rather than approximate.
  const v = fcs.variance(PROJECT);
  assert.strictEqual(v.bac, BAC, 'BAC is the approved plan total');
  assert.strictEqual(v.eac, 1_700_000, 'EAC = BAC / CPI_cum = 1,000,000 / (500,000/850,000)');
  assert.strictEqual(v.vac, -700_000, 'VAC = BAC - EAC; NEGATIVE means over budget at the end');
  assert.ok(v.vac < 0, 'and the sign means the same as CV does \u2014 over is negative');

  // The estimate is dated by the month it was MEASURED, and by the LAST such month. VR8.2
  // recorded cost in April, so April is now the later measured month and the estimate is dated
  // there — the same rule the forecast screen uses, via the same `latestCumulative` helper, so
  // the two screens cannot disagree about "as at". The forecast screen's own test (FC8.2) pins
  // the other side of this: it dates its estimate at March because nothing was measured after it.
  // April's cumulative CPI = EV_cum/AC_cum = 500,000/850,000, so EAC = 1,000,000 x 850,000/500,000.
  const aprRow = viewRow('2026-04');
  assert.strictEqual(aprRow.ac, 50_000, 'precondition: April carries a measurement');
  assert.strictEqual(v.eac_month, aprRow.period_month,
    'dated at the latest month with a measurement, which is April after VR8.2');

  // A project with a plan but no measurement has no estimate, so no VAC — and the reason travels
  // with it rather than being left for the view to reconstruct.
  const other = fx.db.prepare("SELECT id FROM projects WHERE code = 'VR8-EMPTY'").get().id;
  const v2 = fcs.variance(other);
  assert.strictEqual(v2.eac, null, 'no measurement => no estimate');
  assert.strictEqual(v2.vac, null, 'and therefore no variance at completion');
  assert.ok(v2.reason, 'with the reason attached');
  assert.strictEqual(v2.at, null, 'and no "current month" to report figures for');
});

// ---------------------------------------------------------------------------
// VR8.7 — the screen, over HTTP: it renders, states the sign convention, and a Viewer MAY read it
// ---------------------------------------------------------------------------

test('VR8.7 the report renders, prints the sign convention, and a Viewer may read it', async () => {
  // AUTHORIZATION: this one is a decision, not a default, and it is asserted in BOTH directions.
  //
  // The variance report is READ-ONLY — there is no write path on it at all — and PRD §5.4 hands
  // "EVM trend" and the project dashboard to the PM, the Controller AND the exec/Viewer portfolio
  // view. So a Viewer MAY open it: `canViewForecast` is `true` on purpose and this page reads it.
  //
  // The boundary that IS enforced is the WRITE, on the same project's forecast, and that is
  // asserted below — a tight write gate with an open read gate. Pinning the read as allowed here
  // matters as much as pinning the refusal: a later change that locked Viewers out of the project
  // dashboard would fail this test rather than quietly shipping.
  const viewer = fx.clients.get('viewer');
  const allowed = await viewer.get('/reports/variance');
  assert.strictEqual(allowed.status, 200,
    'a Viewer may READ the variance report — PRD §5.4 gives EVM trend to the exec portfolio view, '
    + 'and the report has no write path to protect');
  const viewerHtml = await allowed.text();
  assert.ok(/Schedule variance/i.test(viewerHtml),
    'and gets the same figures, not a silently shortened page');

  // The WRITE on the same router stays restricted. A Viewer submitting the forecast form must be
  // refused WITH a reason, and the refusal must write nothing.
  const before = fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'")
    .get().n;
  const refusedWrite = await fx.post(viewer, '/reports/forecast',
    { transaction_account_id: account().id, period_month: '2026-08', amount: '42' });
  assert.strictEqual(refusedWrite.status, 403,
    'whatever the read gate says, a Viewer cannot SET the forecast');
  assert.match(await refusedWrite.text(), /Cost Controller/,
    'and is told whose job it is');
  assert.strictEqual(
    fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'").get().n,
    before, 'and the refusal wrote nothing');

  const cc = fx.clients.get('cost_controller');
  const res = await cc.get('/reports/variance');
  assert.strictEqual(res.status, 200, 'the Cost Controller can open it');
  const html = await res.text();

  assert.ok(html.includes('Schedule variance'), 'the two variances are named');
  assert.ok(html.includes('Cost variance'), 'including CV by name');
  assert.ok(/positive means ahead of schedule/i.test(html),
    'the SV convention is printed, not assumed');
  assert.ok(/positive means under budget/i.test(html),
    'the CV convention is printed \u2014 this is the assertion that stops a sign inversion shipping');
  assert.ok(/opposite/i.test(html),
    'and the ledger-side figure is named as opposite, so the two cannot be conflated on screen');

  // The hand-computed figures reach the page, signed.
  assert.ok(html.includes('400,000'), 'SV of +400,000 is rendered');
  assert.ok(html.includes('300,000'), 'CV magnitude 300,000 is rendered');
  // The trend table carries the months that have something recorded.
  assert.ok(html.includes('2026-03') && html.includes('2026-04'),
    'the months with data are in the trend table');

  // The empty months are omitted by default AND the page says how many — a chart of nothing but
  // flat zeroes would look like steady performance rather than an absence of measurement.
  const v = fcs.variance(PROJECT);
  if (v.omitted > 0) {
    assert.ok(new RegExp(`${v.omitted} month`).test(html),
      `the page states that ${v.omitted} empty months are hidden, rather than hiding them silently`);
  }
  // And they can be asked for.
  const all = await cc.get('/reports/variance?all=1');
  assert.strictEqual(all.status, 200, '?all=1 is a real page, not an error');
  const allHtml = await all.text();
  assert.ok(allHtml.includes('2026-12'),
    'with every planned month shown, including the ones nobody has measured');
});
