// MP7-series: milestone ticks → per-period % complete (module 7, plan part 7.2;
// PRD §5.1).
//
// WHAT THIS FILE EXISTS FOR
//
// The number this part produces is `wbs_progress.pct_complete`, and `v_evm_period`
// multiplies it by the line's budget to get earned value. So the risk here is not a
// crash — it is a figure that is wrong and looks fine.
//
// The semantics come from the view, which sums ONLY the period it is reporting:
//
//     SUM(ba * wp.pct_complete / 100.0) GROUP BY (project, period_month)
//
// PV (cbs_plan buckets) and AC (v_cbs_actual) are monthly too, so `pct_complete`
// must be the increment earned IN THAT PERIOD. A cumulative value would inflate EV
// against a monthly PV and every SPI would be wrong by construction. MP7.7 is the
// test that pins it: two ticks in one period update one row; a tick in a later
// period adds a row and leaves the earlier period alone.
//
// The other thing worth knowing: a milestone is ticked ONCE (ticked is 0/1), so a
// tick must be CONVERTED to a period increment — (ticked now) − (already reported).
// The earlier rows are themselves increments, so their sum is the previous
// cumulative figure. That is what makes 3-of-4 ticked give +25 in the later period,
// not +75.
//
// Every deny-case asserts the DATABASE, because a refusal and a success are both
// redirects and only the data can tell them apart.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3915;   // F7: 3906 collides with security.test.js

let dbPath, proc, db, admin, viewer, controller;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  // A REAL fresh database, not this repo's dev file: the point is that the seed
  // gives every project's lines their milestones, which is exactly what the live
  // install was missing.
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-prog-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'e@example.com', 'epw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });

  admin = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  db = new (require('better-sqlite3'))(dbPath);

  const { asRole } = require('./helpers/authz');
  controller = (await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_controller',
    { email: 'mp7-pc@example.test' })).client;
  viewer = (await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'mp7-viewer@example.test' })).client;
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- helpers ---------------------------------------------------------------
const post = (client, url, body) => client.post(url, new URLSearchParams(body).toString());
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

async function assertRefused(res, why) {
  assert.strictEqual(res.status, 302, `${why}: expected a redirect carrying the reason`);
  const loc = res.headers.get('location') || '';
  assert.match(loc, /[?&]err=/, `${why}: must carry an error`);
  assert.ok(!/[?&]msg=/.test(loc), `${why}: must NOT report success`);
  return decodeURIComponent(loc);
}

// The node the tests report against, by code.
const nodeByCode = (code) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = 1 AND wbs_code = ? ORDER BY version').get(code);
const milestonesOf = (id) => db.prepare(
  'SELECT * FROM progress_milestones WHERE wbs_node_id = ? ORDER BY seq').all(id);
const progressOf = (id) => db.prepare(
  'SELECT * FROM wbs_progress WHERE wbs_node_id = ? ORDER BY period_month').all(id);

// The service's pure arithmetic, exercised directly. Requires the module against
// the test's own database file first, so the shared `db` handle is not the dev file.
function svc() {
  process.env.PRACTIS_DB = dbPath;
  delete require.cache[require.resolve('../src/db/db')];
  delete require.cache[require.resolve('../src/lib/progress-service')];
  return require('../src/lib/progress-service');
}

// ---- the arithmetic, as pure functions -------------------------------------

test('MP7.1 two of four 25% milestones ticked = 50%', () => {
  const { pctFromMilestones } = svc();
  assert.strictEqual(pctFromMilestones([
    { pct_weight: 25, ticked: 1 }, { pct_weight: 25, ticked: 1 },
    { pct_weight: 25, ticked: 0 }, { pct_weight: 25, ticked: 0 },
  ]), 50);
});

test('MP7.2 none ticked = 0, all ticked = 100', () => {
  const { pctFromMilestones } = svc();
  const mk = (t) => ({ pct_weight: 25, ticked: t });
  assert.strictEqual(pctFromMilestones([mk(0), mk(0), mk(0), mk(0)]), 0);
  assert.strictEqual(pctFromMilestones([mk(1), mk(1), mk(1), mk(1)]), 100);
  assert.strictEqual(pctFromMilestones([]), 0, 'no milestones = nothing earned');
});

test('MP7.3 weights need not be equal: 60/20/10/10 with the first two ticked = 80%', () => {
  const { pctFromMilestones } = svc();
  assert.strictEqual(pctFromMilestones([
    { pct_weight: 60, ticked: 1 }, { pct_weight: 20, ticked: 1 },
    { pct_weight: 10, ticked: 0 }, { pct_weight: 10, ticked: 0 },
  ]), 80);
});

test('MP7.4 weights totalling over 100 are refused before anything is written', () => {
  const { assertWeightsUsable } = svc();
  assert.throws(() => assertWeightsUsable([40, 30, 30, 30]), /more than 100/);
  assert.doesNotThrow(() => assertWeightsUsable([25, 25, 25, 25]),
    'exactly 100 is the normal case and must pass');
});

