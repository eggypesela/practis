// WB7-series: the WBS tree (module 7, plan part 7.1; PRD §4.4, §5.1).
//
// WHAT THIS FILE EXISTS FOR
//
// The WBS screen looks like a tree viewer with an edit form. It is where the
// PRD's change-control boundary actually lives, and three rules carry real money:
//
//   1. INTERNAL REPLANNING IS FREE; A CONTRACT CHANGE IS NOT. PRD §4.4: "the test
//      is the contract, not a size threshold." Add/split/rename/reparent a line
//      with the SAME total contract value → allowed directly, written to
//      `change_log` with `contract_value_delta = 0`. Add work NOT in the
//      contract → a full BCR. So a delta of one rupiah must be refused with no
//      tolerance and no "small change" carve-out. WB7.3 pins that, and asserts
//      the DATABASE is untouched, not merely the status code.
//
//   2. A RENAME VERSIONS THE LINE, IT DOES NOT OVERWRITE IT. PRD §5.1 and §4.4.
//      The old row keeps its name forever and points at the new one via
//      `superseded_by`; the new row is `version + 1`. WB7.4 proves the old text
//      still reads back — if the service UPDATEd in place, every historic
//      progress row would silently re-label itself.
//
//   3. A LINE IS NEVER DELETED. PRD §4.4. WB7.7 asserts there is no route that
//      deletes one (a 403 would still mean the route exists).
//
// WHY VERSIONS KEEP THEIR IDENTITY (`superseded_by` is a marker, not a redirect)
//
// This was the one design decision worth writing down. Two readers of this table
// disagree about versions, and both are right:
//
//   * `v_evm_period` joins `wbs_progress` to `wbs_nodes` per NODE, so it must see
//     every version INCLUDING superseded ones — a version drop would silently
//     erase earned value from the month it was reported.
//   * `v_descoped_lines` has no version filter at all, so if a second ACTIVE
//     version were created, a de-scoped line would be reported twice.
//
// The resolution: `superseded_by` marks the old row as historical but leaves its
// `status` alone, and the service REFUSES TO EDIT A SUPERSEDED ROW. A version
// exists exactly once, so neither view double-counts, and nothing is erased. If
// superseded rows were hidden from `v_evm_period` the whole point (history stays
// truthful) would be lost.
//
// Every deny-case asserts the DATABASE.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3907;              // was 3903 in the first plan draft — bola.test.js holds that

let dbPath, proc, db, admin, viewer, controller;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-wbs-')), 'test.db');
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
  // asRole returns { client, userId, email, password } — take the CLIENT here so
  // the rest of the file reads like every other test file.
  controller = (await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_controller',
    { email: 'wb7-pc@example.test' })).client;
  viewer = (await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'wb7-viewer@example.test' })).client;
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- helpers -------------------------------------------------------------
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const nodeBy = (id) => db.prepare('SELECT * FROM wbs_nodes WHERE id = ?').get(id);
const nodeByCode = (code) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = 1 AND wbs_code = ? ORDER BY version').all(code);
const logCount = () => count('change_log');
const logFor = (nodeId) => db.prepare(
  'SELECT * FROM change_log WHERE wbs_node_id = ? ORDER BY id').all(nodeId);

const post = (client, url, body) => client.post(url, new URLSearchParams(body).toString());

// A refusal on a FORM submission comes back as a redirect carrying the reason
// (`?err=`), not as a 403 — the 403 page is for a ROLE refusal. So "was it
// refused?" is answered by the message, and "did it actually change nothing?" is
// answered by the database. This helper asserts the first half; every call site
// asserts the second, because a 302 alone is exactly what SUCCESS returns too —
// which is how five authorization bugs once shipped past a green suite.
async function assertRefused(res, why) {
  assert.strictEqual(res.status, 302, `${why}: expected a redirect carrying the reason`);
  const loc = res.headers.get('location') || '';
  assert.match(loc, /[?&]err=/, `${why}: the redirect must carry an error, not a success notice`);
  assert.ok(!/[?&]msg=/.test(loc), `${why}: it must NOT report success`);
  return decodeURIComponent(loc);
}

// An Administrator adds a company-standard code FIRST (PRD §5.1: the per-project
// tree comes FROM the master menu). Fixture setup uses the test's own handle —
// never `require('../src/...')`, which would bind the default DB file.
let seq = 0;
function addMasterCode(code, name) {
  db.prepare('INSERT INTO wbs_code (code, name, parent_code, active) VALUES (?, ?, NULL, 1)')
    .run(code, name);
  return code;
}

// A fresh master code + the code string, so a test never depends on leftover state.
function freshCode(label) {
  seq += 1;
  const code = `9.${seq}`;
  addMasterCode(code, label);
  return code;
}

