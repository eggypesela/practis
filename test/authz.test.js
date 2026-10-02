// Authorization tests (TEST_PLAN §11, AZ-series). Port 3901.
//
// THE POINT OF THESE TESTS
// Every assertion below checks the DATABASE, not the HTTP status. A status-only
// test passes on all five audit blockers, because the vulnerable routes answered
// 302 or 200 while writing money. Row counts are the evidence.
//
// These tests must FAIL before Task 0.1 — that failure is the proof the bug was
// real, not theoretical. See docs/AUDIT-2026-09-30.md.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3901;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let dbPath, proc, db, importsDir;
let viewer, finance, costController, projectManager;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

// --- DB probes (the actual assertions) ---------------------------------------

const ledgerCount = () => db.prepare('SELECT COUNT(*) n FROM accounting_ledger').get().n;
const batchesCount = () => db.prepare('SELECT COUNT(*) n FROM import_batches').get().n;

// The one-shot correction slot. If a Viewer manages to consume this, a real cost
// line can never be corrected again — irrecoverable.
function reversalsOf(lineId) {
  return db.prepare(
    `SELECT COUNT(*) n FROM accounting_ledger
      WHERE reverses_ledger_id = ?`
  ).get(lineId).n;
}

function checkedOf(lineId) {
  return db.prepare('SELECT cost_checked c FROM accounting_ledger WHERE id = ?').get(lineId)?.c ?? null;
}

function firstUncheckedLineId() {
  const r = db.prepare(
    `SELECT id FROM accounting_ledger
      WHERE project_id = 1 AND cost_checked = 0 AND reverses_ledger_id IS NULL
      ORDER BY id LIMIT 1`
  ).get();
  return r ? r.id : null;
}

// A line that has NOT yet been reversed, so the reversal slot is genuinely free.
function firstUnreversedLineId() {
  const r = db.prepare(
    `SELECT l.id FROM accounting_ledger l
      WHERE l.project_id = 1 AND l.reverses_ledger_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM accounting_ledger r WHERE r.reverses_ledger_id = l.id)
      ORDER BY l.id LIMIT 1`
  ).get();
  return r ? r.id : null;
}

async function uploadAs(role, csvText) {
  const fd = new FormData();
  fd.append('file', new Blob([csvText], { type: 'text/csv' }), 'ledger.csv');
  const res = await fetch(`${ORIGIN}/api/imports`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: role.client.cookieHeader(), 'x-csrf-token': role.client.token() },
    body: fd,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON (403 HTML page) */ }
  return { status: res.status, body };
}

// --- setup --------------------------------------------------------------------

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-authz-')), 'test.db');
  importsDir = path.join(path.dirname(dbPath), 'imports');
  const env = { PRACTIS_DB: dbPath, PRACTIS_IMPORTS: importsDir };

  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'admin@example.test', 'adminpw123'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);
  sh([path.join('src', 'db', 'seed-demo.js')], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });

  db = new (require('better-sqlite3'))(dbPath);
  const { asRole } = require('./helpers/authz');
  viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer');
  finance = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance', { email: 'authz-fin@example.test' });
  costController = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'cost_controller', { email: 'authz-cc@example.test' });
  projectManager = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager', { email: 'authz-pm@example.test' });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  try { db && db.close(); } catch { /* ignore */ }
});

// =============================================================================
// AZ1 — POST /ledger/entry
// =============================================================================

test('AZ1.1 a Viewer cannot post a ledger entry (and nothing is written)', async () => {
  const before = ledgerCount();
  const res = await viewer.client.post('/ledger/entry',
    'type=Expense&date=2026-09-30&side=debit&amount=777000&description=viewer+attempt');

  assert.strictEqual(res.status, 403, 'a read-only role must be refused');
  assert.strictEqual(ledgerCount(), before, 'AND no row may be written');
});

