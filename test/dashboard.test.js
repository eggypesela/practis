// DB8-series: the project dashboard / S-curves (module 8, plan part 8.6).
// THIS IS PART 8.6'S GATE.
//
// WHAT THIS FILE IS DEFENDING, and why the assertions look the way they do
//
// The page draws its charts with Chart.js, in the browser, onto a <canvas>. **A canvas cannot be
// asserted on in this environment** — headless Chrome is unreliable on this 2 GB no-swap host — so
// this file never touches a browser. Instead it asserts on the two things that CAN be checked and
// that between them leave nothing unchecked:
//
//   1. THE FIGURES, in src/lib/chart-config.js, in Node. Every number the chart would draw is
//      asserted here against a hand-computed expectation. If a figure is wrong, this fails.
//   2. THE PLUMBING, in the emitted HTML. The JSON block the page hands to the library, the
//      <script> tag it points at, and the fact that the script file EXISTS — because a 404'd chart
//      script produces a page that looks perfect and a canvas that is silently blank.
//
// DB8.6 is the one that keeps the separation honest: it asserts the browser script carries no
// monetary figure at all. Without that, a later change could quietly move arithmetic back into the
// view, where nothing can test it.
//
// EVERY EXPECTED NUMBER IS WORKED OUT BY HAND IN A COMMENT.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3926;   // 3925 is variance.test.js, 3927 will be the portfolio.
const REPO = path.join(__dirname, '..');
const PROJECT = 1;
const LINE = '3.1';       // Concrete works
const ACCOUNT = '1.1.1';

const MONTHLY = 100_000;
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10', '2026-11', '2026-12'];
const BAC = MONTHLY * MONTHS.length;   // 1,000,000

// The pinned Chart.js build. Asserted so a re-vendor, a hand-edit or a truncated download fails
// the suite instead of shipping. Provenance: vendored from the npm registry tarball for 4.5.1.
const CHART_SHA = '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a';
const CHART_REL = 'assets/vendor/chart.js/chart.umd.min.js';

let fx;
let chart;
let progress;
let cbs;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-db8-' });
  [chart, progress, cbs] = fx.loadMany('src/lib/chart-config.js', 'src/lib/progress-service.js',
    'src/lib/cbs-service.js');

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

const line = () => fx.db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(PROJECT, LINE);
const account = () => fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
const viewRow = (m) => fx.db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(PROJECT, m);

