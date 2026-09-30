// Module 5 (continued): the checker's three options — Check / Return / Block.
//
// The control question: should an invalid line be rejected, or only checked with a
// warning? Research (GAO's segregation of duties; Stanford's Expense Requests
// System, which separates "returned for more info" from "rejected"; SAP invoice
// blocking) says the checker must be able to refuse, and that ONE refusal state is
// not enough. Three outcomes, and they mean different things:
//
//   CHECK  I have a CBS + WBS; this is real cost      -> status 'checked'
//   RETURN the ENTERER made a mistake                 -> status 'rejected'
//   BLOCK  the line is fine, the PROJECT cannot book it yet (no code exists)
//                                                     -> status 'blocked'
//
// Warn-and-carry is not among them: the check is final, so checking a line whose
// cost cannot be attributed freezes unattributable money into the report. X1.8 and
// X1.9 are the regression tests for exactly that hole.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3996;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let dbPath, proc, db;
let pm, controller, otherController;
const { loggedIn } = require('./helpers/csrf');

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

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
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-m5x-')), 'test.db');
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

async function openAdvance(amount, no) {
  const res = await pm.post('/advances',
    `amount=${amount}&advance_no=${encodeURIComponent(no)}&recipient_type=project_admin&description=Advance`);
  assert.strictEqual(res.status, 302, 'advance opens');
  return Number(res.headers.get('location').match(/\/advances\/(\d+)/)[1]);
}

async function enterLine(advanceId, amount, desc, side = 'debit') {
  const res = await pm.post(`/advances/${advanceId}/lines`,
    `amount=${amount}&entry_date=2026-06-10&description=${encodeURIComponent(desc)}&side=${side}`);
  assert.strictEqual(res.status, 302);
  return db.prepare(`SELECT id FROM lpb_statements ORDER BY id DESC LIMIT 1`).get().id;
}

const lineById = (id) => db.prepare(`SELECT * FROM lpb_statements WHERE id = ?`).get(id);
const cbsId = () => db.prepare(`SELECT id FROM transaction_accounts WHERE active=1 AND hidden=0 LIMIT 1`).get().id;
const actualCost = (cbs) => db.prepare(`
  SELECT COALESCE(SUM(actual_amount),0) n FROM v_cbs_actual
  WHERE project_id = ? AND transaction_account_id = ?`).get(proj(), cbs).n;

// ---- X1 the checker's three options: Check / Return / Block ------------------
//
// The control question: should an invalid line be rejected or only checked with a
// warning? Research (GAO's segregation of duties; Stanford's Expense Requests
// System, which separates "returned for more info" from "rejected"; SAP invoice
// blocking) says the checker must be able to refuse — and that one refusal state
// is not enough. Three outcomes, and they mean different things:
//
//   CHECK  I have a CBS + WBS; this is real cost
//   RETURN the ENTERER made a mistake — a PROBLEM WITH THE LINE
//   BLOCK  the line is fine, the PROJECT cannot book it yet — a MISSING CODE
//
// Warn-and-carry is not among them: the check is final, so checking a line whose
// cost cannot be attributed freezes bad data into the report. That is what X1.7
// demonstrates.

test('X1.1 a Project Admin cannot block or clear a block (both belong to the checker)', async () => {
  const adv = await openAdvance(3000000, 'ADV-X101');
  const line = await enterLine(adv, 300000, 'Admin tries to block');

  const blocked = await pm.post(`/expenses/${line}/block`, 'reason=no+code');
  assert.strictEqual(blocked.status, 403, 'blocking is the checker\'s control');
  assert.strictEqual(lineById(line).status, 'draft', 'and nothing changed');

  // and clearing a block is the checker's too
  await controller.post(`/expenses/${line}/block`, 'reason=' + encodeURIComponent('no CBS code for this phase'));
  assert.strictEqual(lineById(line).status, 'blocked');
  const clear = await pm.post(`/expenses/${line}/unblock`, '');
  assert.strictEqual(clear.status, 403, 'clearing is the checker\'s control');
  assert.strictEqual(lineById(line).status, 'blocked', 'still blocked');
});

