// PF8-series: the portfolio dashboard + closed-project hiding (module 8, plan part 8.7).
// THIS IS PART 8.7'S GATE.
//
// WHAT THIS FILE DEFENDS. The screen is a grid of traffic-light tiles and two money totals, and it
// has three ways to lie that all look fine on a rendered page:
//
//   1. PAINT AN UNMEASURED PROJECT RED. Every row of v_evm_period on real data has spi_cum = NULL
//      and cpi_cum = NULL. A tile that compared SQL 0 against a 0.95 threshold would say the
//      project is in breach. PF8.3 pins grey-not-green-not-red with NULL, and PF8.4 pins that a
//      genuine breach at a hand-computed value either side of the threshold goes red and green —
//      so the grey is not simply "everything is grey".
//   2. HIDE A CLOSED PROJECT AND SAY NOTHING. PF8.5/PF8.6 pin that the live total is smaller, the
//      toggle adds exactly the difference, and the same project shows the SAME figure in both.
//   3. COUNT A PROJECT THE USER MAY NOT SEE. This exact page leaked project names in the
//      2026-09-30 audit. PF8.9 pins that the totals equal the sum over the AUTHORISED set only.
//
// The threshold is asserted as READ FROM SETTINGS (PF8.8 changes the row and watches the tile
// change), because a hard-coded 0.95 would make PRD §4.4's "tunable" untrue.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3927;   // 3926 is dashboard.test.js, 3928 will be revenue.
const PROJECT = 1;
const ACCOUNT = '1.1.1';
const LINE = '3.1';

const MONTHLY = 100_000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

let fx;
let portfolio;
let cbs;
let progress;
let ids = {};

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-pf8-' });
  [portfolio, cbs, progress] = fx.loadMany('src/lib/portfolio-service.js',
    'src/lib/cbs-service.js', 'src/lib/progress-service.js');

  const node = fx.db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? LIMIT 1')
    .get(PROJECT, LINE);
  const acct = fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);

  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, acct.id, MONTHLY, MONTHS.length, BAC);

  cbs.spreadBaseline({
    projectId: PROJECT, accountId: acct.id, wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });

  // An ACTUAL overrun big enough to be an unambiguous breach, driven to a hand-computed index.
  // 1/10 of the budget is planned by March (100,000). Earn 50%, i.e. EV 500,000, for AC 900,000:
  //   SPI_cum = EV/PV = 500,000 / 100,000 = 5.00   (ahead of schedule)
  //   CPI_cum = EV/AC = 500,000 / 900,000 = 0.5555 (well under 0.95 -> breached)
  // This is the same shape the 8.5 variance work measured: a large early EV against a small
  // monthly plan makes SPI look enormous. It is a fixture artifact, and PF8.4 says so.
  const ms = progress.milestones(node.id);
  const actor = fx.users.get('project_controller');
  for (let i = 0; i < 2; i += 1) {
    progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: ms[i].id,
      ticked: true, period: '2026-03' });
  }
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, '2026-03-15', 'Expense', 'expense', 1, 'manual', 900000, 900000, 0, ?, ?, 'PF8-1', 'pf8')`)
    .run(PROJECT, node.id, acct.id);

  // The index really is what the hand computation says. If this fails the fixture is wrong, and
  // every threshold assertion below would be meaningless.
  //
  // NOTE THE TOLERANCE, and why it is 1e-3 and not 1e-9. The view rounds its indices with
  // ROUND(x, 4) (migration 019, lines 151-152), so cpi_cum is exactly 0.5556 — LEGIBLY different
  // from the true 5/9 = 0.55555... This is the same rounding that produced the Part 8.5 EAC defect
  // (dividing by the rounded cpi_cum inflated an estimate by ~0.006%). The assertion is written
  // against what the view actually emits, with the reason recorded, rather than an idealised value
  // that would make this file fail for a reason unrelated to the portfolio screen.
  const row = fx.db.prepare(`SELECT spi_cum, cpi_cum FROM v_evm_period
      WHERE project_id = ? AND period_month = '2026-03'`).get(PROJECT);
  assert.strictEqual(Number(row.spi_cum), 5, 'fixture: SPI_cum = EV/PV = 500,000 / 100,000');
  assert.strictEqual(Number(row.cpi_cum), 0.5556,
    'fixture: CPI_cum = ROUND(EV/AC, 4) = ROUND(5/9, 4) = 0.5556');

  ids.live = PROJECT;
  ids.closed = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, status,
      project_type_id, start_date, end_date)
      VALUES ('PF8-CLOSED', 'Finished Bridge', 4000000, 'closed', NULL, '2025-01-01', '2025-12-31')`)
    .run().lastInsertRowid);
  // Operationally + financially closed, NOT contractually: PRD §4.5 puts that step out of the
  // live schedule AND live cashflow, while leaving it reportable. The three stamps are set
  // separately on purpose so the test can tell the steps apart.
  fx.db.prepare(`UPDATE projects SET close_operational_at = '2026-01-15',
      close_financial_at = '2026-02-20' WHERE id = ?`).run(ids.closed);
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis,
      source, amount, debit, credit, document_no, description)
      VALUES (?, '2026-02-01', 'Expense', 'expense', 1, 'manual', 250000, 250000, 0, 'PF8-C', 'pf8')`)
    .run(ids.closed);

  ids.measurable = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, status)
      VALUES ('PF8-NEW', 'Not measured at all', 2000000, 'active')`).run().lastInsertRowid);
});

