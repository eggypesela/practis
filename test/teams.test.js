// TM4-series: team register (module 6, plan task 6.4, PRD §4.1 "Team register").
//
// WHAT THIS FILE EXISTS FOR
// A team is the register that is easiest to get wrong in a specific way: it is
// tempting to make a team grant access. It must not. PRD §4.1 says the Admin
// creates the team and its roles — the ROLE does the granting. So these tests pin:
//
//   1. MEMBERSHIP IS `users.team_id`. There is no junction table (schema line
//      546), so "add a member" is an assignment on the account, and moving a
//      member records BOTH ends in the audit trail.
//   2. A TEAM GRANTS NOTHING. There is no approval chain (it is not a register of
//      parties) and adding someone to a team must not touch `user_roles`.
//   3. IT IS AN ADMINISTRATOR ACT. A Project Manager is refused.
//   4. INVITATIONS REUSE THE EXISTING PATH. `invites.sendInvite` is called, not
//      re-implemented — a second invite path is a second place for token and
//      expiry rules to drift.
//
// Every deny-case asserts the DATABASE, not a status code.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3912;

let dbPath, proc, db, admin, pm, viewer;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-teams-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'e@example.com', 'epw12345'], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });

  admin = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  db = new (require('better-sqlite3'))(dbPath);

  const { asRole } = require('./helpers/authz');
  pm = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { email: 'tm4-pm@example.test' });
  viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'tm4-viewer@example.test' });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const teamCount = () => db.prepare('SELECT COUNT(*) n FROM teams').get().n;
const byCode = (code) => db.prepare('SELECT * FROM teams WHERE code = ?').get(code);
const teamById = (id) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
const teamAudit = (id) => db.prepare(
  `SELECT * FROM audit_log WHERE entity_type='team' AND entity_id=? ORDER BY id`).all(id);
const teamOfUser = (id) => db.prepare('SELECT team_id FROM users WHERE id = ?').get(id).team_id;
const roleCount = (id) => db.prepare('SELECT COUNT(*) n FROM user_roles WHERE user_id = ?').get(id).n;

const form = (over = {}) => new URLSearchParams({ code: 'TM-4001', name: 'Cost Engineering', ...over }).toString();

// ---- TM4.1-TM4.3 creation ----
test('TM4.1 creating a team writes the row and an audit event', async () => {
  const res = await admin.post('/admin/teams', form());
  assert.strictEqual(res.status, 302, 'redirects to the new roster');

  const row = byCode('TM-4001');
  assert.ok(row, 'the team exists');
  assert.strictEqual(row.name, 'Cost Engineering');
  assert.strictEqual(row.active, 1);
  assert.strictEqual(teamAudit(row.id).filter((a) => a.action === 'create').length, 1);
});

test('TM4.2 a duplicate team code is refused and nothing is written', async () => {
  const before = teamCount();
  const res = await admin.post('/admin/teams', form({ name: 'Copy' }));
  assert.ok(res.status >= 400, 'refused');
  assert.strictEqual(teamCount(), before);
});

test('TM4.3 a team needs a name', async () => {
  const before = teamCount();
  const res = await admin.post('/admin/teams', form({ code: 'TM-4002', name: '   ' }));
  assert.strictEqual(res.status, 400);
  assert.strictEqual(teamCount(), before);
  assert.strictEqual(byCode('TM-4002'), undefined);
});

// ---- TM4.4 the screens ----
test('TM4.4 the team list and roster render', async () => {
  const list = await admin.get('/admin/teams');
  assert.strictEqual(list.status, 200);
  assert.ok((await list.text()).includes('TM-4001'), 'the team is listed');

  const row = byCode('TM-4001');
  const roster = await admin.get(`/admin/teams/${row.id}`);
  assert.strictEqual(roster.status, 200);
  const html = await roster.text();
  assert.ok(html.includes('Cost Engineering'), 'the roster shows the team');
  assert.ok(html.includes('Members'), 'and its members section');
});

test('TM4.5 an unknown team id gives a 404 page', async () => {
  const res = await admin.get('/admin/teams/999999');
  assert.strictEqual(res.status, 404);
  assert.ok((await res.text()).includes('Not found'));
});

test('TM4.6 anonymous visitors cannot reach the team screens', async () => {
  const { client } = require('./helpers/csrf');
  const anon = client(ORIGIN);
  const res = await anon.get('/admin/teams');
  assert.strictEqual(res.status, 302, 'redirected to sign in');
});

// ---- TM4.7-TM4.10 membership ----
test('TM4.7 assigning an existing account sets users.team_id and audits it', async () => {
  const team = byCode('TM-4001');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('tm4-pm@example.test');
  assert.strictEqual(teamOfUser(target.id), null, 'starts with no team');

  const res = await admin.post(`/admin/teams/${team.id}/members`,
    new URLSearchParams({ user_id: String(target.id) }).toString());
  assert.strictEqual(res.status, 302);
  assert.strictEqual(teamOfUser(target.id), team.id, 'the account now belongs to the team');

  const added = teamAudit(team.id).find((a) => a.action === 'member_added');
  assert.ok(added, 'the assignment is audited');
  assert.strictEqual(JSON.parse(added.after_json).team, 'TM-4001');
});

test('TM4.8 adding someone already in the team is refused and changes nothing', async () => {
  const team = byCode('TM-4001');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('tm4-pm@example.test');
  const before = teamAudit(team.id).filter((a) => a.action === 'member_added').length;

  const res = await admin.post(`/admin/teams/${team.id}/members`,
    new URLSearchParams({ user_id: String(target.id) }).toString());
  assert.strictEqual(res.status, 302, 'the screen reports it, it does not crash');
  assert.strictEqual(teamOfUser(target.id), team.id, 'still exactly one assignment');
  assert.strictEqual(teamAudit(team.id).filter((a) => a.action === 'member_added').length, before,
    'no second audit row');
});

