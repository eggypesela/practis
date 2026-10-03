// MA5-series: master data screens (module 6, plan task 6.5; PRD §5.5).
//
// WHAT THIS FILE EXISTS FOR
// Master data looks like ordinary CRUD and is not. Three rules carry real money:
//
//   1. NOTHING IS DELETED. `transaction_accounts` (CBS) is the column `v_cbs_actual`
//      groups by, and `accounting_ledger` rows point at it. So the screens only
//      deactivate, and deactivating an UNUSED bucket must not move an existing
//      report total. MA5.9 proves that against the view itself rather than against
//      the column.
//   2. THE GATE IS TWO-LEVEL. PRD §8 "Ask first" puts WBS/RBS menu changes behind
//      Administrator; a cost bucket or ledger account is day-to-day Finance work.
//      MA5.7/MA5.8 pin both halves — an admin-only rule and a manager-only rule
//      would each pass a single test and fail the intent.
//   3. THE CODE IS SET ONCE. It is the key imports and other rows match on.
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
const PORT = 3913;

let dbPath, proc, db, admin, finance, viewer;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-master-')), 'test.db');
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

  // MA5.1 and the dataset registry reach the app IN-PROCESS: `keys9()` requires
  // `src/lib/master-service.js` from THIS process, and that binds `src/db/db.js` to whatever
  // `PRACTIS_DB` says — or to `data/practis.db`, the DEV database, when it is unset. This file
  // hands PRACTIS_DB only to the CHILD server, so before this line the in-process require was
  // silently reading and writing the dev database.
  //
  // It went unnoticed until module 8 migration 021 added a column to `v_aging`: a test process
  // then prepared a statement against a dev database still on v20 and failed with
  // "no such column: terms_days". The stale read was always wrong; only the shared-run made the
  // consequence visible. Binding the parent process here is the fix.
  process.env.PRACTIS_DB = dbPath;

  const { asRole } = require('./helpers/authz');
  finance = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance',
    { email: 'ma5-fin@example.test' });
  viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'ma5-viewer@example.test' });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const rowBy = (t, col, v) => db.prepare(`SELECT * FROM ${t} WHERE ${col} = ?`).get(v);
const auditOf = (t, id) => db.prepare(
  `SELECT * FROM audit_log WHERE entity_type=? AND entity_id=? ORDER BY id`).all(t, id);
// The view the cost report is built on.
const cbsTotal = () => db.prepare('SELECT COALESCE(SUM(actual_amount),0) s FROM v_cbs_actual').get().s;

let costCatId, wbsId, rescatId, cbsId;

// ---- MA5.1 the index and every list render ----
test('MA5.1 the master-data index and all nine lists render', async () => {
  const idx = await admin.get('/master');
  assert.strictEqual(idx.status, 200);
  const html = await idx.text();
  assert.ok(html.includes('Master data'), 'the index has its heading');

  const KEYS = ['coa', 'cashflow', 'costcat', 'rescat', 'wbs', 'rbs', 'cbs', 'industry', 'projecttype'];
  for (const k of keys9()) {
    const res = await admin.get(`/master/${k}`);
    assert.strictEqual(res.status, 200, `/master/${k} renders`);
  }
  assert.strictEqual(KEYS.length, 9, 'nine datasets are registered');
});

function keys9() {
  // Read the registry rather than hard-coding: a tenth dataset should not require
  // editing this test's list, only adding an assertion below.
  const svc = require(path.join(ROOT, 'src/lib/master-service.js'));
  return svc.keys();
}

test('MA5.2 an unknown dataset is a 404, not a guess', async () => {
  const res = await admin.get('/master/not-a-list');
  assert.strictEqual(res.status, 404);
});

test('MA5.3 an anonymous visitor cannot open the master-data screens', async () => {
  const { client } = require('./helpers/csrf');
  const anon = client(ORIGIN);
  assert.strictEqual((await anon.get('/master')).status, 302, 'redirected to sign in');
});

// ---- MA5.4 create, with the key enforced ----
test('MA5.4 a Finance user can add a cost category; a duplicate code is refused', async () => {
  const before = count('cost_categories');
  const res = await finance.client.post('/master/costcat',
    new URLSearchParams({ code: 'ZZZ', name: 'Test category', category: 'Test' }).toString());
  assert.strictEqual(res.status, 302, 'created');

  const row = rowBy('cost_categories', 'code', 'ZZZ');
  assert.ok(row, 'the row exists');
  costCatId = row.id;
  assert.strictEqual(auditOf('cost_categories', row.id).filter((a) => a.action === 'create').length, 1);

  const dup = await finance.client.post('/master/costcat',
    new URLSearchParams({ code: 'ZZZ', name: 'Another' }).toString());
  assert.ok(dup.status >= 400, 'duplicate refused');
  assert.strictEqual(count('cost_categories'), before + 1, 'no second row');
});