function bookCost(amount, documentNo, month = '2026-03') {
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'db8')`)
    .run(PROJECT, `${month}-15`, amount, amount, line().id, account().id, documentNo);
}

function tick(n, month = '2026-03') {
  const ms = progress.milestones(line().id);
  const actor = fx.users.get('project_controller');
  for (let i = 0; i < n; i += 1) {
    progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: ms[i].id,
      ticked: true, period: month });
  }
}

// ---------------------------------------------------------------------------
// DB8.1 — the cumulatives the chart draws ARE the view's columns, per month
// ---------------------------------------------------------------------------

test('DB8.1 every point on the planned curve is the view\u2019s own cumulative, not a re-sum', () => {
  // Month 1 of 10. Half the line done, and MORE cost booked than value earned — the shape that
  // makes the three curves separate visibly rather than overlap.
  //
  //   PV (March bucket)                        =   100,000
  //   EV = whole-line budget 1,000,000 x 50%   =   500,000
  //   AC = cost booked                         =   800,000
  tick(2);
  bookCost(800_000, 'DB8-1');

  const c = chart.scurve(PROJECT);
  assert.ok(!c.emptyReason, 'with a budget and a measurement there is a curve to draw');

  // One point per month drawn, and the labels are the months themselves.
  assert.strictEqual(c.labels.length, c.datasets[0].data.length,
    'every series has exactly one value per label \u2014 the alignment is done in the service');
  assert.ok(c.labels.includes('2026-03'), 'March is on the axis');

  // Each series' value at each month must be BYTE-IDENTICAL to the view's `*_cum` column. This is
  // the no-re-derivation property: if the service ever summed the monthly figures itself, a
  // difference in COALESCE or rounding would surface here.
  for (const ds of c.datasets) {
    const col = `${ds.key}_cum`;
    c.labels.forEach((m, i) => {
      const raw = viewRow(m);
      assert.strictEqual(ds.data[i], raw[col],
        `${ds.label} at ${m} is v_evm_period.${col} (${raw[col]}), not a fresh sum`);
    });
  }

  // And the first point, hand-computed, so the test does not merely agree with whatever is there.
  assert.strictEqual(c.datasets.find((d) => d.key === 'pv').data[0], 100_000, 'PV cum at March');
  assert.strictEqual(c.datasets.find((d) => d.key === 'ev').data[0], 500_000, 'EV cum at March');
  assert.strictEqual(c.datasets.find((d) => d.key === 'ac').data[0], 800_000, 'AC cum at March');

  // The three series are named as PRD §5.4 names them, in that order.
  assert.deepStrictEqual(c.datasets.map((d) => d.key), ['pv', 'ev', 'ac']);
  assert.deepStrictEqual(c.series.map((s) => s.label),
    ['Planned (PV)', 'Earned (EV)', 'Actual (AC)']);
});

// ---------------------------------------------------------------------------
// DB8.2 — cumulative means cumulative: the curve rises, and by the month's own amount
// ---------------------------------------------------------------------------

test('DB8.2 the curve accumulates \u2014 each point is the previous plus the month', () => {
  // April: another 50,000 spent, nothing new earned. The plan continues at 100,000 a month.
  //   PV_cum = 100,000 + 100,000 = 200,000
  //   EV_cum = 500,000 +       0 = 500,000
  //   AC_cum = 800,000 +  50,000 = 850,000
  bookCost(50_000, 'DB8-2', '2026-04');

  const c = chart.scurve(PROJECT);
  const at = (key) => c.datasets.find((d) => d.key === key).data;
  const iApr = c.labels.indexOf('2026-04');
  const iMar = c.labels.indexOf('2026-03');
  assert.ok(iApr > iMar, 'April follows March on the axis');

  assert.strictEqual(at('pv')[iApr], 200_000, 'planned cumulative = 200,000');
  assert.strictEqual(at('ev')[iApr], 500_000, 'earned is flat \u2014 nothing was earned in April');
  assert.strictEqual(at('ac')[iApr], 850_000, 'actual cumulative = 850,000');

  // The defining property of the S-curve: each point is the previous one plus that month's own
  // figure. Checked against the view's per-period column, so it is a real identity and not a
  // tautology about the same array.
  for (const key of ['pv', 'ev', 'ac']) {
    const raw = viewRow('2026-04');
    assert.strictEqual(at(key)[iApr], at(key)[iMar] + raw[key],
      `${key}: cumulative April = cumulative March + April's own ${key}`);
  }
});

// ---------------------------------------------------------------------------
// DB8.3 — the three empty states are DISTINCT, and none of them is a flat line
// ---------------------------------------------------------------------------