test('AZ1.2 a Project Manager cannot post a ledger entry (entering is Finance)', async () => {
  const before = ledgerCount();
  const res = await projectManager.client.post('/ledger/entry',
    'type=Expense&date=2026-09-30&side=debit&amount=777000&description=pm+attempt');

  assert.strictEqual(res.status, 403);
  assert.strictEqual(ledgerCount(), before);
});

test('AZ1.3 Finance CAN post a ledger entry (the guard is not a wall)', async () => {
  const before = ledgerCount();
  const res = await finance.client.post('/ledger/entry',
    'type=Expense&date=2026-09-30&side=debit&amount=777000&description=finance+entry');

  assert.strictEqual(res.status, 302, 'the permitted role must still get through');
  assert.strictEqual(ledgerCount(), before + 1);
});

// =============================================================================
// AZ2 — POST /ledger/:id/reverse
// =============================================================================

test('AZ2.1 a Viewer cannot reverse a ledger line (nor burn its one-time slot)', async () => {
  const lineId = firstUnreversedLineId();
  assert.ok(lineId, 'fixture has a line available to reverse');

  const before = ledgerCount();
  const res = await viewer.client.post(`/ledger/${lineId}/reverse`, 'date=2026-09-30');

  assert.strictEqual(res.status, 403);
  assert.strictEqual(ledgerCount(), before, 'no reversal row written');
  assert.strictEqual(reversalsOf(lineId), 0, 'the one-shot correction slot is untouched');
});

test('AZ2.2 a Project Manager cannot reverse (decision 2A: Finance + Cost Controller only)', async () => {
  const lineId = firstUnreversedLineId();
  const res = await projectManager.client.post(`/ledger/${lineId}/reverse`, 'date=2026-09-30');

  assert.strictEqual(res.status, 403);
  assert.strictEqual(reversalsOf(lineId), 0);
});

test('AZ2.3 a Cost Controller CAN reverse (decision 2A)', async () => {
  const lineId = firstUnreversedLineId();
  const before = ledgerCount();
  const res = await costController.client.post(`/ledger/${lineId}/reverse`, 'date=2026-09-30');

  assert.strictEqual(res.status, 302, 'the granted role must still get through');
  assert.strictEqual(ledgerCount(), before + 1, 'the reversal was written');
  assert.strictEqual(reversalsOf(lineId), 1);
});

// =============================================================================
// AZ3 — POST /queue/tag (the checker's route; writes into v_cbs_actual)
// =============================================================================

test('AZ3.1 a Viewer cannot mark a cost line as checked', async () => {
  const lineId = firstUncheckedLineId();
  assert.ok(lineId, 'fixture has an unchecked line');

  const res = await viewer.client.post('/queue/tag', `line=${lineId}&check=1`);

  assert.strictEqual(res.status, 403);
  assert.strictEqual(checkedOf(lineId), 0, 'the cost report must not gain a checked line');
});

test('AZ3.2 a Project Manager cannot mark a cost line as checked', async () => {
  const lineId = firstUncheckedLineId();
  const res = await projectManager.client.post('/queue/tag', `line=${lineId}&check=1`);

  assert.strictEqual(res.status, 403);
  assert.strictEqual(checkedOf(lineId), 0);
});

test('AZ3.3 a Cost Controller CAN mark a cost line as checked', async () => {
  const lineId = firstUncheckedLineId();
  assert.ok(lineId, 'fixture has an unchecked line');

  const res = await costController.client.post('/queue/tag', `line=${lineId}&check=1`);

  assert.strictEqual(res.status, 302);
  assert.strictEqual(checkedOf(lineId), 1);
});

// =============================================================================
// AZ4 — the import endpoints (they write ledger rows directly)
// =============================================================================

const HEADER = 'transaction_id,date,account_code,debit,credit,amount,project_code,description,cashflow_code,type,reference_no,sub_rbs_code,date_adjustment';

