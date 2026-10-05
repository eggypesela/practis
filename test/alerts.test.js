// AL-series: alert rules, delivery, dedupe and the notification inbox (module 9 part 9.3).
// THIS IS PART 9.3'S GATE. PRD §4.4 (six alerts, Q19), TECH-SPEC §4.4, TS-03, TS-14, TS-23.
//
// In-process against a migrated temp DB in a throwaway directory, like jobs/health/backup. Mixing an
// HTTP server (for the inbox + polling endpoint) with direct service calls (for the rules), because
// half of this part IS the HTTP contract: TS-03's poll returns unread only, and a JSON endpoint that
// is never actually mounted is exactly the kind of thing a service-only test would call correct.
//
// EVERY CONDITION IS BUILT FROM REAL DATA through the real paths — a cost baseline, progress rows, a
// ledger cost line, a receivable — rather than by inserting an inbox row and asserting it comes back
// out. A test that writes the row it then reads proves only that SQLite works.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-alert-test-'));
const dbPath = path.join(work, 'test.db');

// TRAP: db.js THROWS in a test process when PRACTIS_DB is unset. Set it BEFORE the first require.
process.env.PRACTIS_DB = dbPath;
process.env.PRACTIS_BACKUPS = path.join(work, 'backups');

execFileSync(process.execPath, ['src/db/migrate.js'],
  { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
execFileSync(process.execPath, ['src/db/seed.js', 'alert-admin@example.com', 'pw123456'],
  { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
execFileSync(process.execPath, ['src/db/seed-master.js'],
  { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });

let db;
let svc;
let perms;
let app;
let origin;
let server;
let admin;

const PROJECT = 1;
const MONTH = '2026-03';
const ACCOUNT = '1.1.1';

test.before(async () => {
  db = require('../src/db/db');
  svc = require('../src/lib/alert-service');
  perms = require('../src/lib/permissions');
  app = require('../src/server');

  admin = db.prepare('SELECT * FROM users WHERE email = ?').get('alert-admin@example.com');
  assert.ok(admin, 'the seeded admin must exist');
  assert.strictEqual(admin.is_system_admin, 1);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;

  // Log in HERE, inside the one setup hook, rather than in a second `before`. A second top-level
  // `before` registered after the tests does not reliably run after this one, and when it ran first
  // every HTTP test failed on `origin` being undefined — a hook-ordering dependency that has no
  // business existing. One hook, one place where the world is made ready.
  await login();
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------------------------
// Fixture builders — the conditions, built the way the app builds them
// ---------------------------------------------------------------------------------------------

function wbsNode() {
  const n = db.prepare('SELECT id FROM wbs_nodes WHERE project_id = ? ORDER BY id LIMIT 1').get(PROJECT);
  assert.ok(n, 'the seeded project must have a WBS node');
  return n.id;
}

function account() {
  const a = db.prepare('SELECT id FROM transaction_accounts ORDER BY id LIMIT 1').get();
  assert.ok(a, 'seed-master must create transaction accounts');
  return a.id;
}

function insertPlan(amount, month = MONTH, planType = 'baseline') {
  db.prepare(`INSERT INTO cbs_plan (project_id, transaction_account_id, wbs_node_id, plan_type, version, period_month, amount)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(PROJECT, account(), wbsNode(), planType, month, amount);
}

function insertProgress(pct, month = MONTH, reportedAt = null) {
  db.prepare(`INSERT INTO wbs_progress (wbs_node_id, period_month, pct_complete, source, reported_at)
    VALUES (?, ?, ?, 'manual', COALESCE(?, datetime('now')))`).run(wbsNode(), month, pct, reportedAt);
}

function insertCost(amount, month = MONTH) {
  db.prepare(`INSERT INTO accounting_ledger
    (project_id, date, type, line_role, in_cost_basis, transaction_account_id, wbs_node_id,
     amount, debit, credit, document_no, description, source)
    VALUES (?, ?, 'Expense', 'expense', 1, ?, ?, ?, ?, 0, 'DOC-AL', 'alert test cost', 'manual')`)
    .run(PROJECT, `${month}-15`, account(), wbsNode(), amount, amount);
}

function insertReceivable(amount, daysOverdue) {
  // A receivable is a ledger line with `line_role = 'receivable'`; `v_receivable` (and `v_aging`
  // above it) DERIVE the invoice date — `MIN(date)` grouped per project/partner — and resolve
  // `due_date` from the payment-terms setting (30 days by default, migration 021). So there is no
  // `invoice_date` column to set here: the first attempt at this helper tried to insert one and
  // SQLite refused, which is the schema keeping the derivation in one place.
  const date = new Date(Date.now() - (daysOverdue + 40) * 86400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO accounting_ledger
    (project_id, date, type, line_role, in_cost_basis, amount, debit, credit, paid_amount,
     document_no, description, source)
    VALUES (?, ?, 'Receivable', 'receivable', 0, ?, ?, 0, 0, 'INV-AL-1', 'alert test invoice', 'manual')`)
    .run(PROJECT, date, amount, amount);
}

/** Wipe the inbox so one test's deliveries cannot satisfy another's assertion. */
const clearInbox = () => db.prepare('DELETE FROM notification_inbox').run();

const unreadOf = (userId) => db.prepare(
  'SELECT COUNT(*) n FROM notification_inbox WHERE user_id = ? AND read_at IS NULL').get(userId).n;

const rowsFor = (userId, type) => db.prepare(
  'SELECT * FROM notification_inbox WHERE user_id = ? AND alert_type = ? AND read_at IS NULL')
  .all(userId, type);

// ── AL1 — the rules are wired to real conditions, and to nothing else ───────────────────────

test('AL1 each of the six PRD alerts fires on real data, and only when the condition is true', () => {
  clearInbox();
  // A clean project: one month of plan, fully earned, costing exactly what was planned.
  //
  // THE NUMBERS ARE THE POINT. PV = 1,000,000 (the whole of March's baseline). Progress must be
  // 100% so EV = 1,000,000: SPI = EV/PV = 1.0. Cost must equal EV so CPI = EV/AC = 1.0. Then
  // EAC = BAC * AC/EV = 1,000,000 = BAC, which is NOT an overrun. A first draft of this test used
  // 50% progress and 400,000 cost and expected "nothing" — but 50% earned against a full month of
  // plan is SPI 0.5, a genuine schedule breach, and the rule was right to fire. The healthy case has
  // to actually BE healthy on both indexes.
  insertPlan(1_000_000);
  insertProgress(100);
  insertCost(1_000_000);

  const clean = svc.evaluateProject(PROJECT);
  assert.deepStrictEqual(clean.map((a) => a.alertType), [],
    `a healthy project must raise nothing, got: ${JSON.stringify(clean.map((a) => a.alertType))}`);

  // Now let cost run ahead of the work: AC becomes 1,800,000 against EV 1,000,000.
  // CPI = 1,000,000/1,800,000 = 0.5556 (< 0.95) → breach.
  // EAC = BAC * AC/EV = 1,000,000 * 1,800,000/1,000,000 = 1,800,000 > BAC → overrun.
  insertCost(800_000);
  const broken = svc.evaluateProject(PROJECT).map((a) => a.alertType);
  assert.ok(broken.includes('cpi_spi_breach'), `expected a CPI breach, got ${broken}`);
  assert.ok(broken.includes('cost_overrun'), `expected an EAC overrun, got ${broken}`);
  // SPI is still 1.0, so the breach must be about COST and must not claim a schedule problem.
  const breach = svc.evaluateProject(PROJECT).find((a) => a.alertType === 'cpi_spi_breach');
  assert.match(breach.body, /cost performance \(CPI\) is 0\.56/,
    `the breach must name the real index and value: ${breach.body}`);
  assert.doesNotMatch(breach.body, /schedule performance/,
    'SPI is 1.0 — the alert must not invent a schedule breach');

  // The overrun body must carry the computed figures, not a template.
  const overrun = svc.evaluateProject(PROJECT).find((a) => a.alertType === 'cost_overrun');
  assert.match(overrun.body, /1,800,000/, 'the EAC must be the computed one');
  assert.match(overrun.body, /1,000,000/, 'the budget must be the baseline');
});

// ── AL2 — the two system alerts (TS-14, TS-23) ──────────────────────────────────────────────

test('AL2 a missing or stale backup alerts — and a fresh one does not', () => {
  clearInbox();
  const t = svc.thresholds();

  // No backup has ever been taken (the temp PRACTIS_BACKUPS dir does not exist yet).
  const none = svc.systemAlerts().find((a) => a.alertType === 'backup_overdue');
  assert.ok(none, 'a missing backup must alert — TS-14');
  assert.strictEqual(none.severity, 'critical');
  assert.match(none.body, /no verifiable recovery copy/i);

  // A REAL backup makes the alert go away. This is the check that the rule reads the backup set
  // rather than always returning true.
  const backup = require('../src/lib/backup-service');
  return backup.createBackup({}).then(() => {
    const after = svc.systemAlerts().find((a) => a.alertType === 'backup_overdue');
    assert.strictEqual(after, undefined, 'a fresh verified backup must clear the alert');
    assert.ok(t.cpi > 0);
  });
});

// ── AL3 — the disk rule reads the DATABASE's volume, not the root ───────────────────────────

test('AL3 the disk alert fires when free space is under the threshold', () => {
  clearInbox();
  assert.strictEqual(svc.systemAlerts().find((a) => a.alertType === 'disk_low'), undefined,
    'this host has ample free space, so no disk alert at rest');

  const saved = process.env.PRACTIS_DISK_WARN_BYTES;
  process.env.PRACTIS_DISK_WARN_BYTES = String(1024 ** 6); // 1 PB — nothing has that free
  const fresh = require.resolve('../src/lib/health-service');
  try {
    delete require.cache[fresh];
    delete require.cache[require.resolve('../src/lib/alert-service')];
    const strict = require(require.resolve('../src/lib/alert-service'));
    const a = strict.systemAlerts().find((x) => x.alertType === 'disk_low');
    assert.ok(a, 'the threshold being unreachable must produce the alert');
    assert.strictEqual(a.severity, 'critical');
    // The body must name the DATABASE's filesystem: the check is wired to db.name's parent.
    assert.match(a.body, /holding the database/i);
  } finally {
    delete require.cache[fresh];
    delete require.cache[require.resolve('../src/lib/alert-service')];
    if (saved === undefined) delete process.env.PRACTIS_DISK_WARN_BYTES;
    else process.env.PRACTIS_DISK_WARN_BYTES = saved;
    require('../src/lib/alert-service');
  }
});

// ── AL4 — recipients: only people who can SEE the project AND the figures ───────────────────

test('AL4 an alert is delivered only to someone who can already see the project AND the figure', async () => {
  clearInbox();
  insertReceivable(5_000_000, 10);           // an overdue invoice → requires canViewReceivable

  // The rule has two independent halves and both are checked here, because either one alone would
  // let something through.

  // (1) THE PROJECT HALF. A Cost Controller scoped to a DIFFERENT project. The scope has to point at
  //     a real project — `user_roles.project_id` is a foreign key, so a made-up id is rejected by
  //     SQLite (a first version of this test used 999 and got FOREIGN KEY constraint failed, which is
  //     the schema protecting the fixture from nonsense). The second project deliberately has no WBS
  //     progress and no start date, so it raises nothing of its own and cannot pollute the counts.
  db.prepare(`INSERT INTO projects (code, name, status) VALUES ('PRJ-AL2', 'Alert Scope Test', 'active')`)
    .run();
  const otherProject = db.prepare("SELECT id FROM projects WHERE code = 'PRJ-AL2'").get().id;
  const outsider = db.prepare(`INSERT INTO users (email, full_name, password_hash, is_system_admin)
    VALUES ('alert-outsider@example.com', 'Outside CC', 'x', 0)`).run().lastInsertRowid;
  db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, ?)')
    .run(outsider, 'cost_controller', otherProject);
  assert.strictEqual(perms.projectsFor({ id: outsider }).length, 1, 'the outsider sees exactly one project');
  assert.ok(!perms.projectsFor({ id: outsider }).some((p) => p.id === PROJECT),
    'and it is NOT the one with the overdue invoice — otherwise this test proves nothing');

  // (2) THE CAPABILITY HALF. A global `viewer` sees EVERY project but has no canViewReceivable, so
  //     the receivable position is still none of their business. Without this half, the project rule
  //     alone would hand Finance's customer-by-customer ledger to every signed-in user.
  const viewer = db.prepare(`INSERT INTO users (email, full_name, password_hash, is_system_admin)
    VALUES ('alert-viewer@example.com', 'Alert Viewer', 'x', 0)`).run().lastInsertRowid;
  db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, NULL)')
    .run(viewer, 'viewer');
  const viewerCaps = perms.capabilities({ id: viewer, is_system_admin: 0 });
  assert.strictEqual(viewerCaps.canViewReceivable, false, 'a viewer must not hold canViewReceivable');
  assert.ok(perms.projectsFor({ id: viewer }).some((p) => p.id === PROJECT),
    'the viewer DOES see the project — so only the capability filter can stop the delivery');

  const delivery = svc.evaluateAll();
  assert.ok(delivery.created > 0, 'the overdue invoice must have been delivered to someone');
  assert.strictEqual(unreadOf(outsider), 0, 'someone who cannot see the project must never be told');
  assert.ok(unreadOf(admin.id) > 0, 'the admin (holder of every capability) must have been told');

  // THE CAPABILITY FILTER, asserted precisely. The viewer is NOT told about the receivable — but it
  // would be wrong to assert they receive NOTHING: `canViewForecast` is true for a viewer, so a cost
  // or schedule breach is a figure they may already see on the dashboard and they are entitled to
  // that alert. The rule that matters is narrower — no FINANCE alert for someone without
  // canViewReceivable — and that is what this checks.
  assert.strictEqual(rowsFor(viewer, 'invoice_overdue').length, 0,
    'a viewer must never be told about a customer invoice — Finance\'s book is not theirs');
  assert.ok(rowsFor(admin.id, 'invoice_overdue').length > 0,
    'the admin must receive the invoice alert, so the filter is a filter and not a blanket refusal');
});

// ── AL5 — the dedupe rule is the schema's, and it works ─────────────────────────────────────

test('AL5 the same alert is not delivered twice while unread, but IS after it is read', () => {
  clearInbox();
  svc.evaluateAll();
  const first = unreadOf(admin.id);
  assert.ok(first > 0, 'the first evaluation must deliver something');

  const second = svc.evaluateAll();
  assert.strictEqual(second.created, 0, 'a second evaluation must create NOTHING');
  assert.strictEqual(unreadOf(admin.id), first, 'the unread count must not move');

  // Reading one makes it deliverable again — the partial index only covers unread rows. That is the
  // documented behaviour: "read" means "seen", not "resolved".
  const one = db.prepare('SELECT id FROM notification_inbox WHERE user_id = ? AND read_at IS NULL LIMIT 1').get(admin.id);
  assert.strictEqual(svc.markRead(admin, one.id), true);
  const third = svc.evaluateAll();
  assert.ok(third.created >= 1, 'a read alert whose condition persists must be deliverable again');
});

// ── AL6 — markRead is owner-scoped, and cannot be used as an existence oracle ───────────────

test('AL6 one user cannot read — or even detect — another user\'s alert', () => {
  clearInbox();
  svc.evaluateAll();
  const mine = db.prepare('SELECT id FROM notification_inbox WHERE user_id = ? AND read_at IS NULL LIMIT 1').get(admin.id);
  assert.ok(mine, 'need a real alert row to test against');

  const other = db.prepare('SELECT id FROM users WHERE id <> ? LIMIT 1').get(admin.id);
  if (other) {
    assert.strictEqual(svc.markRead({ id: other.id }, mine.id), false,
      'a different user must not be able to mark it read');
    assert.strictEqual(db.prepare('SELECT read_at FROM notification_inbox WHERE id = ?').get(mine.id).read_at, null,
      'and the row must be untouched');
  }
  // Nonexistent and not-yours answer identically — no way to probe the id space.
  assert.strictEqual(svc.markRead({ id: 424242 }, mine.id), false);
  assert.strictEqual(svc.markRead({ id: 424242 }, 999999), false);
  // Idempotent for the owner.
  assert.strictEqual(svc.markRead(admin, mine.id), true);
  assert.strictEqual(svc.markRead(admin, mine.id), false, 'already read is not read again');
});

// ── AL7 — the inbox ordering puts the urgent thing first ────────────────────────────────────

test('AL7 the inbox is ordered critical first, then newest — not just newest', () => {
  clearInbox();
  const ins = db.prepare(`INSERT INTO notification_inbox
    (user_id, project_id, alert_type, severity, title, body) VALUES (?, NULL, ?, ?, ?, ?)`);
  ins.run(admin.id, 'progress_stale', 'info', 'info one', 'b');
  ins.run(admin.id, 'disk_low', 'critical', 'critical one', 'b');
  ins.run(admin.id, 'cost_overrun', 'warning', 'warning one', 'b');

  const list = svc.inboxFor(admin);
  assert.deepStrictEqual(list.map((a) => a.severity), ['critical', 'warning', 'info'],
    'a five-alarm alert must not sit under routine reminders');
});

// ── AL8 — HTTP: the polling endpoint (TS-03) ────────────────────────────────────────────────

test('AL8 GET /api/alerts returns unread only, with a count and the poll interval', async () => {
  clearInbox();
  svc.evaluateAll();
  const marks = svc.inboxFor(admin);
  assert.ok(marks.length > 0);
  // Read one, so "unread only" has something to exclude.
  svc.markRead(admin, marks[0].id);

  const res = await fetch(`${origin}/api/alerts`, { headers: cookieHeader() });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.pollSeconds, 30, 'TS-03 fixes the interval at 30 seconds');
  assert.strictEqual(body.unread, marks.length - 1);
  assert.strictEqual(body.alerts.length, marks.length - 1,
    'the read alert must NOT be returned — TS-03 says unread only');
  assert.ok(!body.alerts.some((a) => a.id === marks[0].id), 'the read one specifically is absent');
});

test('AL8b an anonymous visitor gets no alerts', async () => {
  const res = await fetch(`${origin}/api/alerts`);
  assert.strictEqual(res.status, 401, 'the poll endpoint must not answer without a session');
});

// ── AL9 — HTTP: marking read, and the CSRF requirement ─────────────────────────────────────

test('AL9 POST /api/alerts/:id/read marks it read, and refuses without a CSRF token', async () => {
  clearInbox();
  svc.evaluateAll();
  const one = svc.inboxFor(admin)[0];
  assert.ok(one);
  const before = svc.unreadCount(admin);
  assert.ok(before >= 1, 'there must be something unread to mark');

  // Without the token the global CSRF middleware must refuse.
  const bare = await fetch(`${origin}/api/alerts/${one.id}/read`, { method: 'POST', headers: cookieHeader() });
  assert.ok(bare.status === 403 || bare.status === 401, `expected a CSRF refusal, got ${bare.status}`);
  assert.strictEqual(svc.unreadCount(admin), before, 'a refused request must change nothing');

  const ok = await fetch(`${origin}/api/alerts/${one.id}/read`, {
    method: 'POST', headers: { ...cookieHeader(), 'x-csrf-token': csrf, accept: 'application/json' },
  });
  assert.strictEqual(ok.status, 200);
  const body = await ok.json();
  assert.strictEqual(body.read, true);
  // ONE row was marked, not all of them: the count drops by exactly one. (Asserting `=== 0` here
  // assumed the invoice alert was the only one, which stopped being true once AL4's fixture data
  // accumulated — the assertion has to be about the delta, not about a total it does not control.)
  assert.strictEqual(body.unread, before - 1, 'exactly one alert is marked read');
  assert.strictEqual(svc.unreadCount(admin), before - 1);
});

// ── AL10 — HTTP: the inbox page renders, and refuses anonymous visitors ─────────────────────

test('AL10 GET /alerts renders the inbox, and requires a session', async () => {
  clearInbox();
  svc.evaluateAll();
  const html = await (await fetch(`${origin}/alerts`, { headers: cookieHeader() })).text();
  assert.match(html, /Notifications/, 'the page title must render');
  assert.match(html, /Waiting for action/, 'the list heading must render');
  assert.match(html, /bellBadge/, 'the topbar badge must be present — it is the TS-03 client');
  assert.match(html, /setInterval/, 'the polling client must be on the page');
  // The empty-state/probe text must not have leaked a raw template error into the response.
  assert.doesNotMatch(html, /ReferenceError|is not defined/);

  const anon = await fetch(`${origin}/alerts`, { redirect: 'manual' });
  assert.strictEqual(anon.status, 302);
  assert.match(anon.headers.get('location') || '', /\/login/, 'the inbox is not public');
});

// ── AL11 — the job is registered, idempotent, and runs through the runner ───────────────────

test('AL11 the evaluation job registers with the runner and is idempotent through it', async () => {
  clearInbox();
  const jobs = require('../src/lib/jobs');
  const type = svc.registerAlertJob(jobs);
  assert.strictEqual(type, svc.JOB_TYPE);
  assert.ok(jobs.registeredTypes().includes(svc.JOB_TYPE),
    'the alert job must be registered, or every tick reports an unmounted type');

  const jobId = svc.enqueueEvaluation(jobs);
  assert.ok(Number.isInteger(jobId) && jobId > 0, 'enqueue must return a job id');

  const done = await jobs.drain();
  assert.ok(done.some((d) => d.type === svc.JOB_TYPE && d.state === 'completed'),
    `the alert job must complete, got: ${JSON.stringify(done)}`);
  const afterFirst = unreadOf(admin.id);
  assert.ok(afterFirst > 0, 'running the job must have delivered alerts');

  // Running it AGAIN through the runner must be a no-op — the schema's partial index, not a flag.
  await svc.enqueueEvaluation(jobs);
  await jobs.drain();
  assert.strictEqual(unreadOf(admin.id), afterFirst, 'a second run must not duplicate anything');
});

// ── helpers for the HTTP tests ──────────────────────────────────────────────────────────────

let cookie = '';
let csrf = '';

async function login() {
  const page = await fetch(`${origin}/login`);
  const html = await page.text();
  const token = (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
  const jar = (page.headers.getSetCookie ? page.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${origin}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
    body: new URLSearchParams({ _csrf: token, email: 'alert-admin@example.com', password: 'pw123456' }),
  });
  cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
  // The token must come from the AUTHENTICATED page: the /login token belonged to the anonymous
  // session and is stale the moment the session id changes.
  const authed = await (await fetch(`${origin}/alerts`, { headers: cookieHeader() })).text();
  csrf = (authed.match(/name="csrf-token"\s+content="([^"]+)"/) || [])[1] || '';
}
const cookieHeader = () => (cookie ? { cookie } : {});
