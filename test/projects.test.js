// PR2-series: project register + approval workflow (module 6, plan task 6.2).
//
// WHAT THIS FILE EXISTS FOR
// Two rules that are easy to state and easy to get wrong:
//
//   1. APPROVAL IS DATA, not code (plan 6.5b). Which steps must be approved is a
//      list in the service; the chain itself is rows in `approvals`. The tests
//      assert the ROWS, because a boolean column would answer "approved?" but
//      could never say who, when or why.
//
//   2. SELF-APPROVAL NEEDS A REASON (owner decision 2026-10-01). A blanket
//      "approver ≠ requester" rule deadlocks a one-person install — the same
//      person creates and approves every project and there is no second user.
//      The rule is therefore "approving your own work requires a written reason
//      on the record", and the tests pin BOTH halves: refused without a reason,
//      allowed with one, and a different approver needs nothing.
//
// Every deny-case asserts the DATABASE (row counts), not a status code. The five
// authorization bugs found in the 2026-09-30 audit all answered 302/200 while
// writing, so a status-only assertion proves nothing.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3904;   // shared with PR1.* — same file, same server

let dbPath, proc, cookie, db;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
async function req(pathname, opts = {}) {
  return fetch(`${ORIGIN}${pathname}`, { redirect: 'manual', ...opts });
}
const { client } = require('./helpers/csrf');

let base;   // csrf-aware client, built in before()

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-projects-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'e@example.com', 'epw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  db = new (require('better-sqlite3'))(dbPath);
  db.prepare(`INSERT INTO projects (code, name, contract_amount, status, start_date, end_date)
              VALUES (?, ?, ?, 'active', '2026-03-01', '2027-12-31')`)
    .run('PRJ-2027', 'Merauke Access Road', 4_250_000_000);
  db.close();

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
  const cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;
  base = cli;
  db = new (require('better-sqlite3'))(dbPath);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const projectCount = () => db.prepare('SELECT COUNT(*) n FROM projects').get().n;
const byCode = (code) => db.prepare('SELECT * FROM projects WHERE code = ?').get(code);
const approvalsOf = (id) => db.prepare(
  `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? ORDER BY id`).all(id);
const auditOf = (id) => db.prepare(
  `SELECT * FROM audit_log WHERE entity_type='project' AND entity_id=? ORDER BY id`).all(id);

// A valid registration body. NOTE: `client.post()` takes a URL-encoded body
// STRING, not an object — an object stringifies to "[object Object]", the CSRF
// check fails, and the test sees a 403 that reads like an authorization bug.
const validForm = (over = {}) => new URLSearchParams({
  code: 'PRJ-3001', name: 'Test Bridge', revenue_method: 'milestone',
  contract_amount: '1000000', payment_terms_days: '30',
  start_date: '2026-05-01', end_date: '2027-05-01', ...over,
}).toString();

// ---- PR2.1 registration ----

test('PR2.1 a Project Admin can register a project; it starts not baselined and not approved', async () => {
  const { asRole } = require('./helpers/authz');
  const actor = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_admin',
    { email: 'pr21-admin@example.test' });

  const before = projectCount();
  const res = await actor.client.post('/projects', validForm({ code: 'PRJ-3001' }));
  assert.strictEqual(res.status, 302, 'a successful registration redirects to the register');

  assert.strictEqual(projectCount(), before + 1, 'exactly one project row was added');
  const p = byCode('PRJ-3001');
  assert.ok(p, 'the project exists');
  assert.strictEqual(p.baseline_locked, 0, 'PRD §4.1 step 6: created with no baseline');
  assert.strictEqual(p.created_by, actor.userId, 'the creator is recorded — approval depends on it');
  assert.strictEqual(p.revenue_method, 'milestone');
  assert.strictEqual(p.contract_amount, 1000000);

  // The chain is ROWS, not a boolean.
  const chain = approvalsOf(p.id);
  assert.strictEqual(chain.length, 4, 'every recorded step exists from the moment of registration');
  assert.ok(chain.every((r) => r.status === 'pending'), 'all start pending');
  // LIGHT chain (decision 8A): the required step is pm_approve, not the full
  // PRD three. Assert the required set through the service so the test fails if
  // someone flips the data without updating the doc.
  const svc = require('../src/lib/projects-service');
  assert.deepStrictEqual(svc.REQUIRED_STEPS.project, ['pm_approve'],
    'decision 8A is LIGHT: the PM approves');
});

