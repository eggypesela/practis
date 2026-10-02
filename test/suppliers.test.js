// SP4-series: supplier register (module 6, plan task 6.4, PRD §4.1).
//
// WHAT THIS FILE EXISTS FOR
// The supplier register is the THIRD register to use the shared approval chain
// (`approvals-service.js`). The point of these tests is that it behaves like the
// other two — because the failure mode this guards against is a control that is
// fixed in one register and quietly drifts in another.
//
// The four rules pinned here:
//
//   1. APPROVAL IS ROWS, not a boolean. Registering records every PRD §4.1 step
//      (procurement_verify, finance_verify, admin_approve, pm_approve) as pending;
//      under decision 8A (LIGHT) only `pm_approve` is REQUIRED.
//   2. SELF-APPROVAL NEEDS A WRITTEN REASON (owner decision 2026-10-01) —
//      refused without, allowed with, and a different approver needs nothing.
//   3. THE CODE IS SET ONCE. The edit view renders it disabled, so a browser does
//      not submit it; `validate()` must therefore ignore it on update or every
//      real edit fails. (This exact bug shipped in the project register and the
//      test that missed it posted `code=HACKED` by hand.)
//   4. DEACTIVATE, NEVER DELETE — ledger lines reference suppliers.
//
// Every deny-case asserts the DATABASE, not a status code: the five authorization
// bugs found in the 2026-09-30 audit all answered 302/200 while writing money, so
// a status-only assertion proves nothing.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3911;

let dbPath, proc, db, base, pm, viewer;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-suppliers-')), 'test.db');
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

  base = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  db = new (require('better-sqlite3'))(dbPath);

  // A Project Manager — the approver under decision 8A — so the
  // "a DIFFERENT person approves" case is exercised with a real second actor.
  const { asRole } = require('./helpers/authz');
  pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'sp4-pm@example.test' });
  // A read-only Viewer: the role that must be denied every write.
  viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'sp4-viewer@example.test' });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const supplierCount = () => db.prepare('SELECT COUNT(*) n FROM suppliers').get().n;
const byCode = (code) => db.prepare('SELECT * FROM suppliers WHERE code = ?').get(code);
const approvalsOf = (id) => db.prepare(
  `SELECT * FROM approvals WHERE entity_type='supplier' AND entity_id=? ORDER BY id`).all(id);
const auditOf = (id) => db.prepare(
  `SELECT * FROM audit_log WHERE entity_type='supplier' AND entity_id=? ORDER BY id`).all(id);

// A valid registration body. NOTE: `post()` takes a URL-encoded body STRING, not
// an object — an object stringifies to "[object Object]", the CSRF check fails,
// and the test sees a 403 that reads like an authorization bug.
const form = (over = {}) => new URLSearchParams({
  code: 'SP-4001', name: 'Baja Utama Steel', supplier_type: 'materials',
  correspondence_person: 'Pak Andi', email: 'sales@baja.test', phone: '021-555',
  address: 'Jakarta', description: 'Structural steel', ...over,
}).toString();

// ---- SP4.1 registration records the approval chain ----
test('SP4.1 registering a supplier records every PRD §4.1 step as pending', async () => {
  const res = await base.post('/suppliers', form());
  assert.strictEqual(res.status, 302, 'registration redirects to the register');

  const row = byCode('SP-4001');
  assert.ok(row, 'the supplier row was created');
  assert.strictEqual(row.supplier_type, 'materials');
  assert.strictEqual(row.active, 1);

  const chain = approvalsOf(row.id);
  assert.deepStrictEqual(chain.map((a) => a.step).sort(),
    ['admin_approve', 'finance_verify', 'pm_approve', 'procurement_verify'],
    'PRD §4.1 records Procurement → Finance → Admin, plus the light pm_approve');
  assert.ok(chain.every((a) => a.status === 'pending'), 'nothing is approved yet');

  assert.strictEqual(auditOf(row.id).filter((a) => a.action === 'create').length, 1);
});

// ---- SP4.2 the code is a human key ----
test('SP4.2 a duplicate supplier code is refused with a sentence, not a SQL error', async () => {
  const before = supplierCount();
  const res = await base.post('/suppliers', form({ name: 'Someone Else' }));
  assert.ok(res.status >= 400, 'refused');
  assert.strictEqual(supplierCount(), before, 'no second row written');
});

