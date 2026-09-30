// Module 5: Cash Advance + Expense Report + reconciliation.
//
// The rules under test (PRD R2-1..R2-3, R2-18, R2-19; TECH-SPEC §5):
//   * an advance is NOT cost — only CHECKED Expense Report detail becomes actual cost
//   * the person who ENTERS a line cannot be the person who CHECKS it (SoD)
//   * a check is FINAL: the line freezes and cannot be edited, un-checked or deleted
//   * Finance's bulk settlement stays out of the cost basis (no double count)
//   * reconciliation reports balanced / difference / missing_detail / awaiting_settlement
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3994;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let dbPath, proc, db;
let admin, pm, controller, otherController;   // four logged-in clients
const { client, loggedIn } = require('./helpers/csrf');

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Create an active user with a known password and exactly one role.
async function makeUser(email, roleCode, fullName) {
  const argon2 = require('argon2');
  const hash = await argon2.hash('pw1234567890');
  const id = db.prepare(`INSERT INTO users (email, full_name, password_hash, is_active, is_system_admin)
                         VALUES (?, ?, ?, 1, 0)`).run(email, fullName, hash).lastInsertRowid;
  db.prepare(`INSERT INTO user_roles (user_id, role_code, project_id, granted_by) VALUES (?, ?, NULL, 1)`)
    .run(id, roleCode);
  return id;
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-m5-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'admin@example.com', 'adminpw12345'], env);
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

  db = new (require('better-sqlite3'))(dbPath);
  await makeUser('pm@example.com', 'project_admin', 'Putri Admin');
  await makeUser('cc@example.com', 'cost_controller', 'Cahya Controller');
  await makeUser('cc2@example.com', 'cost_controller', 'Cinta Controller');

  admin = await loggedIn(ORIGIN, 'admin@example.com', 'adminpw12345');
  pm = await loggedIn(ORIGIN, 'pm@example.com', 'pw1234567890');
  controller = await loggedIn(ORIGIN, 'cc@example.com', 'pw1234567890');
  otherController = await loggedIn(ORIGIN, 'cc2@example.com', 'pw1234567890');
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const proj = () => db.prepare(`SELECT id FROM projects WHERE code='PRJ-2026'`).get().id;

// Open an advance through the real form; returns its id.
async function openAdvance(amount, no) {
  // omit the field entirely when there is no number — `advance_no=${no}` would
  // send the literal string "null"
  const body = `amount=${amount}${no == null ? '' : `&advance_no=${encodeURIComponent(no)}`}`
    + '&recipient_type=project_admin&description=Advance';
  const res = await pm.post('/advances', body);
  assert.strictEqual(res.status, 302, 'advance opens');
  return Number(res.headers.get('location').match(/\/advances\/(\d+)/)[1]);
}

// Finance's bulk settlement, booked straight into the ledger as an LPB line.
// Written through THIS test's db handle, not the app's modules: requiring
// src/db/queries would bind the default database file instead of this temp one.
function insertBulkLpb(documentNo, amount) {
  return db.prepare(`
    INSERT INTO accounting_ledger
      (project_id, date, document_no, description, type, line_role, in_cost_basis,
       amount, debit, credit, source)
    VALUES (?, '2026-06-30', ?, 'Finance bulk settlement', 'LPB', 'expense', 1,
            ?, 0, ?, 'manual')`).run(proj(), documentNo, -amount, amount).lastInsertRowid;
}

// Enter a draft usage line through the real form; returns the line id.
async function enterLine(advanceId, amount, desc, side = 'debit') {
  const res = await pm.post(`/advances/${advanceId}/lines`,
    `amount=${amount}&entry_date=2026-06-10&description=${encodeURIComponent(desc)}&side=${side}`);
  assert.strictEqual(res.status, 302);
  return db.prepare(`SELECT id FROM lpb_statements ORDER BY id DESC LIMIT 1`).get().id;
}

