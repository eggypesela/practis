// FC8-series: forecast / EAC (module 8, plan part 8.4).
// THIS IS PART 8.4'S GATE. src/lib/forecast-service.js is the change under test.
//
// WHY THIS FILE EXISTS
//
// PRD §4.4 step 1 promises "auto EAC from CPI + manual override", and the schema has always
// allowed both: `cbs_plan.plan_type` admits 'forecast', and `is_manual_override` exists as its
// own column rather than the write path simply overwriting `amount`. Two things were missing —
// nothing computed EAC, and nothing wrote a forecast row.
//
// THE RULE THIS FILE DEFENDS ABOVE ALL OTHERS
//
// When there is no cost performance to project from, the estimate is BLANK and says why. It is
// never set to BAC. Migration 018 made "no measurement" a blank rather than a false zero in
// `v_evm_period`, and 019 kept the rule for the cumulative columns; this file is where it
// reaches the UI. A project nobody has measured must not be shown as perfectly on budget.
//
// THE SECOND PROPERTY, PROVED FROM THE OTHER SIDE
//
// Module 7's BL7.14 proved a forecast row is invisible to PV. FC8.7 proves the direction that
// matters for module 8: writing a forecast moves NO baseline row (counted AND checksummed) and
// no figure any dashboard reads.
//
// EVERY EXPECTED NUMBER IS WORKED OUT BY HAND IN A COMMENT. A test that reads its expectation
// back out of the code it is testing proves nothing.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3924;   // 3923 is reporting-screen.test.js, 3925 is variance.test.js.
const PROJECT = 1;   // PRJ-2026 "Citarum Bridge" — seeded by seed.js.
const LINE = '3.1';  // Concrete works: 4 milestones at 25% each.
const ACCOUNT = '1.1.1';

// 100,000 a month for ten months => BAC = 1,000,000 on the one line.
const MONTHLY = 100_000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

let fx;
let fcs;
let cbs;
let progress;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-fc8-' });
  // ONE shared connection for all three services — see the note on `loadMany`. Loading them
  // separately gives each its own `db.js`, and two connections writing one file is the
  // "database is locked" trap that looks like a logic bug.
  [cbs, fcs, progress] = fx.loadMany('src/lib/cbs-service.js', 'src/lib/forecast-service.js',
    'src/lib/progress-service.js');

  const node = line();
  const acct = account();
  // The resource plan comes first: the CBS invariant is "Σ monthly buckets = the account's
  // resource plan" (PRD §6), so `spreadBaseline` below has something to reconcile against.
  // This is the real write path from part 7.4, not a direct INSERT into cbs_plan.
  // `rbs_code` is a foreign key to the seeded master menu, so it must be a REAL code.
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, acct.id, MONTHLY, MONTHS.length, BAC);

  cbs.spreadBaseline({
    projectId: PROJECT,
    accountId: acct.id,
    wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });
});

after(() => { if (fx) fx.stop(); });

// ---- helpers ---------------------------------------------------------------

const projectId = () => PROJECT;
const line = () => fx.db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(PROJECT, LINE);
const account = () => fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);