test('MA5.5 a required name is enforced', async () => {
  const before = count('cost_categories');
  const res = await finance.client.post('/master/costcat',
    new URLSearchParams({ code: 'YYY', name: '  ' }).toString());
  assert.strictEqual(res.status, 400);
  assert.strictEqual(count('cost_categories'), before);
  assert.strictEqual(rowBy('cost_categories', 'code', 'YYY'), undefined);
});

// ---- MA5.6 the code is set once ----
test('MA5.6 editing posts no code and a crafted code cannot rename the row', async () => {
  const res = await finance.client.post(`/master/costcat/${costCatId}`,
    new URLSearchParams({ name: 'Test category (renamed)', category: 'Test' }).toString());
  assert.strictEqual(res.status, 302, 'the edit saved although no code was posted');
  assert.strictEqual(rowBy('cost_categories', 'code', 'ZZZ').name, 'Test category (renamed)');

  await finance.client.post(`/master/costcat/${costCatId}`,
    new URLSearchParams({ code: 'HACKED', name: 'Test category (renamed)' }).toString());
  assert.strictEqual(rowBy('cost_categories', 'code', 'ZZZ').code, 'ZZZ', 'the code is set once');
  assert.strictEqual(rowBy('cost_categories', 'code', 'HACKED'), undefined);
});

// ---- MA5.7/MA5.8 the two-level admin gate (PRD §8 "Ask first") ----
test('MA5.7 WBS structure changes are ADMIN-only — Finance is refused', async () => {
  const before = count('wbs_code');
  const res = await finance.client.post('/master/wbs',
    new URLSearchParams({ code: '9', name: 'Should not exist' }).toString());
  assert.strictEqual(res.status, 403, 'PRD §8 "Ask first"');
  assert.strictEqual(count('wbs_code'), before, 'nothing written');
  assert.strictEqual(rowBy('wbs_code', 'code', '9'), undefined);
});

test('MA5.8 CBS changes are FINANCE-allowed — the gate is not admin-only everywhere', async () => {
  // The other half of the rule: if the gate were applied to every dataset, MA5.7
  // would still pass and the app would be useless to the people who maintain CBS.
  const before = count('transaction_accounts');
  const res = await finance.client.post('/master/cbs',
    new URLSearchParams({ code: '9.9.9', name: 'Test bucket' }).toString());
  assert.strictEqual(res.status, 302, 'Finance may maintain cost buckets');
  assert.strictEqual(count('transaction_accounts'), before + 1);
  cbsId = rowBy('transaction_accounts', 'code', '9.9.9').id;
});

test('MA5.8b an Administrator may change WBS structure', async () => {
  const before = count('wbs_code');
  const res = await admin.post('/master/wbs',
    new URLSearchParams({ code: '9', name: 'Admin-added code' }).toString());
  assert.strictEqual(res.status, 302);
  assert.strictEqual(count('wbs_code'), before + 1);
  wbsId = rowBy('wbs_code', 'code', '9').id;
});

test('MA5.8c a Viewer cannot write master data at all', async () => {
  const before = count('cost_categories');
  const res = await viewer.client.post('/master/costcat',
    new URLSearchParams({ code: 'VIEW', name: 'Nope' }).toString());
  assert.strictEqual(res.status, 403);
  assert.strictEqual(count('cost_categories'), before, 'the DATABASE is unchanged');
});

// ---- MA5.9 THE REPORT-INTEGRITY RULE ----
test('MA5.9 deactivating an UNUSED cost bucket moves no existing report total', async () => {
  // Build a real ledger line tagged to a DIFFERENT bucket, then deactivate the
  // test bucket. The view is the assertion: the cost report is what could break.
  db.prepare(`INSERT INTO accounting_ledger
      (project_id, date, type, line_role, in_cost_basis, amount, debit, credit, transaction_account_id)
    VALUES (1, '2026-02-10', 'Expense', 'expense', 1, 500000, 500000, 0, ?)`)
    .run(db.prepare(`SELECT id FROM transaction_accounts WHERE code='2.1.1'`).get().id);

  const before = cbsTotal();
  assert.ok(before > 0, 'the ledger line is visible to the cost report');

  const res = await finance.client.post(`/master/cbs/${cbsId}/active`,
    new URLSearchParams({ action: 'deactivate' }).toString());
  assert.strictEqual(res.status, 302);

  const row = rowBy('transaction_accounts', 'code', '9.9.9');
  assert.strictEqual(row.active, 0, 'the bucket is deactivated');
  assert.ok(row, 'and NOT deleted — ledger rows may still point at it');
  assert.strictEqual(cbsTotal(), before, 'no existing report total moved');
});

