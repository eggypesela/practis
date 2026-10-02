// RB7-series: the resource plan (module 7, plan part 7.3; PRD §5.1).
//
// WHAT THIS FILE EXISTS FOR
//
// The resource plan is what the project will CONSUME — and part 7.4 checks the PRD's
// named invariant, sum of the resource plan = the account total = the budget. So the
// total stored here has to be exact, and a plan line must not be able to exist twice.
//
// TWO THINGS ARE ACTUALLY BEING TESTED
//
//   1. THE ARITHMETIC IS MATERIALISED AND WHOLE-RUPIAH. `total_amount` is
//      rate x units, rounded once at write time and STORED — not recomputed on read.
//      Every other money column here is an integer enforced by trigger; a float
//      total would break the reconciliation where nobody would look. RB7.1–RB7.3
//      assert Number.isInteger, not merely a close value.
//
//   2. THE UNIQUE CONSTRAINT HAD TO BE FIXED, AND THE FIX IS PINNED. `rbs_load`'s
//      inline UNIQUE lists `transaction_account_id`, which is USUALLY NULL — and
//      SQLite treats NULLs as distinct, so the constraint applied to nothing.
//      Measured before migration 013: two identical rows inserted happily and the
//      plan total came out at 6,000,000 instead of 3,000,000. RB7.5 reproduces that
//      exact case, because a test that only used an ASSIGNED account would have
//      passed against the broken schema and proved nothing.
//
// Every deny-case asserts the DATABASE, not the status code: a refusal and a success
// are both redirects.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3906;   // F7: security.test.js holds 3905, so 3906 is free here

let dbPath, proc, db, admin, viewer, controller;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-rbs-')), 'test.db');
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
    { email: 'rb7-pc@example.test' })).client;
  viewer = (await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'rb7-viewer@example.test' })).client;
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

const nodeByCode = (code) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = 1 AND wbs_code = ? ORDER BY version').get(code);

// Every row for a bucket, regardless of version — so a test can tell "one live row"
// from "two rows", which is the whole point of the uniqueness checks.
const rowsFor = (nodeId, code, acct = null) => db.prepare(`
  SELECT * FROM rbs_load
  WHERE project_id = 1 AND wbs_node_id = ? AND rbs_code = ?
    AND COALESCE(transaction_account_id, 0) = COALESCE(?, 0)
  ORDER BY version`).all(nodeId, code, acct);

// The plan total: the sum of the LATEST version of each bucket. Deliberately
// written as its own SQL rather than by calling the service, so the test does not
// check the service against itself. A raw SUM over the table would count superseded
// versions too — a total that grows every time someone edits a rate.
const planTotal = () => db.prepare(`
  SELECT COALESCE(SUM(r.total_amount),0) s FROM rbs_load r
  WHERE r.version = (
    SELECT COALESCE(MAX(r2.version),1) FROM rbs_load r2
    WHERE r2.project_id = r.project_id AND r2.wbs_node_id = r.wbs_node_id
      AND r2.rbs_code = r.rbs_code
      AND COALESCE(r2.transaction_account_id,0) = COALESCE(r.transaction_account_id,0))`).get().s;

// The service's arithmetic, against this test's database.
function svc() {
  process.env.PRACTIS_DB = dbPath;
  delete require.cache[require.resolve('../src/db/db')];
  delete require.cache[require.resolve('../src/lib/rbs-service')];
  return require('../src/lib/rbs-service');
}

// ---- the arithmetic --------------------------------------------------------

test('RB7.1 total_amount is rate x units, stored as a whole number of rupiah', () => {
  const { totalFor } = svc();
  assert.strictEqual(totalFor(250000, 12), 3000000);
  assert.ok(Number.isInteger(totalFor(250000, 12)));
});

test('RB7.2 a fractional product rounds to whole rupiah — never a float', () => {
  const { totalFor } = svc();
  // 133,333.33... → 133,333, an integer. A float here would poison every sum.
  const t = totalFor(3333333 / 25, 1);
  assert.ok(Number.isInteger(t), 'the total must be an integer');
  assert.strictEqual(totalFor(100000, 2.5), 250000);
  assert.strictEqual(totalFor(99999, 0.335), Math.round(99999 * 0.335));
});

test('RB7.3 nonsense is refused rather than stored', () => {
  const { totalFor } = svc();
  assert.throws(() => totalFor(-1, 5), /negative/);
  assert.throws(() => totalFor(100, -5), /negative/);
  assert.throws(() => totalFor('abc', 5), /numbers/);
  assert.throws(() => totalFor(100, 1e15), /plausible/);
  assert.strictEqual(totalFor(0, 0), 0, 'a zero line is legal; withdrawing uses it');
});

// ---- uniqueness: the defect migration 013 closed ----------------------------

