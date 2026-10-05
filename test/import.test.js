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

  // I8.4 and the import-service tests reach the app IN-PROCESS from THIS process (`db` below,
  // `require('../src/lib/import-service')`, `require('../src/server')`). `src/db/db.js` binds to
  // whatever `PRACTIS_DB` says, and the CHILD server is the only thing that got it above — so
  // before this line every in-process require was opening `data/practis.db`, the DEV database.
  //
  // It surfaced in module 8: migration 021 added a column to `v_aging`, and a test process
  // preparing a statement against a dev database still on v20 failed with
  // "no such column: terms_days". The dev-database read was always wrong; the schema change only
  // made the consequence visible. (I8.4 is the one that hits it, because it requires the whole
  // app in-process to walk the route table.)
  process.env.PRACTIS_DB = dbPath;
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
const COA_LIAB = '200000000000001';    // balance-sheet side for a payable group
const COA_ASSET = '110000000000001';   // balance-sheet side for an expense group

// Build CSV lines for ONE balanced transaction group.
//
// WHY THIS HELPER EXISTS. TECH-SPEC §8.4 requires every imported transaction
// group to balance to zero or be quarantined, so a lone debit is NOT a valid
// import — it is exactly the defect that rule refuses. These tests originally
// uploaded single-line transactions, which is why the rule had never been
// implemented: honouring it would have failed them. Each test now uploads a
// real, balanced group (a cost line plus its balance-sheet counterpart), which
// is what an actual export contains.
function txnGroup(id, date, amount, opts = {}) {
  const type = opts.type || 'Expense';
  const other = opts.otherType || (type === 'Expense' ? 'Payable' : 'Receivable');
  const otherCoa = opts.otherCoa || (type === 'Expense' ? COA_LIAB : COA_ASSET);
  const desc = opts.desc || 'group';
  const ref = opts.ref || `PO-${id}`;
  const coa = type === 'Income' || type === 'Revenue' ? COA_INCOME : COA_EXPENSE;
  return [
    // debit side → positive amount
    `${id},${date},${coa},${amount},0,${amount},PRJ-2026,${desc},10001,${type},${ref},,`,
    // credit side → negative amount (→ BUT ignored by the mapper, which derives
    // amount from debit − credit; kept correct so the file reads like a real export)
    `${id},${date},${otherCoa},0,${amount},-${amount},PRJ-2026,${desc} (settled),10001,${other},${ref},,`,
  ];
}

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
    ...txnGroup('T-1001', '2026-01-15', 5000000, { desc: 'Material purchase' }),
    ...txnGroup('T-1002', '2026-01-16', 7500000, { type: 'Income', desc: 'Progress bill 1' }),
  ].join('\n');

  const res = await upload(csv);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.rowCount, 4);
  assert.strictEqual(res.body.newCount, 4);
  assert.strictEqual(res.body.skippedCount, 0);
  assert.strictEqual(res.body.unbalancedGroupCount, 0, 'both groups balance');
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
    // one good, balanced group…
    ...txnGroup('T-2001', '2026-02-01', 1000000, { desc: 'Good group' }),
    // …then three rows that quarantine for their own row-level reasons. Each is
    // given its own transaction_id so the row errors stay the thing under test.
    `T-2002,2026-02-02,${COA_EXPENSE},3000000,2000000,3000000,PRJ-2026,Both sides set,10001,Expense,PO-2002,,`,
    `T-2003,not-a-date,${COA_EXPENSE},1000000,0,1000000,PRJ-2026,Bad date,10001,Expense,PO-2003,,`,
    `T-2004,2026-02-04,999999999999999,1000000,0,1000000,PRJ-2026,Unknown account,10001,Expense,PO-2004,,`,
  ].join('\n');

  const up = await upload(csv);
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.rowCount, 5);
  assert.strictEqual(up.body.newCount, 2, 'only the good row and its counterpart are new');

  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.body.newCount, 2);
  assert.strictEqual(pv.body.invalid.length, 3, 'three rows quarantined, each with reasons');

  const lines = pv.body.invalid.map((i) => i.line).sort();
  assert.deepStrictEqual(lines, [4, 5, 6], 'row numbers are file line numbers');
  const both = pv.body.invalid.find((i) => i.line === 4);
  assert.match(both.errors.join(' '), /check sign/i);
  const unknown = pv.body.invalid.find((i) => i.line === 6);
  assert.match(unknown.errors.join(' '), /unknown chart_of_accounts/i);
});

