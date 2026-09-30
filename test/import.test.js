// TS-04 import tests: stage → preview → confirm, dedupe, quarantine, idempotency.
//
// Boots a real server on a throwaway DB (same harness as entry.test.js), uploads
// real multipart CSV over HTTP with the CSRF header the browser client uses, and
// asserts on the actual ledger rows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3998;

let dbPath, proc, cookie, db, cli, csrf;
const { client } = require('./helpers/csrf');
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Upload a CSV string as multipart/form-data, with the CSRF header.
async function upload(csvText, filename = 'ledger.csv') {
  const fd = new FormData();
  fd.append('file', new Blob([csvText], { type: 'text/csv' }), filename);
  const res = await fetch(`${ORIGIN}/api/imports`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'x-csrf-token': csrf },
    body: fd,
  });
  return { status: res.status, body: await res.json() };
}

async function preview(batchId) {
  const res = await fetch(`${ORIGIN}/api/imports/${batchId}/preview`, {
    headers: { cookie },
  });
  return { status: res.status, body: await res.json() };
}

async function confirm(batchId) {
  const res = await fetch(`${ORIGIN}/api/imports/${batchId}/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-import-')), 'test.db');
  const env = { PRACTIS_DB: dbPath, PRACTIS_IMPORTS: path.join(path.dirname(dbPath), 'imports') };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'e@example.com', 'epw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
  cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;
  csrf = cli.token();
  db = new (require('better-sqlite3'))(dbPath);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const count = () => db.prepare(`SELECT COUNT(*) n FROM accounting_ledger`).get().n;
const importedCount = () => db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE source='import'`).get().n;

// The legacy export's own column set (legacy/erd-parsed.json → c_accounting_ledger).
const HEADER = 'transaction_id,date,account_code,debit,credit,amount,project_code,description,cashflow_code,type,reference_no,sub_rbs_code,date_adjustment';

// Codes that seed-master actually creates, so lookups resolve.
const COA_EXPENSE = '500000000000001';
const COA_INCOME = '400000000000001';

// ---- I1 page route ----

test('I1.1 GET /import renders the upload screen', async () => {
  const res = await cli.get('/import');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Upload ledger CSV/);
  assert.match(html, /Recent imports/);
});

// ---- I2 stage ----

test('I2.1 stage a valid file: 201, nothing written to the ledger', async () => {
  const before = count();
  const csv = [
    HEADER,
    `T-1001,2026-01-15,${COA_EXPENSE},5000000,0,5000000,PRJ-2026,Material purchase,10001,Expense,PO-1001,,`,
    `T-1002,2026-01-16,${COA_INCOME},0,7500000,7500000,PRJ-2026,Progress bill 1,10001,Income,INV-1001,,`,
  ].join('\n');

  const res = await upload(csv);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.rowCount, 2);
  assert.strictEqual(res.body.newCount, 2);
  assert.strictEqual(res.body.skippedCount, 0);
  assert.strictEqual(count(), before, 'stage must not write accounting_ledger');

  const b = db.prepare(`SELECT * FROM import_batches WHERE id = ?`).get(res.body.batchId);
  assert.strictEqual(b.status, 'staged');
  assert.ok(b.staging_json, 'staged rows persisted');
});

test('I2.2 missing a required column → 400, no batch staged', async () => {
  const batches = db.prepare(`SELECT COUNT(*) n FROM import_batches`).get().n;
  const res = await upload('date,debit\n2026-01-01,1000');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error.code, 'STAGE_FAILED');
  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM import_batches`).get().n, batches);
});

test('I2.3 no file in the request → 400', async () => {
  const res = await fetch(`${ORIGIN}/api/imports`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'x-csrf-token': csrf },
    body: new FormData(),
  });
  assert.strictEqual(res.status, 400);
});

test('I2.4 upload without the CSRF header is blocked', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['a,b\n1,2'], { type: 'text/csv' }), 'x.csv');
  const res = await fetch(`${ORIGIN}/api/imports`, {
    method: 'POST', redirect: 'manual', headers: { cookie }, body: fd,
  });
  assert.strictEqual(res.status, 403);
});

// ---- I3 preview + row-level quarantine ----

test('I3.1 preview reports new vs invalid with row numbers', async () => {
  const csv = [
    HEADER,
    `T-2001,2026-02-01,${COA_EXPENSE},1000000,0,1000000,PRJ-2026,Good row,10001,Expense,PO-2001,,`,
    `T-2002,2026-02-02,${COA_EXPENSE},3000000,2000000,3000000,PRJ-2026,Both sides set,10001,Expense,PO-2002,,`,
    `T-2003,not-a-date,${COA_EXPENSE},1000000,0,1000000,PRJ-2026,Bad date,10001,Expense,PO-2003,,`,
    `T-2004,2026-02-04,999999999999999,1000000,0,1000000,PRJ-2026,Unknown account,10001,Expense,PO-2004,,`,
  ].join('\n');

  const up = await upload(csv);
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.rowCount, 4);
  assert.strictEqual(up.body.newCount, 1, 'only the good row is new');

  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.body.newCount, 1);
  assert.strictEqual(pv.body.invalid.length, 3, 'three rows quarantined, each with reasons');

  const lines = pv.body.invalid.map((i) => i.line).sort();
  assert.deepStrictEqual(lines, [3, 4, 5], 'row numbers are file line numbers');
  const both = pv.body.invalid.find((i) => i.line === 3);
  assert.match(both.errors.join(' '), /check sign/i);
  const unknown = pv.body.invalid.find((i) => i.line === 5);
  assert.match(unknown.errors.join(' '), /unknown chart_of_accounts/i);
});

test('I3.2 Indonesian number formats and Revenue type map correctly', async () => {
  const csv = [
    HEADER,
    `T-3001,15/03/2026,${COA_EXPENSE},"1.750.000",0,"1.750.000",PRJ-2026,Local format,10001,Expense,PO-3001,,`,
    `T-3002,2026-03-16,${COA_INCOME},0,2000000,2000000,PRJ-2026,Revenue note,10001,Revenue,REV-3002,,2026-03-31`,
  ].join('\n');

  const up = await upload(csv);
  assert.strictEqual(up.body.newCount, 2, 'both rows valid');
  await confirm(up.body.batchId);

  const r1 = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-3001'`).get();
  assert.strictEqual(r1.amount, 1750000, 'dots are thousands separators');
  assert.strictEqual(r1.date, '2026-03-15', 'DD/MM/YYYY → ISO');

  const r2 = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-3002'`).get();
  assert.strictEqual(r2.type, 'Revenue', 'legacy Revenue type survives the import');
  assert.strictEqual(r2.line_role, 'receivable');
  assert.strictEqual(r2.effective_date, '2026-03-31', 'date_adjustment → effective_date');
});

