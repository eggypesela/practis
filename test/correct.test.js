// Ledger correction path tests: a posted line is immutable; the fix is a
// reversing entry that negates it, at most once, with the DB as the floor.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3996;

let dbPath, proc, cookie, db, cli;
const { client } = require('./helpers/csrf');
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-correct-')), 'test.db');
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
const rowById = (id) => db.prepare(`SELECT * FROM accounting_ledger WHERE id = ?`).get(id);

// Post a line through the real form so the fixtures are honest.
async function postExpense(amount, doc) {
  const res = await cli.post('/ledger/entry',
    `side=debit&amount=${amount}&type=Expense&date=2026-06-01&document_no=${doc}&description=Fixture ${doc}`);
  assert.strictEqual(res.status, 302);
  return db.prepare(`SELECT * FROM accounting_ledger ORDER BY id DESC LIMIT 1`).get();
}

// ---- C1 the original is untouchable ----

test('C1.1 GET correct shows the line read-only plus the reversal form', async () => {
  const line = await postExpense(3000000, 'C-1001');
  const res = await cli.get(`/ledger/${line.id}/correct`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`Line #${line.id}`));
  assert.match(html, /Post reversing entry/);
  assert.match(html, /nothing is edited or deleted/i);
});

test('C1.2 the DB still refuses an edit or a delete of a posted line', async () => {
  const line = await postExpense(1000000, 'C-1002');
  assert.throws(
    () => db.prepare(`UPDATE accounting_ledger SET amount = 999 WHERE id = ?`).run(line.id));
  assert.throws(
    () => db.prepare(`DELETE FROM accounting_ledger WHERE id = ?`).run(line.id));
  assert.strictEqual(rowById(line.id).amount, 1000000, 'the original is unchanged');
});

// ---- C2 posting the reversal ----

test('C2.1 reverse posts a negating line and leaves the original intact', async () => {
  const line = await postExpense(5000000, 'C-2001');
  const res = await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-02&description=Wrong project code`);
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/ledger\?reversed=\d+/);

  const rev = db.prepare(`SELECT * FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(line.id);
  assert.ok(rev, 'a reversing line exists');
  assert.strictEqual(rev.amount, -5000000);
  assert.strictEqual(rev.debit, 0);
  assert.strictEqual(rev.credit, 5000000);
  assert.strictEqual(rev.project_id, line.project_id);
  assert.strictEqual(rev.type, line.type);
  assert.strictEqual(rev.line_role, line.line_role, 'classification follows the original');
  assert.strictEqual(rev.description, 'Wrong project code');

  const orig = rowById(line.id);
  assert.strictEqual(orig.amount, 5000000, 'the original line is untouched');
  assert.strictEqual(orig.debit, 5000000);
});

test('C2.2 a reversal follows the original into the queue when it carries no CBS tag', async () => {
  const line = await postExpense(2200000, 'C-2002');
  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-03`);
  const rev = db.prepare(`SELECT * FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(line.id);
  assert.strictEqual(rev.cost_checked, 1, 'the reversal records itself as checked');
  assert.ok(rev.cost_checked_by, 'a reversal records who checked it');

  // cost_checked=1 is not the whole queue predicate: an untagged line still
  // needs a CBS account before the cost report can attribute it. The reversal
  // has one only because it copied the original's — so it comes back to the
  // queue until that tag exists, which is the honest behaviour.
  const queued = db.prepare(`SELECT COUNT(*) n FROM v_untagged_queue WHERE id = ?`).get(rev.id).n;
  assert.strictEqual(queued, 1, 'untagged reversal still needs a CBS tag');

  // Once tagged (as the original was), it leaves the queue.
  const cbs = db.prepare(`SELECT id, cost_category_id FROM transaction_accounts WHERE active=1 AND hidden=0 LIMIT 1`).get();
  const wbs = db.prepare(`SELECT id FROM wbs_nodes WHERE project_id=? AND status='active' LIMIT 1`).get(proj());
  db.prepare(`UPDATE accounting_ledger SET transaction_account_id=?, wbs_node_id=?, cost_category_id=? WHERE id=?`)
    .run(cbs.id, wbs ? wbs.id : null, cbs.cost_category_id, rev.id);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM v_untagged_queue WHERE id = ?`).get(rev.id).n, 0);
});

test('C2.3 the reversal carries the original cost tags (nets to zero in CBS)', async () => {
  const line = await postExpense(4000000, 'C-2003');
  // tag the original like the Cost Controller would
  const cbs = db.prepare(`SELECT id, cost_category_id FROM transaction_accounts WHERE active=1 AND hidden=0 LIMIT 1`).get();
  const wbs = db.prepare(`SELECT id FROM wbs_nodes WHERE project_id=? AND status='active' LIMIT 1`).get(proj());
  db.prepare(`UPDATE accounting_ledger
                 SET transaction_account_id=?, wbs_node_id=?, cost_category_id=? WHERE id=?`)
    .run(cbs.id, wbs ? wbs.id : null, cbs.cost_category_id, line.id);

  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-04`);
  const rev = db.prepare(`SELECT * FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(line.id);
  assert.strictEqual(rev.transaction_account_id, cbs.id);
  assert.strictEqual(rev.wbs_node_id, wbs ? wbs.id : null);
  assert.strictEqual(rev.cost_category_id, cbs.cost_category_id);
});

test('C2.4 reversal writes both audit trails', async () => {
  const line = await postExpense(1500000, 'C-2004');
  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-05`);
  const rev = db.prepare(`SELECT * FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(line.id);

  const created = db.prepare(`SELECT * FROM audit_log
    WHERE entity_type='accounting_ledger' AND entity_id=? AND action='create'`).get(rev.id);
  assert.ok(created, 'the reversal has a create audit row');

  const reversed = db.prepare(`SELECT * FROM audit_log
    WHERE entity_type='accounting_ledger' AND entity_id=? AND action='reverse'`).get(line.id);
  assert.ok(reversed, 'the original records that it was reversed');
  assert.doesNotThrow(() => JSON.parse(reversed.after_json));
});

// ---- C3 the guards ----

test('C3.1 a line cannot be reversed twice (409, one reversal only)', async () => {
  const line = await postExpense(700000, 'C-3001');
  const first = await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-06`);
  assert.strictEqual(first.status, 302);

  const second = await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-07`);
  assert.strictEqual(second.status, 409);
  const html = await second.text();
  assert.match(html, /already reversed/i);

  const count = db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE reverses_ledger_id=?`).get(line.id).n;
  assert.strictEqual(count, 1, 'exactly one reversal exists');
});

