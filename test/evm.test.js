// EV7-series: the EVM acceptance test (module 7, plan part 7.8). THIS IS THE MODULE GATE.
//
// WHAT THIS FILE EXISTS FOR
//
// Module 7 built the work breakdown, progress reporting, the resource plan, the cost
// baseline, baseline change control and de-scope. Every one of those exists to feed a single
// view: `v_evm_period`, whose `spi` and `cpi` are the product's two headline numbers — PRD §1,
// success criterion 2: "SPI and CPI computed automatically each period from progress + costs
// — no manual EVM math". So this file measures that view directly, on a real migrated
// database, through the real services. Not a mock, and not a second copy of the arithmetic.
//
// TWO REAL DEFECTS WERE MEASURED AND CLOSED BY MIGRATION 018 (that file has the figures; this
// file pins the behaviour so it cannot come back):
//
//   1. An index was reported as `0` when there was no earned value to divide at all. A month
//      with a plan and no progress came back `spi = 0`; a month with costs and no progress
//      came back `cpi = 0`. Measured on the seeded dev database, PRJ-2026 returned exactly
//      `cpi = 0` for 2026-03 (pv 0, ev 0, ac 175,000,000). Both zeros are CLAIMS — "totally
//      behind schedule", "cost efficiency is zero" — when the truth is that nothing has been
//      measured yet. The view's own author intended NULL for this (its `CASE WHEN pv <> 0`
//      guard returns NULL "for a genuine cannot-be-computed"); the numerator was simply never
//      covered. EV7.1 and EV7.5 pin the honest NULL; EV7.2 pins that a real measurement is
//      left alone, so the defect cannot be "fixed" by blanking everything.
//
//   2. `v_evm_period` sums baseline rows with no version filter. An approved change order
//      writes a NEW version of the affected buckets — which is precisely what parts 7.5, 7.6
//      and 7.7 exist to do — so on the old view every approved change silently doubled the
//      planned value of those months. Migration 014 fixed the view; EV7.4 re-asserts it from
//      the report side, which is where a user would eventually notice it.
//
// EVERY EXPECTED NUMBER BELOW IS COMPUTED BY HAND IN A COMMENT. A test that reads its
// expectation back out of the code it is testing proves nothing.
//
// SCOPE NOTE, RECORDED DELIBERATELY: this view is PER PERIOD. `pv` is that month's bucket
// (it groups by `period_month`, it does not accumulate) and `ev` is that month's earned
// value, so `spi`/`cpi` here are period indexes. Standard EVM also reports CUMULATIVE indexes,
// and those are NOT derivable from this view — you cannot add monthly indexes. A cumulative
// column belongs with the dashboards and trend reports that need it (Module 8, which owns
// "EV, forecast, variance, dashboards"). Flagged there, not invented here.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3920;   // 3918 is held by bcr.test.js and 3919 by descope.test.js
const PROJECT = 1;   // PRJ-2026 "Citarum Bridge" — seeded by seed-master.js
const LINE = '3.1';  // Concrete works: 4 milestones at 25% each
const ACCOUNT = '1.1.1';
// March 2026 is the month a fixture DB can always write to: no other data exists for it, and
// it is the month the rest of module 7's tests use.
const MONTH = '2026-03';

// 100,000 a month for ten months => a Budget At Completion (BAC) of 1,000,000 on the line.
const MONTHLY = 100000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

let fx;
let cbs;
let progress;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-ev7-' });
  // One shared connection for both services — see the note on `loadMany`. Loading them
  // separately gives each its own `db.js`, and two connections writing one file is the
  // "database is locked" trap, not a logic error.
  [cbs, progress] = fx.loadMany('src/lib/cbs-service.js', 'src/lib/progress-service.js');

  const node = line();
  const account = acct();
  // The resource plan is what makes the budget credible: the CBS invariant is
  // "sum of monthly buckets = the account's resource plan" (PRD §6), so the RBS row is
  // created first and `spreadBaseline` is asked to honour it. This is the real write path
  // from part 7.4, not a direct INSERT — if the invariant broke, 7.8 would not compile.
  // `rbs_code` is a foreign key to the master resource menu, so it must be a REAL seeded
  // code (M-CEM is cement — the resource behind "Concrete works" on line 3.1), not a label
  // invented here; a made-up code fails on the constraint rather than on what is under test.
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, account.id, MONTHLY, MONTHS.length, BAC);

  cbs.spreadBaseline({
    projectId: PROJECT,
    accountId: account.id,
    wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });
});

after(() => { if (fx) fx.stop(); });

// ---- helpers ---------------------------------------------------------------
const line = () => fx.db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(PROJECT, LINE);
const acct = () => fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
const evm = (projectId, month) => fx.db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(projectId, month);