test('PR2.2 the registration is audited and notifies an approver, not the actor', async () => {
  const p = byCode('PRJ-3001');
  const trail = auditOf(p.id);
  assert.strictEqual(trail.length, 1, 'one audit row for the create');
  assert.strictEqual(trail[0].action, 'create');

  // A notification must reach someone else. The actor is excluded in
  // `approverIds`, so if this is the ONLY user we expect zero rows — assert the
  // exclusion explicitly (the actor must never be told to approve their own work
  // with no hint that a reason is required).
  const notes = db.prepare('SELECT * FROM notification_inbox WHERE entity_id = ?').all(p.id);
  const actorId = p.created_by;
  assert.ok(!notes.some((n) => n.user_id === actorId),
    'the person who registered the project is not notified to approve it');
});

test('PR2.3 revenue method is required (PRD §4.1 step 5)', async () => {
  const before = projectCount();
  const res = await base.post('/projects', validForm({ code: 'PRJ-3002', revenue_method: '' }));
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /revenue recognition method is required/i);
  assert.strictEqual(projectCount(), before, 'nothing was written');
  assert.strictEqual(byCode('PRJ-3002'), undefined);
});

test('PR2.4 an invalid revenue method is refused with a sentence, not a SQL error', async () => {
  const before = projectCount();
  const res = await base.post('/projects', validForm({ code: 'PRJ-3003', revenue_method: 'whenever' }));
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /must be one of/i);
  assert.strictEqual(projectCount(), before);
});

test('PR2.5 the project code must be unique — 409, not a 500', async () => {
  const before = projectCount();
  const res = await base.post('/projects', validForm({ code: 'PRJ-3001' }));
  assert.strictEqual(res.status, 409, 'a duplicate code is a conflict, not a server error');
  assert.match(await res.text(), /already in use/i);
  assert.strictEqual(projectCount(), before, 'no second row');
});

test('PR2.6 an end date before the start date is refused', async () => {
  const before = projectCount();
  const res = await base.post('/projects',
    validForm({ code: 'PRJ-3004', start_date: '2027-01-01', end_date: '2026-01-01' }));
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /end date cannot fall before/i);
  assert.strictEqual(projectCount(), before);
});

test('PR2.7 payment terms, when given, must be a positive whole number of days', async () => {
  const before = projectCount();
  const bad = await base.post('/projects', validForm({ code: 'PRJ-3005', payment_terms_days: '0' }));
  assert.strictEqual(bad.status, 400);
  assert.match(await bad.text(), /positive number of days/i);
  assert.strictEqual(projectCount(), before);
});

// ---- PR2.8 authorization on the write path ----

test('PR2.8 a Viewer cannot register a project (403 AND no row written)', async () => {
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'pr28-viewer@example.test' });

  const before = projectCount();
  const res = await viewer.client.post('/projects', validForm({ code: 'PRJ-3006' }));
  assert.strictEqual(res.status, 403, '403 with a reason, not a hidden link');
  assert.strictEqual(projectCount(), before, '*** the row count is the real assertion ***');
  assert.strictEqual(byCode('PRJ-3006'), undefined);
});