test('I3.2 Indonesian number formats and Revenue type map correctly', async () => {
  const csv = [
    HEADER,
    `T-3001,15/03/2026,${COA_EXPENSE},"1.750.000",0,"1.750.000",PRJ-2026,Local format,10001,Expense,PO-3001,,`,
    `T-3001,15/03/2026,${COA_LIAB},0,"1.750.000","-1.750.000",PRJ-2026,Local format settled,10001,Payable,PO-3001,,`,
    `T-3002,2026-03-16,${COA_INCOME},0,2000000,2000000,PRJ-2026,Revenue note,10001,Revenue,REV-3002,,2026-03-31`,
    `T-3002,2026-03-16,${COA_ASSET},2000000,0,2000000,PRJ-2026,Revenue settled,10001,Receivable,REV-3002,,`,
  ].join('\n');

  const up = await upload(csv);
  assert.strictEqual(up.body.newCount, 4, 'both rows valid');
  await confirm(up.body.batchId);

  const r1 = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-3001' AND debit>0`).get();
  assert.strictEqual(r1.amount, 1750000, 'dots are thousands separators');
  assert.strictEqual(r1.date, '2026-03-15', 'DD/MM/YYYY → ISO');

  const r2 = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-3002' AND credit>0`).get();
  assert.strictEqual(r2.type, 'Revenue', 'legacy Revenue type survives the import');
  assert.strictEqual(r2.line_role, 'receivable');
  assert.strictEqual(r2.effective_date, '2026-03-31', 'date_adjustment → effective_date');
});

// ---- I4 confirm ----

test('I4.1 confirm posts the staged rows with source=import and an audit trail', async () => {
  const csv = [
    HEADER,
    ...txnGroup('T-4001', '2026-04-01', 1234500, { desc: 'Commit me' }),
  ].join('\n');
  const up = await upload(csv);
  const before = count();

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.status, 200);
  assert.strictEqual(cf.body.inserted, 2);
  assert.strictEqual(count(), before + 2);

  const row = db.prepare(`SELECT * FROM accounting_ledger WHERE transaction_id='T-4001' AND debit>0`).get();
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
    ...txnGroup('T-4001', '2026-04-01', 1234500, { desc: 'Commit me' }),
  ].join('\n');
  const before = count();
  const up = await upload(csv);
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.newCount, 0, 'both lines are already in the ledger');
  assert.strictEqual(up.body.skippedCount, 2);

  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.body.newCount, 0);
  assert.strictEqual(pv.body.skippedCount, 2);
  assert.strictEqual(pv.body.unbalancedGroups.length, 0,
    'the group is refused as a duplicate, NOT as unbalanced — dedupe runs first');

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 0, 'nothing re-applied');
  assert.strictEqual(count(), before);
});