test('DB8.3 no baseline, baseline-without-measurement and measured are three different answers', () => {
  // (a) A project with NO baseline and no cost at all.
  const bare = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status) VALUES ('DB8-BARE', 'Nothing at all', 1000000, 'IDR', 'active')`)
    .run().lastInsertRowid);
  const a = chart.scurve(bare);
  assert.strictEqual(a.emptyReason !== null, true, 'a project with no plan reports why');
  assert.match(a.emptyReason, /no approved cost baseline/i, 'and it names the missing thing');
  assert.deepStrictEqual(a.datasets, [], 'and hands back NO series to draw');
  assert.deepStrictEqual(a.labels, [], 'and no axis');
  assert.strictEqual(a.bac, 0, 'BAC is zero');

  // (b) A baseline that has BEGUN, and nothing measured against it yet. This is the state every
  // project is in for its first month. Two things must be true, and this is where the first
  // version of the service was wrong:
  //
  //   - the PLANNED curve must be drawn (there is a plan, and a plan is data), and
  //   - the reason must say nothing has been MEASURED, not that there is no budget.
  //
  // The service originally judged "has this project reached this month?" on the PER-PERIOD
  // figures, so a project with a spread budget and no ticks yet looked entirely empty and was
  // told "nothing has been measured against the budget" while its budget sat there. It is judged
  // on the CUMULATIVE figures now.
  const planned = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status) VALUES ('DB8-PLAN', 'Planned not measured', 1000000, 'IDR', 'active')`)
    .run().lastInsertRowid);
  const nodeId = Number(fx.db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name,
      sort_order, version) VALUES (?, '1', 'A line', 10, 1)`).run(planned).lastInsertRowid);
  fx.db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id, plan_type,
      version, period_month, amount) VALUES (?, ?, ?, 'baseline', 1, '2026-05', 500000)`)
    .run(planned, account().id, nodeId);
  const b = chart.scurve(planned);
  assert.strictEqual(b.bac, 500_000, 'the budget IS set');
  assert.ok(b.datasets.length === 3, 'so the planned curve IS drawn \u2014 a plan is data');
  assert.strictEqual(b.datasets.find((d) => d.key === 'pv').data[0], 500_000,
    'and the planned series carries the baseline');
  assert.strictEqual(b.datasets.find((d) => d.key === 'ev').data[0], 0,
    'while nothing has been earned yet');
  assert.strictEqual(b.datasets.find((d) => d.key === 'ac').data[0], 0,
    'and nothing has been spent');
  assert.ok(!b.emptyReason, 'this project HAS something to draw, so it is not an empty state');

  // (c) The genuinely empty plan: no baseline at all. Its reason is a different sentence, because
  // the reader's next action is different.
  assert.notStrictEqual(a.emptyReason, b.emptyReason,
    'no-budget and budget-not-measured must NOT be the same sentence \u2014 the fix differs');
  assert.match(a.emptyReason, /baseline/i, 'no baseline is about the budget');

  // (d) A project can hold COST and still have no plan to compare it against. That gets its own
  // wording too \u2014 "nothing recorded" would be false, because cost IS recorded.
  const costOnly = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status) VALUES ('DB8-COST', 'Cost but no plan', 1000000, 'IDR', 'active')`)
    .run().lastInsertRowid);
  fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis,
      source, amount, debit, credit, document_no, description)
      VALUES (?, '2026-06-10', 'Expense', 'expense', 1, 'manual', 70000, 70000, 0, 'DB8-C', 'db8')`)
    .run(costOnly);
  const d = chart.scurve(costOnly);
  assert.strictEqual(d.bac, 0, 'still no baseline');
  assert.match(d.emptyReason, /cost recorded/i,
    'and the sentence acknowledges the cost that IS there rather than claiming nothing is');
});

// ---------------------------------------------------------------------------
// DB8.4 — the Y scale is stated, covers the data, and rounds UP to a readable step
// ---------------------------------------------------------------------------

test('DB8.4 the stated Y scale covers every point and is rounded up to a readable figure', () => {
  const c = chart.scurve(PROJECT);

  // The largest figure anywhere on the chart, including the approved budget (so the budget line
  // is never above the top of the axis where it cannot be seen).
  const peak = Math.max(...c.datasets.flatMap((d) => d.data), c.bac);
  assert.ok(c.yMax >= peak, `yMax ${c.yMax} covers the peak ${peak}`);

  // Rounded UP to a power-of-ten step: 1,000,000 -> step 1,000,000 -> yMax exactly 1,000,000.
  assert.strictEqual(c.yMax, 1_000_000,
    'peak is the budget 1,000,000, one significant figure step, so the axis tops out there');

  // The scale is a number the page prints. If it were recomputed in the view it could disagree
  // with the axis the library actually draws.
  assert.strictEqual(typeof c.yMax, 'number', 'yMax is a plain number, serialisable to JSON');
});

// ---------------------------------------------------------------------------
// DB8.5 — the period bars are the same figures at a different granularity
// ---------------------------------------------------------------------------

test('DB8.5 the period bars are the view\u2019s per-period figures, not the cumulatives', () => {
  const b = chart.bars(PROJECT);
  const c = chart.scurve(PROJECT);

  assert.ok(!b.emptyReason, 'there are measured months, so there are bars');
  assert.strictEqual(b.labels.length, b.datasets[0].data.length, 'one value per label');

  // The bars default to a WINDOW (the most recent measured months), while the curve draws every
  // month. So the concrete checks below are made on a wide window, and the default is asserted
  // separately — otherwise this test would be asserting about a window that does not contain the
  // month it is talking about.
  assert.ok(b.points <= 6, 'the bars default to the last six measured months');
  assert.ok(b.points > 0, 'and there are some');

  const wide = chart.bars(PROJECT, { limit: 24 });

  // NOT cumulative. This is the whole reason the bars exist: the running total hides a bad month.
  for (const ds of wide.datasets) {
    wide.labels.forEach((m, i) => {
      const raw = viewRow(m);
      assert.strictEqual(ds.data[i], raw[ds.key],
        `the ${ds.label} bar for ${m} is the PERIOD figure (${raw[ds.key]}), not the cumulative`);
    });
  }

  // Concretely: April's actual bar is 50,000 while April's actual CURVE point is 850,000. Same
  // source, same month, deliberately different numbers.
  const iApr = wide.labels.indexOf('2026-04');
  assert.ok(iApr >= 0, 'April is inside the wide window');
  const acBar = wide.datasets.find((d) => d.key === 'ac').data[iApr];
  const acCurve = chart.scurve(PROJECT).datasets.find((d) => d.key === 'ac')
    .data[chart.scurve(PROJECT).labels.indexOf('2026-04')];
  assert.strictEqual(acBar, 50_000, 'April\u2019s actual for that month alone');
  assert.strictEqual(acCurve, 850_000, 'April\u2019s actual running total');
  assert.notStrictEqual(acBar, acCurve, 'and they are not the same figure \u2014 the point of the bars');
});