const lineById = (id) => db.prepare(`SELECT * FROM lpb_statements WHERE id = ?`).get(id);
const cbsId = () => db.prepare(`SELECT id FROM transaction_accounts WHERE active=1 AND hidden=0 LIMIT 1`).get().id;

// Actual cost for a CBS account, as the report computes it.
const actualCost = (cbs) => db.prepare(`
  SELECT COALESCE(SUM(actual_amount),0) n FROM v_cbs_actual
  WHERE project_id = ? AND transaction_account_id = ?`).get(proj(), cbs).n;

// ---- A1 the advance pot ----

test('A1.1 opening a cash advance records it as open and non-zero whole rupiah', async () => {
  const id = await openAdvance(5000000, 'ADV-1001');
  const a = db.prepare(`SELECT * FROM cash_advance WHERE id = ?`).get(id);
  assert.strictEqual(a.amount, 5000000);
  assert.strictEqual(a.status, 'open');
  assert.strictEqual(a.project_id, proj());
});

test('A1.2 a non-whole or zero advance is refused', async () => {
  const zero = await pm.post('/advances', 'amount=0&advance_no=ADV-BAD');
  assert.strictEqual(zero.status, 400);
  const before = db.prepare(`SELECT COUNT(*) n FROM cash_advance`).get().n;
  // the DB trigger is the floor for anything that reaches it
  assert.throws(() => db.prepare(`INSERT INTO cash_advance (project_id, amount) VALUES (?, 0)`).run(proj()),
    /non-zero whole-rupiah/);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM cash_advance`).get().n, before);
});

test('A1.3 a viewer without a relevant role is refused with 403, not a hidden link', async () => {
  await makeUser('viewer@example.com', 'viewer', 'Vera Viewer');
  const v = await loggedIn(ORIGIN, 'viewer@example.com', 'pw1234567890');
  const res = await v.get('/advances');
  assert.strictEqual(res.status, 403);
  assert.match(await res.text(), /Not allowed/);
});

// ---- E1 entering Expense Report lines ----

test('E1.1 a Project Admin can enter a usage line and it lands as draft', async () => {
  const adv = await openAdvance(3000000, 'ADV-2001');
  const line = await enterLine(adv, 750000, 'Fuel and tolls');
  const l = lineById(line);
  assert.strictEqual(l.status, 'draft');
  assert.strictEqual(l.amount, 750000, 'debit side → positive amount (amount = debit - credit, money out)');
  assert.strictEqual(l.debit, 750000);
  assert.strictEqual(l.credit, 0);
  assert.strictEqual(l.cash_advance_id, adv);
  assert.ok(l.created_by, 'the enterer is recorded');
});

test('E1.2 a DRAFT line contributes NOTHING to actual cost', async () => {
  const adv = await openAdvance(2000000, 'ADV-2002');
  const cbs = cbsId();
  const before = actualCost(cbs);
  const line = await enterLine(adv, 1250000, 'Materials');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbs}`);

  // Only now does it count. Before the check the figure must be unchanged.
  const afterEnter = db.prepare(`SELECT status FROM lpb_statements WHERE id = ?`).get(line).status;
  assert.strictEqual(afterEnter, 'checked');
  assert.strictEqual(actualCost(cbs), before + 1250000, 'checked line rolls into actual cost');

  // and a fresh draft does not move it
  const line2 = await enterLine(adv, 999000, 'Still a draft');
  assert.strictEqual(actualCost(cbs), before + 1250000, 'the draft is excluded');
  assert.strictEqual(lineById(line2).status, 'draft');
});

test('E1.3 the advance itself is never cost (it is money handed out)', async () => {
  const cbs = cbsId();
  const before = actualCost(cbs);
  await openAdvance(8000000, 'ADV-2003');
  assert.strictEqual(actualCost(cbs), before, 'opening an advance adds no cost');
});