after(() => { if (fx) fx.stop(); });

const client = () => fx.clients.get('cost_controller');
const rowFor = (vm, id) => vm.rows.find((r) => r.id === id);

// The authorised list, exactly as the scope middleware would hand it over.
const authorised = () => fx.db.prepare('SELECT * FROM projects ORDER BY id').all();

// ---------------------------------------------------------------------------
// PF8.1 — the three index states, as a unit
// ---------------------------------------------------------------------------

test('PF8.1 an index is not-measured, within or breached \u2014 and NULL is its own state', () => {
  // The rule the whole screen depends on, tested directly. 0.95 is the PRD §4.4 default.
  const T = 0.95;

  // NULL and undefined are NOT zero. This is the case real data is in.
  assert.strictEqual(portfolio.indexState(null, T), 'not-measured');
  assert.strictEqual(portfolio.indexState(undefined, T), 'not-measured');

  // A real zero is not NULL and IS a breach: a project that has earned nothing against planned
  // work is 100% behind, and calling that "not measured" would hide a real problem.
  assert.strictEqual(portfolio.indexState(0, T), 'breached',
    'a genuine 0 is a breach, not a blank \u2014 0 <= 0.95');

  // Either side of the threshold, hand-picked.
  assert.strictEqual(portfolio.indexState(0.94, T), 'breached');
  assert.strictEqual(portfolio.indexState(0.95, T), 'within', 'the threshold itself is within');
  assert.strictEqual(portfolio.indexState(1.0, T), 'within');

  // And the state is decided by the THRESHOLD PASSED IN, not a constant in the comparison.
  assert.strictEqual(portfolio.indexState(0.97, 0.99), 'breached', 'a raised threshold reclassifies');
  assert.strictEqual(portfolio.indexState(0.97, 0.95), 'within');
});

// ---------------------------------------------------------------------------
// PF8.2 — a project with nothing measured reports NOT MEASURED, not a breach
// ---------------------------------------------------------------------------

test('PF8.2 a project with no measurement is grey, not red \u2014 the trap this screen exists around', () => {
  const h = portfolio.health(ids.measurable);

  assert.strictEqual(h.measured, false, 'nothing has been measured for this project');
  assert.strictEqual(h.spi, null, 'so there is no SPI');
  assert.strictEqual(h.cpi, null, 'and no CPI');
  assert.strictEqual(h.spiState, 'not-measured', 'SPI is the grey state');
  assert.strictEqual(h.cpiState, 'not-measured', 'and CPI is too');

  // The failure mode stated as an assertion: if a blank were treated as 0 it would be a breach.
  assert.notStrictEqual(h.spiState, 'breached',
    'a blank index must never render as a breach \u2014 that is the whole point of 018/019');

  // The same project through the view model, so the state survives the aggregation.
  const vm = portfolio.portfolio(authorised());
  const r = rowFor(vm, ids.measurable);
  assert.strictEqual(r.health.spiState, 'not-measured');
  assert.strictEqual(r.health.cpiState, 'not-measured');
  assert.strictEqual(r.health.measured, false);
});

// ---------------------------------------------------------------------------
// PF8.3 — the measured project: one real breach, one genuine within
// ---------------------------------------------------------------------------