test('X1.2 blocking needs a reason and records who blocked it', async () => {
  const adv = await openAdvance(3000000, 'ADV-X102');
  const line = await enterLine(adv, 250000, 'Needs a reason to block');

  const noReason = await controller.post(`/expenses/${line}/block`, 'reason=');
  assert.strictEqual(lineById(line).status, 'draft', 'a block with no reason is refused');

  await controller.post(`/expenses/${line}/block`, 'reason=' + encodeURIComponent('no WBS code for this package'));
  const l = lineById(line);
  assert.strictEqual(l.status, 'blocked');
  assert.strictEqual(l.block_reason, 'no WBS code for this package');
  assert.ok(l.checked_by, 'the blocker is recorded');
  assert.ok(l.checked_at, 'and stamped');

  // the DB is the floor, not just the route
  assert.throws(() => db.prepare(`UPDATE lpb_statements SET status='blocked', block_reason=NULL WHERE id=?`).run(line),
    /requires block_reason/);
});

test('X1.3 a blocked line is NOT cost, and is visible to chase', async () => {
  const adv = await openAdvance(4000000, 'ADV-X103');
  const line = await enterLine(adv, 700000, 'Blocked, must not count as cost');
  await controller.post(`/expenses/${line}/block`, 'reason=' + encodeURIComponent('awaiting the CBS account'));

  // contributes nothing to actual cost, even though it has a CBS proposed
  assert.strictEqual(actualCost(cbsId()), 0, 'blocked contributes no cost');

  // counted in the summary's attention bucket, listed as stalled, and shown
  const page = await controller.get('/expenses');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /BLOCKED/, 'the blocked line is shown on /expenses');
  assert.match(html, /awaiting the CBS account/, 'with its reason');
  assert.match(html, /Needs attention/, 'in the attention section');
});

test('X1.4 clearing a block returns the line to draft, and it can then be checked', async () => {
  const adv = await openAdvance(4500000, 'ADV-X104');
  const line = await enterLine(adv, 900000, 'Blocked then cleared');

  await controller.post(`/expenses/${line}/block`, 'reason=' + encodeURIComponent('no code yet'));
  assert.strictEqual(lineById(line).status, 'blocked');

  // another checker clears it: the code now exists
  const cleared = await otherController.post(`/expenses/${line}/unblock`, '');
  assert.strictEqual(cleared.status, 302);
  const after = lineById(line);
  assert.strictEqual(after.status, 'draft', 'a block is a PAUSE, not an end state');
  assert.strictEqual(after.block_reason, null);

  // and now the normal path works
  await otherController.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(lineById(line).status, 'checked');
  assert.strictEqual(actualCost(cbsId()), 900000, 'and only now does it count as cost');
});

test('X1.5 a checked line cannot be blocked — the check is final', async () => {
  const adv = await openAdvance(2000000, 'ADV-X105');
  const line = await enterLine(adv, 150000, 'Checked then blocked?');
  await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(lineById(line).status, 'checked');

  const res = await otherController.post(`/expenses/${line}/block`, 'reason=too+late');
  assert.strictEqual(res.status, 302, 'refused via a redirect carrying the reason');
  assert.strictEqual(lineById(line).status, 'checked', 'the line is untouched');
});