// ---- I4 confirm ----

test('I4.1 confirm posts the staged rows with source=import and an audit trail', async () => {
  const csv = [
    HEADER,
    `T-4001,2026-04-01,${COA_EXPENSE},1234500,0,1234500,PRJ-2026,Commit me,10001,Expense,PO-4001,,`,
  ].join('\n');
  const up = await upload(csv);
  const before = count();

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.status, 200);
  assert.strictEqual(cf.body.inserted, 1);
  assert.strictEqual(count(), before + 1);

  const row = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-4001'`).get();
  assert.strictEqual(row.source, 'import');
  assert.strictEqual(row.import_batch_id, up.body.batchId);
  assert.strictEqual(row.amount, 1234500);
  assert.strictEqual(row.debit, 1234500);
  assert.strictEqual(row.credit, 0);
  assert.strictEqual(row.cost_checked, 0, 'imported lines arrive untagged → queue');

  const audit = db.prepare(`SELECT COUNT(*) n FROM audit_log
    WHERE entity_type='accounting_ledger' AND entity_id=? AND action='create'`).get(row.id).n;
  assert.strictEqual(audit, 1, 'one create audit row per imported line');

  const b = db.prepare(`SELECT status, confirmed_at FROM import_batches WHERE id=?`).get(up.body.batchId);
  assert.strictEqual(b.status, 'confirmed');
  assert.ok(b.confirmed_at);
});

test('I4.2 re-confirming the same batch is a no-op (idempotent, TS-24)', async () => {
  const b = db.prepare(`SELECT id FROM import_batches WHERE status='confirmed' ORDER BY id DESC LIMIT 1`).get();
  const before = count();
  const cf = await confirm(b.id);
  assert.strictEqual(cf.status, 200);
  assert.strictEqual(cf.body.alreadyConfirmed, true);
  assert.strictEqual(count(), before, 'no rows posted twice');
});

test('I4.3 confirm a never-staged batch → 409; unknown batch → 404', async () => {
  const notStaged = db.prepare(`
    INSERT INTO import_batches (filename, row_count, status) VALUES ('x.csv', 0, 'staged')`).run().lastInsertRowid;
  const res = await confirm(notStaged);
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error.code, 'NOT_STAGED');

  const missing = await confirm(999999);
  assert.strictEqual(missing.status, 404);
});

// ---- I5 dedupe (R2-27): re-upload is skipped, never re-applied ----

test('I5.1 re-uploading the same rows stages 0 new and records the skip', async () => {
  const csv = [
    HEADER,
    `T-4001,2026-04-01,${COA_EXPENSE},1234500,0,1234500,PRJ-2026,Commit me,10001,Expense,PO-4001,,`,
  ].join('\n');
  const before = count();
  const up = await upload(csv);
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.newCount, 0, 'the row is already in the ledger');
  assert.strictEqual(up.body.skippedCount, 1);

  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.body.newCount, 0);
  assert.strictEqual(pv.body.skippedCount, 1);

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 0, 'nothing re-applied');
  assert.strictEqual(count(), before);
});

test('I5.2 a duplicate inside one file is skipped once (first occurrence wins)', async () => {
  const line = `T-5001,2026-05-01,${COA_EXPENSE},900000,0,900000,PRJ-2026,Dup pair,10001,Expense,PO-5001,,`;
  const up = await upload([HEADER, line, line].join('\n'));
  assert.strictEqual(up.body.rowCount, 2);
  assert.strictEqual(up.body.newCount, 1);
  assert.strictEqual(up.body.skippedCount, 1);

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 1);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE transaction_id='T-5001'`).get().n, 1);
});

// ---- I6 the DB stays the floor ----

test('I6.1 an imported row still cannot bypass the money triggers', async () => {
  assert.throws(
    () => db.prepare(`
      INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
        amount, debit, credit, cost_checked)
      VALUES (?, '2026-01-01', 'Expense', 'expense', 1, 'import', 5000000, 10000000, 0, 0)`).run(
        db.prepare(`SELECT id FROM projects LIMIT 1`).get().id),
    /amount must equal debit - credit/,
  );
});

test('I6.2 signing out does not expose the import register', async () => {
  const anon = client(ORIGIN);
  const res = await anon.get('/import');
  assert.strictEqual(res.status, 302, 'unauthenticated page request redirects to login');
});