test('PF8.3 the measured project reports each index on its own evidence', () => {
  const h = portfolio.health(PROJECT);

  assert.strictEqual(h.measured, true, 'this project HAS a measurement');
  assert.strictEqual(h.month, '2026-03', 'dated by the month it was measured');

  // Hand-computed in the fixture: SPI 5.00, CPI 5/9 = 0.5556. Compared with a small tolerance
  // rather than exactly, because the VIEW rounds cpi_cum to 4 decimals (0.5556, not 5/9) — the
  // same rounding that caused the Part 8.5 EAC defect. Asserting exact equality here would fail
  // for a reason that has nothing to do with this screen.
  assert.ok(Math.abs(h.spi - 5) < 1e-9, 'SPI_cum = 5.00');
  assert.strictEqual(h.cpi, 0.5556, 'CPI_cum = ROUND(5/9, 4) = 0.5556, as the view emits it');

  // SAME PROJECT, TWO DIFFERENT VERDICTS. This is why each index carries its own state, and why
  // colouring the row once would hide half the truth: the project is well ahead on schedule and
  // badly over budget at the same time.
  assert.strictEqual(h.spiState, 'within', 'SPI 5.00 is above the 0.95 threshold');
  assert.strictEqual(h.cpiState, 'breached', 'CPI 0.5556 is below it');

  // The threshold in force is carried with the reading, so a caller never has to guess it.
  assert.strictEqual(h.threshold.spi, 0.95);
  assert.strictEqual(h.threshold.cpi, 0.95);
});

// ---------------------------------------------------------------------------
// PF8.4 — the CUMULATIVE columns are used, never the per-period ones (decision 7.9A)
// ---------------------------------------------------------------------------

test('PF8.4 health is dated by the last month with a REAL measurement, not the last row', () => {
  // THE TRAP, and this test is the record of it. Migration 019 carries the cumulative figures
  // FORWARD across the month grid, so `spi_cum`/`cpi_cum` are NON-NULL all the way to the end of
  // the calendar even though nothing was measured after March. A naive "latest row with a
  // cumulative index" therefore reads 2026-12 — a month the project has not reached — and would
  // date the health tile seven months in the future.
  //
  // This is the same defect Part 8.4 found and fixed in the forecast (it read 2026-12 there too).
  // `forecast.latestCumulative` carries the guard that excludes carried-forward months; the
  // portfolio service REUSES that helper precisely so the two screens cannot disagree.
  const naive = fx.db.prepare(`SELECT period_month FROM v_evm_period
      WHERE project_id = ? AND spi_cum IS NOT NULL
      ORDER BY period_month DESC LIMIT 1`).get(PROJECT);
  assert.strictEqual(naive.period_month, '2026-12',
    'naive query: the cumulative index is carried forward to the end of the grid');

  const h = portfolio.health(PROJECT);
  assert.strictEqual(h.month, '2026-03',
    'the service dates the reading by the last month ACTUALLY measured, not the last row');

  // The evidence that the guard is what makes the difference: December HAS an index, but nothing
  // happened in December.
  const dec = fx.db.prepare(`SELECT spi_cum, ev, ac FROM v_evm_period
      WHERE project_id = ? AND period_month = '2026-12'`).get(PROJECT);
  assert.notStrictEqual(dec.spi_cum, null, 'December carries an index forward');
  assert.strictEqual(dec.ev, 0, 'but nothing was earned in December');
  assert.strictEqual(dec.ac, 0, 'and nothing was spent \u2014 so it is not a measurement');

  // And the reading is the CUMULATIVE column of the real measurement month.
  const mar = fx.db.prepare(`SELECT spi_cum, cpi_cum FROM v_evm_period
      WHERE project_id = ? AND period_month = '2026-03'`).get(PROJECT);
  assert.strictEqual(h.spi, Number(mar.spi_cum), 'the SPI is March\u2019s cumulative figure');
  assert.strictEqual(h.cpi, Number(mar.cpi_cum), 'and so is the CPI');
});

// ---------------------------------------------------------------------------
// PF8.5 — closed projects: out of live, in under the toggle, same figure both ways
// ---------------------------------------------------------------------------