test('PR2.9 a Cost Controller cannot register a project either (not in PRD §4.1)', async () => {
  const { asRole } = require('./helpers/authz');
  const cc = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'cost_controller',
    { email: 'pr29-cc@example.test' });
  const before = projectCount();
  const res = await cc.client.post('/projects', validForm({ code: 'PRJ-3007' }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(projectCount(), before);
});

// ---- PR2.10 the approval workflow ----

test('PR2.10 a different Project Manager can approve; the approvals row records who and when', async () => {
  const { asRole } = require('./helpers/authz');
  const approver = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr210-approver@example.test' });

  const p = byCode('PRJ-3001');
  const res = await approver.client.post(`/projects/${p.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 302, 'a different person needs no reason');

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).get(p.id);
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.actor_id, approver.userId, 'the approver is recorded');
  assert.ok(row.acted_at, 'and when');
});

test('PR2.11 approving is recorded in the audit trail', async () => {
  const p = byCode('PRJ-3001');
  const trail = auditOf(p.id);
  assert.strictEqual(trail.length, 2, 'create + approve');
  assert.strictEqual(trail[1].action, 'approve');
  const after = JSON.parse(trail[1].after_json);
  assert.strictEqual(after.step, 'pm_approve');
  assert.strictEqual(after.self_approved, false, 'this was a genuine second-person approval');
});

test('PR2.12 approving twice is refused (409) and does not add a second row', async () => {
  const { asRole } = require('./helpers/authz');
  const approver = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr212-approver@example.test' });
  const p = byCode('PRJ-3001');
  const res = await approver.client.post(`/projects/${p.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 409);
  const rows = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).all(p.id);
  assert.strictEqual(rows.length, 1, 'still exactly one approval row');
});

// ---- PR2.13 self-approval (the owner's decision) ----

test('PR2.13 the CREATOR cannot approve their own project without a reason', async () => {
  const { asRole } = require('./helpers/authz');
  // A PM registers their own project, then tries to approve it with no reason.
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr213-pm@example.test' });

  await pm.client.post('/projects', validForm({ code: 'PRJ-3010' }));
  const p = byCode('PRJ-3010');
  assert.strictEqual(p.created_by, pm.userId);

  const res = await pm.client.post(`/projects/${p.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 403, 'self-approval without a reason is refused');
  assert.match(await res.text(), /written reason/i);

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).get(p.id);
  assert.strictEqual(row.status, 'pending', '*** the database still says pending ***');
});

test('PR2.14 the CREATOR CAN approve their own project by giving a reason — and it is audited', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr214-pm@example.test' });

  await pm.client.post('/projects', validForm({ code: 'PRJ-3011' }));
  const p = byCode('PRJ-3011');

  const reason = 'Only operator on this install; verified the contract myself.';
  const res = await pm.client.post(`/projects/${p.id}/approve`,
    `reason=${encodeURIComponent(reason)}`);
  assert.strictEqual(res.status, 302, 'a justified self-approval goes through');

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).get(p.id);
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.actor_id, pm.userId);
  assert.strictEqual(row.comment, reason, 'the reason is stored on the approval itself');

  // And on the audit trail, which is the part that actually answers "why?".
  const trail = auditOf(p.id);
  const approve = trail.find((t) => t.action === 'approve');
  const after = JSON.parse(approve.after_json);
  assert.strictEqual(after.self_approved, true, 'flagged as a self-approval');
  assert.strictEqual(after.reason, reason, 'with the justification attached');
});

test('PR2.15 a one-character reason is not enough (the rule is a real speed bump)', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr215-pm@example.test' });
  await pm.client.post('/projects', validForm({ code: 'PRJ-3012' }));
  const p = byCode('PRJ-3012');

  const res = await pm.client.post(`/projects/${p.id}/approve`, 'reason=ok');
  assert.strictEqual(res.status, 403);
  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).get(p.id);
  assert.strictEqual(row.status, 'pending');
});

test('PR2.16 a Viewer cannot approve anything (403 and still pending)', async () => {
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'pr216-viewer@example.test' });
  const p = byCode('PRJ-3010');
  const res = await viewer.client.post(`/projects/${p.id}/approve`,
    `reason=${encodeURIComponent('a plausible looking reason')}`);
  assert.strictEqual(res.status, 403);
  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='project' AND entity_id=? AND step='pm_approve'`).get(p.id);
  assert.strictEqual(row.status, 'pending');
});

// ---- PR2.17 edit ----

test('PR2.17 editing a project is audited and cannot change its code', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr217-pm@example.test' });
  const p = byCode('PRJ-3011');

  // NOTE: no `code` in this body, on purpose. The edit view renders the code
  // read-only AND disabled, so a BROWSER DOES NOT SUBMIT IT. A test that posts a
  // code would pass while every real edit through the UI failed — which is
  // exactly what happened before this assertion was corrected.
  const res = await pm.client.post(`/projects/${p.id}`,
    'name=Renamed+Bridge&revenue_method=poc&contract_amount=2000000&status=active');
  assert.strictEqual(res.status, 302);

  const after = byCode('PRJ-3011');
  assert.ok(after, 'the code is unchanged — it is the human key for this project');
  assert.strictEqual(after.name, 'Renamed Bridge');
  assert.strictEqual(after.revenue_method, 'poc');

  const trail = auditOf(p.id);
  assert.ok(trail.some((t) => t.action === 'update'), 'the edit is audited');
});