// Book a real cost through the same integrity triggers as production: whole rupiah,
// amount = debit - credit, non-zero, tagged so it lands in the cost basis. A fixture row
// production would reject is rejected here too, rather than passing the test on data that
// could not exist.
function bookCost(amount, documentNo, month = '2026-03', project = PROJECT, acct = account()) {
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'fc8')`)
    .run(project, `${month}-15`, amount, amount, line().id, acct.id, documentNo);
}

// Every baseline row as one stable string. FC8.7 compares it either side of a forecast write:
// a row COUNT alone could miss a swap that preserves the count, and a checksum alone could
// miss an added row, so the test uses both.
function baselineFingerprint() {
  return JSON.stringify(fx.db.prepare(`SELECT id, transaction_account_id,
      COALESCE(wbs_node_id, 0) AS n, version, period_month, amount, is_manual_override
    FROM cbs_plan WHERE plan_type = 'baseline' ORDER BY id`).all());
}

// Everything a dashboard reads, at every month.
function evmSnapshot() {
  return JSON.stringify(fx.db.prepare(`SELECT period_month, pv, ev, ac, spi, cpi, spi_cum, cpi_cum
    FROM v_evm_period WHERE project_id = ? ORDER BY period_month`).all(PROJECT));
}

// A second project, created inside the test, with its own line, resource plan and baseline.
// Used by FC8.3 to hold two DIFFERENT kinds of blank side by side.
function makeProject(code, name) {
  const id = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status, start_date, end_date) VALUES (?, ?, ?, 'IDR', 'active', '2026-01-01', '2026-12-31')`)
    .run(code, name, BAC).lastInsertRowid);
  const nodeId = Number(fx.db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name,
      sort_order, version) VALUES (?, '9.9', 'Their line', 10, 1)`).run(id).lastInsertRowid);
  const acct = account();
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(id, nodeId, acct.id, MONTHLY, MONTHS.length, BAC);
  cbs.spreadBaseline({
    projectId: id, accountId: acct.id, wbsNodeId: nodeId,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });
  return { id, nodeId, acct };
}

// ---------------------------------------------------------------------------
// FC8.1 — the headline rule: no measurement means NO estimate
// ---------------------------------------------------------------------------

test('FC8.1 with a budget but nothing measured, the estimate is BLANK — never the budget', () => {
  // State right now: a real 1,000,000 baseline, no progress, no cost.
  const out = fcs.eac(projectId());

  assert.strictEqual(out.bac, BAC, 'there is a budget to complete');
  assert.strictEqual(out.ev_cum, 0, 'nothing has been earned');
  assert.strictEqual(out.ac_cum, 0, 'and nothing has been spent');
  assert.strictEqual(out.eac, null,
    'no cost performance => NO estimate. Returning BAC here would present a project nobody has '
    + 'measured as perfectly on budget — the false-confidence failure migration 018 removed');
  assert.strictEqual(out.etc, null, 'no cash-to-complete figure is invented either');
  assert.strictEqual(out.vac, null, 'nor a variance at completion');
  assert.strictEqual(out.over, null, 'and no verdict on whether it is over');
  assert.ok(out.reason, 'the blank is explained rather than silent');
  assert.ok(/nothing has been spent and no progress has been measured/i.test(out.reason),
    `the reason names the cause in words a reader can act on; got: ${out.reason}`);
});

// ---------------------------------------------------------------------------
// FC8.2 — the arithmetic, hand-computed, and the reason names the basis
// ---------------------------------------------------------------------------

test('FC8.2 the estimate is BAC / CPI, worked out by hand', () => {
  const node = line();
  const actor = fx.users.get('project_controller');

  // Tick two of the line's four 25% milestones => the line is 50% complete.
  const milestones = progress.milestones(node.id);
  assert.strictEqual(milestones.length, 4, 'the seeded line has its four default milestones');
  progress.setMilestoneTick({ projectId: PROJECT, actorId: actor,
    milestoneId: milestones[0].id, ticked: true, period: '2026-03' });
  progress.setMilestoneTick({ projectId: PROJECT, actorId: actor,
    milestoneId: milestones[1].id, ticked: true, period: '2026-03' });

  // Two costs of 100,000 => AC = 200,000.
  bookCost(100_000, 'FC8-1');
  bookCost(100_000, 'FC8-2');

  // Read the two inputs straight out of the TABLES, then do the arithmetic here. Deriving the
  // expectation from the service would make the test a restatement of the code.
  //
  //   PV  = March's bucket                        =   100,000
  //   EV  = whole-line budget x 50%               = 1,000,000 x 0.5 = 500,000
  //   AC  = tagged costs booked                   =   200,000
  //   CPI = EV / AC = 500,000 / 200,000           = 2.5
  //   EAC = BAC / CPI = 1,000,000 / 2.5           = 400,000
  //   ETC = EAC - AC  = 400,000 - 200,000         = 200,000
  //   VAC = BAC - EAC = 1,000,000 - 400,000       = 600,000  (under budget)
  const march = fx.db.prepare('SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?')
    .get(PROJECT, '2026-03');
  assert.strictEqual(march.pv, 100_000, 'PV is March\u2019s bucket only');
  assert.strictEqual(march.ev, 500_000, 'EV = 1,000,000 whole-line budget x 50%');
  assert.strictEqual(march.ac, 200_000, 'AC = 100,000 + 100,000 tagged');

  const out = fcs.eac(projectId());
  assert.strictEqual(out.bac, BAC, 'BAC is the sum of every baseline bucket');
  assert.strictEqual(out.ev_cum, 500_000, 'cumulative EV matches the view');
  assert.strictEqual(out.ac_cum, 200_000, 'cumulative AC matches the view');
  assert.strictEqual(out.cpi_cum, 2.5, 'CPI = EV / AC = 500,000 / 200,000');
  assert.strictEqual(out.eac, 400_000, 'EAC = BAC / CPI = 1,000,000 / 2.5');
  assert.strictEqual(out.etc, 200_000, 'ETC = EAC - AC');
  assert.strictEqual(out.vac, 600_000, 'VAC = BAC - EAC; POSITIVE means under budget');
  assert.strictEqual(out.over, false, 'so the page will not call this project over budget');
  assert.strictEqual(out.reason, null, 'nothing to explain once the estimate exists');

  // The page prints the basis, and the basis must be the month that was MEASURED — not the
  // last month on the calendar. This assertion caught a real defect: the baseline runs to
  // December and migration 019 carries the cumulative columns forward, so every month
  // March-December has a non-null cpi_cum of 2.5. Taking the newest such row labelled the
  // estimate "as at 2026-12", which tells a reader the project has been measured through
  // December. It has not. Nothing after March has been measured, so March is the answer.
  assert.strictEqual(out.cpi_month, '2026-03',
    'the estimate is dated by the month it was measured, not by the end of the plan');
});

// ---------------------------------------------------------------------------
// FC8.3 — the two different blanks must not share one sentence
// ---------------------------------------------------------------------------

test('FC8.3 the blank reason tells "nothing spent" from "nothing earned"', () => {
  // (a) cost booked, no progress recorded.
  const a = makeProject('FC8-3A', 'Cost but no progress');
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis,
      source, amount, debit, credit, wbs_node_id, transaction_account_id, document_no, description)
      VALUES (?, '2026-03-15', 'Expense', 'expense', 1, 'manual', 700000, 700000, 0, ?, ?, 'FC8-3A', 'a')`)
    .run(a.id, a.nodeId, a.acct.id);

  const outA = fcs.eac(a.id);
  assert.ok(outA.ac_cum > 0, 'precondition: cost IS recorded');
  assert.strictEqual(outA.ev_cum, 0, 'precondition: no progress is');
  assert.ok(/no progress has been measured/i.test(outA.reason),
    `cost without progress must ask for progress; got: ${outA.reason}`);

  // (b) progress recorded, no cost booked. Written straight into wbs_progress because this
  // project is created inside the test and so has no seeded milestones to tick.
  const b = makeProject('FC8-3B', 'Progress but no cost');
  fx.db.prepare(`INSERT INTO wbs_progress (wbs_node_id, period_month, pct_complete, source,
      reported_by) VALUES (?, '2026-03', 40, 'manual', ?)`)
    .run(b.nodeId, fx.users.get('project_controller'));

  const outB = fcs.eac(b.id);
  assert.ok(outB.ev_cum > 0, 'precondition: progress IS recorded');
  assert.strictEqual(outB.ac_cum, 0, 'precondition: no cost is');
  assert.ok(/no cost has been booked/i.test(outB.reason),
    `progress without cost must ask for cost; got: ${outB.reason}`);

  // The whole assertion: one message cannot serve both, because the reader's next action
  // is different in each case.
  assert.notStrictEqual(outA.reason, outB.reason,
    'the two blanks are different situations and must not share one message');
});

