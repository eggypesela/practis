// UP8-series: the Project Update Report and the period freeze (module 8, plan part 8.10).
// THIS IS PART 8.10'S GATE. PRD §4.4/§5.4 and owner decision A (2026-10-04).
//
// WHAT THIS FILE DEFENDS
//
// **UP8.7 IS THE POINT.** Everything else here could pass with a report that is merely a stored row.
// Only UP8.7 proves that approving the report actually CLOSES THE PERIOD: it approves, then attempts
// a backdated ledger write into that month and requires the DATABASE to refuse it. A freeze that
// writes a `frozen_periods` row but does not stop writes is the exact failure that would look fine
// on every screen and silently rewrite reported history.
//
// The second thing this file defends is that the report COMPILES and does not COMPUTE. UP8.2 reads
// the report's figures and the owning service's figures independently and requires them equal. If
// someone later re-derives SPI/CPI/EAC inside the report, this test is what catches the drift.
//
// WHY `measuredAt` IS NOT `latestCumulative` (UP8.3). The report for a month must quote the latest
// position measured AT OR BEFORE that month, not the project's latest position overall. Quoting
// December's CPI on a March report is the same class of error as no figure at all, and on a project
// with running totals every month has a row, so "the row for this month" is not the answer either.
//
// EVERY NUMBER IS WORKED OUT BY HAND IN THE TEST THAT ASSERTS IT.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3930;   // 3929 is acceptance.test.js.
const PROJECT = 1;   // PRJ-2026 "Citarum Bridge".
const LINE = '3.1';  // Concrete works.
const ACCOUNT = '1.1.1';

const MONTHLY = 100_000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

let fx;
let cbs;
let progress;
let rpt;
let revenue;
let acceptance;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-up8-' });
  [cbs, progress, rpt, revenue, acceptance] = fx.loadMany(
    'src/lib/cbs-service.js', 'src/lib/progress-service.js', 'src/lib/report-service.js',
    'src/lib/revenue-service.js', 'src/lib/acceptance-service.js');

  fx.db.prepare(`UPDATE projects SET contract_amount = 10000000, start_date = '2026-03-01',
      end_date = '2026-12-31', revenue_method = 'poc' WHERE id = ?`).run(PROJECT);

  // Clear the tables THIS FILE asserts exact figures on, so the assertions do not depend on whatever
  // the shared fixture happens to seed. A pre-existing accepted certificate would silently change
  // the POC basis, and a pre-existing approved BCR would break UP8.9's "nothing changed" case —
  // both would look like product bugs. (variance.test.js relies on the fixture seeding no progress
  // and no baseline; this file additionally needs a clean register and revenue history.)
  for (const t of ['project_reports', 'acceptance_register', 'revenue_recognized', 'bcr_register']) {
    fx.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(PROJECT);
  }

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

  // Measure MARCH: half the line done, and cost booked.
  //
  //   PV (March bucket)                       =   100,000
  //   EV = whole-line budget 1,000,000 x 50%  =   500,000
  //   AC = cost booked                        =   800,000
  //
  //   spi_cum = ev_cum / pv_cum = 500,000 / 100,000  =  5.0    (the fixture is tiny; a single
  //            monthly bucket against half a line earns 5x the plan. An ARTIFACT of the fixture's
  //            size, not a claim about the product — asserted as an exact number so it is visible.)
  //   cpi_cum = ev_cum / ac_cum = 500,000 / 800,000  =  0.625  BELOW the 0.95 threshold, so the
  //            report must raise a CPI exception. Deliberate: a fixture that never breaches cannot
  //            test the breach alert.
  //   cost_variance_pct = (ac_cum - ev_cum) / ev_cum x 100 = 300,000/500,000 = 60%
  tick(2, '2026-03');
  bookCost(800_000, 'UP8-BASE', '2026-03');

  // A certificate the client accepted in MARCH, so POC revenue has a basis (part 8.9 -> 8.10 -> 8.8).
  const rec = acceptance.record({
    projectId: PROJECT, actorId: fx.users.get('project_controller'),
    input: { certificate_no: 'UP8-BAST', percentage_progress: '25', document_date: '2026-03-05' },
  });
  acceptance.submit({ projectId: PROJECT, id: rec.certificate.id,
    actorId: fx.users.get('project_controller') });
  acceptance.accept({ projectId: PROJECT, id: rec.certificate.id,
    actorId: fx.users.get('project_manager'), acceptedDate: '2026-03-10' });

  // Recognise March. 25% of 10,000,000 = 2,500,000.
  revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
});