// Book a real cost. Goes through the same integrity triggers as production: whole rupiah,
// amount = debit - credit, non-zero — so a fixture row that production would reject is
// rejected here too, rather than quietly making the test pass on impossible data.
function bookCost(amount, documentNo, month = MONTH) {
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'ev7')`)
    .run(PROJECT, `${month}-15`, amount, amount, line().id, acct().id, documentNo);
}

// ---- 8.1 a baseline with no progress: PV is real, the indexes do not exist -----

test('EV7.1 with a baseline but nothing measured, PV is real and SPI/CPI are NULL (not 0)', () => {
  const row = evm(PROJECT, MONTH);
  assert.ok(row, 'the month has a row at all — the view must not drop a baseline month');
  assert.strictEqual(row.pv, MONTHLY, 'planned value for the month is the month\'s bucket');
  assert.strictEqual(row.ev, 0, 'nothing has been reported, so earned value is genuinely 0');
  assert.strictEqual(row.ac, 0, 'and nothing has been spent');
  // The whole point of migration 018. `0 / 100,000` is arithmetically 0, but reporting it
  // says "nothing earned against the plan" — a schedule judgement nobody has made. NULL is
  // the honest answer: there is no earned value to divide, so there is no index.
  assert.strictEqual(row.spi, null, 'no earned value => no schedule index (0 would read as "totally behind")');
  assert.strictEqual(row.cpi, null, 'no earned value => no cost index (0 would read as "zero efficiency")');
});

// ---- 8.2 measure it: the indexes become real, and arithmetically right --------

test('EV7.2 SPI = EV/PV and CPI = EV/AC on the numbers we just wrote', () => {
  const node = line();
  const milestones = progress.milestones(node.id);   // seq 1..4, 25% each
  assert.strictEqual(milestones.length, 4);

  // Tick two of the four => the line is 50% complete. Earned value is the line's WHOLE
  // approved budget (its current baseline for every month, summed) times that percentage:
  //   EV = 1,000,000 x 50% = 500,000
  const actor = fx.users.get('project_controller');
  progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: milestones[0].id, ticked: true, period: MONTH });
  progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: milestones[1].id, ticked: true, period: MONTH });

  const pct = fx.db.prepare('SELECT pct_complete FROM wbs_progress WHERE wbs_node_id = ? AND period_month = ?')
    .get(node.id, MONTH).pct_complete;
  assert.strictEqual(pct, 50, 'two 25% milestones ticked is 50% for the period');

  // Two costs of 100,000 => AC = 200,000.
  bookCost(100000, 'EV7-1');
  bookCost(100000, 'EV7-2');

  const row = evm(PROJECT, MONTH);
  assert.strictEqual(row.pv, 100000, 'planned value: March\'s bucket only');
  assert.strictEqual(row.ev, 500000, 'EV = 1,000,000 whole-line budget x 50%');
  assert.strictEqual(row.ac, 200000, 'AC = 100,000 + 100,000 tagged costs');
  // By hand: SPI = EV/PV = 500,000 / 100,000 = 5. CPI = EV/AC = 500,000 / 200,000 = 2.5.
  assert.strictEqual(row.spi, 5, 'SPI = 500,000 / 100,000');
  assert.strictEqual(row.cpi, 2.5, 'CPI = 500,000 / 200,000');
  // The assertion above is the one that keeps the EV7.1 fix honest: a view that returned
  // NULL for everything would pass EV7.1 and EV7.5 and fail here.
});

// ---- 8.3 one project's numbers never appear in another's ---------------------

test('EV7.3 a second project\'s baseline does not leak into this project\'s rows', () => {
  const info = fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency, status)
    VALUES ('EV7-OTHER', 'Other project', 1000000, 'IDR', 'active')`).run();
  const other = Number(info.lastInsertRowid);
  const node = fx.db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name, sort_order, version)
    VALUES (?, '1', 'Their line', 10, 1)`).run(other).lastInsertRowid;
  fx.db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id, plan_type,
      version, period_month, amount) VALUES (?, ?, ?, 'baseline', 1, ?, 7777777)`)
    .run(other, acct().id, node, MONTH);

  const mine = evm(PROJECT, MONTH);
  const theirs = evm(other, MONTH);
  // `v_evm_period` groups by project_id but chains two FULL OUTER JOINs, which is exactly the
  // shape of SQL where a missing join predicate hides and silently merges two projects. Pin it.
  assert.strictEqual(theirs.pv, 7777777, 'their own baseline is theirs');
  assert.strictEqual(mine.pv, 100000, 'and it does not appear in ours');
  assert.strictEqual(mine.ev, 500000, 'our earned value is unchanged');
  assert.strictEqual(theirs.ev, 0, 'their earned value is 0 — ours did not leak across');
  assert.strictEqual(mine.spi, 5, 'our index is unaffected');
});

// ---- 8.4 PV equals the baseline rows exactly — no double counting ------------