test('PR2.17b a submitted code is IGNORED on edit (the column is not updatable)', async () => {
  // The other half of the same rule: a crafted POST cannot rename the key.
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr217b-pm@example.test' });
  const p = byCode('PRJ-3011');
  await pm.client.post(`/projects/${p.id}`, 'name=Renamed+Bridge&revenue_method=poc&code=HACKED');
  assert.strictEqual(byCode('HACKED'), undefined, 'a posted code never renames the project');
  assert.ok(byCode('PRJ-3011'), 'and the original code still works');
});

// ---- PR2.18 the register surfaces approval state ----

test('PR2.18 the register shows which projects are awaiting approval', async () => {
  const res = await base.get('/projects');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Awaiting approval/i,
    'the register must show the approval state it manages');
  assert.match(html, /not approved|Awaiting|pending/i);
});

test('PR2.19 the register does not offer Register/Approve to a Viewer', async () => {
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'pr219-viewer@example.test' });
  const res = await viewer.client.get('/projects');
  const html = await res.text();
  assert.doesNotMatch(html, /href="\/projects\/new"/, 'no Register button for a Viewer');
});

// ===========================================================================
// PR1-series: the portfolio register itself (module 6, plan task 6.1).
// Kept in this file because both series drive the same routes and share one
// server/DB; the port is the same 3904.
// ===========================================================================

test('PR1.1 GET /projects renders the portfolio register (was 404)', async () => {
  const res = await req('/projects', { headers: { cookie } });
  assert.strictEqual(res.status, 200, 'the sidebar links /projects on every page — it must not 404');
  const html = await res.text();
  assert.match(html, /PRJ-2026/, 'the seeded project code is listed');
  assert.match(html, /Citarum Bridge/, 'and its name');
  assert.match(html, /PRJ-2027/, 'and every other project the user may see');
});

test('PR1.2 the register shows each project with its contract value and baseline state', async () => {
  const res = await req('/projects', { headers: { cookie } });
  const html = await res.text();
  assert.match(html, /12\.480\.000\.000/, 'contract amount is rendered grouped, not raw');
  assert.match(html, /not baselined|Not baselined|no baseline/i,
    'an un-baselined project is labelled, not silently blank (EVM depends on this)');
});

test('PR1.3 the page follows the house UI contract (title + muted subtitle)', async () => {
  const res = await req('/projects', { headers: { cookie } });
  const html = await res.text();
  // Every app page renders through layout-app's `.hd` block: an <h1> title plus
  // a muted sub-title <p>. (`.sub` exists only on the auth pages, which use a
  // different layout — asserting it here would test a class this layout never
  // emits.)
  assert.match(html, /<div class="hd">\s*<div><h1>Projects<\/h1><p>[^<]+<\/p>/,
    'title and a non-empty sub-title, in the shared header block');
});

test('PR1.4 the sidebar switcher offers every authorised project as a real link', async () => {
  const res = await req('/', { headers: { cookie } });
  const html = await res.text();
  const p1 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2026'`).get().id;
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  assert.match(html, new RegExp(`href="/\\?project=${p1}"`), 'first project is a link, not a dead button');
  assert.match(html, new RegExp(`href="/\\?project=${p2}"`), 'second project too');
});

test('PR1.5 anonymous GET /projects is sent to /login, not rendered', async () => {
  const res = await req('/projects');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location') || '', /\/login/);
});

test('PR1.6 a project-scoped user sees ONLY their assigned project', async () => {
  // The scope layer's job. Asserted as DATA: which codes render, and which do
  // NOT — a status-only test would pass on a page that leaked everything.
  const { asRole } = require('./helpers/authz');
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  const scoped = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { projectId: p2, email: 'pr16-scoped@example.test' });

  const res = await scoped.client.get('/projects');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /PRJ-2027/, 'their own project is listed');
  assert.doesNotMatch(html, /Citarum Bridge/, 'and the project they are NOT on is not');
});

test('PR1.7 the register counts what it shows (no whole-portfolio query leaking in)', async () => {
  // A scoped user's page must not be built from q.projects() — the whole-
  // portfolio query. Same class of bug as the dashboard leak (audit BOLA).
  const { asRole } = require('./helpers/authz');
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  const scoped = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { projectId: p2, email: 'pr17-scoped@example.test' });

  const res = await scoped.client.get('/projects');
  const html = await res.text();
  const rows = (html.match(/PRJ-20\d\d/g) || []).length;
  assert.strictEqual(rows, 1, `exactly one project row for a one-project user (saw ${rows})`);
});