test('SP4.3 a supplier needs a name', async () => {
  const before = supplierCount();
  const res = await base.post('/suppliers', form({ code: 'SP-4002', name: '   ' }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(supplierCount(), before, 'nothing written');
  assert.strictEqual(byCode('SP-4002'), undefined);
});

test('SP4.4 a malformed email is refused', async () => {
  const before = supplierCount();
  const res = await base.post('/suppliers', form({ code: 'SP-4003', email: 'not-an-address' }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(supplierCount(), before);
});

// ---- SP4.5/SP4.6 the disabled-code rule ----
test('SP4.5 editing posts no code (as a browser does) and the edit still saves', async () => {
  const row = byCode('SP-4001');
  // The browser does NOT submit the disabled code field. Requiring it would make
  // every real edit fail — the bug that shipped in the project register.
  const res = await base.post(`/suppliers/${row.id}`,
    new URLSearchParams({ name: 'Baja Utama Steel (renamed)', supplier_type: 'materials', active: '1' }).toString());
  assert.strictEqual(res.status, 302, 'the edit saved');
  assert.strictEqual(byCode('SP-4001').name, 'Baja Utama Steel (renamed)');
});

test('SP4.6 a code posted anyway cannot change the supplier code', async () => {
  const row = byCode('SP-4001');
  await base.post(`/suppliers/${row.id}`,
    new URLSearchParams({ code: 'SP-HACKED', name: 'Baja Utama Steel (renamed)' }).toString());
  assert.strictEqual(byCode('SP-4001').code, 'SP-4001', 'the code is set once at registration');
  assert.strictEqual(byCode('SP-HACKED'), undefined, 'no rename happened');
  assert.strictEqual(auditOf(row.id).filter((a) => a.action === 'update').length >= 2, true);
});

// ---- SP4.7-SP4.9 the shared segregation-of-duties rule ----
test('SP4.7 a DIFFERENT person approves with no reason required', async () => {
  const row = byCode('SP-4001');
  const res = await pm.client.post(`/suppliers/${row.id}/approve`, '');
  assert.strictEqual(res.status, 302, 'approved');

  const step = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='supplier' AND entity_id=? AND step='pm_approve'`).get(row.id);
  assert.strictEqual(step.status, 'approved');
  assert.strictEqual(step.actor_id, pm.userId, 'recorded against the approver');
  const audited = auditOf(row.id).find((a) => a.action === 'approve');
  assert.ok(audited, 'the approval is an audit event');
  assert.strictEqual(JSON.parse(audited.after_json).self_approved, false);
});

test('SP4.8 approving your OWN supplier without a reason is refused, and nothing is written', async () => {
  // Registered by the Administrator (base); approve as the same Administrator.
  const res = await base.post('/suppliers', form({ code: 'SP-4004', name: 'Own Work Ltd' }));
  assert.strictEqual(res.status, 302);
  const row = byCode('SP-4004');

  const refused = await base.post(`/suppliers/${row.id}/approve`, '');
  assert.strictEqual(refused.status, 403, 'self-approval without a reason is refused');

  const step = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='supplier' AND entity_id=? AND step='pm_approve'`).get(row.id);
  assert.strictEqual(step.status, 'pending', 'the DATABASE still says pending');
  assert.strictEqual(step.actor_id, null, 'no approver recorded');
});

test('SP4.9 approving your OWN supplier WITH a reason passes and keeps the reason', async () => {
  const row = byCode('SP-4004');
  const reason = 'Sole supplier for the Merauke works; tender waived for schedule.';
  const res = await base.post(`/suppliers/${row.id}/approve`,
    new URLSearchParams({ reason }).toString());
  assert.strictEqual(res.status, 302, 'approved');

  const step = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='supplier' AND entity_id=? AND step='pm_approve'`).get(row.id);
  assert.strictEqual(step.status, 'approved');
  assert.strictEqual(step.comment, reason, 'the reason is stored on the approval row');

  const audited = auditOf(row.id).find((a) => a.action === 'approve');
  const after = JSON.parse(audited.after_json);
  assert.strictEqual(after.self_approved, true, 'marked as a self-approval in the trail');
  assert.strictEqual(after.reason, reason);
});

test('SP4.10 approving an already-approved supplier is refused and changes nothing', async () => {
  const row = byCode('SP-4001');
  const res = await pm.client.post(`/suppliers/${row.id}/approve`, '');
  assert.ok(res.status >= 400, 'refused');
  const approved = db.prepare(
    `SELECT COUNT(*) n FROM approvals WHERE entity_type='supplier' AND entity_id=? AND step='pm_approve' AND status='approved'`)
    .get(row.id).n;
  assert.strictEqual(approved, 1, 'exactly one approved step — no second approval row');
});

// ---- SP4.11/SP4.12 authorization: the class the audit found missing ----
test('SP4.11 a read-only Viewer cannot register a supplier', async () => {
  const before = supplierCount();
  const res = await viewer.client.post('/suppliers', form({ code: 'SP-4005' }));
  assert.strictEqual(res.status, 403, 'denied with a reason');
  assert.strictEqual(supplierCount(), before, 'nothing written');
  assert.strictEqual(byCode('SP-4005'), undefined);
});

test('SP4.12 a read-only Viewer cannot approve a supplier', async () => {
  const res = await base.post('/suppliers', form({ code: 'SP-4006', name: 'Pending Co' }));
  assert.strictEqual(res.status, 302);
  const row = byCode('SP-4006');

  const refused = await viewer.client.post(`/suppliers/${row.id}/approve`, '');
  assert.strictEqual(refused.status, 403, 'denied');

  const step = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='supplier' AND entity_id=? AND step='pm_approve'`).get(row.id);
  assert.strictEqual(step.status, 'pending', 'the DATABASE still says pending');
});

// ---- SP4.13 deactivate, never delete ----
test('SP4.13 a supplier is deactivated, never deleted', async () => {
  const row = byCode('SP-4006');
  await base.post(`/suppliers/${row.id}`,
    new URLSearchParams({ name: 'Pending Co', active: '0' }).toString());
  const after = byCode('SP-4006');
  assert.ok(after, 'the row still exists');
  assert.strictEqual(after.active, 0, 'deactivated');
});

// ---- SP4.14/SP4.15 the screens ----
test('SP4.14 the register lists suppliers for a signed-in user', async () => {
  const res = await base.get('/suppliers');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('SP-4001'), 'the seeded supplier is shown');
  assert.ok(html.includes('Supplier register'), 'the screen has its heading');
});

test('SP4.15 an unknown supplier id gives a 404 page, not a crash', async () => {
  const res = await base.get('/suppliers/999999/edit');
  assert.strictEqual(res.status, 404);
  assert.ok((await res.text()).includes('Not found'));
});

test('SP4.16 the supplier register is not readable by an anonymous visitor', async () => {
  const { client } = require('./helpers/csrf');
  const anon = client(ORIGIN);
  const res = await anon.get('/suppliers');
  assert.strictEqual(res.status, 302, 'redirected to sign in');
});
