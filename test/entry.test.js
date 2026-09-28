// Ledger entry tests (the write path that feeds the tagging queue).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3997;

let dbPath, proc, cookie, db, cli;
const { client } = require('./helpers/csrf');
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
async function req(pathname, opts = {}) {
  return fetch(`${ORIGIN}${pathname}`, { redirect: 'manual', ...opts });
}
// Kept for negative tests: a raw POST that carries no CSRF token.
function formNoToken(body) {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body };
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-entry-')), 'test.db');
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
  cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;
  db = new (require('better-sqlite3'))(dbPath);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const proj = () => db.prepare(`SELECT id FROM projects WHERE code='PRJ-2026'`).get().id;
const latest = () => db.prepare(`SELECT * FROM accounting_ledger ORDER BY id DESC LIMIT 1`).get();
const count = () => db.prepare(`SELECT COUNT(*) n FROM accounting_ledger`).get().n;

// ---- L1 form + validation ----

test('L1.1 GET /ledger/entry renders the form', async () => {
  const res = await req('/ledger/entry', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /New entry/);
  assert.match(html, /Debit/);
  assert.match(html, /Credit/);
  assert.match(html, /immutable once posted/);
});

test('L1.2 missing amount → 400, nothing posted', async () => {
  const before = count();
  const res = await cli.post('/ledger/entry', 'side=debit&amount=&type=Expense');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(count(), before);
});

test('L1.3 non-integer amount → 400', async () => {
  const before = count();
  const res = await cli.post('/ledger/entry', 'side=debit&amount=100.5&type=Expense');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(count(), before);
});

// ---- L2 valid post ----

test('L2.1 valid Expense debit posts, derived fields correct', async () => {
  const before = count();
  const res = await cli.post('/ledger/entry', 
    'side=debit&amount=15000000&type=Expense&date=2026-09-26&document_no=INV-0999&description=Test expense');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/ledger\?saved=\d+/);
  assert.strictEqual(count(), before + 1);

  const row = latest();
  assert.strictEqual(row.amount, 15000000);
  assert.strictEqual(row.debit, 15000000);
  assert.strictEqual(row.credit, 0);
  assert.strictEqual(row.type, 'Expense');
  assert.strictEqual(row.line_role, 'expense');      // type → role mapping
  assert.strictEqual(row.in_cost_basis, 1);          // expense counts as cost
  assert.strictEqual(row.source, 'manual');
  assert.strictEqual(row.cost_checked, 0);           // untagged → queue
});

test('L2.2 valid Income credit posts with opposite side', async () => {
  const res = await cli.post('/ledger/entry', 
    'side=credit&amount=25000000&type=Income&date=2026-09-26&document_no=CASHIN-0999');
  assert.strictEqual(res.status, 302);
  const row = latest();
  assert.strictEqual(row.amount, -25000000);
  assert.strictEqual(row.debit, 0);
  assert.strictEqual(row.credit, 25000000);
  assert.strictEqual(row.line_role, 'receivable');
  assert.strictEqual(row.in_cost_basis, 0);
});

test('L2.3 null type → line_role other, in_cost_basis 0 (conservative)', async () => {
  const res = await cli.post('/ledger/entry', 'side=debit&amount=5000000&date=2026-09-26');
  assert.strictEqual(res.status, 302);
  const row = latest();
  assert.strictEqual(row.line_role, 'other');
  assert.strictEqual(row.in_cost_basis, 0);
});

test('L2.4 entry writes a create audit row', async () => {
  const row = latest();
  const audit = db.prepare(`SELECT * FROM audit_log WHERE entity_id = ? AND action = 'create'`).get(row.id);
  assert.ok(audit, 'create audit row exists');
  const after = JSON.parse(audit.after_json);
  assert.strictEqual(after.amount, row.amount);
  assert.strictEqual(after.type, row.type);
});

// ---- L3 the money triggers are the floor ----

test('L3.1 amount ≠ debit - credit is aborted by the trigger', () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
        amount, debit, credit, cost_checked)
      VALUES (?, '2026-09-26', 'Expense', 'expense', 1, 'manual', 5000000, 10000000, 0, 0)`).run(proj()),
    /amount must equal debit - credit/,
  );
});

test('L3.2 both sides set is aborted by the trigger', () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
        amount, debit, credit, cost_checked)
      VALUES (?, '2026-09-26', 'Expense', 'expense', 1, 'manual', 1000000, 3000000, 2000000, 0)`).run(proj()),
    /ONE side only/,
  );
});

test('L3.3 negative credit is aborted by the trigger', () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
        amount, debit, credit, cost_checked)
      VALUES (?, '2026-09-26', 'Expense', 'expense', 1, 'manual', -1000000, 0, -1000000, 0)`).run(proj()),
    /never a negative side/,
  );
});

// ---- L4 duplicate policy ----

test('L4.1 manual duplicate is ALLOWED (dedupe index is import-only by design)', async () => {
  const before = count();
  const res = await cli.post('/ledger/entry', 
    'side=debit&amount=15000000&type=Expense&date=2026-09-26&document_no=INV-0999&description=Test expense');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(count(), before + 1);
});

test('L4.2 the dedupe index rejects IMPORT duplicates at the schema level', () => {
  db.pragma('foreign_keys = ON');
  const insert = db.prepare(`
    INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
      amount, debit, credit, cost_checked, document_no)
    VALUES (?, '2026-09-26', 'Expense', 'expense', 1, 'import', 15000000, 15000000, 0, 0, 'IMP-1')`);
  const projId = proj();
  insert.run(projId); // first import
  assert.throws(() => insert.run(projId), /UNIQUE/);
});

// ---- L5 route guard ----

test('L5.1 POST /ledger/entry without session → 302 /login (token valid, only auth missing)', async () => {
  // Use a token that IS valid for this anonymous client, so the request gets
  // past CSRF and is stopped by the auth guard — that is what this test is about.
  const anon = client(ORIGIN);
  await anon.get('/ledger/entry'); // 302 to login, but sets the csrf cookie
  const res = await anon.post('/ledger/entry', 'side=debit&amount=1000&type=Expense');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/login$/);
});