// ---------------------------------------------------------------------------
// DB8.6 — THE SEPARATION: the browser script carries no figures
// ---------------------------------------------------------------------------

test('DB8.6 the page script contains no monetary figure \u2014 all arithmetic is server-side', async () => {
  // The risk this pins: someone later "simplifies" by computing a total in the inline script.
  // That code would be untestable here (no reliable headless browser), so the suite would go on
  // passing while the chart silently diverged from the report underneath it.
  const src = fs.readFileSync(path.join(REPO, 'views/project-dashboard.ejs'), 'utf8');

  // The inline script block itself must not contain a rupiah literal or a hard-coded figure from
  // the fixture. It may READ the JSON; it must not know any number.
  const script = src.slice(src.lastIndexOf('<script nonce='));
  assert.ok(script.length > 100, 'the inline script was found');
  for (const needle of ['1,000,000', '1000000', '850,000', '500,000', '800,000', 'Rp 1']) {
    assert.ok(!script.includes(needle),
      `the browser script must not contain the figure ${needle} \u2014 it belongs in chart-config.js`);
  }
  // It draws only what it is handed.
  assert.match(script, /getElementById\('scurve-data'\)/,
    'the script reads the server-built JSON block');
  assert.match(script, /scurve-data/, 'by id');
  assert.match(script, /JSON\.parse/, 'and parses it rather than recomputing it');

  // And the figures really are in the JSON the server emits, not in the script.
  assert.match(src, /type="application\/json" id="scurve-data"/,
    'the server serialises the chart data into a JSON block');
});

// ---------------------------------------------------------------------------
// DB8.7 — the screen over HTTP: it renders, it is scoped, and the numbers reach the page
// ---------------------------------------------------------------------------

