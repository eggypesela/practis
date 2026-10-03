// MS6-series: project WBS defaults + the sidebar's no-dead-links contract
// (module 6, plan task 6.6).
//
// WHAT THIS FILE EXISTS FOR
//
//   1. EVERY NEW PROJECT GETS ITS TREE AND MILESTONES. PRD §5.1: the WBS tree
//      comes from the company-standard menu and each line carries the default
//      milestone set (mobilize → install → test → handover). Before this change a
//      project registered through the UI got NOTHING — no tree, no milestones — so
//      there was no progress to record. That is an empty-default problem and it is
//      invisible until someone tries to tick a milestone.
//
//   2. DECISION 7A: EQUAL 25% WEIGHTS. If the weights ever change, this test should
//      fail loudly, because "% complete" is derived from them.
//
//   3. NO DEAD LINKS. The sidebar carried five href="#" entries (Reports, Overview,
//      WBS, CBS plan, Revenue). A link that goes nowhere reads as "broken", not
//      "not built yet". This walks every sidebar link and asserts each one resolves
//      to a real route — and separately asserts no href="#" remains, so the five
//      cannot quietly come back.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3914;

let dbPath, proc, db, admin;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-wbsdef-')), 'test.db');
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
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// The audit rows for a project, in order — the ORDER matters in several tests.
const auditOf = (type, id) => db.prepare(
  'SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(type, id);

// Register a project THROUGH THE APP, as a user would.
async function registerProject(code) {
  const res = await admin.post('/projects', new URLSearchParams({
    code, name: `WBS test ${code}`, revenue_method: 'milestone', contract_amount: '1000000',
    start_date: '2026-05-01', end_date: '2027-05-01',
  }).toString());
  assert.strictEqual(res.status, 302, `project ${code} registered`);
  const id = db.prepare('SELECT id FROM projects WHERE code = ?').get(code).id;
  return id;
}

// ---- MS6.1 the tree exists ----
test('MS6.1 a newly registered project gets a WBS tree from the standard menu', async () => {
  const id = await registerProject('PRJ-WBS-1');
  const nodes = db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ? ORDER BY sort_order').all(id);

  assert.ok(nodes.length > 0, 'the project has a WBS tree');
  assert.strictEqual(nodes.length, 15, 'the whole standard menu was copied');

  // Codes come from the master menu, so the two cannot disagree.
  const master = db.prepare('SELECT code FROM wbs_code WHERE active = 1').all().map((r) => r.code);
  for (const n of nodes) assert.ok(master.includes(n.wbs_code), `${n.wbs_code} is in the master menu`);
});

test('MS6.2 the tree nests: a child points at a node of ITS OWN project', async () => {
  const id = db.prepare(`SELECT id FROM projects WHERE code='PRJ-WBS-1'`).get().id;
  const child = db.prepare(`SELECT * FROM wbs_nodes WHERE project_id=? AND wbs_code='1.1'`).get(id);
  const parent = db.prepare('SELECT * FROM wbs_nodes WHERE id=?').get(child.parent_id);

  assert.ok(parent, 'the child has a parent');
  assert.strictEqual(parent.wbs_code, '1', 'and it is the right parent');
  assert.strictEqual(parent.project_id, id, 'the parent belongs to the same project');

  const top = db.prepare(`SELECT * FROM wbs_nodes WHERE project_id=? AND wbs_code='1'`).get(id);
  assert.strictEqual(top.parent_id, null, 'a top-level code has no parent');
});

// ---- MS6.3/6.4 the milestones and decision 7A ----
test('MS6.3 every WBS line carries the four default milestones in order', async () => {
  const id = db.prepare(`SELECT id FROM projects WHERE code='PRJ-WBS-1'`).get().id;
  const node = db.prepare(`SELECT * FROM wbs_nodes WHERE project_id=? AND wbs_code='2.1'`).get(id);
  const ms = db.prepare('SELECT * FROM progress_milestones WHERE wbs_node_id=? ORDER BY seq').all(node.id);

  assert.deepStrictEqual(ms.map((m) => m.name), ['mobilize', 'install', 'test', 'handover'],
    'PRD §5.1 default progression');
  assert.deepStrictEqual(ms.map((m) => m.seq), [1, 2, 3, 4], 'in sequence');
  assert.ok(ms.every((m) => m.ticked === 0), 'and none is ticked — progress is recorded, not assumed');
});

test('MS6.4 the four default milestones carry EQUAL 25% weights (decision 7A)', async () => {
  const id = db.prepare(`SELECT id FROM projects WHERE code='PRJ-WBS-1'`).get().id;
  const rows = db.prepare(`
    SELECT pct_weight w, COUNT(*) c FROM progress_milestones m
    JOIN wbs_nodes n ON n.id = m.wbs_node_id WHERE n.project_id = ?
    GROUP BY pct_weight`).all(id);

  assert.deepStrictEqual(rows, [{ w: 25, c: 60 }],
    'PRD §5.1 default weights are 25% each (decision 7A)');
  assert.strictEqual(db.prepare(`
    SELECT COUNT(*) n FROM (SELECT wbs_node_id FROM progress_milestones m
      JOIN wbs_nodes n ON n.id=m.wbs_node_id WHERE n.project_id=?
      GROUP BY wbs_node_id HAVING COUNT(*) <> 4)`).get(id).n, 0,
    'every line has exactly four');
});

test('MS6.5 the tree build is recorded ON the create audit event — not as a second event', async () => {
  const id = db.prepare(`SELECT id FROM projects WHERE code='PRJ-WBS-1'`).get().id;
  const trail = auditOf('project', id);

  // REGRESSION GUARD. An earlier version of this wrote a SECOND audit row
  // ('wbs_defaults_created'), which broke PR2.2 and PR2.11: `auditOf(id).length`
  // became 2 for a freshly created project, so "the create is the first row" and
  // "approve is the second" both failed. Those tests were right — one create is
  // one audit EVENT, so the tree is a field of it.
  assert.strictEqual(trail.filter((t) => t.action === 'wbs_defaults_created').length, 0,
    'the tree build must NOT be its own audit row');

  const create = trail.find((t) => t.action === 'create');
  assert.ok(create, 'there is a create row');
  const after = JSON.parse(create.after_json);
  assert.ok(after.wbs_defaults, 'and it carries the tree summary');
  assert.strictEqual(after.wbs_defaults.nodes, 15);
  assert.strictEqual(after.wbs_defaults.milestones, 60);
  assert.strictEqual(after.wbs_defaults.weights, 'equal 25% (decision 7A)');
});

test('MS6.5b a project with no WBS master menu is created with no tree and still audits once', async () => {
  // The tree build must not be able to half-create a project. With the master menu
  // deactivated there are no codes to copy, so the project is created with an empty
  // tree — and must NOT be retried or refused.
  db.prepare('UPDATE wbs_code SET active = 0').run();
  try {
    const id = await registerProject('PRJ-WBS-NONE');
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) n FROM wbs_nodes WHERE project_id=?').get(id).n, 0,
      'no codes in the menu means no tree, not a failure');
    assert.strictEqual(auditOf('project', id).filter((t) => t.action === 'create').length, 1,
      'still exactly one create event');
  } finally {
    db.prepare('UPDATE wbs_code SET active = 1').run();
  }
});