test('PF8.5 a closed project is out of the live totals and back under the toggle, unchanged', () => {
  const live = portfolio.portfolio(authorised(), { includeClosed: false });
  const all = portfolio.portfolio(authorised(), { includeClosed: true });

  // PRD §4.5: operationally + financially closed is out of the live schedule and cashflow.
  assert.strictEqual(rowFor(live, ids.closed), undefined,
    'the financially/operationally closed project is not in the live list');

  // And present when the toggle asks for it.
  const back = rowFor(all, ids.closed);
  assert.ok(back, 'the toggle brings it back');

  // THE SAME FIGURE in both places. A toggle that showed a different number for the closed
  // project would mean the exclusion was filtering more than it said it was.
  const liveCost = Number(fx.db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM v_ledger_period
      WHERE project_id = ? AND in_cost_basis = 1 AND line_role IN ('expense','payable','tax')`)
    .get(ids.closed).n);
  assert.strictEqual(back.costToDate, liveCost, 'the closed project shows its real cost to date');
  assert.strictEqual(back.contractAmount, 4_000_000, 'and its real contract value');

  // Totals. The expected figures are READ FROM THE DATABASE rather than hardcoded: the fixture
  // seeder gives project 1 a contract value of its own choosing, and a hardcoded number here
  // would fail for a reason that has nothing to do with this screen (the same mistake as the
  // RP8 `PRJ-2026` and DB8 project-name assertions).
  const contractOf = (id) => Number(
    fx.db.prepare('SELECT contract_amount FROM projects WHERE id = ?').get(id).contract_amount) || 0;
  const openContract = contractOf(PROJECT) + contractOf(ids.measurable);

  assert.strictEqual(live.totals.live.contract, openContract,
    'live contract value is the sum over the OPEN projects only');
  assert.strictEqual(all.totals.all.contract, openContract + 4_000_000,
    'and including closed adds the closed project\u2019s own contract value');

  // The figure the live page PRINTS is the sum of the rows it renders. This is the anti-footgun:
  // an earlier version of this service printed the all-projects total in the footer of a page
  // that showed live rows only, so the footer disagreed with the table above it.
  assert.strictEqual(live.totals.shown.contract, live.totals.shown.contract, 'shown is computed');
  assert.strictEqual(
    live.totals.shown.contract,
    live.rows.reduce((s, r) => s + r.contractAmount, 0),
    'the printed total IS the sum of the rows rendered');

  // The difference the toggle advertises is exactly what it adds \u2014 not an estimate.
  assert.strictEqual(live.added.contract, 4_000_000,
    'the advertised addition is the closed project\u2019s own contract value');
  assert.strictEqual(all.totals.all.contract - live.totals.live.contract, live.added.contract,
    'and it reconciles: all - live = what the toggle said it would add');

  // PRD §4.5: closed projects remain in history totals forever, so the "all" figure is a real
  // reporting number, not a debug view.
  assert.ok(all.totals.all.contract > all.totals.live.contract,
    'including closed is strictly the larger figure while anything is closed');
});

// ---------------------------------------------------------------------------
// PF8.6 — each close step excludes from ITS OWN list and the toggle names it
// ---------------------------------------------------------------------------

test('PF8.6 each close step is recorded, and the toggle names the project and the step', () => {
  const vm = portfolio.portfolio(authorised(), { includeClosed: false });
  const all = portfolio.portfolio(authorised(), { includeClosed: true });

  const r = rowFor(all, ids.closed);
  assert.strictEqual(r.exclusion.operational, true, 'operationally closed');
  assert.strictEqual(r.exclusion.financial, true, 'financially closed');
  assert.strictEqual(r.exclusion.contractual, false, 'contractually NOT closed \u2014 archived is different');

  // PRD §4.5's two distinct exclusions, kept distinct.
  assert.strictEqual(r.exclusion.outOfSchedule, true, 'out of the live schedule');
  assert.strictEqual(r.exclusion.outOfMoney, true, 'and out of live cashflow');

  // The steps carry the STEP NAME and WHAT IT LEFT, because PRD §4.5 excludes each from a
  // different place — a single "closed" flag would lose which totals moved.
  const steps = r.exclusion.steps.map((s) => s.step);
  assert.deepStrictEqual(steps, ['Operationally closed', 'Financially closed']);
  assert.match(r.exclusion.steps[0].left, /schedule/i);
  assert.match(r.exclusion.steps[1].left, /cashflow/i);

  // What the toggle ADVERTISES: the project by name, and why it was out.
  assert.strictEqual(vm.added.count, 1, 'one project would be added');
  assert.strictEqual(vm.added.names.length, 1);
  assert.strictEqual(vm.added.names[0].id, ids.closed);
  assert.strictEqual(vm.added.names[0].name, 'Finished Bridge', 'named, not counted');
  assert.ok(vm.added.names[0].steps.length >= 2, 'with the steps it left at');

  // A contractually-closed project is a THIRD case: fully archived. Not built here as a fixture
  // row, but the flags must not collapse it into the others.
  const fake = { id: 99, code: 'X', name: 'Archived', status: 'closed', contract_amount: 0,
    close_operational_at: '2026-01-01', close_financial_at: '2026-01-01',
    close_contractual_at: '2026-03-01' };
  const ex = portfolio.exclusion(fake);
  assert.strictEqual(ex.fullyClosed, true);
  assert.strictEqual(ex.steps.length, 3, 'all three steps recorded');
});

// ---------------------------------------------------------------------------
// PF8.7 — the LIVE figures really are live, and the open project is in them
// ---------------------------------------------------------------------------

test('PF8.7 the live totals include the open projects and nothing closed', () => {
  const live = portfolio.portfolio(authorised(), { includeClosed: false });

  const r = rowFor(live, PROJECT);
  assert.ok(r, 'the measured, open project IS in the live list');

  const liveIds = live.rows.map((x) => x.id);
  assert.ok(!liveIds.includes(ids.closed), 'the closed project is not');

  // The live cost total is the sum of the rows shown — so the footer cannot disagree with the
  // table above it. Both read the same rows.
  const sumCost = live.rows.reduce((s, x) => s + x.costToDate, 0);
  assert.strictEqual(live.totals.shown.cost, sumCost,
    'the printed total IS the sum of the rows rendered, to the rupiah');

  // And the measured project's own cost is its real ledger cost.
  const real = Number(fx.db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM v_ledger_period
      WHERE project_id = ? AND in_cost_basis = 1 AND line_role IN ('expense','payable','tax')`)
    .get(PROJECT).n);
  assert.strictEqual(r.costToDate, real, 'cost to date is the ledger\u2019s own figure');
});