// ===========================================================================
// PR3-series: the CLIENT register (module 6, plan task 6.3).
//
// WHAT THESE TESTS ARE ACTUALLY GUARDING
// Two things, and the second is the one that matters.
//
// 1. The client register works: create, edit, validate, approve.
//
// 2. **The approval control behaves IDENTICALLY to the project register.** Task
//    6.2 put the segregation-of-duties rule inside the project service; 6.3
//    extracted it into `approvals-service.js` so both registers share ONE copy.
//    The plan's own note for 6.5b says to keep "requester ≠ approver" in all
//    cases — taken literally that deadlocks a one-person install, which is why
//    the owner's decision (2026-10-01) is "self-approval allowed WITH a written
//    reason". PR3.5/PR3.6 pin both halves for clients, exactly as PR2.13/PR2.14
//    do for projects. If someone later "fixes" one register and not the other,
//    one of these pairs fails.
// ===========================================================================

const clientCount = () => db.prepare('SELECT COUNT(*) n FROM clients').get().n;
const clientByCode = (code) => db.prepare('SELECT * FROM clients WHERE code = ?').get(code);
const clientApprovals = (id) => db.prepare(
  `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? ORDER BY id`).all(id);
const clientAudit = (id) => db.prepare(
  `SELECT * FROM audit_log WHERE entity_type='client' AND entity_id=? ORDER BY id`).all(id);

// `client.post()` takes a URL-encoded body STRING (see validForm above).
const clientForm = (over = {}) => new URLSearchParams({
  code: 'CL-3001', name: 'Test Client Bhd', payment_terms_days: '30',
  email: 'ap@testclient.example', correspondence_person: 'A Person',
  ...over,
}).toString();

test('PR3.1 a client can be registered; it starts NOT approved with the full chain recorded', async () => {
  const { asRole } = require('./helpers/authz');
  const actor = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance',
    { email: 'pr31-finance@example.test' });

  const before = clientCount();
  const res = await actor.client.post('/clients', clientForm());
  assert.strictEqual(res.status, 302, 'a successful registration redirects');

  assert.strictEqual(clientCount(), before + 1);
  const c = clientByCode('CL-3001');
  assert.ok(c, 'the client exists');
  assert.strictEqual(c.created_by, actor.userId, 'the creator is recorded — approval depends on it');
  assert.strictEqual(c.payment_terms_days, 30);

  const chain = clientApprovals(c.id);
  assert.strictEqual(chain.length, 3, 'every RECORDED step exists from the moment of registration');
  assert.ok(chain.every((r) => r.status === 'pending'), 'all start pending');
  const svc = require('../src/lib/approvals-service');
  assert.deepStrictEqual(svc.REQUIRED_STEPS.client, ['pm_approve'],
    'decision 8A is LIGHT for clients too');
});

test('PR3.2 registering a client is audited and does not notify the actor', async () => {
  const c = clientByCode('CL-3001');
  const trail = clientAudit(c.id);
  assert.strictEqual(trail.length, 1);
  assert.strictEqual(trail[0].action, 'create');

  const notes = db.prepare(
    `SELECT * FROM notification_inbox WHERE entity_type='client' AND entity_id = ?`).all(c.id);
  assert.ok(!notes.some((n) => n.user_id === c.created_by),
    'the person who registered the client is not notified to approve it');
});

test('PR3.3 a duplicate client code is 409, not a 500', async () => {
  const before = clientCount();
  const res = await base.post('/clients', clientForm({ code: 'CL-3001' }));
  assert.strictEqual(res.status, 409);
  assert.match(await res.text(), /already in use/i);
  assert.strictEqual(clientCount(), before);
});

test('PR3.4 payment terms must be a positive number of days when given', async () => {
  // A term of 0 or a negative value is meaningless data: it would mean "due the
  // day it was issued" or "already overdue when issued".
  const before = clientCount();
  for (const bad of ['0', '-5']) {
    const res = await base.post('/clients', clientForm({ code: `CL-X${bad}`, payment_terms_days: bad }));
    assert.strictEqual(res.status, 400, `terms=${bad} must be refused`);
    assert.match(await res.text(), /positive number of days/i);
  }
  assert.strictEqual(clientCount(), before, 'nothing was written');
});

