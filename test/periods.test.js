// FP-series: frozen accounting periods (TECH-SPEC §8.4, plan task 0.10).
//
// THE HOLE THIS CLOSES
// §8.4 requires "Frozen period rejects ordinary backdated writes". The
// `frozen_periods` table has existed since migration 001 with ZERO rows, no
// trigger, no route and no reference anywhere in src/ — the invariant was
// written in the specification and enforced nowhere. A month that had been
// reported could be backdated silently.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A STATUS CODE
// A refusal is proven by the LEDGER TOTAL for the period being unchanged, not by
// a 400. The five original authorization bugs all returned a cheerful 302/200
// while writing; a status-only test passes on the bug. FP1.1 therefore compares
// SUM(amount) before and after.
//
// BOTH LAYERS ARE TESTED, DELIBERATELY
// The route refuses first, so the user gets a message naming the period and the
// way forward instead of a raw RAISE(ABORT) string. The trigger is the floor
// beneath it, for any path that bypasses the route. FP1.6 exercises the trigger
// directly, because a test that only drives the route would pass even if the
// trigger were deleted — and the trigger is the guarantee, the route is the
// courtesy.
//
// THE DOOR IS THE EXISTING CORRECTION MECHANISM
// §8.4 requires the revision path to stay explicit: a frozen month must still
// admit a deliberate correction, or people work around the lock. PRACTIS corrects
// a posted line by REVERSING it (reverses_ledger_id), which is already the only
// legal way to fix a line and already the only thing lib/ledger-correction.js
// writes. FP1.2 asserts that reversal is admitted while an ordinary write is not.
//
// Port: 3910, per TEST_PLAN §12.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const argon2 = require('argon2');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3910;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PW = 'periods-pw-12345';

// The month under test, and one deliberately left open for contrast.
const MONTH = '2026-06';
const OPEN_MONTH = '2026-07';
const D_IN = '2026-06-15';
const D_OPEN = '2026-07-15';

let dbPath, db, srv, ids = {};

async function boot(port, extraEnv = {}) {
  const proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 20000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); }
    });
  });
  return proc;
}

const { loggedIn } = require('./helpers/csrf');