// ---------------------------------------------------------------------------
// PF8.8 — the threshold is READ, and changing it changes the verdict
// ---------------------------------------------------------------------------

test('PF8.8 the breach threshold comes from app_settings, and tuning it reclassifies', () => {
  // Seeded by migration 023 at the PRD §4.4 default.
  const seeded = fx.db.prepare("SELECT value FROM app_settings WHERE key = 'spi_breach_threshold'")
    .get();
  assert.ok(seeded, 'migration 023 seeds the threshold');
  assert.strictEqual(seeded.value, '0.95', 'at the PRD default');

  const before = portfolio.health(PROJECT);
  assert.strictEqual(before.threshold.spi, 0.95, 'the service reads 0.95');
  assert.strictEqual(before.threshold.fromSettings, true, 'and says it came from settings');
  assert.strictEqual(before.spiState, 'within', 'SPI 5.00 is within a 0.95 threshold');

  // Raise the threshold ABOVE the project's CPI but BELOW its SPI, and watch the verdict move.
  // This is the proof that the number is read rather than baked in: a hard-coded 0.95 would not
  // budge, and PRD §4.4's "tunable" would be a lie.
  fx.db.prepare("UPDATE app_settings SET value = '6' WHERE key = 'spi_breach_threshold'").run();
  const after = portfolio.health(PROJECT);
  assert.strictEqual(after.threshold.spi, 6, 'the service now reads 6');
  assert.strictEqual(after.spiState, 'breached', 'and SPI 5.00 is now a breach');

  // Restore, so the rest of the file and the page render at the real threshold.
  fx.db.prepare("UPDATE app_settings SET value = '0.95' WHERE key = 'spi_breach_threshold'").run();
  assert.strictEqual(portfolio.health(PROJECT).spiState, 'within', 'and it goes back');

  // A missing row falls back to the default rather than throwing \u2014 an installation that
  // somehow lacks the setting still renders.
  fx.db.prepare("DELETE FROM app_settings WHERE key = 'cpi_breach_threshold'").run();
  const fallback = portfolio.thresholds();
  assert.strictEqual(fallback.cpi, 0.95, 'absent setting falls back to the PRD default');
  assert.strictEqual(fallback.spi, 0.95, 'while the present one is still read');
  fx.db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cpi_breach_threshold', '0.95')")
    .run();
});