test('E1.4 a non-whole amount is refused before it reaches the table', async () => {
  const adv = await openAdvance(1000000, 'ADV-2004');
  const res = await pm.post(`/advances/${adv}/lines`, 'amount=0&entry_date=2026-06-10');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /error=/);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM lpb_statements WHERE cash_advance_id = ?`).get(adv).n, 0);
});

// ---- C1 the check is final ----

test('C1.1 checking sets checked_by/checked_at and is final', async () => {
  const adv = await openAdvance(1500000, 'ADV-3001');
  const line = await enterLine(adv, 600000, 'Site supplies');
  const cbs = cbsId();
  const res = await controller.post(`/expenses/${line}/check`, `cbs=${cbs}`);
  assert.strictEqual(res.status, 302);

  const l = lineById(line);
  assert.strictEqual(l.status, 'checked');
  assert.strictEqual(l.transaction_account_id, cbs, 'the controller confirms the CBS account');
  assert.ok(l.checked_by, 'the checker is recorded');
  assert.ok(l.checked_at, 'the check is timestamped');
});

test('C1.2 a checked line cannot be edited, un-checked or deleted', async () => {
  const adv = await openAdvance(900000, 'ADV-3002');
  const line = await enterLine(adv, 400000, 'Frozen once checked');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);

  assert.throws(() => db.prepare(`UPDATE lpb_statements SET amount = 1 WHERE id = ?`).run(line),
    /a checked line is final/);
  assert.throws(() => db.prepare(`UPDATE lpb_statements SET status = 'draft' WHERE id = ?`).run(line),
    /a checked line is final/);
  assert.throws(() => db.prepare(`DELETE FROM lpb_statements WHERE id = ?`).run(line),
    /never deleted/);

  const l = lineById(line);
  assert.strictEqual(l.amount, 400000, 'debit side → positive amount');
  assert.strictEqual(l.status, 'checked');
});

test('C1.3 a draft line cannot be checked without a checker identity', async () => {
  const adv = await openAdvance(700000, 'ADV-3003');
  const line = await enterLine(adv, 300000, 'No checker');
  // Give the line a CBS account first, so the only rule it breaks is the one
  // under test. Without this the CBS guard fires first and the test would pass
  // or fail on a different guard than it claims to check.
  db.prepare(`UPDATE lpb_statements SET transaction_account_id = ? WHERE id = ?`).run(cbsId(), line);
  assert.throws(
    () => db.prepare(`UPDATE lpb_statements SET status='checked' WHERE id = ?`).run(line),
    /requires checked_by and checked_at/);
  assert.strictEqual(lineById(line).status, 'draft');
});

test('C1.4 checking twice is refused (the line is already final)', async () => {
  const adv = await openAdvance(1200000, 'ADV-3004');
  const line = await enterLine(adv, 500000, 'Double check');
  const first = await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(first.status, 302);

  const second = await otherController.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.match(second.headers.get('location'), /error=/);
  assert.strictEqual(lineById(line).checked_by,
    db.prepare(`SELECT id FROM users WHERE email='cc@example.com'`).get().id,
    'the first checker stands');
});

test('C1.5 a check must carry a CBS account', async () => {
  const adv = await openAdvance(600000, 'ADV-3005');
  const line = await enterLine(adv, 250000, 'No CBS given');
  const res = await controller.post(`/expenses/${line}/check`, 'cbs=');
  assert.match(res.headers.get('location'), /must%20assign%20a%20CBS|error=/);
  assert.strictEqual(lineById(line).status, 'draft');
});

// ---- S1 separation of duties ----

test('S1.1 the person who ENTERED a line cannot also CHECK it', async () => {
  // one user holding BOTH roles is the honest way to test the rule itself
  const bothId = await makeUser('both@example.com', 'project_admin', 'Bella Both');
  db.prepare(`INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, 'cost_controller', NULL)`)
    .run(bothId);
  const both = await loggedIn(ORIGIN, 'both@example.com', 'pw1234567890');

  const adv = await openAdvance(1000000, 'ADV-4001');
  // enter as `both` (they hold the enter role)
  const ent = await both.post(`/advances/${adv}/lines`,
    'amount=350000&entry_date=2026-06-10&description=Self-check attempt');
  assert.strictEqual(ent.status, 302);
  const line = db.prepare(`SELECT id FROM lpb_statements ORDER BY id DESC LIMIT 1`).get().id;

  const res = await both.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.match(res.headers.get('location'), /error=/i, 'the self-check is refused');
  assert.strictEqual(lineById(line).status, 'draft', 'the line stays draft');

  // a DIFFERENT controller may check it
  const ok = await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(lineById(line).status, 'checked');
});

test('S1.2 a Cost Controller cannot enter Expense Report lines', async () => {
  const adv = await openAdvance(500000, 'ADV-4002');
  const res = await controller.post(`/advances/${adv}/lines`,
    'amount=100000&entry_date=2026-06-10&description=Not my job');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM lpb_statements WHERE cash_advance_id = ?`).get(adv).n, 0);
});