after(() => { if (fx) fx.stop(); });

// ---- helpers ---------------------------------------------------------------

const line = () => fx.db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(PROJECT, LINE);
const account = () => fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
const evmRow = (month) => fx.db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(PROJECT, month);

function bookCost(amount, documentNo, month) {
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'up8')`)
    .run(PROJECT, `${month}-15`, amount, amount, line().id, account().id, documentNo);
}

// Tick N of the line's four 25% milestones for one period.
function tick(n, month) {
  const ms = progress.milestones(line().id);
  const actor = fx.users.get('project_controller');
  for (let i = 0; i < n; i += 1) {
    progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: ms[i].id,
      ticked: true, period: month });
  }
}

const resetReports = () => fx.db.prepare('DELETE FROM project_reports').run();

// ---------------------------------------------------------------------------
// UP8.1 — a month with no measurement STATES that, and never renders zero
// ---------------------------------------------------------------------------

test('UP8.1 a month before any measurement reports the figures as ABSENT, not zero', () => {
  // 2026-01 is before the baseline window and before any cost, so nothing has been measured.
  const body = rpt.compile(PROJECT, '2026-01');

  assert.strictEqual(body.measured_month, null, 'no month has been measured at or before January');
  assert.strictEqual(body.spi, null, 'SPI is ABSENT (null), not 0');
  assert.strictEqual(body.cpi, null, 'CPI is ABSENT (null), not 0');
  assert.strictEqual(body.cost_variance_pct, null, 'and so is the variance %');

  // The distinction that matters: absent is not the same as "measured and equal to zero". A report
  // that printed 0.00 would claim the project is exactly on plan.
  assert.notStrictEqual(body.spi, 0, 'and specifically not 0');
  assert.strictEqual(body.evm_period, null, 'with no per-period figures either');
});

// ---------------------------------------------------------------------------
// UP8.2 — THE COMPILE-NOT-COMPUTE RULE: the report equals its owning services
// ---------------------------------------------------------------------------

test('UP8.2 the report\u2019s figures EQUAL the services that own them', () => {
  const body = rpt.compile(PROJECT, '2026-03');
  const row = evmRow('2026-03');

  // (a) The EVM figures come from the VIEW, not from arithmetic in the report.
  assert.strictEqual(body.spi, row.spi_cum, 'SPI is the view\u2019s spi_cum, unchanged');
  assert.strictEqual(body.cpi, row.cpi_cum, 'CPI is the view\u2019s cpi_cum, unchanged');
  assert.strictEqual(body.spi, 5, 'and the view says 5 on this fixture');
  assert.strictEqual(body.cpi, 0.625, 'and CPI is 500,000 / 800,000 = 0.625');
  assert.deepStrictEqual(body.evm_period,
    { pv: row.pv, ev: row.ev, ac: row.ac, pv_cum: row.pv_cum, ev_cum: row.ev_cum, ac_cum: row.ac_cum },
    'the per-period figures are the view\u2019s own row');

  // (b) Revenue comes from revenue-service, which is the only place the recognition rule lives.
  const reg = revenue.register(PROJECT);
  const expected = reg.rows.filter((r) => r.period_month <= '2026-03')
    .reduce((s, r) => s + (r.amount || 0), 0);
  assert.strictEqual(body.revenue_recognized, expected,
    'the report\u2019s revenue is revenue-service\u2019s cumulative position');
  assert.strictEqual(body.revenue_recognized, 2_500_000,
    'which is the accepted 25% of the 10,000,000 contract');

  // (c) Receivables come from the aging reader, so the report and the aging screen agree.
  const aging = fx.db.prepare(
    'SELECT COALESCE(SUM(outstanding_amount), 0) AS s FROM v_aging WHERE project_id = ?')
    .get(PROJECT).s;
  assert.strictEqual(body.receivable_amount, aging, 'the receivable is the aging view\u2019s total');

  // (d) The one figure with no owning service is computed here, and is labelled as such.
  // (ac_cum - ev_cum) / ev_cum = 300,000 / 500,000 = 60%
  assert.strictEqual(body.cost_variance_pct, 60, 'cost_variance_pct = (AC - EV) / EV = 60%');
});

// ---------------------------------------------------------------------------
// UP8.3 — the position is dated by the last REAL measurement at or before the month
// ---------------------------------------------------------------------------

test('UP8.3 a report quotes the position as at the last measured month, and flags staleness', () => {
  // 2026-04 has no bucket and no cost: no row of its own. The report must quote MARCH.
  const apr = rpt.compile(PROJECT, '2026-04');
  assert.strictEqual(apr.measured_month, '2026-03', 'April\u2019s report quotes the March position');
  assert.strictEqual(apr.evm_stale, true, 'and flags that the position is older than the month');
  assert.strictEqual(apr.spi, 5, 'using March\u2019s SPI, not an invented zero');
  assert.strictEqual(apr.cpi, 0.625, 'and March\u2019s CPI');

  // For March itself the position IS the month, so nothing is stale.
  const mar = rpt.compile(PROJECT, '2026-03');
  assert.strictEqual(mar.measured_month, '2026-03');
  assert.strictEqual(mar.evm_stale, false, 'a report whose month was measured is not stale');

  // The naive alternative — `forecast.latestCumulative` — would ignore the month asked about
  // entirely and quote the project's latest position. Pin the difference so the bounds stay.
  const forecast = fx.loadMany('src/lib/forecast-service.js')[0];
  const unbounded = forecast.latestCumulative(PROJECT);
  assert.ok(unbounded, 'the project does have a latest position');
  assert.strictEqual(unbounded.period_month, '2026-03',
    'on this fixture the latest is also March, so the bound is proved by UP8.1 (January = absent)');
});

// ---------------------------------------------------------------------------
// UP8.4 — generating twice, and what regeneration is and is not allowed to do
// ---------------------------------------------------------------------------

test('UP8.4 a later generation updates a DRAFT, and never touches a FROZEN report', () => {
  resetReports();

  const first = rpt.generate({ projectId: PROJECT, month: '2026-03',
    actorId: fx.users.get('project_controller') });
  assert.strictEqual(first.report.status, 'draft', 'a generated report is a DRAFT');
  assert.strictEqual(first.report.spi, 5, 'carrying the measured SPI');

  // A draft is not a commitment, so it may be regenerated (a cost was booked late).
  //
  // THE COST IS WHAT MOVES CPI, NOT THE RECEIVABLE. Booking a cost changes EV/AC, so the stored
  // `cpi` must change: 500,000 / 800,000 = 0.625 before, 500,000 / 850,000 = 0.5882 after. A
  // receivable would NOT move — receivables come from invoices, not from cost — so asserting that
  // instead would have "proved" regeneration with a number that never changes.
  bookCost(50_000, 'UP8-LATE', '2026-03');
  assert.strictEqual(first.report.cpi, 0.625, 'before: CPI = 500,000 / 800,000');
  const again = rpt.generate({ projectId: PROJECT, month: '2026-03',
    actorId: fx.users.get('project_controller') });
  assert.strictEqual(again.regenerated, true, 'the second generation UPDATED the existing row');
  assert.strictEqual(again.report.id, first.report.id, 'same row, not a duplicate');
  assert.strictEqual(fx.db.prepare('SELECT COUNT(*) n FROM project_reports').get().n, 1,
    'exactly one report for the month (the UNIQUE constraint holds)');
  assert.strictEqual(again.report.cpi, 0.5882,
    'and the stored CPI was RECOMPUTED from the new cost (500,000 / 850,000)');
  assert.notStrictEqual(again.report.cpi, first.report.cpi, 'so the figure genuinely moved');

  // The receivable did not move, because no invoice was issued — and the report still agrees with
  // the aging reader it reads from. Both facts asserted, so "unchanged" is a result and not a gap.
  assert.strictEqual(again.report.receivable_amount, first.report.receivable_amount,
    'the receivable is unchanged: booking a cost does not invoice the client');
  assert.strictEqual(again.report.receivable_amount, fx.db.prepare(
    'SELECT COALESCE(SUM(outstanding_amount), 0) AS s FROM v_aging WHERE project_id = ?')
    .get(PROJECT).s, 'and it still equals the aging view\u2019s total');

  // It was written straight to draft and signed off by nobody.
  assert.strictEqual(again.report.approved_by, null, 'regeneration clears any approval');
  assert.strictEqual(again.report.frozen_at, null, 'and writes nothing frozen');

  // The regeneration is on the record, with the figures it replaced.
  const audits = fx.db.prepare(`SELECT action FROM audit_log
      WHERE entity_type = 'project_reports' ORDER BY id`).all();
  assert.deepStrictEqual(audits.map((a) => a.action), ['create', 'regenerate'],
    'both writes are audited');

  // Now freeze it, and prove regeneration is refused afterwards.
  rpt.review({ projectId: PROJECT, id: first.report.id, actorId: fx.users.get('project_controller') });
  rpt.approve({ projectId: PROJECT, id: first.report.id, actorId: fx.users.get('project_manager') });
  assert.throws(
    () => rpt.generate({ projectId: PROJECT, month: '2026-03',
      actorId: fx.users.get('project_controller') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    'a frozen month\u2019s report cannot be regenerated');
});

// ---------------------------------------------------------------------------
// UP8.5 — the only path is draft -> reviewed -> frozen, and `approved` is never a resting state
// ---------------------------------------------------------------------------

test('UP8.5 the only path is draft \u2192 reviewed \u2192 frozen; approval IS the freeze', () => {
  resetReports();

  const g = rpt.generate({ projectId: PROJECT, month: '2026-05',
    actorId: fx.users.get('project_controller') });
  const id = g.report.id;
  assert.strictEqual(g.report.status, 'draft');

  // draft -> frozen (i.e. approving without reviewing) is refused. Asserted on BOTH entry points,
  // because `approve()` and `transition()` are separate code paths and one must not be a bypass.
  assert.throws(
    () => rpt.approve({ projectId: PROJECT, id, actorId: fx.users.get('project_manager') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    'a DRAFT cannot be approved \u2014 it must be reviewed first');
  assert.throws(
    () => rpt.transition({ projectId: PROJECT, id, to: 'frozen',
      actorId: fx.users.get('project_manager') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    'and the raw transition refuses it too');

  // draft -> reviewed
  const reviewed = rpt.review({ projectId: PROJECT, id,
    actorId: fx.users.get('project_controller') });
  assert.strictEqual(reviewed.status, 'reviewed', 'draft \u2192 reviewed');

  // reviewed -> APPROVED IS FROZEN. Under decision A these are one act, so the resting status is
  // `frozen`; `approved` is never stored. This is the assertion that pins the owner's decision.
  const done = rpt.approve({ projectId: PROJECT, id, actorId: fx.users.get('project_manager') });
  assert.strictEqual(done.report.status, 'frozen',
    'approval lands the report in FROZEN \u2014 approval and the freeze are the same act');
  assert.notStrictEqual(done.report.status, 'approved',
    '`approved` is never a resting state');
  assert.ok(done.report.approved_by, 'but WHO approved it is stamped');
  assert.ok(done.report.approved_at, 'and when');
  assert.ok(done.report.frozen_at, 'and it is stamped frozen');

  // No further move is possible.
  for (const to of ['draft', 'reviewed', 'approved']) {
    assert.throws(
      () => rpt.transition({ projectId: PROJECT, id, to, actorId: fx.users.get('project_manager') }),
      (e) => e instanceof rpt.ReportError && e.status === 409,
      `frozen \u2192 ${to} is refused`);
  }
});

// ---------------------------------------------------------------------------
// UP8.6 — only a Project Manager approves, and a refusal changes nothing
// ---------------------------------------------------------------------------

test('UP8.6 only the Project Manager may approve, and a refusal leaves the period OPEN', async () => {
  resetReports();
  const month = '2026-07';
  const g = rpt.generate({ projectId: PROJECT, month, actorId: fx.users.get('project_controller') });
  rpt.review({ projectId: PROJECT, id: g.report.id, actorId: fx.users.get('project_controller') });

  const before = fx.db.prepare('SELECT * FROM project_reports WHERE id = ?').get(g.report.id);

  // A project_controller may generate and review, but may NOT approve.
  const pc = fx.clients.get('project_controller');
  const pcPage = await pc.get('/reports/update');
  assert.strictEqual(pcPage.status, 200, 'the report screen renders');

  // THE PAGE MUST ACTUALLY RENDER, and say what it is. The route used to nest its locals under a
  // `locals:` key, which `page()` spreads as a single undefined-ish variable — the view then threw
  // `periods is not defined` and Express answered 500. The status assertions below passed anyway,
  // which is exactly why this one exists: a 403 from a broken page is not evidence of a working
  // permission.
  const html = await pcPage.text();
  assert.match(html, /Project update report/i, 'the heading is on the page');
  assert.match(html, /Exception/i, 'and the exceptions section rendered');
  assert.doesNotMatch(html, /is not defined|ReferenceError/i,
    'the view did not throw — a rendered error page would satisfy the 403 checks below for the '
    + 'wrong reason');

  const asPC = await pc.post(`/reports/update/${g.report.id}/approve`, '');
  assert.strictEqual(asPC.status, 403, 'a project_controller is refused the approve action');

  // A cost_controller holds neither capability. Asserted on a POST that EXISTS: there is no
  // `GET /reports/update/generate` (generation is a POST only), so asking for one would 404 for
  // everyone and the assertion would prove nothing about permission.
  const cc = fx.clients.get('cost_controller');
  await cc.get('/reports/update');
  const ccGenerate = await cc.post('/reports/update/generate',
    `period_month=${encodeURIComponent(month)}`);
  assert.strictEqual(ccGenerate.status, 403,
    'a cost_controller may not compile a report, and is refused by the capability guard');

  // THE ASSERTION THAT MATTERS: the DB is unchanged and the period is still WRITABLE.
  const after = fx.db.prepare('SELECT * FROM project_reports WHERE id = ?').get(g.report.id);
  assert.strictEqual(after.status, before.status, 'status untouched by the refused approvals');
  assert.strictEqual(after.frozen_at, null, 'nothing was frozen');
  const periods = fx.loadMany('src/lib/periods.js')[0];
  assert.strictEqual(periods.isFrozen(PROJECT, month), false,
    'and the month is STILL OPEN after the refusals');

  // The PM can approve it.
  const pm = fx.clients.get('project_manager');
  await pm.get('/reports/update');
  const asPM = await pm.post(`/reports/update/${g.report.id}/approve`, '');
  assert.strictEqual(asPM.status, 302, 'the Project Manager approves it');
  assert.strictEqual(periods.isFrozen(PROJECT, month), true, 'and the period is now frozen');
});

// ---------------------------------------------------------------------------
// UP8.7 — THE POINT: approving the report CLOSES THE PERIOD, in the database
// ---------------------------------------------------------------------------

test('UP8.7 approving the report freezes the period, and a BACKDATED WRITE IS REFUSED', () => {
  const month = '2026-08';   // a month with no cost yet, so the write below is the first

  const g = rpt.generate({ projectId: PROJECT, month, actorId: fx.users.get('project_controller') });
  rpt.review({ projectId: PROJECT, id: g.report.id, actorId: fx.users.get('project_controller') });

  // BEFORE the approval the month is open and a backdated entry is accepted — so the refusal below
  // is caused by the freeze and not by some unrelated rule about that month.
  bookCost(10_000, 'UP8-OPEN', month);
  const openCount = fx.db.prepare(
    "SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ? AND date LIKE ?")
    .get(PROJECT, `${month}%`).n;
  assert.strictEqual(openCount, 1, 'the entry was accepted while the month was open');

  const out = rpt.approve({ projectId: PROJECT, id: g.report.id,
    actorId: fx.users.get('project_manager') });
  assert.strictEqual(out.report.status, 'frozen', 'the report is frozen');
  assert.strictEqual(out.period, month, 'and it names the period it closed');

  // THE FREEZE IS IN THE DATABASE, not just on the report row: `frozen_periods` carries the month.
  const periods = fx.loadMany('src/lib/periods.js')[0];
  assert.strictEqual(periods.isFrozen(PROJECT, month), true, 'frozen_periods says the month is closed');
  const fp = fx.db.prepare('SELECT * FROM frozen_periods WHERE project_id = ? AND period_month = ?')
    .get(PROJECT, month);
  assert.ok(fp, 'the freezing row exists');
  assert.ok(fp.actor_id || fp.frozen_by || fp.created_by || fp.frozen_at,
    'and carries who/when it was frozen');

  // *** THE ASSERTION THAT JUSTIFIES THIS WHOLE PART ***
  // A NEW backdated entry into the frozen month must be REFUSED by the DATABASE. If a future change
  // makes `approve()` merely write a status, this line is what fails.
  assert.throws(
    () => bookCost(99_000, 'UP8-BACKDATED', month),
    (err) => /frozen/i.test(String(err.message)),
    'a backdated ledger write into the frozen period is REFUSED, with a reason');

  const afterCount = fx.db.prepare(
    "SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ? AND date LIKE ?")
    .get(PROJECT, `${month}%`).n;
  assert.strictEqual(afterCount, openCount, 'and nothing was written by the refused entry');

  // The freeze is audited, and the audit says it came from a report approval (not the /periods
  // button) so the two doors are distinguishable after the fact.
  const audit = fx.db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'frozen_periods'
      AND action = 'freeze' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(audit, 'the freeze is on the record');
  assert.match(audit.after_json, /report approval/,
    'and the audit names the report approval as what closed it');
});

// ---------------------------------------------------------------------------
// UP8.8 — a frozen report's figures cannot move
// ---------------------------------------------------------------------------

test('UP8.8 a frozen report cannot be regenerated or re-approved, and its figures stay put', () => {
  const r = rpt.forMonth(PROJECT, '2026-08');
  assert.strictEqual(r.status, 'frozen', 'the August report is frozen');

  const snapshot = { spi: r.spi, cpi: r.cpi, receivable: r.receivable_amount,
    revenue: r.revenue_recognized, payable: r.payable_amount };

  assert.throws(
    () => rpt.generate({ projectId: PROJECT, month: '2026-08',
      actorId: fx.users.get('project_controller') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    'regeneration is refused');
  assert.throws(
    () => rpt.approve({ projectId: PROJECT, id: r.id, actorId: fx.users.get('project_manager') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    're-approval is refused');
  assert.throws(
    () => rpt.review({ projectId: PROJECT, id: r.id, actorId: fx.users.get('project_controller') }),
    (e) => e instanceof rpt.ReportError && e.status === 409,
    'and it cannot be sent back to review either');

  const after = rpt.forMonth(PROJECT, '2026-08');
  assert.deepStrictEqual(
    { spi: after.spi, cpi: after.cpi, receivable: after.receivable_amount,
      revenue: after.revenue_recognized, payable: after.payable_amount },
    snapshot,
    'every stored figure is byte-identical after all the refused attempts');
});

// ---------------------------------------------------------------------------
// UP8.9 — exceptions and the baseline comparison, INCLUDING what is not checked
// ---------------------------------------------------------------------------

test('UP8.9 the report raises the alerts that fired, and NAMES the alerts it did not check', () => {
  const body = rpt.compile(PROJECT, '2026-03');
  const kinds = body.exceptions.raised.map((e) => e.kind);

  // THE EXPECTED CPI IS READ FROM THE DATABASE, not hardcoded. Earlier tests in this file book
  // additional cost into March (UP8.4 adds 50,000), so the accumulated CPI is 500,000 / 850,000 =
  // 0.5882 — not the 0.625 the fixture started at. Hardcoding would make this test fail for a
  // reason that has nothing to do with the alerts.
  const ev = fx.db.prepare(
    'SELECT ev_cum, ac_cum FROM v_evm_period WHERE project_id = ? AND period_month = ?')
    .get(PROJECT, '2026-03');
  const expectedCpi = Math.round((ev.ev_cum / ev.ac_cum) * 10000) / 10000;
  assert.strictEqual(body.cpi, expectedCpi, `the report quotes the accumulated CPI ${expectedCpi}`);

  // That CPI is below the 0.95 threshold, so the breach must be raised — and say which index.
  assert.ok(expectedCpi < 0.95, 'the fixture\u2019s March CPI is genuinely below the threshold');
  assert.ok(kinds.includes('cpi_breach'), 'the CPI breach is raised');
  const cpiAlert = body.exceptions.raised.find((e) => e.kind === 'cpi_breach');
  assert.ok(cpiAlert.text.includes(String(expectedCpi)),
    `the alert quotes the actual figure (${expectedCpi}): "${cpiAlert.text}"`);
  assert.match(cpiAlert.text, /0\.95/, 'and the threshold it breached');

  // SPI is 5.0 on this fixture — an artifact of a one-bucket month — so it is NOT a breach, and
  // asserting that keeps the check honest in both directions.
  assert.ok(!kinds.includes('spi_breach'), 'SPI did not breach, so no SPI alert');

  // "Progress not updated" cannot be evaluated (no per-line last-progress column). The report must
  // say so rather than let an absent alert read as a clean bill of health.
  const notChecked = body.exceptions.notEvaluated.map((e) => e.kind);
  assert.ok(notChecked.includes('progress_not_updated'),
    'the alert that CANNOT be checked is named as not checked');
  assert.match(body.exceptions.notEvaluated[0].reason, /last progress/i,
    'with the reason it cannot be checked');

  // Every alert names its threshold or its count — a bare "breach" would be unusable.
  for (const e of body.exceptions.raised) {
    assert.ok(e.text && e.text.length > 15, `alert ${e.kind} explains itself: "${e.text}"`);
  }

  // THE BASELINE COMPARISON. With no approved BCR in March, "nothing changed" is stated as an
  // ANSWER, not left blank — an empty box implies it was not looked at.
  assert.strictEqual(body.baseline_changes.rows.length, 0, 'no baseline change in March');
  assert.strictEqual(body.baseline_changes.totalImpact, 0, 'so the impact is zero');
  assert.match(body.baseline_changes.note, /No baseline change/i,
    'and the report SAYS nothing changed rather than showing an empty section');

  // Now add an approved BCR effective in March, and prove the report names it.
  fx.db.prepare(`INSERT INTO bcr_register (bcr_no, project_id, change_type, title, impact_cost,
      effective_period, status, initiated_by, approved_by, decided_at)
      VALUES ('BCR-UP8-1', ?, 'add_scope', 'Extra retaining wall', 250000, '2026-03', 'approved', ?, ?,
      '2026-03-20 10:00:00')`)
    .run(PROJECT, fx.users.get('cost_controller'), fx.users.get('project_manager'));

  const withBcr = rpt.compile(PROJECT, '2026-03');
  assert.strictEqual(withBcr.baseline_changes.rows.length, 1, 'the BCR is picked up');
  assert.strictEqual(withBcr.baseline_changes.rows[0].bcr_no, 'BCR-UP8-1', 'and named');
  assert.strictEqual(withBcr.baseline_changes.totalImpact, 250_000, 'with its cost impact summed');
  assert.match(withBcr.baseline_changes.note, /1 approved baseline change/i,
    'and the note says how many changed the period');

  // A BCR effective in ANOTHER period is not swept into this one.
  const other = rpt.compile(PROJECT, '2026-09');
  assert.strictEqual(other.baseline_changes.rows.length, 0,
    'a March BCR does not appear in September\u2019s report');
});