test('MS6.6 a second project gets its OWN tree, not a share of the first', async () => {
  const a = db.prepare(`SELECT id FROM projects WHERE code='PRJ-WBS-1'`).get().id;
  const b = await registerProject('PRJ-WBS-2');

  const countFor = (pid) => db.prepare('SELECT COUNT(*) n FROM wbs_nodes WHERE project_id=?').get(pid).n;
  assert.strictEqual(countFor(a), 15, 'the first project is unchanged by the second');
  assert.strictEqual(countFor(b), 15, 'and the second got its own full tree');

  // The two trees must not be interlinked: every parent must be in the same project.
  assert.strictEqual(db.prepare(`
    SELECT COUNT(*) n FROM wbs_nodes c JOIN wbs_nodes p ON p.id = c.parent_id
    WHERE c.project_id <> p.project_id`).get().n, 0,
  'no node parents across projects');

  // And they are distinct rows, not the same 15 shared twice.
  assert.strictEqual(db.prepare(`
    SELECT COUNT(DISTINCT id) d FROM wbs_nodes WHERE project_id IN (?,?)`).get(a, b).d, 30);
});

// ---- MS6.7 the sidebar contract ----
test('MS6.7 no sidebar link is a dead href="#"', async () => {
  const res = await admin.get('/');
  const html = await res.text();
  const nav = html.slice(html.indexOf('<nav'));
  const sidebar = nav.slice(0, nav.indexOf('</nav>'));

  const dead = sidebar.match(/href="#"/g) || [];
  assert.strictEqual(dead.length, 0,
    'the sidebar must not advertise routes that do not exist — five were removed in task 6.6');
});