// ---------------------------------------------------------------------------
// FC8.4 — an override is recorded, flagged, and supersedes rather than overwrites
// ---------------------------------------------------------------------------

test('FC8.4 an override is flagged as the human’s, and the approved figure is still shown', () => {
  const acct = account();
  const before = fcs.months(projectId())
    .find((r) => r.period_month === '2026-04' && r.account_id === acct.id);
  assert.ok(before, 'the bucket is on the grid');
  assert.strictEqual(before.is_override, false, 'nothing is overridden yet');
  assert.strictEqual(before.forecast, MONTHLY, 'so the forecast IS the approved plan');

  fcs.setOverride({
    projectId: projectId(), accountId: acct.id, periodMonth: '2026-04',
    amount: 150_000, actorId: fx.users.get('cost_controller'), note: 'steel price rise',
  });

  const after = fcs.months(projectId())
    .find((r) => r.period_month === '2026-04' && r.account_id === acct.id);
  assert.strictEqual(after.is_override, true, 'flagged as the human\u2019s own figure');
  assert.strictEqual(after.forecast, 150_000, 'the human figure is in force');
  assert.strictEqual(after.baseline, MONTHLY, 'the APPROVED figure is untouched and still shown');
  assert.strictEqual(after.delta, 50_000, 'the difference is reported, not hidden');
  assert.strictEqual(after.note, 'steel price rise', 'the reason travels with the figure');

  // The flag is a fact in the table, not a UI convention.
  const flagged = fx.db.prepare(`SELECT COUNT(*) n FROM cbs_plan WHERE project_id = ?
    AND plan_type = 'forecast' AND period_month = '2026-04' AND is_manual_override = 1`)
    .get(PROJECT).n;
  assert.strictEqual(flagged, 1, 'exactly one flagged forecast row');

  // Re-forecasting SUPERSEDES: version 2 holds the new figure, version 1 stays readable.
  fcs.setOverride({
    projectId: projectId(), accountId: acct.id, periodMonth: '2026-04',
    amount: 175_000, actorId: fx.users.get('cost_controller'), note: 'revised again',
  });
  const versions = fx.db.prepare(`SELECT version, amount, note FROM cbs_plan
    WHERE project_id = ? AND plan_type = 'forecast' AND period_month = '2026-04'
    ORDER BY version`).all(PROJECT);
  assert.deepEqual(versions.map((v) => v.version), [1, 2], 'the earlier figure is kept');
  assert.deepEqual(versions.map((v) => v.amount), [150_000, 175_000]);
  assert.strictEqual(
    fcs.months(projectId()).find((r) => r.period_month === '2026-04' && r.account_id === acct.id).forecast,
    175_000, 'and the reader takes the LATEST version');
});