test('DB8.7 the dashboard renders, is project-scoped, and carries the figures and the charts', async () => {
  const cc = fx.clients.get('cost_controller');
  // For the read-only assertion at the end: what the ledger holds before this test touches anything.
  const before = fx.db.prepare('SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?')
    .get(PROJECT).n;
  const res = await cc.get('/reports/project?project=' + PROJECT);
  assert.strictEqual(res.status, 200, 'the project overview renders');
  const html = await res.text();

  // The page says which project it is about — a dashboard that does not name its subject is a
  // dashboard someone screenshots and mis-files. Read the name from the database rather than
  // hardcoding it: the seeder's name is the fixture's business, not this test's.
  const name = fx.db.prepare('SELECT name FROM projects WHERE id = ?').get(PROJECT).name;
  assert.ok(html.includes(name), `the project (${name}) is named in the heading`);

  // The JSON block is present and parses, and carries the same figures the service returns.
  const m = html.match(/<script type="application\/json" id="scurve-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'the chart data block is emitted');
  const payload = JSON.parse(m[1]);
  assert.deepStrictEqual(payload.curve.labels, chart.scurve(PROJECT).labels,
    'the labels the page hands the library are the service\u2019s labels');
  assert.strictEqual(payload.curve.yMax, 1_000_000, 'and the stated scale travels with them');
  assert.strictEqual(payload.curve.datasets.length, 3, 'three series, planned / earned / actual');
  assert.strictEqual(payload.source, '/vendor/chart.js/chart.umd.min.js',
    'the page names the vendored script');

  // Both canvases are in the markup (they are what the library draws into).
  assert.ok(html.includes('id="curve"'), 'the S-curve canvas is on the page');
  assert.ok(html.includes('id="bars"'), 'and the period-bars canvas');

  // The script tag is present, served from our own origin (no CDN — TECH-SPEC §3.6).
  assert.ok(html.includes('src="/vendor/chart.js/chart.umd.min.js"'),
    'the chart script is self-hosted from our own origin');
  assert.ok(!/src="https?:\/\//.test(html), 'and nothing on the page loads from a CDN');

  // SCOPING. Two honest assertions, because "is this page scoped?" has two different answers
  // depending on the user, and asserting only one of them would pin a half-truth.
  //
  // (1) A user holding NO role resolves to NO project. `projectsFor` returns an empty list and
  //     `projectContext` leaves `project` null, so the page renders its no-project state. This is
  //     the case that actually matters: an unassigned account must be told there is nothing in
  //     scope, never quietly dropped into some project and shown a stranger's money.
  const argon2 = require('argon2');
  const { loggedIn } = require('./helpers/csrf');
  const PB = 'db8-password-12345';
  fx.db.prepare(`INSERT INTO users (email, full_name, password_hash, is_system_admin)
      VALUES ('db8-norole@example.test', 'No role', ?, 0)`).run(await argon2.hash(PB));
  const norole = await loggedIn(fx.ORIGIN, 'db8-norole@example.test', PB);

  const other = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, currency,
      status) VALUES ('DB8-OTHER', 'Another project entirely', 5000000, 'IDR', 'active')`)
    .run().lastInsertRowid);
  const otherName = fx.db.prepare('SELECT name FROM projects WHERE id = ?').get(other).name;

  const noScope = await norole.get('/reports/project?project=' + other);
  const noScopeHtml = await noScope.text();
  assert.ok(/no project is in scope/i.test(noScopeHtml),
    'a user with no role is told no project is in scope');
  assert.ok(!noScopeHtml.includes(otherName),
    'and is NOT shown the project they asked for \u2014 the ?project= parameter does not widen scope');

  // (2) An ORG-WIDE role legitimately reaches every project, and the switch is honoured. A Cost
  // Controller is org-wide by rule 5 of `projectsFor`, so this is not a leak — it is the rule
  // working — and pinning it here records that deliberately, so a later change that silently
  // narrowed org-wide users would fail this test rather than ship.
  const switched = await cc.get('/reports/project?project=' + other);
  assert.strictEqual(switched.status, 200, 'an org-wide user may open another project');
  assert.ok((await switched.text()).includes(otherName), 'and the page follows the switch');

  // The dashboard is read-only: none of the above may have written anything.
  assert.strictEqual(
    fx.db.prepare('SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?').get(PROJECT).n,
    before, 'and none of it changed the ledger');
});

// ---------------------------------------------------------------------------
// DB8.8 — THE SILENT FAILURE: the chart script must exist, and be the pinned build
// ---------------------------------------------------------------------------

test('DB8.8 the vendored Chart.js exists on disk and is the pinned build', async () => {
  // Why this test exists at all: if the script 404s, EVERYTHING ELSE STILL PASSES. The page
  // renders, the JSON is correct, the markup is correct — and the charts are blank, because the
  // library never loaded. It is the single defect in this part that nothing else would catch, and
  // it is the one an operator would blame on "the charts are broken" weeks later.
  const abs = path.join(REPO, CHART_REL);
  assert.ok(fs.existsSync(abs), `${CHART_REL} exists on disk`);

  // Served over HTTP too — a file that exists but is not reachable through express.static is the
  // same blank canvas.
  const cc = fx.clients.get('cost_controller');
  const asset = await cc.get('/vendor/chart.js/chart.umd.min.js');
  assert.strictEqual(asset.status, 200, 'and is served by the app at the URL the page names');

  // The exact pinned build. A re-vendor, a hand-edit or a truncated download must fail the suite
  // rather than ship quietly.
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  assert.strictEqual(sha, CHART_SHA,
    'the vendored Chart.js is the pinned 4.5.1 build \u2014 if this changed, it was re-vendored or edited');

  // MIT requires the notice to ship with the bundle.
  assert.ok(fs.existsSync(path.join(REPO, 'assets/vendor/chart.js/LICENSE.md')),
    'the MIT licence ships beside the bundle');
  const head = fs.readFileSync(abs, 'utf8').slice(0, 200);
  assert.match(head, /Chart\.js v4\.5\.1/, 'and the copyright banner is still at the top of the file');
  assert.match(head, /MIT License/, 'naming the licence');

  // The saved bytes are the ones we hashed — guard against a binary-safe-copy mistake where the
  // file ends up with a BOM or CRLF translation that would still "look fine".
  assert.ok(fs.statSync(abs).size > 150_000,
    'the full bundle is present (a truncated copy would be a blank chart)');
});