test('EV7.4 a month\'s PV is exactly the current baseline rows, counted once', () => {
  // Read the expectation out of the TABLE, not out of the view — the two must agree.
  const expected = fx.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM cbs_plan
    WHERE project_id = ? AND period_month = ? AND plan_type = 'baseline'
      AND version = (SELECT MAX(version) FROM cbs_plan WHERE project_id = ? AND period_month = ?
                       AND plan_type = 'baseline')`).get(PROJECT, MONTH, PROJECT, MONTH).s;
  assert.strictEqual(expected, MONTHLY);
  assert.strictEqual(evm(PROJECT, MONTH).pv, expected, 'PV is the baseline rows for that month');

  // Now the double-count itself. An approved change order does not edit the old bucket — it
  // writes a NEW VERSION of it (parts 7.5-7.7 do exactly this). The month must not grow.
  const node = line();
  fx.db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id, plan_type,
      version, period_month, amount) VALUES (?, ?, ?, 'baseline', 2, ?, ?)`)
    .run(PROJECT, acct().id, node.id, MONTH, MONTHLY);

  const after = evm(PROJECT, MONTH);
  assert.strictEqual(after.pv, MONTHLY,
    'the superseded version is not added in — PV stays 100,000, not 200,000 (the F2 double-count)');
  assert.strictEqual(after.ev, 500000, 'and earned value is untouched by a baseline version');
  assert.ok(fx.db.prepare(`SELECT COUNT(*) n FROM cbs_plan WHERE project_id = ? AND period_month = ?`)
    .get(PROJECT, MONTH).n >= 2, 'both versions really are in the table — the view is what filtered');
});

// ---- 8.5 the honesty rule holds everywhere in the view, not just here --------

test('EV7.5 no row anywhere claims an index it cannot compute', () => {
  // The two halves of migration 018 are DIFFERENT columns, and the cases above only exercise one
  // of them: EV7.1 leaves `ac` at 0, so the OLD view also returned NULL for `cpi` there — a CPI
  // regression could hide behind a passing EV7.1. So drive `cpi`'s failing case explicitly, in a
  // month with a plan and NO progress (2026-12, the last baseline month; cost arriving before the
  // milestone it belongs to is ticked is the realistic shape of this).
  const NO_PROGRESS = '2026-12';
  bookCost(40000, 'EV7-LUMP', NO_PROGRESS);
  const lumpy = evm(PROJECT, NO_PROGRESS);
  assert.strictEqual(lumpy.ev, 0, 'no progress has ever been reported for this month');
  assert.strictEqual(lumpy.pv, MONTHLY, 'but the month does have a plan');
  assert.strictEqual(lumpy.ac, 40000, 'and a cost has been booked against it');
  assert.strictEqual(lumpy.spi, null, 'no earned value => no schedule index');
  assert.strictEqual(lumpy.cpi, null,
    'no earned value => no cost index either (the old view said 0 — "zero efficiency")');

  // Stated as the invariant, so it covers rows this file never built — including the seeded months,
  // where a plan exists but no progress ever has.
  const offenders = fx.db.prepare(`SELECT project_id, period_month, pv, ev, ac, spi, cpi
    FROM v_evm_period
    WHERE (spi IS NOT NULL AND (COALESCE(ev,0) = 0 OR COALESCE(pv,0) = 0))
       OR (cpi IS NOT NULL AND (COALESCE(ev,0) = 0 OR COALESCE(ac,0) = 0))`).all();
  assert.deepStrictEqual(offenders, [],
    'an index exists only where earned value and its denominator both do');

  // And the converse, so the rule cannot be satisfied by never reporting anything: the months that
  // DO have both denominators are not blank.
  const real = fx.db.prepare(`SELECT COUNT(*) n FROM v_evm_period
    WHERE ev <> 0 AND pv <> 0 AND ac <> 0 AND spi IS NOT NULL AND cpi IS NOT NULL`).get().n;
  assert.ok(real >= 1, 'a month with a real measurement still reports both indexes');
});

// ---- 8.6 the deliberate non-change, pinned ----------------------------------

test('EV7.6 cost_variance is still AC minus EV — migration 018 did not touch it', () => {
  // Migration 018 fixed the indexes and deliberately left `cost_variance` alone: nothing reads
  // it and its sign convention is a separate decision. Pinned so a future "consistency" edit
  // is a deliberate act with a failing test, not a silent one.
  const row = evm(PROJECT, MONTH);
  assert.strictEqual(row.cost_variance, row.ac - row.ev, 'CV = AC - EV, the view\'s own convention');
  assert.strictEqual(row.cost_variance, 200000 - 500000, '-300,000 on these numbers');
});

// ---- 8.7 the curve has no gaps and no duplicates ---------------------------

test('EV7.7 every month of the baseline is reported once, with no month dropped', () => {
  const rows = fx.db.prepare(`SELECT period_month FROM v_evm_period
    WHERE project_id = ? ORDER BY period_month`).all(PROJECT);
  const months = rows.map((r) => r.period_month);
  // The chain of FULL OUTER JOINs is what can drop a month whose row exists in only one of
  // pv/ev/ac. Every baseline month must survive, and none may appear twice.
  assert.deepStrictEqual(months, MONTHS, 'the ten baseline months, in order, once each');
  assert.strictEqual(new Set(months).size, months.length, 'no month is reported twice');
});