test('FC8.4b handing a month back restores the plan without deleting history', () => {
  const acct = account();
  const row = fcs.months(projectId())
    .find((r) => r.period_month === '2026-04' && r.account_id === acct.id);
  assert.strictEqual(row.is_override, true, 'precondition: the month is overridden');

  fcs.clearOverride({
    projectId: projectId(), accountId: acct.id, periodMonth: '2026-04',
    actorId: fx.users.get('cost_controller'),
  });

  const back = fcs.months(projectId())
    .find((r) => r.period_month === '2026-04' && r.account_id === acct.id);
  assert.strictEqual(back.is_override, false, 'no longer the human\u2019s figure');
  assert.strictEqual(back.forecast, MONTHLY, 'the approved plan is in force again');

  const history = fx.db.prepare(`SELECT amount, is_manual_override FROM cbs_plan
    WHERE project_id = ? AND plan_type = 'forecast' AND period_month = '2026-04'
    ORDER BY version`).all(PROJECT);
  assert.strictEqual(history.length, 3, 'the two human figures are still on disk');
  assert.deepEqual(history.map((h) => h.is_manual_override), [1, 1, 0],
    'and the last row is the hand-back — a supersede, not a deletion');

  // Handing back a month that carries no human figure is REFUSED, not a silent no-op: a
  // silent success would tell the person who clicked that something happened when nothing did.
  assert.throws(() => fcs.clearOverride({
    projectId: projectId(), accountId: acct.id, periodMonth: '2026-04',
    actorId: fx.users.get('cost_controller'),
  }), /nothing to hand back/i, 'a second hand-back is refused with a sentence');
});

// ---------------------------------------------------------------------------
// FC8.5 — bad input is refused and writes nothing
// ---------------------------------------------------------------------------

test('FC8.5 a bad amount or month is refused, and not one row is written', () => {
  const acct = account();
  const before = fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'")
    .get().n;

  const bad = [
    [{ periodMonth: '2026-13', amount: '1000' }, /YYYY-MM/, 'month 13 does not exist'],
    [{ periodMonth: 'March', amount: '1000' }, /YYYY-MM/, 'a month name is not a month'],
    [{ periodMonth: '2026-03', amount: '-5' }, /no minus sign/, 'a negative forecast'],
    [{ periodMonth: '2026-03', amount: '1.5' }, /no decimals/, 'a fractional rupiah'],
    [{ periodMonth: '2026-03', amount: '' }, /Give the forecast amount/, 'an empty amount'],
    [{ periodMonth: '2026-03', amount: 'abc' }, /whole number of rupiah/, 'not a number'],
  ];
  for (const [patch, re, why] of bad) {
    assert.throws(() => fcs.setOverride({
      projectId: projectId(), accountId: acct.id,
      actorId: fx.users.get('cost_controller'), ...patch,
    }), re, why);
  }
  // An unknown cost account is refused too, rather than failing on a foreign key.
  assert.throws(() => fcs.setOverride({
    projectId: projectId(), accountId: 999_999, periodMonth: '2026-03', amount: '1000',
    actorId: fx.users.get('cost_controller'),
  }), /does not exist/i, 'a made-up cost account is refused with a sentence');

  assert.strictEqual(
    fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'").get().n,
    before, 'not one refused attempt left a row behind');
});

// ---------------------------------------------------------------------------
// FC8.6 — a forecast moves neither the baseline nor anything a dashboard reads
// ---------------------------------------------------------------------------

