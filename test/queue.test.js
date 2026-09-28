// Tagging queue tests (TEST_PLAN T-series). Fresh temp DB + server per run.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3998;

let dbPath, proc, cookie, db, cli;
const { client } = require('./helpers/csrf');
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

async function req(pathname, opts = {}) {
  return fetch(`${ORIGIN}${pathname}`, { redirect: 'manual', ...opts });
}

// Raw POST with no CSRF token — used by the negative tests.
function formNoToken(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  };
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-queue-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'q@example.com', 'qpw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);
  sh([path.join('src', 'db', 'seed-demo.js')], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });

  cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'q@example.com', 'qpw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;

  // direct handle for DB-level assertions (same file the server uses)
  db = new (require('better-sqlite3'))(dbPath);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const proj = () => db.prepare(`SELECT id FROM projects WHERE code='PRJ-2026'`).get().id;
const line = (id) => db.prepare('SELECT * FROM accounting_ledger WHERE id = ?').get(id);
const untagged = () => db.prepare('SELECT COUNT(*) n FROM v_untagged_queue WHERE project_id = ?').get(proj()).n;

// ---- T1 queue read ----

test('T1.1 GET /queue renders untagged lines with pickers', async () => {
  const res = await req('/queue', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Tagging queue/);
  assert.match(html, /Tag with CBS/);
  assert.match(html, /Site setup/);
});

test('T1.2 untagged lines come from v_untagged_queue (all 6 demo lines)', async () => {
  const res = await req('/queue', { headers: { cookie } });
  const html = await res.text();
  assert.match(html, /PO-0897/);
  assert.strictEqual(untagged(), 6);
});

// ---- T2 tag write ----

test('T2.1 POST /queue/tag assigns CBS + WBS and checks the line', async () => {
  const cbs = db.prepare(`SELECT id FROM transaction_accounts WHERE code='1.1.1'`).get().id;
  const wbs = db.prepare(`SELECT id FROM wbs_nodes WHERE project_id=? AND wbs_code='1.1'`).get(proj()).id;
  const target = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no='PO-0897'`).get().id;

  const res = await cli.post('/queue/tag', `line=${target}&cbs=${cbs}&wbs=${wbs}&check=1`);
  assert.strictEqual(res.status, 302);

  const row = line(target);
  assert.strictEqual(row.transaction_account_id, cbs);
  assert.strictEqual(row.wbs_node_id, wbs);
  assert.strictEqual(row.cost_checked, 1);
  assert.ok(row.cost_checked_by, 'cost_checked_by must be stamped');
  assert.ok(row.cost_checked_at, 'cost_checked_at must be stamped');
});

test('T2.2 tagging writes an append-only audit row', async () => {
  const target = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no='PO-0897'`).get().id;
  const rows = db.prepare(`SELECT * FROM audit_log WHERE entity_id = ?`).all(target);
  assert.ok(rows.length >= 1);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.entity_type, 'accounting_ledger');
  assert.strictEqual(last.action, 'update');
  assert.ok(JSON.parse(last.before_json).cost_checked === 0);
  assert.strictEqual(JSON.parse(last.after_json).cost_checked, 1);
});

test('T2.3 the tagged line leaves the untagged queue', async () => {
  assert.strictEqual(untagged(), 5);
});

test('T2.4 batch: several lines in one submit', async () => {
  const cbs = db.prepare(`SELECT id FROM transaction_accounts WHERE code='4.1.1'`).get().id;
  const wbs = db.prepare(`SELECT id FROM wbs_nodes WHERE project_id=? AND wbs_code='4.1'`).get(proj()).id;
  const ids = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no IN ('SAL-0012','CASHOUT-0208')`).all().map(r => r.id);

  const res = await cli.post('/queue/tag', `line=${ids[0]}&line=${ids[1]}&cbs=${cbs}&wbs=${wbs}&check=1`);
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /tagged=2/);
  for (const id of ids) assert.strictEqual(line(id).cost_checked, 1);
  assert.strictEqual(untagged(), 3);
});

// ---- T3 tamper resistance (DB triggers are the last line of defence) ----

test('T3.1 rewriting an existing tag is aborted by the trigger', () => {
  const target = db.prepare(`SELECT id, wbs_node_id FROM accounting_ledger WHERE document_no='PO-0897'`).get();
  const other = db.prepare(`SELECT id FROM wbs_nodes WHERE project_id=? AND id <> ?`).get(proj(), target.wbs_node_id).id;
  assert.throws(
    () => db.prepare('UPDATE accounting_ledger SET wbs_node_id = ? WHERE id = ?').run(other, target.id),
    /immutable/,
  );
});

test('T3.2 un-checking a line is aborted by the trigger', () => {
  const target = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no='PO-0897'`).get().id;
  assert.throws(
    () => db.prepare(`UPDATE accounting_ledger SET cost_checked = 0 WHERE id = ?`).run(target),
    /immutable/,
  );
});

test('T3.3 changing an amount is aborted by the trigger', () => {
  const target = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no='PO-0897'`).get().id;
  assert.throws(
    () => db.prepare('UPDATE accounting_ledger SET amount = 1 WHERE id = ?').run(target),
    /immutable/,
  );
});

test('T3.4 deleting a ledger row is aborted by the trigger', () => {
  const target = db.prepare(`SELECT id FROM accounting_ledger WHERE document_no='PO-0897'`).get().id;
  assert.throws(
    () => db.prepare('DELETE FROM accounting_ledger WHERE id = ?').run(target),
    /never deleted/,
  );
});

test('T3.5 audit rows are append-only', () => {
  assert.throws(
    () => db.prepare(`UPDATE audit_log SET action = 'x' WHERE id = 1`).run(),
    /append-only/,
  );
});

// ---- T4 route guard ----

test('T4.1 POST /queue/tag without a session redirects to /login (token valid, auth missing)', async () => {
  // Valid anonymous token, so the request clears CSRF and is stopped by the auth
  // guard — that is the behaviour under test here.
  const anon = client(ORIGIN);
  await anon.get('/queue'); // 302 to login, but mints the csrf cookie
  const res = await anon.post('/queue/tag', 'line=1&cbs=1&check=1');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/login$/);
});

test('T4.2 a submit with no line ids tags nothing', async () => {
  const before = untagged();
  const res = await cli.post('/queue/tag', 'cbs=1&check=1');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(untagged(), before);
});

test('T4.3 a submit with no action tags nothing', async () => {
  const before = untagged();
  const res = await cli.post('/queue/tag', 'line=1');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /tagged=0/);
  assert.strictEqual(untagged(), before);
});