test('MP7.5 weights BELOW 100 are allowed — the line tops out with a known ceiling', () => {
  const { assertWeightsUsable, pctFromMilestones } = svc();
  assert.strictEqual(assertWeightsUsable([40, 20, 20]), 80, 'an 80% set is accepted');
  // ...and the ceiling is honest: all three ticked reports 80, not a false 100.
  assert.strictEqual(pctFromMilestones([
    { pct_weight: 40, ticked: 1 }, { pct_weight: 20, ticked: 1 }, { pct_weight: 20, ticked: 1 },
  ]), 80);
});

test('MP7.5b a weight set that would exceed 100 is refused through the app, DB unchanged', async () => {
  const node = nodeByCode('3.1');
  const before = milestonesOf(node.id).map((m) => m.pct_weight);

  const res = await post(controller, `/wbs/lines/${node.id}/weights`, {
    weights: '50,50,50,50',
  });
  const loc = await assertRefused(res, 'weights totalling 200%');
  assert.match(loc, /100/);
  assert.deepStrictEqual(milestonesOf(node.id).map((m) => m.pct_weight), before,
    'the database is unchanged');
});

// ---- the seed: every project's lines get milestones -------------------------

test('MP7.6 the seed gives EVERY project line its milestones, not just the demo project', () => {
  // This is the live-install bug: seed-master.js only filled the demo project, so a
  // real bridge got a tree with nothing to tick. Assert it across ALL lines.
  const bare = db.prepare(`
    SELECT COUNT(*) n FROM wbs_nodes n
    WHERE NOT EXISTS (SELECT 1 FROM progress_milestones m WHERE m.wbs_node_id = n.id)`).get().n;
  assert.strictEqual(bare, 0, 'no WBS line anywhere is left without milestones');
  assert.strictEqual(count('progress_milestones'), 15 * 4,
    '15 lines x the four defaults');
});

test('MP7.6b re-running the seed does not duplicate or reset milestones', () => {
  const before = count('progress_milestones');
  const node = nodeByCode('3.1');
  // A weight someone edited by hand must survive a second seed run.
  db.prepare('UPDATE progress_milestones SET pct_weight = 40 WHERE wbs_node_id = ? AND seq = 1')
    .run(node.id);

  sh([path.join('src', 'db', 'seed-master.js')], { PRACTIS_DB: dbPath });

  assert.strictEqual(count('progress_milestones'), before, 'no duplicates');
  assert.strictEqual(milestonesOf(node.id)[0].pct_weight, 40,
    'a hand-edited weight is not silently reset');
  db.prepare('UPDATE progress_milestones SET pct_weight = 25 WHERE wbs_node_id = ? AND seq = 1')
    .run(node.id);
});

// ---- ticking, through the app ----------------------------------------------

test('MP7.7 a tick writes ONE row for the period with the right increment and source', async () => {
  const node = nodeByCode('2.2');
  const ms = milestonesOf(node.id);
  assert.strictEqual(ms.length, 4, 'the line carries the four defaults');

  const res = await post(controller, `/wbs/milestones/${ms[0].id}/tick`, {
    period: '2026-06', note: 'piling rig mobilised',
  });
  assert.strictEqual(res.status, 302);

  const rows = progressOf(node.id);
  assert.strictEqual(rows.length, 1, 'exactly one row for the period');
  // 1 of 4 at 25% each = 25% earned in this period (NOT cumulative — see the header).
  assert.strictEqual(rows[0].pct_complete, 25);
  assert.strictEqual(rows[0].period_month, '2026-06');
  assert.strictEqual(rows[0].source, 'milestones');
  assert.ok(rows[0].reported_by, 'the reporter is recorded');
  assert.strictEqual(milestonesOf(node.id)[0].ticked, 1, 'the milestone itself is ticked');
});

test('MP7.8 two ticks in the SAME period UPDATE that row — never a second row', async () => {
  const node = nodeByCode('2.2');
  const ms = milestonesOf(node.id);
  const before = progressOf(node.id).length;

  await post(controller, `/wbs/milestones/${ms[1].id}/tick`, { period: '2026-06' });

  const rows = progressOf(node.id);
  assert.strictEqual(rows.length, before, 'still one row for 2026-06 (UNIQUE wbs_node_id+period)');
  assert.strictEqual(rows[0].pct_complete, 50, '2 of 4 ticked = 50%');
});

test('MP7.9 a later period adds its OWN row and leaves the earlier period alone', async () => {
  const node = nodeByCode('2.2');
  const ms = milestonesOf(node.id);

  await post(controller, `/wbs/milestones/${ms[2].id}/tick`, { period: '2026-07' });

  const rows = progressOf(node.id);
  assert.strictEqual(rows.length, 2, 'a new period is a new row');
  assert.strictEqual(rows[0].period_month, '2026-06');
  assert.strictEqual(rows[0].pct_complete, 50, 'JUNE IS UNCHANGED — history is not rewritten');
  assert.strictEqual(rows[1].period_month, '2026-07');
  // 3 of 4 ticked now, 50 already reported → 25 more earned in July. This is the
  // assertion that would fail if pct_complete were cumulative.
  assert.strictEqual(rows[1].pct_complete, 25, 'the increment, not the running total');
});