test('FC8.6 writing a forecast changes no baseline row and no EVM figure', () => {
  const acct = account();
  const baseBefore = baselineFingerprint();
  const evmBefore = evmSnapshot();
  const eacBefore = fcs.eac(projectId());
  const totalsBefore = fcs.totals(projectId());

  fcs.setOverride({
    projectId: projectId(), accountId: acct.id, periodMonth: '2026-05',
    amount: 9_999_999, actorId: fx.users.get('cost_controller'), note: 'deliberately huge',
  });

  // Identity AND count. Either alone can miss a change the other would catch.
  assert.strictEqual(baselineFingerprint(), baseBefore,
    'every baseline row — id, account, line, version, month, amount, flag — is identical');

  assert.strictEqual(evmSnapshot(), evmBefore,
    'PV, EV, AC, SPI and CPI are unchanged: a forecast is invisible to EVM, the same fact '
    + 'BL7.14 asserts from the other side');

  assert.deepEqual(fcs.eac(projectId()), eacBefore,
    'and so is the system estimate, because it reads CPI rather than the forecast');

  // The ONE thing that changed is the human total — which is the point of writing it.
  const totalsAfter = fcs.totals(projectId());
  assert.strictEqual(totalsAfter.human_forecast - totalsBefore.human_forecast, 9_999_999 - MONTHLY,
    'the human forecast moved by exactly the difference between the override and the plan');
  assert.ok(totalsAfter.overrides > totalsBefore.overrides, 'and the override is counted');
  assert.strictEqual(totalsAfter.baseline, totalsBefore.baseline,
    'while the plan total is untouched');
});

// ---------------------------------------------------------------------------
// FC8.7 — the report, through real HTTP, in real sessions
// ---------------------------------------------------------------------------

test('FC8.7 the report renders, refuses a Viewer, and prints the estimate’s basis', async () => {
  const acct = account();

  // A Viewer must be refused the WRITE with a reason, and nothing may be written.
  const before = fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'")
    .get().n;
  const viewer = fx.clients.get('viewer');
  const refused = await fx.post(viewer, '/reports/forecast',
    { transaction_account_id: acct.id, period_month: '2026-08', amount: '123' });
  assert.strictEqual(refused.status, 403,
    'a Viewer cannot set the cost forecast — PRD §4.4 step 1 gives that to the Cost Controller');
  assert.strictEqual(
    fx.db.prepare("SELECT COUNT(*) n FROM cbs_plan WHERE plan_type = 'forecast'").get().n,
    before, 'and the refusal wrote nothing');

  // The Cost Controller opens it, and the page states how the estimate is built.
  const cc = fx.clients.get('cost_controller');
  const page = await cc.get('/reports/forecast');
  assert.strictEqual(page.status, 200, 'the Cost Controller can open the forecast report');
  const html = await page.text();

  assert.ok(html.includes('Cost forecast'), 'the page is titled for a human');
  assert.ok(html.includes('Approved budget'),
    'the approved budget is stated, so the estimate has something to compare against');
  assert.ok(/BAC\s*\u00f7\s*CPI/.test(html.replace(/\s+/g, ' ')),
    'the basis of the estimate is printed on the page rather than left to the reader to assume');
  assert.ok(html.includes('approved plan'),
    'and the table says which rows are the plan rather than the human\u2019s figure');

  // Write through the REAL form and watch it land.
  const ok = await fx.post(cc, '/reports/forecast',
    { transaction_account_id: acct.id, period_month: '2026-09', amount: '777000',
      note: 'from FC8.7' });
  assert.ok([302, 303].includes(ok.status), 'a valid submission redirects (POST-redirect-GET)');
  const written = fx.db.prepare(`SELECT amount, is_manual_override, note FROM cbs_plan
    WHERE project_id = ? AND plan_type = 'forecast' AND period_month = '2026-09'
    ORDER BY version DESC LIMIT 1`).get(PROJECT);
  assert.ok(written, 'the forecast row exists');
  assert.strictEqual(written.amount, 777_000, 'at the amount submitted');
  assert.strictEqual(written.is_manual_override, 1, 'flagged as the human\u2019s');
  assert.strictEqual(written.note, 'from FC8.7', 'with the reason given');

  // And the page now says whose figure that row is.
  const after = await cc.get('/reports/forecast');
  const html2 = await after.text();
  assert.ok(html2.includes('from FC8.7'), 'the reason is shown beside the figure');
  assert.ok(html2.includes('your figure'),
    'and the UI names it as the human\u2019s rather than presenting it as the plan');
});