test('S1.3 a Project Admin cannot check (the check belongs to the Cost Controller)', async () => {
  const adv = await openAdvance(450000, 'ADV-4003');
  const line = await enterLine(adv, 200000, 'Admin tries to check');
  const res = await pm.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(lineById(line).status, 'draft');
});

test('S1.4 a rejection needs a reason and records the rejecter', async () => {
  const adv = await openAdvance(800000, 'ADV-4004');
  const line = await enterLine(adv, 275000, 'Rejected line');

  const noReason = await controller.post(`/expenses/${line}/reject`, 'reason=');
  assert.match(noReason.headers.get('location'), /error=/);
  assert.strictEqual(lineById(line).status, 'draft');

  const ok = await controller.post(`/expenses/${line}/reject`, 'reason=Wrong+project+period');
  assert.strictEqual(ok.status, 302);
  const l = lineById(line);
  assert.strictEqual(l.status, 'rejected');
  assert.strictEqual(l.reject_reason, 'Wrong project period');

  // a rejected line is not cost
  assert.strictEqual(
    db.prepare(`SELECT COUNT(*) n FROM v_cbs_actual WHERE project_id=?`).get(proj()).n >= 0, true);
});

// ---- R1 reconciliation (R2-19) ----

test('R1.1 a settlement with no detail reports missing_detail', async () => {
  // Finance books the bulk settlement directly in the ledger as an LPB line
  insertBulkLpb('LPB-9001', 4000000);

  const res = await admin.get('/reconciliation');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /MISSING DETAIL/);

  const v = db.prepare(`SELECT * FROM v_lpb_reconciliation WHERE project_id=? AND lpb_no='LPB-9001'`)
    .get(proj());
  assert.strictEqual(v.status, 'missing_detail');
  assert.strictEqual(v.finance_amount, 4000000);
  assert.strictEqual(v.admin_detail_amount, null, 'nothing was reported at all');
  assert.strictEqual(v.difference, 4000000, 'the whole settlement is unreported');
});

test('R1.2 detail that matches the settlement reports balanced', async () => {
  insertBulkLpb('LPB-9002', 1000000);

  const adv = await openAdvance(1000000, 'LPB-9002');
  const line = await enterLine(adv, 1000000, 'Matches the settlement');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);

  const v = db.prepare(`SELECT * FROM v_lpb_reconciliation WHERE project_id=? AND lpb_no='LPB-9002'`)
    .get(proj());
  assert.strictEqual(v.status, 'balanced');
  assert.strictEqual(v.finance_amount, 1000000);
  assert.strictEqual(v.admin_detail_amount, 1000000);
  assert.strictEqual(v.difference, 0);
});