test('I5.2 a duplicate inside one file is skipped once (first occurrence wins)', async () => {
  const group = txnGroup('T-5001', '2026-05-01', 900000, { desc: 'Dup pair' });
  // Repeat the group's credit line verbatim: an exact fingerprint match, so the
  // second copy is skipped and the remaining pair still balances.
  const up = await upload([HEADER, ...group, group[1]].join('\n'));
  assert.strictEqual(up.body.rowCount, 3);
  assert.strictEqual(up.body.newCount, 2);
  assert.strictEqual(up.body.skippedCount, 1);
  assert.strictEqual(up.body.unbalancedGroupCount, 0,
    'skipping the duplicate leaves a balanced pair, so §8.4 has nothing to refuse');

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 2);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE transaction_id='T-5001'`).get().n, 2);
});

// ---- I7 §8.4 group balance ----

test('I7.1 a group that does not balance is quarantined IN FULL', async () => {
  // The rule (TECH-SPEC §8.4): "Every imported transaction group balances to zero
  // or is quarantined." A group is one transaction_id; a lone debit with no
  // credit leg is the exact defect. Every individual line here is a LEGAL row
  // (one-sided, whole rupiah, amount = debit − credit) — the defect is only
  // visible in the SUM, which is why per-row validation could never catch it.
  const lone = `T-6001,2026-06-01,${COA_EXPENSE},14200000,0,14200000,PRJ-2026,Lone debit,10001,Expense,PO-6001,,`;
  const partial = `T-6002,2026-06-02,${COA_EXPENSE},5000000,0,5000000,PRJ-2026,Half a pair,10001,Expense,PO-6002,,`;

  const up = await upload([HEADER, lone, partial].join('\n'));
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.body.newCount, 0, 'nothing importable — no group balances');
  assert.strictEqual(up.body.unbalancedGroupCount, 2);

  const pv = await preview(up.body.batchId);
  const groups = Object.fromEntries(pv.body.unbalancedGroups.map((g) => [g.transaction_id, g]));
  assert.strictEqual(groups['T-6001'].drift, 14200000, 'the drift is the missing credit leg');
  assert.strictEqual(groups['T-6001'].lines, 1);
  assert.strictEqual(groups['T-6002'].drift, 5000000);

  // Every line of a failed group is reported, so the operator sees the whole
  // group rather than a single mystery row.
  assert.strictEqual(pv.body.invalid.length, 2);
  assert.ok(pv.body.invalid.every((i) => i.group_unbalanced === true));
  assert.match(pv.body.invalid[0].errors.join(' '), /does not balance/i);
});

test('I7.2 the unbalanced group never reaches the ledger', async () => {
  const up = await upload([
    HEADER,
    `T-6003,2026-06-03,${COA_EXPENSE},7777777,0,7777777,PRJ-2026,Lone debit,10001,Expense,PO-6003,,`,
  ].join('\n'));
  assert.strictEqual(up.body.newCount, 0);

  const before = count();
  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 0);
  assert.strictEqual(count(), before);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE transaction_id='T-6003'`).get().n, 0,
    'a one-sided group must not be stored — that is the whole point of §8.4');
});

test('I7.3 a balanced group imports whole; an unbalanced one is refused in the same file', async () => {
  // The discriminating case: a file containing BOTH must keep the good and drop
  // the bad, so the rule is not a whole-file gate.
  const csv = [
    HEADER,
    ...txnGroup('T-6004', '2026-06-04', 2500000, { desc: 'Good group' }),
    `T-6005,2026-06-05,${COA_EXPENSE},9900000,0,9900000,PRJ-2026,Broken group,10001,Expense,PO-6005,,`,
  ].join('\n');

  const up = await upload(csv);
  assert.strictEqual(up.body.rowCount, 3);
  assert.strictEqual(up.body.newCount, 2, 'the balanced pair survives');
  assert.strictEqual(up.body.unbalancedGroupCount, 1);

  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 2);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE transaction_id='T-6004'`).get().n, 2);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM accounting_ledger WHERE transaction_id='T-6005'`).get().n, 0,
    'the broken group is not partially applied — no half a transaction');
});

test('I7.4 the rule is debit − credit, and it holds across three or more lines', async () => {
  // A real export carries groups with more than two legs (the fixture's
  // 2024010110 has three). Assert a 3-line group is accepted and that a 3-line
  // group with one leg missing is refused — so the check is a genuine sum over
  // the group, not a two-row pairing.
  const good = [
    `T-6006,2026-06-06,${COA_EXPENSE},100000,0,100000,PRJ-2026,Leg A,10001,Expense,PO-6006,,`,
    `T-6006,2026-06-06,${COA_EXPENSE},250000,0,250000,PRJ-2026,Leg B,10001,Expense,PO-6006,,`,
    `T-6006,2026-06-06,${COA_LIAB},0,350000,-350000,PRJ-2026,Leg C,10001,Payable,PO-6006,,`,
  ];
  const up = await upload([HEADER, ...good].join('\n'));
  assert.strictEqual(up.body.newCount, 3, 'a three-leg group that nets to zero imports');
  assert.strictEqual(up.body.unbalancedGroupCount, 0);

  const short = [
    `T-6007,2026-06-07,${COA_EXPENSE},100000,0,100000,PRJ-2026,Leg A,10001,Expense,PO-6007,,`,
    `T-6007,2026-06-07,${COA_EXPENSE},250000,0,250000,PRJ-2026,Leg B,10001,Expense,PO-6007,,`,
  ];
  const up2 = await upload([HEADER, ...short].join('\n'));
  assert.strictEqual(up2.body.newCount, 0, 'the same group missing its credit leg is refused whole');
  assert.strictEqual(up2.body.unbalancedGroupCount, 1);
  const pv = await preview(up2.body.batchId);
  assert.strictEqual(pv.body.unbalancedGroups[0].lines, 2,
    'both legs of the failed group are reported');
});