test('PR3.5 a malformed email is refused with a sentence', async () => {
  const before = clientCount();
  const res = await base.post('/clients', clientForm({ code: 'CL-3003', email: 'not-an-address' }));
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /email address/i);
  assert.strictEqual(clientCount(), before);
});

test('PR3.6 a Viewer cannot register a client (403 AND no row written)', async () => {
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'pr36-viewer@example.test' });
  const before = clientCount();
  const res = await viewer.client.post('/clients', clientForm({ code: 'CL-3004' }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(clientCount(), before, '*** the row count is the real assertion ***');
  assert.strictEqual(clientByCode('CL-3004'), undefined);
});

// ---- PR3.7 the shared SoD control, for clients ----

test('PR3.7 the CREATOR cannot self-approve a client without a reason', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr37-pm@example.test' });
  await pm.client.post('/clients', clientForm({ code: 'CL-3010' }));
  const c = clientByCode('CL-3010');
  assert.strictEqual(c.created_by, pm.userId);

  const res = await pm.client.post(`/clients/${c.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 403, 'self-approval without a reason is refused');
  assert.match(await res.text(), /written reason/i);

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? AND step='pm_approve'`).get(c.id);
  assert.strictEqual(row.status, 'pending', '*** the database still says pending ***');
});

test('PR3.8 the CREATOR CAN self-approve a client WITH a reason, and it is audited', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr38-pm@example.test' });
  await pm.client.post('/clients', clientForm({ code: 'CL-3011' }));
  const c = clientByCode('CL-3011');

  const reason = 'Sole operator; confirmed the contract terms myself.';
  const res = await pm.client.post(`/clients/${c.id}/approve`, `reason=${encodeURIComponent(reason)}`);
  assert.strictEqual(res.status, 302);

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? AND step='pm_approve'`).get(c.id);
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.comment, reason);

  const trail = clientAudit(c.id);
  const approve = trail.find((t) => t.action === 'approve');
  const after = JSON.parse(approve.after_json);
  assert.strictEqual(after.self_approved, true);
  assert.strictEqual(after.reason, reason);
});

test('PR3.9 a DIFFERENT approver needs no reason', async () => {
  const { asRole } = require('./helpers/authz');
  const finance = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance',
    { email: 'pr39-finance@example.test' });
  await finance.client.post('/clients', clientForm({ code: 'CL-3012' }));
  const c = clientByCode('CL-3012');

  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr39-approver@example.test' });
  const res = await pm.client.post(`/clients/${c.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 302, 'a different person needs no justification');

  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? AND step='pm_approve'`).get(c.id);
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.actor_id, pm.userId);

  const trail = clientAudit(c.id);
  const after = JSON.parse(trail.find((t) => t.action === 'approve').after_json);
  assert.strictEqual(after.self_approved, false);
});

test('PR3.10 approving twice is 409 and adds no second row', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr310-pm@example.test' });
  const c = clientByCode('CL-3012');
  const res = await pm.client.post(`/clients/${c.id}/approve`, 'reason=');
  assert.strictEqual(res.status, 409);
  const rows = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? AND step='pm_approve'`).all(c.id);
  assert.strictEqual(rows.length, 1);
});

test('PR3.11 a Viewer cannot approve a client (403 and still pending)', async () => {
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'pr311-viewer@example.test' });
  const c = clientByCode('CL-3010');
  const res = await viewer.client.post(`/clients/${c.id}/approve`,
    `reason=${encodeURIComponent('a plausible looking reason')}`);
  assert.strictEqual(res.status, 403);
  const row = db.prepare(
    `SELECT * FROM approvals WHERE entity_type='client' AND entity_id=? AND step='pm_approve'`).get(c.id);
  assert.strictEqual(row.status, 'pending');
});