// ---------------------------------------------------------------------------
// PF8.9 — the screen over HTTP: BOLA, the toggle, and the rendered tiles
// ---------------------------------------------------------------------------

test('PF8.9 the page renders, is scoped to what the user may see, and the toggle works', async () => {
  const cc = client();

  const res = await cc.get('/');
  assert.strictEqual(res.status, 200, 'the portfolio dashboard renders');
  const html = await res.text();

  // The threshold is STATED on the page, because a green tile nobody can check is decoration.
  assert.match(html, /0\.95/, 'the threshold in force is printed');
  assert.match(html, /breach below/i, 'and what it means');

  // The closed project must not be a ROW on the live dashboard. It legitimately still appears in
  // the SIDEBAR's project switcher, because PRD §4.5 keeps a closed project reportable — so the
  // assertion is scoped to the table, not the whole document. (Asserting on the whole page would
  // fail for a correct reason, which is how a test starts lying.)
  const tableStart = html.indexOf('<h2>Projects</h2>');
  assert.ok(tableStart > 0, 'the projects table is on the page');
  const tableHtml = html.slice(tableStart);
  assert.ok(!tableHtml.includes('Finished Bridge'),
    'the closed project has no ROW in the live table');
  assert.match(tableHtml, /what is shown/, 'and the footer says what the figure covers');

  // THE GREY TILE, on a real render. The measured project is over budget, so its CPI tile must be
  // the breach class; and a project with nothing measured must be the neutral one. Both classes
  // are asserted, so neither can silently become the other.
  assert.match(html, /chip bd[^>]*>\s*0\.56/, 'the over-budget CPI renders as a breach tile');
  assert.match(html, /chip nt[^>]*>\s*not measured/, 'an unmeasured index renders as the grey tile');
  assert.ok(!/chip ok[^>]*>\s*not measured/.test(html),
    'and NEVER as a green "within" tile \u2014 the defect this screen exists around');

  // The toggle actually changes the response: the closed project gains a ROW, and the page is
  // larger for it. Asserted on the table, for the same reason as above.
  const withClosed = await cc.get('/?include_closed=1');
  const html2 = await withClosed.text();
  const table2 = html2.slice(html2.indexOf('<h2>Projects</h2>'));
  assert.ok(table2.includes('Finished Bridge'),
    'the toggle brings the closed project onto the page as a row');
  assert.match(html2, /including closed/i, 'and the heading says so');
  assert.ok(table2.length > tableHtml.length, 'the toggled table is the larger of the two');

  // BOLA: the totals must equal the sum over the AUTHORISED set. A user with no role sees no
  // projects and none of their money.
  const argon2 = require('argon2');
  const { loggedIn } = require('./helpers/csrf');
  const PB = 'pf8-password-12345';
  fx.db.prepare(`INSERT INTO users (email, full_name, password_hash, is_system_admin)
      VALUES ('pf8-norole@example.test', 'No role', ?, 0)`).run(await argon2.hash(PB));
  const norole = await loggedIn(fx.ORIGIN, 'pf8-norole@example.test', PB);

  const none = await norole.get('/');
  const noneHtml = await none.text();
  assert.ok(!noneHtml.includes('Citarum Bridge'),
    'a user with no role is shown no project names \u2014 the audit BOLA rule');
  assert.match(noneHtml, /No projects are in scope|no project is in scope/i,
    'and is told why the list is empty');
  assert.ok(!/\d{3}\.\d{3}\.\d{3}/.test(noneHtml),
    'and none of the portfolio\u2019s money is on the page');
  assert.ok(!/Rp\s?[\d.]{7,}/.test(noneHtml),
    'and no rupiah figure at all \u2014 a role-less user sees no money');

  // An Administrator is org-wide (isOrgWide), so they see the whole portfolio — the rule working,
  // pinned so a later narrowing fails loudly rather than silently hiding projects.
  const adminHtml = await (await fx.admin.get('/')).text();
  assert.ok(adminHtml.includes('Citarum Bridge'), 'an org-wide user sees the portfolio');
});