test('X1.6 a returned line cannot be silently checked later — the fix is a new line', async () => {
  const adv = await openAdvance(2500000, 'ADV-X106');
  const line = await enterLine(adv, 800000, 'Wrong amount');
  await controller.post(`/expenses/${line}/reject`, 'reason=' + encodeURIComponent('amount does not match the receipt'));
  assert.strictEqual(lineById(line).status, 'rejected');

  // the DB refuses the back door
  assert.throws(() => db.prepare(`UPDATE lpb_statements SET status='checked', transaction_account_id=? WHERE id=?`)
    .run(cbsId(), line), /cannot be checked/);

  const res = await controller.post(`/expenses/${line}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(lineById(line).status, 'rejected', 'still returned');
  assert.strictEqual(res.status, 302);
});

test('X1.7 the correction closes the loop: a new line links back to the returned one', async () => {
  const adv = await openAdvance(2600000, 'ADV-X107');
  const bad = await enterLine(adv, 800000, 'Wrong amount');
  await controller.post(`/expenses/${bad}/reject`, 'reason=' + encodeURIComponent('should be 500000'));

  // the Project Admin re-enters the corrected figure and links the pair
  const res = await pm.post(`/advances/${adv}/lines`,
    `amount=500000&entry_date=2026-06-10&description=${encodeURIComponent('Corrected amount')}&side=debit&replaces=${bad}`);
  assert.strictEqual(res.status, 302);
  const fixed = db.prepare(`SELECT id FROM lpb_statements ORDER BY id DESC LIMIT 1`).get().id;

  assert.strictEqual(lineById(bad).superseded_by, fixed, 'the returned line points at its correction');
  assert.strictEqual(lineById(fixed).status, 'draft', 'the correction is a normal draft');

  // it can be checked, and only the corrected figure becomes cost
  await controller.post(`/expenses/${fixed}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(lineById(fixed).status, 'checked');

  // the corrected line is no longer offered as an outstanding correction
  const page = await pm.get(`/advances/${adv}`);
  assert.match(await page.text(), /replaced by #/, 'the pair is visible');
});

test('X1.8 the missing-code hole is closed: a check without a CBS account is refused', async () => {
  const adv = await openAdvance(1500000, 'ADV-X108');
  const line = await enterLine(adv, 400000, 'No CBS to book against');

  // through the route
  const res = await controller.post(`/expenses/${line}/check`, 'cbs=');
  assert.strictEqual(lineById(line).status, 'draft', 'the route refuses it');

  // and through the DB, which is what actually protects the report
  assert.throws(() => db.prepare(`UPDATE lpb_statements SET status='checked', checked_by=1, checked_at='x' WHERE id=?`)
    .run(line), /must carry a CBS account/);
  assert.throws(() => db.prepare(`INSERT INTO lpb_statements
      (cash_advance_id, project_id, entry_date, debit, credit, amount, status, checked_by, checked_at, transaction_account_id)
      VALUES (?,?,?,100,0,100,'checked',1,'x',NULL)`).run(adv, proj(), '2026-06-10'),
    /must carry a CBS account/);
});

test('X1.9 the CBS report can only contain attributable cost', async () => {
  // Historically a checked line with a NULL CBS account put unattributable money
  // in this report — the whole reason for the guard. The view also filters it, so
  // a database written before the guard cannot leak one either.
  const before = db.prepare(`SELECT COUNT(*) n FROM v_cbs_actual WHERE transaction_account_id IS NULL`).get().n;
  assert.strictEqual(before, 0, 'no NULL-account rows in the CBS report');

  const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE name='v_cbs_actual'`).get().sql;
  assert.match(sql, /transaction_account_id IS NOT NULL/, 'the view guards it too');
});

// Regression: the pages carrying the ENTER form were gated on `canReconcile`,
// which the Project Admin does not hold — so the person whose job it is to start
// the workflow got 403 on the screen holding the form, and the whole enter →
// check flow was unreachable for them. Page visibility is the union of the three
// role families; the ACTIONS stay separately gated.
test('X2.1 a Project Admin can open the pot and its enter form', async () => {
  const adv = await openAdvance(800000, 'ADV-X201');

  const pot = await pm.get(`/advances/${adv}`);
  assert.strictEqual(pot.status, 200, 'the Project Admin can open the pot');
  const html = await pot.text();
  assert.match(html, new RegExp(`/advances/${adv}/lines`), 'and the ENTER form is on it');

  assert.strictEqual((await pm.get('/advances')).status, 200, 'and the register');
  assert.strictEqual((await pm.get('/expenses')).status, 200, 'and the detail list');

  // Seeing is not doing: the checker's actions are still refused.
  const check = await pm.post(`/expenses/${await enterLine(adv, 100000, 'x')}/check`, `cbs=${cbsId()}`);
  assert.strictEqual(check.status, 403, 'but checking is not theirs to do');
});

test('X2.2 a Cost Controller can see the screens but cannot enter lines', async () => {
  const adv = await openAdvance(900000, 'ADV-X202');
  assert.strictEqual((await controller.get(`/advances/${adv}`)).status, 200, 'the controller can open the pot');

  const entered = await controller.post(`/advances/${adv}/lines`,
    'amount=100000&entry_date=2026-06-10&description=nope&side=debit');
  assert.strictEqual(entered.status, 403, 'but entering is not theirs to do');
});

test('X2.3 opening a cash advance still needs the opening capability', async () => {
  // Regression: while restructuring the role map, `canOpenAdvance` was dropped,
  // which would have made cash-advance creation 403 for everyone. Asserted
  // through the routes, not by requiring the module — requiring app code binds
  // the default DB rather than this suite's temp one.

  // A Cost Controller neither enters nor opens: they check.
  const denied = await controller.post('/advances', 'amount=500000&recipient_type=employee');
  assert.strictEqual(denied.status, 403, 'a Cost Controller cannot open a pot');

  // The Project Admin can — the flow has to be startable by someone.
  const allowed = await pm.post('/advances', 'amount=500000&recipient_type=employee');
  assert.strictEqual(allowed.status, 302, 'a Project Admin can open a pot');
});