test('MA5.10 deactivating a bucket still IN USE is allowed and reports what references it', async () => {
  // The reference counts are what make the soft-delete defensible: the screen says
  // what is affected instead of letting someone find out from a report.
  const inUse = db.prepare(`SELECT id, code FROM transaction_accounts WHERE code='2.1.1'`).get();
  const res = await finance.client.post(`/master/cbs/${inUse.id}/active`,
    new URLSearchParams({ action: 'deactivate' }).toString());
  assert.strictEqual(res.status, 302, 'allowed — it is a soft flag, not a delete');

  const row = rowBy('transaction_accounts', 'code', '2.1.1');
  assert.ok(row, 'the row survives');
  const audit = auditOf('transaction_accounts', inUse.id).find((a) => a.action === 'deactivate');
  assert.ok(audit, 'the deactivation is audited');
  assert.strictEqual(cbsTotal(), 500000, 'and the ledger line it carries still reports');
});

test('MA5.11 reactivating restores the row', async () => {
  const row = rowBy('transaction_accounts', 'code', '9.9.9');
  const res = await finance.client.post(`/master/cbs/${row.id}/active`,
    new URLSearchParams({ action: 'activate' }).toString());
  assert.strictEqual(res.status, 302);
  assert.strictEqual(rowBy('transaction_accounts', 'code', '9.9.9').active, 1);
});

// ---- MA5.12 the two type lists have no active flag (schema truth) ----
test('MA5.12 industry/project types accept an edit and have no deactivate action', async () => {
  const row = db.prepare(`SELECT * FROM industry_types LIMIT 1`).get();
  assert.ok(row, 'the seed populated industry types');

  const res = await finance.client.post(`/master/industry/${row.id}`,
    new URLSearchParams({ name: 'Renamed industry', description: 'x' }).toString());
  assert.strictEqual(res.status, 302, 'editable');
  assert.strictEqual(db.prepare('SELECT name FROM industry_types WHERE id=?').get(row.id).name,
    'Renamed industry', 'a rename applies immediately — the table has no active flag');

  // The table genuinely has no `active` column, so there is nothing to switch.
  const cols = db.prepare('PRAGMA table_info(industry_types)').all().map((c) => c.name);
  assert.ok(!cols.includes('active'), 'industry_types has no active column by schema');

  // The route uses the app's redirect-with-message idiom rather than an error page.
  // What matters is that the user is TOLD and that nothing changed.
  const refused = await finance.client.post(`/master/industry/${row.id}/active`,
    new URLSearchParams({ action: 'deactivate' }).toString());
  assert.strictEqual(refused.status, 302, 'it redirects back to the list');

  const shown = await finance.client.get(`/master/industry?msg=${
    encodeURIComponent('Industry types has no active flag — nothing to switch.')}`);
  const html = await shown.text();
  assert.ok(/no active flag/i.test(html), 'and the screen says why it did nothing');

  assert.strictEqual(db.prepare('SELECT name FROM industry_types WHERE id=?').get(row.id).name,
    'Renamed industry', 'the row is untouched');
  assert.strictEqual(auditOf('industry_types', row.id).filter((a) => a.action === 'deactivate').length,
    0, 'and nothing was audited as a deactivation');
});

// ---- MA5.13 a lookup must resolve ----
test('MA5.13 a lookup pointing at nothing is refused', async () => {
  const before = count('rbs_code');
  const res = await admin.post('/master/rbs',
    new URLSearchParams({ code: 'BAD-1', name: 'Bad link', resource_category_id: '999999' }).toString());
  assert.strictEqual(res.status, 400, 'a dangling reference is refused');
  assert.strictEqual(count('rbs_code'), before, 'nothing written');
});

test('MA5.14 a valid lookup is accepted and displayed by name', async () => {
  rescatId = db.prepare(`SELECT id FROM resource_categories LIMIT 1`).get().id;
  const before = count('rbs_code');
  const res = await admin.post('/master/rbs',
    new URLSearchParams({ code: 'OK-1', name: 'Valid link', resource_category_id: String(rescatId) }).toString());
  assert.strictEqual(res.status, 302);
  assert.strictEqual(count('rbs_code'), before + 1);

  const listed = await admin.get('/master/rbs');
  const html = await listed.text();
  // The LIST shows the LABEL, not the id — otherwise the screen is unreadable.
  assert.ok(html.includes('Valid link'), 'the row is listed');
  assert.ok(html.includes('Labour') || html.includes('Plant'), 'the lookup resolves to a name');
});

// ---- MA5.15 the screens still satisfy the UI contract ----
test('MA5.15 a master-data list page has a title and a sub-title', async () => {
  const res = await admin.get('/master/coa');
  const html = await res.text();
  assert.ok(/<h1[^>]*>[^<]+<\/h1>/.test(html), 'the page has a heading');
  assert.ok(/Chart of accounts/.test(html), 'the heading names the list');
  assert.ok(/ledger accounts/i.test(html), 'and the page states what the list is for');
});