test('PR3.12 editing a client is audited and cannot change its code', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr312-pm@example.test' });
  const c = clientByCode('CL-3011');

  // No `code` in the body: the edit view renders it disabled, so a browser does
  // not submit it (same trap as PR2.17).
  const res = await pm.client.post(`/clients/${c.id}`,
    'name=Renamed+Client&payment_terms_days=45&active=1');
  assert.strictEqual(res.status, 302);

  const after = clientByCode('CL-3011');
  assert.ok(after, 'the code is unchanged — it is the human key for this client');
  assert.strictEqual(after.name, 'Renamed Client');
  assert.strictEqual(after.payment_terms_days, 45);
  assert.ok(clientAudit(c.id).some((t) => t.action === 'update'));

  // And a crafted code is ignored rather than honoured.
  await pm.client.post(`/clients/${c.id}`, 'name=Renamed+Client&payment_terms_days=45&code=HACKED');
  assert.strictEqual(clientByCode('HACKED'), undefined);
  assert.ok(clientByCode('CL-3011'));
});

test('PR3.12b editing a client through the REAL UI shape (no code posted) succeeds', async () => {
  // This is the regression guard for the bug PR2.17 masked: `validate()` required
  // `code` on update, but the disabled input is not submitted by a browser, so
  // every real edit failed with "A client code is required."
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr312b-pm@example.test' });
  await pm.client.post('/clients', clientForm({ code: 'CL-3013' }));
  const c = clientByCode('CL-3013');

  const res = await pm.client.post(`/clients/${c.id}`, 'name=Edited+Via+UI&payment_terms_days=15&active=1');
  assert.strictEqual(res.status, 302, 'a real edit must not be refused for a missing code');
  const after = clientByCode('CL-3013');
  assert.strictEqual(after.name, 'Edited Via UI');
  assert.strictEqual(after.payment_terms_days, 15);
});

test('PR3.13 a client can be deactivated rather than deleted (history stays readable)', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr313-pm@example.test' });
  const c = clientByCode('CL-3011');

  await pm.client.post(`/clients/${c.id}`, 'name=Renamed+Client&payment_terms_days=45&active=0');
  const after = clientByCode('CL-3011');
  assert.ok(after, 'the row still exists');
  assert.strictEqual(after.active, 0, 'deactivated, not deleted');
});

// ---- PR3.14 the register screens ----

test('PR3.14 GET /clients lists the register and the sidebar links to it', async () => {
  const res = await base.get('/clients');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /CL-3001/, 'registered clients are listed');
  assert.match(html, /Test Client Bhd/);
  assert.match(html, /Awaiting approval/i, 'the register surfaces the state it manages');
});

test('PR3.15 anonymous GET /clients is sent to /login, not rendered', async () => {
  const res = await req('/clients');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location') || '', /\/login/);
});

test('PR3.16 the client list is NOT filtered by the selected project', async () => {
  // Clients are org-wide master data: one client serves many projects. If this
  // list ever becomes project-scoped, a client registered under project A would
  // vanish when the operator switches to project B.
  const { asRole } = require('./helpers/authz');
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  const scoped = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { projectId: p2, email: 'pr316-scoped@example.test' });

  const res = await scoped.client.get('/clients');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /CL-3001/, 'every client is visible regardless of the project context');
});

// ---- PR3.17 the project form's client link ----

test('PR3.17 a project can be registered against a client, and the client name is shown', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr317-pm@example.test' });
  const c = clientByCode('CL-3001');

  const res = await pm.client.post('/projects',
    validForm({ code: 'PRJ-3100', client_id: String(c.id) }));
  assert.strictEqual(res.status, 302);

  const p = byCode('PRJ-3100');
  assert.strictEqual(p.client_id, c.id, 'the project records the client');

  const list = await base.get('/projects');
  const html = await list.text();
  assert.match(html, /Test Client Bhd/, 'the register shows the client name, not a blank or a raw id');
});

test('PR3.18 the project form offers the client terms as a default', async () => {
  const { asRole } = require('./helpers/authz');
  const pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'pr318-pm@example.test' });
  // Register a dedicated client rather than reusing another test's: PR3.13
  // deactivates CL-3011, and the prefill correctly offers only ACTIVE clients —
  // so borrowing it would make this test depend on execution order.
  await pm.client.post('/clients', clientForm({ code: 'CL-3018', payment_terms_days: '45' }));
  const c = clientByCode('CL-3018');
  assert.strictEqual(c.payment_terms_days, 45);

  const res = await pm.client.get('/projects/new');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // The prefill data ships as JSON next to the form; the field itself is filled
  // in by the nonce'd script so an operator's typed value is never clobbered.
  assert.match(html, /id="terms-by-client"/, 'the prefill source is present');
  assert.match(html, new RegExp(`"${c.id}":45`), "the client's terms are offered as the default");
});