test('MP7.10 a line with nothing ticked still gets a 0% row — missing ≠ zero', async () => {
  const node = nodeByCode('4.1');
  const res = await post(controller, `/wbs/lines/${node.id}/progress`, { period: '2026-06' });
  assert.strictEqual(res.status, 302);

  const rows = progressOf(node.id);
  assert.strictEqual(rows.length, 1, 'a row exists');
  assert.strictEqual(rows[0].pct_complete, 0, 'and it says zero, which is a reported fact');
  assert.strictEqual(rows[0].source, 'milestones');
});

test('MP7.11 unticking reverses the period figure rather than going negative', async () => {
  const node = nodeByCode('2.2');
  const ms = milestonesOf(node.id);

  await post(controller, `/wbs/milestones/${ms[0].id}/untick`, { period: '2026-08' });

  const rows = progressOf(node.id);
  const aug = rows.find((r) => r.period_month === '2026-08');
  assert.ok(aug, 'the tick created an August row first');
  assert.ok(aug.pct_complete >= 0, 'never negative');
  // 2 of 4 ticked (June's pair, July's tick is still on) → 50 cumulative as of
  // August, and 50 was already reported in June+July, so August earns 0.
  assert.strictEqual(aug.pct_complete, 0);
  assert.strictEqual(progressOf(node.id).find((r) => r.period_month === '2026-06').pct_complete, 50,
    'the earlier periods are untouched by a later untick');
});

test('MP7.12 a frozen period is refused and the database is unchanged', async () => {
  const node = nodeByCode('2.2');
  const june = progressOf(node.id).find((r) => r.period_month === '2026-06');
  db.prepare('UPDATE wbs_progress SET frozen = 1 WHERE id = ?').run(june.id);
  const ms = milestonesOf(node.id);

  const res = await post(controller, `/wbs/milestones/${ms[3].id}/tick`, { period: '2026-06' });
  const loc = await assertRefused(res, 'a tick into a frozen period');
  assert.match(loc, /frozen/i);

  assert.strictEqual(
    progressOf(node.id).find((r) => r.period_month === '2026-06').pct_complete, 50,
    'the frozen figure is untouched');
  assert.strictEqual(milestonesOf(node.id)[3].ticked, 0,
    'and the milestone was NOT ticked — the refusal is all-or-nothing');

  db.prepare('UPDATE wbs_progress SET frozen = 0 WHERE id = ?').run(june.id);
});

test('MP7.13 a viewer cannot tick, and the database is unchanged', async () => {
  const node = nodeByCode('5.1');
  const ms = milestonesOf(node.id);
  const before = count('wbs_progress');

  const res = await post(viewer, `/wbs/milestones/${ms[0].id}/tick`, { period: '2026-06' });

  assert.strictEqual(res.status, 403, 'a ROLE refusal is the 403 page, not a redirect');
  assert.strictEqual(count('wbs_progress'), before, 'nothing was written');
  assert.strictEqual(milestonesOf(node.id)[0].ticked, 0, 'and the milestone is unticked');
});

test('MP7.14 a bad period is refused with a readable reason, nothing written', async () => {
  const node = nodeByCode('5.1');
  const ms = milestonesOf(node.id);
  const before = count('wbs_progress');

  const res = await post(controller, `/wbs/milestones/${ms[0].id}/tick`, { period: 'June 2026' });
  const loc = await assertRefused(res, 'a period that is not YYYY-MM');
  assert.match(loc, /YYYY-MM/);
  assert.strictEqual(count('wbs_progress'), before);
});

test('MP7.15 ticking a milestone of ANOTHER project is refused (no cross-project write)', async () => {
  // A second project, so the id genuinely belongs elsewhere.
  const info = db.prepare(`INSERT INTO projects (code, name, contract_amount, currency, status)
    VALUES ('MP7-OTHER', 'Other project', 1000000, 'IDR', 'active')`).run();
  const pid = info.lastInsertRowid;
  db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name, sort_order, version)
    VALUES (?, '1', 'Their line', 10, 1)`).run(pid);
  const theirNode = db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ?').get(pid);
  db.prepare(`INSERT INTO progress_milestones (wbs_node_id, seq, name, pct_weight)
    VALUES (?, 1, 'Their milestone', 100)`).run(theirNode.id);
  const theirMs = milestonesOf(theirNode.id)[0];

  const before = count('wbs_progress');
  const res = await post(controller, `/wbs/milestones/${theirMs.id}/tick`, { period: '2026-06' });

  // Either a refusal with a reason or a 404 is acceptable — what is NOT acceptable
  // is a write. The scope layer should stop this before the service sees it.
  assert.ok(res.status === 404 || res.status === 302,
    `expected a refusal, got ${res.status}`);
  assert.strictEqual(count('wbs_progress'), before, 'NOTHING was written for another project');
  assert.strictEqual(milestonesOf(theirNode.id)[0].ticked, 0, 'their milestone is untouched');
});