// The period total the reports read. A write that "succeeded" but did not move
// this number is not a write; a refusal that left it alone is a real refusal.
const periodTotal = (month) => db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS n FROM accounting_ledger
  WHERE project_id = ? AND substr(COALESCE(effective_date, date), 1, 7) = ?`)
  .get(ids.projectId, month).n;

const ledgerCount = () => db.prepare(
  'SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?').get(ids.projectId).n;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-periods-')), 'test.db');
  execFileSync(NODE, [path.join('src', 'db', 'migrate.js')],
    { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
  execFileSync(NODE, [path.join('src', 'db', 'seed.js'), 'periods-admin@example.test', 'periodspw12345'],
    { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
  execFileSync(NODE, [path.join('src', 'db', 'seed-master.js')],
    { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });

  db = new (require('better-sqlite3'))(dbPath);
  ids.projectId = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;

  // Two lines in the month under test — the seed data is real-shaped and its
  // dates are arbitrary, so give this month a known, non-zero baseline.
  const insLine = db.prepare(`INSERT INTO accounting_ledger
      (project_id, date, type, amount, debit, credit, description, source)
      VALUES (?, ?, 'Expense', ?, ?, 0, ?, 'manual')`);
  insLine.run(ids.projectId, D_IN, 5000000, 5000000, 'BASELINE-JUNE');
  insLine.run(ids.projectId, D_IN, 2500000, 2500000, 'BASELINE-JUNE-2');

  // An Administrator (the only role that may freeze) and a Finance user (who may
  // post but not freeze). Emails must not collide with the ones seed.js creates
  // (it already inserts periods-admin@example.test as the bootstrap admin).
  const hash = await argon2.hash(PW);
  const mk = (email, role, admin) => {
    const r = db.prepare(
      'INSERT INTO users (email, full_name, password_hash, is_system_admin) VALUES (?, ?, ?, ?)')
      .run(email, email, hash, admin ? 1 : 0);
    db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, NULL)')
      .run(r.lastInsertRowid, role);
    return r.lastInsertRowid;
  };
  ids.adminId = db.prepare('SELECT id FROM users WHERE email = ?')
    .get('periods-admin@example.test').id;
  ids.finId = mk('fp-finance@example.test', 'finance', 0);

  srv = await boot(PORT);

  ids.clients = {
    admin: await loggedIn(ORIGIN, 'periods-admin@example.test', 'periodspw12345'),
    fin: await loggedIn(ORIGIN, 'fp-finance@example.test', PW),
  };
});

after(() => {
  if (srv) srv.kill('SIGKILL');
  if (db) db.close();
});

// The csrf test helper takes a URL-encoded BODY STRING (it appends `&_csrf=` to
// whatever it is given), so every POST here is built with URLSearchParams rather
// than passed an object — an object would be stringified to "[object Object]"
// and fail the CSRF check before reaching the route under test.
const form = (o) => new URLSearchParams(o).toString();

// Re-mint the CSRF token. Every rendered page carries a fresh token bound to the
// session, so a client that has just received an HTML response (a 400 re-render,
// say) holds a token the server no longer accepts on the NEXT post. Re-reading a
// page before acting keeps each step independent of what the previous one
// returned — without this, the order tests run in changes their outcome.
async function refresh(client) {
  await client.get('/');
  return client;
}

// Freeze/unfreeze through the real HTTP route, so the route and the DB agree.
async function freeze(month) {
  await refresh(ids.clients.admin);
  const res = await ids.clients.admin.post('/periods/freeze', form({ period_month: month }));
  assert.strictEqual(res.status, 302, 'freeze should redirect on success');
}
async function unfreeze(month) {
  await refresh(ids.clients.admin);
  const res = await ids.clients.admin.post('/periods/unfreeze', form({ period_month: month }));
  assert.strictEqual(res.status, 302, 'unfreeze should redirect on success');
}

// Post a new ledger entry through the form, as Finance may.
async function postEntry(client, { date, amount, description }) {
  await refresh(client);
  return client.post('/ledger/entry', form({
    type: 'Expense', date, description, side: 'debit', amount: String(amount),
  }));
}

test('FP1.1 a backdated write into a frozen month is REFUSED and the period total does not move', async () => {
  await freeze(MONTH);
  const before = periodTotal(MONTH);
  const countBefore = ledgerCount();

  const res = await postEntry(ids.clients.fin, {
    date: D_IN, amount: 10000000, description: 'SHOULD-NOT-LAND',
  });

  assert.strictEqual(res.status, 400, 'the entry form comes back with the refusal');
  const body = await res.text();
  assert.match(body, /frozen/i, 'the message names the problem in plain words');
  assert.ok(body.includes(MONTH), `the message names the frozen period ${MONTH}`);

  // The assertion that matters: nothing was written. A status-only test would
  // pass on a route that returns 400 AFTER inserting.
  assert.strictEqual(periodTotal(MONTH), before, 'the frozen period total is unchanged');
  assert.strictEqual(ledgerCount(), countBefore, 'no ledger row was added');

  const landed = db.prepare(
    "SELECT COUNT(*) n FROM accounting_ledger WHERE description = 'SHOULD-NOT-LAND'").get().n;
  assert.strictEqual(landed, 0, 'the refused row is provably absent from the table');
});

test('FP1.2 the revision door: reversing an existing frozen-month line IS admitted', async () => {
  await freeze(MONTH);
  const line = db.prepare(
    "SELECT id, amount FROM accounting_ledger WHERE description = 'BASELINE-JUNE' AND project_id = ?")
    .get(ids.projectId);
  assert.ok(line, 'the baseline line to reverse exists');

  const before = periodTotal(MONTH);

  // The correction path is the reversal route, not a new backdated entry.
  await refresh(ids.clients.fin);
  const res = await ids.clients.fin.post(`/ledger/${line.id}/reverse`, form({
    date: D_IN, description: 'Correction inside the frozen month',
  }));

  assert.strictEqual(res.status, 302, 'the reversal is accepted');

  const reversal = db.prepare(
    'SELECT id, amount, reverses_ledger_id FROM accounting_ledger WHERE reverses_ledger_id = ?')
    .get(line.id);
  assert.ok(reversal, 'a reversal row now exists');
  assert.strictEqual(reversal.amount, -line.amount, 'and it negates the line it corrects');

  // The period total moved — by exactly the correction that was asked for, which
  // is the difference between a deliberate door and a lock nobody can open.
  assert.strictEqual(periodTotal(MONTH), before - line.amount,
    'the frozen period total moved by exactly the reversal');
});

test('FP1.3 unfreezing restores ordinary writes', async () => {
  await freeze(MONTH);
  const refused = await postEntry(ids.clients.fin, {
    date: D_IN, amount: 3000000, description: 'AFTER-UNFREEZE',
  });
  assert.strictEqual(refused.status, 400, 'still refused while frozen');

  await unfreeze(MONTH);

  const before = periodTotal(MONTH);
  const res = await postEntry(ids.clients.fin, {
    date: D_IN, amount: 3000000, description: 'AFTER-UNFREEZE',
  });
  assert.strictEqual(res.status, 302, 'the same write now succeeds');
  assert.strictEqual(periodTotal(MONTH), before + 3000000, 'and the period total moved');
});

test('FP1.4 a month that is not frozen is unaffected', async () => {
  await freeze(MONTH);
  const before = periodTotal(OPEN_MONTH);
  const res = await postEntry(ids.clients.fin, {
    date: D_OPEN, amount: 4000000, description: 'OPEN-MONTH-WRITE',
  });
  assert.strictEqual(res.status, 302, 'a write into an open month still succeeds');
  assert.strictEqual(periodTotal(OPEN_MONTH), before + 4000000,
    'and lands in its own period, leaving the frozen one untouched');
  await unfreeze(MONTH);
});

test('FP1.5 freeze and unfreeze are audit-logged, with the actor recorded', async () => {
  await freeze(MONTH);
  await unfreeze(MONTH);

  const rows = db.prepare(`
    SELECT action, actor_id, after_json, before_json
    FROM audit_log WHERE entity_type = 'frozen_periods' ORDER BY id DESC LIMIT 2`).all();
  assert.strictEqual(rows.length, 2, 'both transitions are logged');

  const [unfroze, froze] = rows;   // newest first
  assert.strictEqual(froze.action, 'freeze');
  assert.strictEqual(unfroze.action, 'unfreeze');
  assert.strictEqual(froze.actor_id, ids.adminId, 'the freezing admin is recorded');
  assert.strictEqual(unfroze.actor_id, ids.adminId, 'the unfreezing admin is recorded');
  assert.match(froze.after_json, new RegExp(MONTH), 'the frozen month is in the record');
});

test('FP1.6 the TRIGGER is the floor: a direct insert is refused even with no route involved', async () => {
  await freeze(MONTH);
  const before = periodTotal(MONTH);

  // Bypass the app entirely and write to the table — the route is a courtesy,
  // this trigger is the guarantee.
  assert.throws(() => {
    db.prepare(`INSERT INTO accounting_ledger
        (project_id, date, type, amount, debit, credit, description, source)
        VALUES (?, ?, 'Expense', 100, 100, 0, 'RAW-INSERT', 'manual')`)
      .run(ids.projectId, D_IN);
  }, /frozen period/i, 'a direct insert into a frozen month is aborted by the trigger');

  // Backdating via `date` alone is caught too: the trigger follows the accounting
  // date (effective_date when set), which is what the reports group by.
  assert.throws(() => {
    db.prepare(`INSERT INTO accounting_ledger
        (project_id, date, effective_date, type, amount, debit, credit, description, source)
        VALUES (?, '2026-01-01', ?, 'Expense', 100, 100, 0, 'RAW-BACKDATE', 'manual')`)
      .run(ids.projectId, D_IN);
  }, /frozen period/i, 'a row dated elsewhere but EFFECTIVE in the frozen month is refused');

  assert.strictEqual(periodTotal(MONTH), before, 'nothing reached the books');
  await unfreeze(MONTH);
});

test('FP1.8 a row accounted in an open month cannot be WALKED into a frozen month', async () => {
  // The insert hole reached one statement later. Found by db/validate.py, not by
  // reasoning: `effective_date` is DELIBERATELY editable (the sanctioned
  // accounting-date correction — validate.py asserts it) and it is the column the
  // reports group by, so a row POSTED in the frozen month but ACCOUNTED elsewhere
  // could be moved into the frozen month by one UPDATE, never touching a blocked
  // insert. `date` itself is already immutable (trg_ledger_no_amount_update), so
  // effective_date is the only movable column and the only path that matters.
  //
  // This row is inserted directly because the entry form offers no
  // effective-date field — this models the import path, which sets it.
  const row = db.prepare(`INSERT INTO accounting_ledger
      (project_id, date, effective_date, type, amount, debit, credit, description, source)
      VALUES (?, ?, ?, 'Expense', 7700000, 7700000, 0, 'WALK-ME', 'manual')`)
    .run(ids.projectId, D_IN, D_OPEN).lastInsertRowid;

  const openBefore = periodTotal(OPEN_MONTH);
  const frozenBefore = periodTotal(MONTH);

  await freeze(MONTH);

  // Editing effective_date is fine while it stays inside an open month...
  db.prepare('UPDATE accounting_ledger SET effective_date = ? WHERE id = ?')
    .run(`${OPEN_MONTH}-20`, row);
  assert.strictEqual(periodTotal(OPEN_MONTH), openBefore,
    'an effective-date correction inside an open month is still allowed');

  // ...but walking it INTO the frozen month is refused, by the trigger, with no
  // route involved. Without trg_ledger_frozen_period_effective_date this UPDATE
  // succeeds and the frozen month silently gains 7,700,000.
  assert.throws(() => {
    db.prepare('UPDATE accounting_ledger SET effective_date = ? WHERE id = ?').run(D_IN, row);
  }, /frozen period/i, 'the trigger refuses an UPDATE that moves a row into a frozen month');

  // Clearing it is the same walk in reverse: the row would fall back to `date`,
  // which is inside the frozen month.
  assert.throws(() => {
    db.prepare('UPDATE accounting_ledger SET effective_date = NULL WHERE id = ?').run(row);
  }, /frozen period/i, 'NULLing the effective date cannot drop the row into the frozen month either');

  assert.strictEqual(periodTotal(MONTH), frozenBefore, 'nothing reached the frozen month');
  assert.strictEqual(periodTotal(OPEN_MONTH), openBefore, 'and the open month is unchanged');

  await unfreeze(MONTH);

  // The sanctioned correction is still a reversal, not a date edit — and after
  // unfreezing, the same UPDATE goes through, proving the guard is the period
  // state and not a blanket ban on the column.
  db.prepare('UPDATE accounting_ledger SET effective_date = ? WHERE id = ?').run(D_IN, row);
  assert.strictEqual(periodTotal(MONTH), frozenBefore + 7700000,
    'once the period is open again the accounting-date correction works');
});

test('FP1.7 freezing is refused for a non-Administrator', async () => {
  // Finance may post entries but must not be able to open a closed period.
  await refresh(ids.clients.fin);
  const res = await ids.clients.fin.post('/periods/freeze', form({ period_month: OPEN_MONTH }));
  assert.strictEqual(res.status, 403, 'a Finance user cannot freeze a period');

  const frozenRow = db.prepare(
    'SELECT COUNT(*) n FROM frozen_periods WHERE project_id = ? AND period_month = ?')
    .get(ids.projectId, OPEN_MONTH).n;
  assert.strictEqual(frozenRow, 0, 'and provably no period was frozen');

  await refresh(ids.clients.fin);
  const res2 = await ids.clients.fin.post('/periods/unfreeze', form({ period_month: MONTH }));
  assert.strictEqual(res2.status, 403, 'nor unfreeze one');
});