test('RB7.4 two plan lines with NO cost account and the same resource version as ONE row', async () => {
  // THE case that was broken: the account is the normal, optional blank.
  const node = nodeByCode('2.1');
  const before = rowsFor(node.id, 'L-CAR').length;

  const res = await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'L-CAR', transaction_account_id: '',
    rate: '250000', units: '12', unit_label: 'day', description: 'carpenter',
  });
  assert.strictEqual(res.status, 302);
  assert.ok(!/[?&]err=/.test(res.headers.get('location') || ''),
    'the first save must succeed: ' + decodeURIComponent(res.headers.get('location') || ''));

  const rows = rowsFor(node.id, 'L-CAR');
  assert.strictEqual(rows.length, before + 1, 'exactly ONE row for the bucket');
  assert.strictEqual(rows[0].version, 1);
  assert.strictEqual(rows[0].total_amount, 3000000, '12 days at 250,000');
  assert.strictEqual(rows[0].transaction_account_id, null, 'the account really is blank');
});

test('RB7.5 a SECOND save of the same blank-account bucket UPDATES it — the total does not double', async () => {
  // Before migration 013 this inserted a second row at version 1 and the plan total
  // silently became 6,000,000. This is the regression test for that exact bug.
  const node = nodeByCode('2.1');
  const before = rowsFor(node.id, 'L-CAR').length;
  const totalBefore = planTotal();

  const res = await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'L-CAR', transaction_account_id: '',
    rate: '250000', units: '12', unit_label: 'day',
  });
  const loc = decodeURIComponent(res.headers.get('location') || '');
  assert.ok(!/err=/.test(loc), 'the second save must also succeed: ' + loc);

  const rows = rowsFor(node.id, 'L-CAR');
  assert.strictEqual(rows.length, before + 1, 'still ONE new row, not a duplicate');
  assert.strictEqual(rows.length, 2, 'v1 and v2 — the old version is KEPT, not overwritten');
  assert.strictEqual(rows[1].version, 2);
  // The same figures saved again version the row but do NOT move the total: the plan
  // counts the LATEST version of each bucket, so re-saving is not a second line.
  // (Against the pre-013 schema the total doubled here; that is the bug RB7.5 pins.)
  assert.strictEqual(planTotal(), totalBefore, 'the plan total is unchanged, not doubled');
});

test('RB7.6 the same bucket with an ASSIGNED account is a separate line', async () => {
  const node = nodeByCode('2.1');
  const acct = db.prepare('SELECT id FROM transaction_accounts ORDER BY id').get().id;

  await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'L-CAR', transaction_account_id: String(acct),
    rate: '250000', units: '4', unit_label: 'day',
  });

  assert.strictEqual(rowsFor(node.id, 'L-CAR', null).length, 2, 'the blank-account bucket is untouched');
  const withAcct = rowsFor(node.id, 'L-CAR', acct);
  assert.strictEqual(withAcct.length, 1, 'the assigned-account line is its own bucket');
  assert.strictEqual(withAcct[0].total_amount, 1000000);
});

test('RB7.7 the database itself refuses a duplicate version, whatever the service does', () => {
  // The service check gives a readable message; the INDEX is what makes it true.
  // Written directly, bypassing the service entirely — this is the "rule that dies
  // at the first direct write" case that migration 013 exists to prevent.
  const node = nodeByCode('2.1');
  assert.throws(() => db.prepare(`INSERT INTO rbs_load
      (project_id, wbs_node_id, rbs_code, transaction_account_id, description,
       rate, units, unit_label, total_amount, version)
      VALUES (1, ?, 'L-CAR', NULL, 'duplicate', 250000, 12, 'day', 3000000, 1)`)
    .run(node.id), /UNIQUE|constraint/i);
});

// ---- versioning and history -------------------------------------------------

test('RB7.8 editing a rate keeps the earlier figure readable at its own version', async () => {
  const node = nodeByCode('2.2');
  await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'P-EXC', rate: '1500000', units: '10', unit_label: 'day',
  });
  await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'P-EXC', rate: '1800000', units: '10', unit_label: 'day',
  });

  const rows = rowsFor(node.id, 'P-EXC');
  assert.strictEqual(rows.length, 2, 'two versions');
  assert.strictEqual(rows[0].version, 1);
  assert.strictEqual(rows[0].total_amount, 15000000, 'the OLD rate is still readable');
  assert.strictEqual(rows[1].version, 2);
  assert.strictEqual(rows[1].total_amount, 18000000);
});

test('RB7.9 the screen shows the latest version of each bucket, and its total', async () => {
  const node = nodeByCode('2.2');
  const res = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345')
    .then((c) => c.get('/rbs'));
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Resource plan/);
  assert.match(html, /18,000,000/, 'the current excavator figure is shown');
  assert.ok(!/15,000,000/.test(html) || /version/i.test(html),
    'the superseded figure is not presented as the plan');
});