test('C3.2 the DB refuses a second reversal even if the route is bypassed', async () => {
  const line = await postExpense(800000, 'C-3002');
  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-08`);
  const orig = rowById(line.id);
  const insert = db.prepare(`
    INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
      amount, debit, credit, cost_checked, reverses_ledger_id)
    VALUES (?, '2026-06-09', ?, ?, ?, 'manual', ?, ?, ?, 1, ?)`);
  assert.throws(
    () => insert.run(orig.project_id, orig.type, orig.line_role, orig.in_cost_basis,
      -orig.amount, orig.credit, orig.debit, line.id),
    /UNIQUE|constraint/i);
});

test('C3.3 a reversal that does not negate the original is aborted by the trigger', async () => {
  const line = await postExpense(950000, 'C-3003');
  const insert = db.prepare(`
    INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
      amount, debit, credit, cost_checked, reverses_ledger_id)
    VALUES (?, '2026-06-10', ?, ?, ?, 'manual', ?, ?, ?, 1, ?)`);
  // wrong amount: debits instead of crediting, and not the negation
  assert.throws(
    () => insert.run(line.project_id, line.type, line.line_role, line.in_cost_basis,
      950000, 950000, 0, line.id),
    /must negate the original line/);
});

test('C3.4 the reversal link can never be moved or cleared', async () => {
  const line = await postExpense(650000, 'C-3004');
  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-11`);
  const rev = db.prepare(`SELECT * FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(line.id);
  assert.throws(
    () => db.prepare(`UPDATE accounting_ledger SET reverses_ledger_id = NULL WHERE id = ?`).run(rev.id),
    /reversal link cannot be changed/);
});

test('C3.5 a reversal of another project line is refused', async () => {
  const line = await postExpense(450000, 'C-3005');
  const other = db.prepare(`SELECT id FROM accounting_ledger WHERE project_id <> ? LIMIT 1`).get(line.project_id);
  if (!other) return; // single-project fixture: nothing to cross
  const insert = db.prepare(`
    INSERT INTO accounting_ledger (project_id, date, type, line_role, in_cost_basis, source,
      amount, debit, credit, cost_checked, reverses_ledger_id)
    VALUES (?, '2026-06-12', ?, ?, ?, 'manual', ?, ?, ?, 1, ?)`);
  assert.throws(
    () => insert.run(other.project_id, line.type, line.line_role, line.in_cost_basis,
      -line.amount, line.credit, line.debit, line.id),
    /must negate the original line/);
});

// ---- C4 the ledger view reflects it ----

test('C4.1 the ledger flags the reversed pair and hides Correct on it', async () => {
  const line = await postExpense(1100000, 'C-4001');
  await cli.post(`/ledger/${line.id}/reverse`, `date=2026-06-13`);

  const res = await cli.get('/ledger');
  const html = await res.text();
  assert.match(html, new RegExp(`REVERSED #\\d+`), 'original is flagged');
  assert.match(html, new RegExp(`REVERSAL of #${line.id}`), 'reversal is labelled');

  const again = await cli.get(`/ledger/${line.id}/correct`);
  const againHtml = await again.text();
  assert.match(againHtml, /Already reversed/i);
  assert.doesNotMatch(againHtml, /Post reversing entry/);
});

test('C4.2 reversal needs a session and a CSRF token', async () => {
  const line = await postExpense(500000, 'C-4002');

  // No session: the CSRF middleware rejects the tokenless POST before the route
  // guard runs, so this is 403 (the same first line of defence as any other
  // mutating route) — and crucially, no reversal is written either way.
  const anon = client(ORIGIN);
  const res = await anon.post(`/ledger/${line.id}/reverse`, 'date=2026-06-14');
  assert.strictEqual(res.status, 403);

  const noToken = await fetch(`${ORIGIN}/ledger/${line.id}/reverse`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'date=2026-06-14',
  });
  assert.strictEqual(noToken.status, 403, 'no CSRF token → blocked');

  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE reverses_ledger_id=?`).get(line.id).n, 0);

  // And the page itself is not readable without a session.
  const anonPage = await anon.get(`/ledger/${line.id}/correct`);
  assert.strictEqual(anonPage.status, 302, 'unauthenticated page request redirects to login');
});