// Each upload must use a DISTINCT transaction_id. The import dedupe index is
// partial and keyed on (transaction_id, document_no, date, amount, project), so
// re-uploading the same row is legitimately skipped as a duplicate — which would
// make a "did the ledger grow?" assertion fail for the wrong reason.
//
// The group must ALSO balance (TECH-SPEC §8.4). A single debit line is not a
// valid double entry: §8.4 quarantines the whole group, so a lone-debit fixture
// makes AZ4.4 ("Finance CAN confirm") fail for the balance reason instead of the
// authorization reason it exists to test. This is a real double entry — debit
// the cost, credit the bank — and it is what the real export looks like.
function csvWith(txnId) {
  return [
    HEADER,
    `${txnId},2026-01-15,500000000000001,5000000,0,5000000,PRJ-2026,Material,10001,Expense,PO-${txnId},1.1.1,`,
    `${txnId},2026-01-15,100000000000001,0,5000000,-5000000,PRJ-2026,Material,10001,Expense,PO-${txnId},1.1.1,`,
  ].join('\n');
}

test('AZ4.1 a Viewer cannot stage an import', async () => {
  const batches = batchesCount();
  const res = await uploadAs(viewer, csvWith('T-9001'));

  assert.strictEqual(res.status, 403, 'JSON endpoint must answer 403, not an HTML page');
  assert.strictEqual(batchesCount(), batches, 'no batch may be staged');
});

test('AZ4.2 a Cost Controller cannot stage an import (importing is Finance)', async () => {
  const batches = batchesCount();
  const res = await uploadAs(costController, csvWith('T-9002'));

  assert.strictEqual(res.status, 403);
  assert.strictEqual(batchesCount(), batches);
});

test('AZ4.3 a Viewer cannot confirm an import', async () => {
  // Stage as Finance (permitted), then try to CONFIRM as the Viewer. Confirm is
  // the step that actually writes ledger rows, so it needs its own guard.
  const staged = await uploadAs(finance, csvWith('T-9003'));
  assert.strictEqual(staged.status, 201, 'Finance can stage');
  const batchId = staged.body.batchId;

  const before = ledgerCount();
  const res = await fetch(`${ORIGIN}/api/imports/${batchId}/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: viewer.client.cookieHeader(), 'x-csrf-token': viewer.client.token() },
  });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(ledgerCount(), before, 'a Viewer must not be able to commit an import');
});

test('AZ4.4 Finance CAN stage and confirm (the guard is not a wall)', async () => {
  const staged = await uploadAs(finance, csvWith('T-9004'));
  assert.strictEqual(staged.status, 201);
  const batchId = staged.body.batchId;

  const before = ledgerCount();
  const res = await fetch(`${ORIGIN}/api/imports/${batchId}/confirm`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: finance.client.cookieHeader(), 'x-csrf-token': finance.client.token() },
  });

  assert.strictEqual(res.status, 200);
  // TWO rows: a valid double entry (see csvWith) — debit the cost, credit the
  // bank. One lone debit would be quarantined by §8.4 before it ever reached the
  // ledger, and this test would fail for the wrong reason.
  assert.strictEqual(ledgerCount(), before + 2, 'Finance committed the import');
});

// =============================================================================
// AZ5 — page visibility: a Viewer is not shown a form it cannot submit
// =============================================================================

test('AZ5.1 a Viewer is not shown the ledger entry form', async () => {
  const res = await viewer.client.get('/ledger/entry');
  assert.strictEqual(res.status, 403, 'the form is not offered to a read-only role');
});

test('AZ5.2 a Viewer is not shown the import upload page', async () => {
  const res = await viewer.client.get('/import');
  assert.strictEqual(res.status, 403);
});

test('AZ5.3 a Viewer CAN still read the ledger (the guard is not over-broad)', async () => {
  const res = await viewer.client.get('/ledger');
  assert.strictEqual(res.status, 200, 'reading the book of record is allowed');
});

test('AZ5.4 Finance CAN open the entry form and the import page', async () => {
  assert.strictEqual((await finance.client.get('/ledger/entry')).status, 200);
  assert.strictEqual((await finance.client.get('/import')).status, 200);
});