test('RB7.10 withdrawing writes a ZERO version instead of deleting the row', async () => {
  const node = nodeByCode('3.1');
  await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'M-CEM', rate: '1200000', units: '40', unit_label: 'tonne',
  });
  const totalWith = planTotal();

  const res = await post(controller, '/rbs/load/clear', {
    wbs_node_id: node.id, rbs_code: 'M-CEM', transaction_account_id: '',
  });
  assert.strictEqual(res.status, 302);
  assert.ok(!/err=/.test(decodeURIComponent(res.headers.get('location') || '')));

  const rows = rowsFor(node.id, 'M-CEM');
  assert.strictEqual(rows.length, 2, 'the original row still exists — nothing is deleted');
  assert.strictEqual(rows[0].total_amount, 48000000, 'and its figure is still readable');
  assert.strictEqual(rows[1].total_amount, 0, 'the withdrawal is a zero version');
  assert.strictEqual(planTotal(), totalWith - 48000000, 'the plan total dropped by that line');
});

// ---- the tags that are required, and the one that is not --------------------

test('RB7.11 an unknown resource code is refused with a readable message, not an FK crash', async () => {
  const node = nodeByCode('3.2');
  const before = count('rbs_load');

  const res = await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'X-NOPE', rate: '1000', units: '1',
  });
  const loc = await assertRefused(res, 'an unknown resource');
  assert.match(loc, /RBS list/, 'the message says where to add it');
  assert.strictEqual(count('rbs_load'), before, 'nothing was written');
});

test('RB7.12 a plan line with no work line is refused — it would belong to nothing', async () => {
  const before = count('rbs_load');
  const res = await post(controller, '/rbs/load', {
    wbs_node_id: '', rbs_code: 'L-CAR', rate: '1000', units: '1',
  });
  await assertRefused(res, 'no work line');
  assert.strictEqual(count('rbs_load'), before);
});

test('RB7.13 the cost account may be LEFT OFF and added later — decision 2A', async () => {
  // The account is the Cost Controller's call and commonly comes after the plan, so
  // demanding it now would stall planning on paperwork.
  const node = nodeByCode('4.1');
  const res = await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'L-SIT', transaction_account_id: '',
    rate: '200000', units: '30', unit_label: 'day',
  });
  assert.ok(!/err=/.test(decodeURIComponent(res.headers.get('location') || '')),
    'a blank account is NOT an error');

  const rows = rowsFor(node.id, 'L-SIT');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].transaction_account_id, null);
});

test('RB7.14 a bogus account id is refused, and nothing is written', async () => {
  const node = nodeByCode('4.1');
  const before = count('rbs_load');
  const res = await post(controller, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'L-SUP', transaction_account_id: '999999',
    rate: '1000', units: '1',
  });
  const loc = await assertRefused(res, 'a cost account that does not exist');
  assert.match(loc, /cost account/i);
  assert.strictEqual(count('rbs_load'), before);
});

// ---- authorization and scoping ---------------------------------------------

test('RB7.15 a viewer cannot write to the plan, and the database is unchanged', async () => {
  const node = nodeByCode('5.1');
  const before = count('rbs_load');

  const res = await post(viewer, '/rbs/load', {
    wbs_node_id: node.id, rbs_code: 'P-GEN', rate: '500000', units: '5',
  });
  assert.strictEqual(res.status, 403, 'a ROLE refusal is the 403 page');
  assert.strictEqual(count('rbs_load'), before, 'nothing was written');
});

test('RB7.16 a line from ANOTHER project cannot be loaded against', async () => {
  const info = db.prepare(`INSERT INTO projects (code, name, contract_amount, currency, status)
    VALUES ('RB7-OTHER', 'Other', 1000000, 'IDR', 'active')`).run();
  db.prepare(`INSERT INTO wbs_nodes (project_id, wbs_code, name, sort_order, version)
    VALUES (?, '1', 'Their line', 10, 1)`).run(info.lastInsertRowid);
  const theirNode = db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ?').get(info.lastInsertRowid);

  const before = count('rbs_load');
  const res = await post(controller, '/rbs/load', {
    wbs_node_id: theirNode.id, rbs_code: 'L-CAR', rate: '1000', units: '1',
  });

  assert.ok(res.status === 404 || res.status === 302, `expected a refusal, got ${res.status}`);
  assert.strictEqual(count('rbs_load'), before, 'NOTHING was written against another project');
});

test('RB7.17 the plan total is the sum of the LATEST version of each line only', async () => {
  // The number part 7.4 reconciles against the budget. Summing every version would
  // count superseded figures too — a wrong total that still looks like a total.
  const { loadFor, planTotal: total } = svc();
  const rows = loadFor(1);
  const expected = rows.reduce((s, r) => s + Number(r.total_amount || 0), 0);
  assert.strictEqual(total(1), expected, 'planTotal agrees with the rows shown');
  assert.strictEqual(rows.filter((r) => r.rbs_code === 'P-EXC').length, 1,
    'P-EXC appears once despite having two versions');
  assert.strictEqual(rows.find((r) => r.rbs_code === 'P-EXC').total_amount, 18000000,
    'and it is the LATEST version');
});