test('MS6.8 every sidebar link resolves to a real route', async () => {
  const res = await admin.get('/');
  const html = await res.text();
  const nav = html.slice(html.indexOf('<nav'));
  const sidebar = nav.slice(0, nav.indexOf('</nav>'));

  const hrefs = [...new Set([...sidebar.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]))];
  assert.ok(hrefs.length >= 8, 'the sidebar has a real set of links');

  for (const href of hrefs) {
    const r = await admin.get(href);
    // 200 = the page, 302 = a deliberate redirect. Both mean the route exists.
    // A route that does not exist answers 404, which is what this guards against.
    assert.ok(r.status === 200 || r.status === 302,
      `${href} resolves (got ${r.status}) — a dead link would be 404`);
  }
});

test('MS6.9 the sidebar offers Master data (Finance needs it, and cannot see Administration)', async () => {
  const { asRole } = require('./helpers/authz');
  const finance = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance',
    { email: 'ms69-fin@example.test' });

  const res = await finance.client.get('/');
  const html = await res.text();
  assert.ok(html.includes('/master'), 'Finance can see the Master data link');

  const master = await finance.client.get('/master');
  assert.strictEqual(master.status, 200, 'and can open it');

  // ...but the WBS list inside is still an Administrator screen.
  const wbs = await finance.client.get('/master/wbs');
  assert.strictEqual(wbs.status, 200, 'the list is readable');
  const post = await finance.client.post('/master/wbs',
    new URLSearchParams({ code: 'X', name: 'nope' }).toString());
  assert.strictEqual(post.status, 403, 'writing WBS structure is still Administrator-only');
});

test('MS6.10 the sidebar Reports link returns WITH its route (module 8 part 8.3)', async () => {
  // The other half of MS6.7/MS6.8. Those two assert the sidebar carries NO dead link; this
  // one asserts the link that was deliberately removed in task 6.6 came back in the SAME
  // commit as the route it names. A link pointing at an unbuilt route is the exact defect
  // MS6.8 guards against, so the two must land together — and this pins that they did.
  const res = await admin.get('/');
  const html = await res.text();
  const nav = html.slice(html.indexOf('<nav'));
  const sidebar = nav.slice(0, nav.indexOf('</nav>'));
  assert.ok(sidebar.includes('href="/reports"'), 'the sidebar advertises the reports index');

  const index = await admin.get('/reports');
  assert.strictEqual(index.status, 200, 'and the index exists (MS6.8 asserts this too)');
  const body = await index.text();
  assert.ok(body.includes('/reports/aging'), 'the index links to the aging report');
  const aging = await admin.get('/reports/aging');
  assert.strictEqual(aging.status, 200, 'which exists');
});