test('I7.5 the balance rule is a pure function that survives a reversal', async () => {
  // Unit-level, no server: the one legitimate exception. A correcting entry is a
  // SINGLE line that negates a line already in the ledger, so it cannot net to
  // zero on its own. It is recognised by reverses_ledger_id, because
  // accounting_ledger.type has no 'Reversal' member.
  const svc = require('../src/lib/import-service');

  assert.strictEqual(svc.groupBalances([
    { debit: 100, credit: 0 }, { debit: 0, credit: 100 },
  ]), true, 'a normal pair balances');

  assert.strictEqual(svc.groupBalances([
    { debit: 100, credit: 0 },
  ]), false, 'a lone debit does not balance');

  assert.strictEqual(svc.groupBalances([
    { debit: 0, credit: 100, reverses_ledger_id: 7 },
  ]), true, 'a lone REVERSAL is legitimate');

  assert.strictEqual(svc.groupBalances([
    { debit: 100, credit: 0 }, { debit: 0, credit: 100, reverses_ledger_id: 7 },
  ]), true, 'a balanced pair is balanced whether or not a reversal is one of its legs');

  // A reversal must not license an UNRELATED unbalanced line: the group still
  // nets non-zero, and not every leg is a reversal, so it must be refused.
  assert.strictEqual(svc.groupBalances([
    { debit: 100, credit: 0 },
    { debit: 0, credit: 100, reverses_ledger_id: 7 },
    { debit: 50, credit: 0 },
  ]), false, 'a reversal does not excuse a third line that leaves the group unbalanced');

  // And the drift is reported as debit − credit, per group.
  const part = svc.partitionByGroupBalance([
    { transaction_id: 'A', debit: 500, credit: 0 },            // A: lone debit → refused
    { transaction_id: 'B', debit: 0, credit: 500 },            // B: a real pair →
    { transaction_id: 'B', debit: 500, credit: 0 },            //    nets to zero
  ]);
  assert.strictEqual(part.balanced.length, 2, 'both legs of the balanced group survive');
  assert.strictEqual(part.quarantined.length, 1, 'only the lone debit is refused');
  assert.strictEqual(part.drift.get('A'), 500);
  assert.strictEqual(part.drift.get('B'), undefined, 'a balanced group reports no drift');
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

// ---- I8 unknown URLs must be 404, not "sign in" ----
//
// REGRESSION GUARD for a real defect: the projects router mounted its page guard
// unscoped (`router.use(requirePage)`) while being mounted at the root, so the
// guard ran for EVERY request. An anonymous request to a URL that matches no
// route was therefore redirected to /login before Express could reach the 404
// handler — the app answered "sign in" to a URL that does not exist, and the
// user would sign in and still not find it.

test('I8.1 an unknown URL is 404 for an anonymous visitor, not a login redirect', async () => {
  const anon = client(ORIGIN);
  for (const path of ['/nonsense', '/nope/deep/path', '/admin/nope']) {
    const res = await anon.get(path);
    assert.strictEqual(res.status, 404,
      `${path} must be 404; a 302 to /login means a root-mounted guard is swallowing it`);
    assert.ok(!(res.headers.get('location') || '').includes('/login'),
      `${path} must not redirect to /login`);
  }
});

test('I8.2 an unknown URL is 404 for a signed-in user too', async () => {
  for (const path of ['/nonsense', '/nope/deep/path', '/admin/nope']) {
    const res = await cli.get(path);
    assert.strictEqual(res.status, 404, `${path} must be 404 when signed in`);
  }
});

test('I8.3 the route that does not exist is still protected (guard not over-scoped away)', async () => {
  // The other half of the fix: scoping the guard must not have unprotected the
  // pages it is meant to protect. Both registers still demand a session, and a
  // deep path under them is still guarded rather than falling through to 404.
  const anon = client(ORIGIN);
  for (const path of ['/projects', '/projects/new', '/clients', '/clients/new',
                      '/projects/1/edit']) {
    const res = await anon.get(path);
    assert.strictEqual(res.status, 302, `${path} still requires a session`);
    assert.match(res.headers.get('location') || '', /\/login/, `${path} → /login`);
  }
});

test('I8.4 EVERY page route demands a session (the guard list is complete)', async () => {
  // The structural guard for the class of bug in I8.1. Scoping each router's
  // middleware to an explicit path list fixes the 404 problem but introduces a
  // new failure mode: forget one path in the list and that page silently becomes
  // PUBLIC. This walks EVERY registered GET route, except the deliberately
  // public ones, and requires a login redirect.
  //
  // It reads the route table from the live Express app rather than a hand-copied
  // list, so a new route added without being added to APP_PATHS fails here.
  const app = require('../src/server');
  // `/invite/:token` is DELIBERATELY public: invitation acceptance is how a new
  // user sets their first password, so there is no session to demand. It is safe
  // because the token is the credential — 32 random bytes, stored only as a hash,
  // and an unknown token renders one generic "not valid or has expired" page with
  // no enumeration (see routes/admin.js). It was missing from this list, which
  // made the test report the page as a leak; the omission was in the list, not
  // in the app.
  //
  // `/health/live` and `/health/ready` (module 9 part 9.2) are DELIBERATELY public
  // for the same structural reason the Docker HEALTHCHECK exists: a probe has no
  // session, so requiring one would make the check permanently fail. They are safe
  // because TECH-SPEC §4.3 requires their bodies to be minimal — a status word plus
  // the NAMES of failing checks, with no version, path, reason or secret. The
  // authenticated operator detail page is `/system/health`, which is NOT listed
  // here and must redirect an anonymous visitor.
  const PUBLIC = new Set(['/login', '/logout', '/health', '/health/live', '/health/ready',
    '/favicon.ico', '/app.css', '/fonts.css', '/invite/:token']);

  const routes = [];
  const walk = (stack, prefix = '') => {
    for (const layer of stack) {
      if (layer.route) {
        const p = prefix + layer.route.path;
        const methods = Object.keys(layer.route.methods || {});
        if (methods.includes('get')) routes.push(p);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Recover the mount path from the layer's compiled regexp. Express 5
        // stores it there; the exact prefix is not needed for the assertion,
        // only the set of GET paths that exist.
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(app.router?.stack || app._router?.stack || []);

  const pageRoutes = routes
    // PUBLIC is matched against the REAL route path (`/invite/:token`), so it is
    // filtered BEFORE the :param substitution below. Matching after substitution
    // would require listing the mangled form (`/invite/1`), which reads like a
    // literal id and invites someone to "tidy" it away.
    .filter((r) => !PUBLIC.has(r))
    .map((r) => r.replace(/:[A-Za-z_][\w]*/g, '1'))     // :id → 1
    .filter((r) => !r.startsWith('/api/'));             // JSON endpoints: 401, not 302

  assert.ok(pageRoutes.length > 10,
    `expected to discover the app's page routes, found ${pageRoutes.length}`);

  const anon = client(ORIGIN);
  const leaked = [];
  for (const path of pageRoutes) {
    const res = await anon.get(path);
    // 302 → guarded; 200 → PUBLIC; anything else (404/500) is fine here because
    // I8.1/I8.2 already cover unknown-URL handling.
    if (res.status === 200) leaked.push(path);
  }
  assert.deepStrictEqual(leaked, [],
    `these page routes render for an anonymous visitor: ${leaked.join(', ')}`);
});