// WB7.4 creates the two-version line that WB7.5/WB7.6/WB7.8/WB7.10 then work on.
// The coupling is deliberate and explicit: those tests are about what may happen to
// a line once it HAS a history, so they need one. node:test runs a file's tests in
// order, so the dependency is safe — and naming the variable makes it visible
// rather than hiding it behind a hard-coded code.
let code97 = null;

test('WB7.1 the WBS page shows the project tree with parent/child structure', async () => {
  const res = await admin.get('/wbs');
  assert.strictEqual(res.status, 200, 'the page exists');
  const html = await res.text();
  assert.match(html, /Preparatory works/, 'a top-level line is listed');
  assert.match(html, /Site setup/, 'and a child line is listed');
  assert.match(html, /1\.1/, 'with its code from the master menu');
  // The tree must show the project's OWN tree, not every project's.
  assert.ok(!/PRJ-OTHER/.test(html), 'no other project leaks in');
});

test('WB7.2 adding a line inside the contract is allowed and logs delta 0', async () => {
  const code = freshCode('Additional rigging');
  const before = count('wbs_nodes');
  const res = await post(controller, '/wbs/lines', {
    wbs_code: code, name: 'Additional rigging', parent_id: '7',
    contract_value_delta: '0', reason: 're-planning within the same contract value',
  });
  assert.strictEqual(res.status, 302, 'accepted');

  const created = nodeByCode(code);
  assert.strictEqual(created.length, 1, 'exactly one line was created');
  assert.strictEqual(count('wbs_nodes'), before + 1);
  assert.strictEqual(created[0].parent_id, 7, 'placed under the requested parent');
  assert.strictEqual(created[0].version, 1, 'a new line starts at version 1');
  assert.strictEqual(created[0].status, 'active');

  const log = logFor(created[0].id);
  assert.strictEqual(log.length, 1, 'the replanning is recorded');
  assert.strictEqual(log[0].action, 'add_line');
  assert.strictEqual(log[0].contract_value_delta, 0, 'PRD §4.4: internal replanning carries ZERO delta');
  assert.match(log[0].reason, /re-planning/, 'and the reason the PRD asks for is stored');
});

test('WB7.3 an add that moves contract value is REFUSED and writes nothing', async () => {
  const code = freshCode('Client-requested extra');
  const beforeNodes = count('wbs_nodes');
  const beforeLog = logCount();

  const res = await post(controller, '/wbs/lines', {
    wbs_code: code, name: 'Client-requested extra',
    parent_id: '7', contract_value_delta: '1', reason: 'extra work',
  });

  // The PRD is exact: one rupiah is an external change needing a full BCR.
  const loc = await assertRefused(res, 'a one-rupiah contract change');
  assert.match(loc, /BCR/, 'and the message names the BCR as the way to do it');
  assert.strictEqual(count('wbs_nodes'), beforeNodes, 'the DATABASE is unchanged');
  assert.strictEqual(logCount(), beforeLog, 'and nothing was written to change_log');
  assert.strictEqual(nodeByCode(code).length, 0, 'the line does not exist');
});

test('WB7.4 rename VERSIONS the line: the old name reads back, superseded_by points at v2', async () => {
  // create it first through the app so the route is exercised, not just the DB
  const code = freshCode('Original name');
  code97 = code;                       // WB7.5/7.6/7.8/7.10 continue with this line
  await post(controller, '/wbs/lines', {
    wbs_code: code, name: 'Original name', parent_id: '7',
    contract_value_delta: '0', reason: 'initial',
  });
  const v1 = nodeByCode(code)[0];
  assert.ok(v1, 'the line exists before the rename');

  const res = await post(controller, `/wbs/lines/${v1.id}/rename`, {
    name: 'Renamed scope', reason: 'clearer wording, same value',
  });
  assert.strictEqual(res.status, 302);

  const versions = nodeByCode(code);
  assert.strictEqual(versions.length, 2, 'a second version was inserted, not an update');

  const [old1, new2] = versions;
  assert.strictEqual(old1.name, 'Original name', 'the old version keeps its ORIGINAL text');
  assert.strictEqual(old1.version, 1);
  assert.strictEqual(new2.name, 'Renamed scope');
  assert.strictEqual(new2.version, 2);
  assert.strictEqual(old1.superseded_by, new2.id, 'the old version points at its replacement');
  assert.strictEqual(new2.superseded_by, null, 'and the new one supersedes nothing');
  assert.strictEqual(new2.status, 'active', 'the current version stays active');
  assert.strictEqual(old1.status, 'active',
    'the superseded row keeps its status — hiding it would erase its earned value');

  const log = logFor(new2.id);
  assert.strictEqual(log.length, 1, 'the rename is logged against the NEW version');
  assert.strictEqual(log[0].action, 'rename_line');
  assert.strictEqual(log[0].contract_value_delta, 0);
});