test('TM4.9 moving a member records BOTH the old and the new team', async () => {
  // A second team, then move the PM into it.
  await admin.post('/admin/teams', form({ code: 'TM-4003', name: 'Planning' }));
  const first = byCode('TM-4001');
  const second = byCode('TM-4003');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('tm4-pm@example.test');

  const res = await admin.post(`/admin/teams/${second.id}/members`,
    new URLSearchParams({ user_id: String(target.id) }).toString());
  assert.strictEqual(res.status, 302);
  assert.strictEqual(teamOfUser(target.id), second.id, 'the account moved');

  const moved = teamAudit(second.id).find((a) => a.action === 'member_added');
  const after = JSON.parse(moved.after_json);
  assert.strictEqual(after.team, 'TM-4003', 'the new team');
  assert.strictEqual(moved.before_json && JSON.parse(moved.before_json).team, 'TM-4001',
    'and the team they came from, so "who was where when" stays readable');
  assert.notStrictEqual(first.id, second.id);
});

test('TM4.10 removing a member clears the assignment and keeps the account', async () => {
  const second = byCode('TM-4003');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('tm4-pm@example.test');
  const rolesBefore = roleCount(target.id);

  const res = await admin.post(`/admin/teams/${second.id}/members/${target.id}/remove`, '');
  assert.strictEqual(res.status, 302);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  assert.ok(user, 'the account still exists');
  assert.strictEqual(user.team_id, null, 'the team assignment is cleared');
  assert.strictEqual(roleCount(target.id), rolesBefore,
    'roles are untouched — membership and permission are separate');

  const removed = teamAudit(second.id).find((a) => a.action === 'member_removed');
  assert.ok(removed, 'the removal is audited');
});

// ---- TM4.11 invite into a team (reusing the invite machinery) ----
test('TM4.11 inviting into a team creates the invitation AND the membership', async () => {
  const team = byCode('TM-4001');
  const res = await admin.post(`/admin/teams/${team.id}/invite`,
    new URLSearchParams({
      full_name: 'New Engineer', email: 'tm411-new@example.test', role_id: 'cost_controller',
    }).toString());
  assert.strictEqual(res.status, 302, 'the one-time link rides the redirect');

  const invited = db.prepare('SELECT * FROM users WHERE email = ?').get('tm411-new@example.test');
  assert.ok(invited, 'the account was created by the shared invite path');
  assert.strictEqual(invited.is_active, 0, 'pending until the invitation is accepted');
  assert.strictEqual(invited.team_id, team.id, 'and it belongs to the team in one step');

  const inv = db.prepare(
    `SELECT * FROM user_invitations WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`)
    .get('tm411-new@example.test');
  assert.ok(inv, 'a real invitation row exists');

  const audited = teamAudit(team.id).find((a) => a.action === 'member_invited');
  assert.ok(audited, 'the invitation is audited against the team');
});

// ---- TM4.12-TM4.14 authorization ----
test('TM4.12 a Project Manager cannot create a team', async () => {
  const before = teamCount();
  const res = await pm.client.post('/admin/teams', form({ code: 'TM-4004', name: 'Nope' }));
  assert.strictEqual(res.status, 403, 'Administrator-only');
  assert.strictEqual(teamCount(), before, 'nothing written');
  assert.strictEqual(byCode('TM-4004'), undefined);
});

test('TM4.13 a Project Manager cannot open the team screens', async () => {
  const res = await pm.client.get('/admin/teams');
  assert.strictEqual(res.status, 403);
});

test('TM4.14 a Viewer cannot add a member', async () => {
  const team = byCode('TM-4001');
  const target = db.prepare('SELECT id FROM users WHERE email = ?').get('tm4-viewer@example.test');
  const res = await viewer.client.post(`/admin/teams/${team.id}/members`,
    new URLSearchParams({ user_id: String(target.id) }).toString());
  assert.strictEqual(res.status, 403);
  assert.strictEqual(teamOfUser(target.id), null, 'the DATABASE is unchanged');
});

// ---- TM4.15 the rule that keeps a team from becoming a permission set ----
test('TM4.15 a team carries NO approval chain', async () => {
  const team = byCode('TM-4001');
  const rows = db.prepare(`SELECT COUNT(*) n FROM approvals WHERE entity_type='team'`).get().n;
  assert.strictEqual(rows, 0,
    'a team is an internal grouping, not a register of parties — it has no verify/approve steps');
  assert.ok(team, 'and it still exists as a team');
});

// ---- TM4.16 the code is set once ----
test('TM4.16 editing a team posts no code and cannot change it', async () => {
  const team = byCode('TM-4001');
  const res = await admin.post(`/admin/teams/${team.id}`,
    new URLSearchParams({ name: 'Cost Engineering (renamed)', active: '1' }).toString());
  assert.strictEqual(res.status, 302, 'the edit saved although no code was posted');
  assert.strictEqual(teamById(team.id).name, 'Cost Engineering (renamed)');

  await admin.post(`/admin/teams/${team.id}`,
    new URLSearchParams({ code: 'TM-HACKED', name: 'Cost Engineering (renamed)' }).toString());
  assert.strictEqual(teamById(team.id).code, 'TM-4001', 'the code is set once');
  assert.strictEqual(byCode('TM-HACKED'), undefined);
});