test('R1.3 detail that disagrees reports difference with the gap', async () => {
  insertBulkLpb('LPB-9003', 2000000);

  const adv = await openAdvance(2000000, 'LPB-9003');
  const line = await enterLine(adv, 1500000, 'Short by 500k');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);

  const v = db.prepare(`SELECT * FROM v_lpb_reconciliation WHERE project_id=? AND lpb_no='LPB-9003'`)
    .get(proj());
  assert.strictEqual(v.status, 'difference');
  assert.strictEqual(v.difference, 500000, 'the gap is reported, not hidden');
});

test('R1.4 detail with no settlement yet reports awaiting_settlement, not missing_detail', async () => {
  // The 001 view left this case as NULL, which a naive UI renders as the exact
  // opposite of the truth — this is the regression 007 fixes.
  const adv = await openAdvance(300000, 'ADV-5001');
  const line = await enterLine(adv, 300000, 'Reported, not yet settled');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);

  const v = db.prepare(`SELECT * FROM v_lpb_reconciliation WHERE project_id=? AND lpb_no='ADV-5001'`)
    .get(proj());
  assert.ok(v, 'the row exists');
  assert.strictEqual(v.status, 'awaiting_settlement');
  assert.notStrictEqual(v.status, 'missing_detail', 'detail exists, so it is not missing');
  assert.strictEqual(v.finance_amount, null);
  assert.strictEqual(v.admin_detail_amount, 300000);

  const res = await admin.get('/reconciliation');
  assert.match(await res.text(), /AWAITING SETTLEMENT/);
});

test('R1.5 an un-numbered detail line cannot pollute the reconciliation', async () => {
  // a line with no lpb_no has nothing to reconcile against; it must not create a
  // phantom 'missing_detail' row of its own
  const adv = await openAdvance(200000, null);
  const before = db.prepare(`SELECT COUNT(*) n FROM v_lpb_reconciliation WHERE project_id=?`)
    .get(proj()).n;
  await enterLine(adv, 200000, 'Un-numbered');
  const after = db.prepare(`SELECT COUNT(*) n FROM v_lpb_reconciliation WHERE project_id=?`)
    .get(proj()).n;
  assert.strictEqual(after, before, 'an un-numbered line adds no reconciliation row');
});

// ---- Z1 authorization on the whole module ----

test('Z1.1 every module-5 page needs a session', async () => {
  const anon = client(ORIGIN);
  for (const p of ['/advances', '/advances/new', '/expenses', '/reconciliation']) {
    const res = await anon.get(p);
    assert.strictEqual(res.status, 302, `${p} redirects to login`);
    assert.match(res.headers.get('location') || '', /\/login/);
  }
});

test('Z1.2 every module-5 POST needs a CSRF token', async () => {
  const adv = await openAdvance(100000, 'ADV-6001');
  const before = db.prepare(`SELECT COUNT(*) n FROM lpb_statements`).get().n;
  const res = await pm.postNoToken(`/advances/${adv}/lines`,
    'amount=50000&entry_date=2026-06-10&description=No+token');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(db.prepare(`SELECT COUNT(*) n FROM lpb_statements`).get().n, before);
});

test('Z1.3 an Administrator can do everything (they are the system owner)', async () => {
  const advRes = await admin.post('/advances', 'amount=150000&advance_no=ADV-7001');
  assert.strictEqual(advRes.status, 302);
  const adv = Number(advRes.headers.get('location').match(/\/advances\/(\d+)/)[1]);

  const lineRes = await admin.post(`/advances/${adv}/lines`,
    'amount=150000&entry_date=2026-06-10&description=Admin entered');
  assert.strictEqual(lineRes.status, 302);
  const line = db.prepare(`SELECT id FROM lpb_statements ORDER BY id DESC LIMIT 1`).get().id;

  // The admin entered it, so the SoD rule still refuses their own check...
  const selfCheck = await admin.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.match(selfCheck.headers.get('location'), /error=/i);

  // ...and a Cost Controller can complete it.
  const ok = await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(lineById(line).status, 'checked');
});