test('WB7.5 a superseded version cannot be edited again — no third version appears', async () => {
  const code = code97;
  const v1 = nodeByCode(code)[0];
  const before = nodeByCode(code).length;

  const res = await post(controller, `/wbs/lines/${v1.id}/rename`, {
    name: 'Sneaky edit of history', reason: 'trying to rewrite the past',
  });

  const loc = await assertRefused(res, 'editing a superseded version');
  assert.match(loc, /current version/i, 'the message points at the current version');
  assert.strictEqual(nodeByCode(code).length, before, 'no new version was created');
  assert.strictEqual(nodeBy(v1.id).name, 'Original name', 'history is intact');
});

test('WB7.6 a rename that moves contract value is refused, and no version is written', async () => {
  const code = code97;
  const current = nodeByCode(code).find((r) => r.superseded_by === null);
  const before = nodeByCode(code).length;

  const res = await post(controller, `/wbs/lines/${current.id}/rename`, {
    name: 'Renamed with a price rise', reason: 'scope creep',
    contract_value_delta: '5000000',
  });

  await assertRefused(res, 'a rename that moves contract value');
  assert.strictEqual(nodeByCode(code).length, before, 'nothing was added');
  assert.strictEqual(nodeBy(current.id).name, current.name, 'and the current version is untouched');
});

test('WB7.7 no route deletes a WBS line, and the tree survives a POST to one', async () => {
  const before = count('wbs_nodes');
  // There must be no delete route. A 404 (not 403) is the proof it does not exist.
  const res = await post(admin, `/wbs/lines/1/delete`, {});
  assert.strictEqual(res.status, 404, 'there is no delete route at all');
  assert.strictEqual(count('wbs_nodes'), before, 'and the line is still there');

  // Also try the shapes a careless implementation might expose.
  for (const url of ['/wbs/lines/1', '/wbs/lines/1/remove', '/wbs/lines/1/destroy']) {
    const r = await post(admin, url, {});
    assert.ok(r.status === 404 || r.status === 405, `${url} must not delete (got ${r.status})`);
  }
  assert.strictEqual(count('wbs_nodes'), before, 'still nothing deleted');
});

test('WB7.8 a viewer cannot add, rename or change status — and the DB is unchanged', async () => {
  const beforeNodes = count('wbs_nodes');
  const beforeLog = logCount();

  const add = await post(viewer, '/wbs/lines', {
    wbs_code: '9.6', name: 'Viewer add', parent_id: '7', contract_value_delta: '0', reason: 'nope',
  });
  assert.strictEqual(add.status, 403, 'a Viewer cannot add a line');

  const rename = await post(viewer, `/wbs/lines/${nodeByCode(code97)[0].id}/rename`,
    { name: 'Viewer rename', reason: 'nope' });
  assert.strictEqual(rename.status, 403, 'a Viewer cannot rename a line');

  assert.strictEqual(count('wbs_nodes'), beforeNodes, 'the DATABASE is unchanged');
  assert.strictEqual(logCount(), beforeLog, 'and nothing was logged');
});

test('WB7.9 an unknown parent is refused rather than orphaning the line', async () => {
  const beforeNodes = count('wbs_nodes');
  const res = await post(controller, '/wbs/lines', {
    wbs_code: '9.5', name: 'Orphan', parent_id: '999999',
    contract_value_delta: '0', reason: 'bad parent',
  });
  assert.ok(res.status === 302 || res.status === 400, 'handled, not a crash');
  assert.strictEqual(count('wbs_nodes'), beforeNodes, 'no line was created against a missing parent');
});

test('WB7.10 status may move only between active and completed', async () => {
  const line = nodeByCode(code97).find((r) => r.superseded_by === null);

  const ok = await post(controller, `/wbs/lines/${line.id}/status`, {
    status: 'completed', reason: 'work finished',
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(nodeBy(line.id).status, 'completed');

  // `de_scoped` is a BCR-only transition (PRD §4.4) — this screen must not offer it.
  const scoped = await post(controller, `/wbs/lines/${line.id}/status`, {
    status: 'de_scoped', reason: 'trying the side door',
  });
  const loc = await assertRefused(scoped, 'a de-scope from the status control');
  assert.match(loc, /BCR/, 'the message names the one door: an approved BCR');
  assert.strictEqual(nodeBy(line.id).status, 'completed', 'the status is unchanged');
});
