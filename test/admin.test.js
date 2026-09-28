// User administration + invitations (TS-01 §3.1, TS-17).
// Runs its own server and temp DB, like the other suites.
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

let dbPath, proc, db, admin;
const { client, loggedIn } = require('./helpers/csrf');
const policy = require('../src/lib/policy');

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
const tokenFrom = (html) => {
  const m = html.match(/name="_csrf" value="([^"]+)"/) || html.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
};
const userOf = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const inviteOf = (email) => db.prepare('SELECT * FROM user_invitations WHERE email = ?').get(email);
const auditActions = (entityId) => db.prepare(
  `SELECT action FROM audit_log WHERE entity_type='users' AND entity_id = ? ORDER BY id`).all(entityId).map((r) => r.action);
const activeSessions = (userId) => db.prepare(
  `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).run(userId) && db.prepare(
  `SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`).get(userId).n;

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-admin-')), 'test.db');
  process.env.PRACTIS_DB = dbPath; // in-process queries must hit the temp DB
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'admin@example.com', 'adminpass123'], env);

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
  admin = await loggedIn(ORIGIN, 'admin@example.com', 'adminpass123');

  // An active non-admin account, so the guard can be tested against a real session.
  const q = require('../src/db/queries');
  q.insertUser('staff@example.com', 'Staff Member', await policy.hashPassword('staffpass1234'));
  const staff = db.prepare(`SELECT id FROM users WHERE email='staff@example.com'`).get().id;
  q.setUserRole(staff, 'viewer', 1);
  q.setUserActive(true, staff);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- authorization ----

test('anonymous visitors cannot reach user administration', async () => {
  const anon = client(ORIGIN);
  const res = await anon.get('/admin/users');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/login$/);
});

test('a signed-in non-administrator gets 403, not the user list', async () => {
  const staff = await loggedIn(ORIGIN, 'staff@example.com', 'staffpass1234');
  const res = await staff.get('/admin/users');
  assert.strictEqual(res.status, 403);
  const html = await res.text();
  assert.doesNotMatch(html, /Invite a user/);
});

test('a non-administrator cannot post admin actions either', async () => {
  const staff = await loggedIn(ORIGIN, 'staff@example.com', 'staffpass1234');
  await staff.get('/admin/users'); // mint a token bound to this session
  const res = await staff.post('/admin/users', 'email=x@example.com&full_name=X&role=viewer');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(userOf('x@example.com'), undefined);
});

test('the administrator can open the user list and sees the seeded account', async () => {
  const res = await admin.get('/admin/users');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Invite a user/);
  assert.match(html, /admin@example\.com/);
});

test('the sidebar footer shows the real signed-in role, not a hardcoded one', async () => {
  const staff = await loggedIn(ORIGIN, 'staff@example.com', 'staffpass1234');
  const html = await (await staff.get('/')).text();
  const foot = html.match(/<div class="sb-foot">([\s\S]*?)<\/aside>/)[1];
  assert.match(foot, /Staff Member/, 'shows the user name');
  assert.match(foot, /Viewer/, 'shows their actual role');
  assert.doesNotMatch(foot, /Administrator/, 'must not claim a Viewer is an Administrator');
  assert.match(foot, /<div class="av">SM<\/div>/, 'initials derived from the user');
});

test('the Administration link is hidden from non-administrators', async () => {
  const staff = await loggedIn(ORIGIN, 'staff@example.com', 'staffpass1234');
  assert.doesNotMatch(await (await staff.get('/')).text(), /Users &amp; roles/);
  const page = await admin.get('/');
  assert.match(await page.text(), /Users &amp; roles/, 'still shown to an administrator');
});

test('the 403 page renders fully for the blocked user, not a blank shell', async () => {
  const staff = await loggedIn(ORIGIN, 'staff@example.com', 'staffpass1234');
  const res = await staff.get('/admin/users');
  const html = await res.text();
  assert.match(html, /Only an Administrator can manage users/);
  assert.match(html, /Staff Member/, 'the denied page still shows who is signed in');
});

// ---- issuing an invitation ----

test('inviting a new email creates a DISABLED account and issues a link', async () => {
  const page = await admin.get('/admin/users');
  const res = await admin.post('/admin/users',
    'email=dewi@example.com&full_name=Dewi Lestari&role=cost_controller');
  assert.strictEqual(res.status, 302);
  const loc = res.headers.get('location');
  assert.match(loc, /token=/);

  const u = userOf('dewi@example.com');
  assert.ok(u, 'account created');
  assert.strictEqual(u.is_active, 0, 'account starts disabled (TS-01)');
  assert.ok(userOf('dewi@example.com').password_hash.startsWith('invite-pending$'),
    'no usable password is set before setup');
  assert.ok(inviteOf('dewi@example.com'), 'invitation row exists');
  assert.deepStrictEqual(auditActions(u.id), ['invite_created']);
  assert.ok(tokenFrom(await page.text()), 'form carried a csrf token');
});

test('the invitation token is stored hashed, never in the clear', async () => {
  const res = await admin.post('/admin/users', 'email=hashcheck@example.com&full_name=Hash Check&role=viewer');
  const raw = decodeURIComponent(res.headers.get('location')).match(/token=([a-f0-9]+)/)[1];
  const inv = inviteOf('hashcheck@example.com');
  assert.notStrictEqual(inv.token_hash, raw, 'raw token must not be stored');
  assert.strictEqual(inv.token_hash, policy.hashToken(raw), 'stored value is the SHA-256');
  assert.strictEqual(inv.token_hash.length, 64);
});

test('an invited account cannot sign in before the invitation is accepted', async () => {
  const c = client(ORIGIN);
  await c.get('/login');
  const res = await c.post('/login', 'email=dewi@example.com&password=anything123456');
  assert.strictEqual(res.status, 401);
});

test('inviting a malformed address or omitting the name is refused', async () => {
  const bad = await admin.post('/admin/users', 'email=not-an-email&full_name=Someone&role=viewer');
  assert.strictEqual(bad.status, 400);
  assert.match(await bad.text(), /valid email address/);

  const noName = await admin.post('/admin/users', 'email=noname@example.com&role=viewer');
  assert.strictEqual(noName.status, 400);
  assert.match(await noName.text(), /Full name is required/);
  assert.strictEqual(userOf('noname@example.com'), undefined);
});

test('an unknown role is refused', async () => {
  const res = await admin.post('/admin/users', 'email=badrole@example.com&full_name=Bad Role&role=wizard');
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /Choose a role/);
});

// ---- accepting an invitation ----

async function issueAndGetToken(email, name, role = 'viewer') {
  const res = await admin.post('/admin/users',
    `email=${encodeURIComponent(email)}&full_name=${encodeURIComponent(name)}&role=${role}`);
  assert.strictEqual(res.status, 302);
  return decodeURIComponent(res.headers.get('location')).match(/token=([a-f0-9]+)/)[1];
}

test('accepting with a short password is refused and the account stays disabled', async () => {
  const tok = await issueAndGetToken('short@example.com', 'Short Pass');
  const c = client(ORIGIN);
  await c.get(`/invite/${tok}`);
  const res = await c.post(`/invite/${tok}`, 'password=tooshort&confirm=tooshort');
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /at least 12 characters/);
  assert.strictEqual(userOf('short@example.com').is_active, 0);
});

test('accepting with a mismatched confirmation is refused', async () => {
  const tok = await issueAndGetToken('mismatch@example.com', 'Mismatch Pass');
  const c = client(ORIGIN);
  await c.get(`/invite/${tok}`);
  const res = await c.post(`/invite/${tok}`, 'password=averylongpassword1&confirm=averylongpassword2');
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /do not match/);
});

test('accepting a valid password activates the account and lets it sign in', async () => {
  const tok = await issueAndGetToken('accept@example.com', 'Accept User', 'finance');
  const c = client(ORIGIN);
  const form = await c.get(`/invite/${tok}`);
  assert.strictEqual(form.status, 200);
  assert.match(await form.text(), /Accept User/);

  const res = await c.post(`/invite/${tok}`, 'password=kalimatrahasiapanjang&confirm=kalimatrahasiapanjang');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);

  const u = userOf('accept@example.com');
  assert.strictEqual(u.is_active, 1, 'account activated on completion');
  assert.ok(u.password_hash.startsWith('$argon2id$'), 'password stored as Argon2id');
  assert.ok(inviteOf('accept@example.com').used_at, 'invitation marked used');

  // the login route also retires any open invitation for the account
  const live = await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  const page = await live.get('/');
  assert.strictEqual(page.status, 200);
});

test('the role chosen at invite time is applied to the new account', async () => {
  const id = userOf('accept@example.com').id;
  const row = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ? AND project_id IS NULL').get(id);
  assert.strictEqual(row.role_code, 'finance');
});

test('an invitation link works only once', async () => {
  const tok = await issueAndGetToken('once@example.com', 'Once Only');
  const c = client(ORIGIN);
  await c.get(`/invite/${tok}`);
  const first = await c.post(`/invite/${tok}`, 'password=firstpasswordlong1&confirm=firstpasswordlong1');
  assert.strictEqual(first.status, 302);

  const c2 = client(ORIGIN);
  const second = await c2.get(`/invite/${tok}`);
  assert.strictEqual(second.status, 200);
  assert.match(await second.text(), /Link not usable/);

  const retry = await c2.post(`/invite/${tok}`, 'password=secondpasswordlong&confirm=secondpasswordlong');
  assert.strictEqual(retry.status, 410);
  // the original password was not overwritten
  const again = await loggedIn(ORIGIN, 'once@example.com', 'firstpasswordlong1');
  assert.strictEqual((await again.get('/')).status, 200);
});

test('an unknown or malformed invitation token shows one generic message', async () => {
  for (const bad of ['deadbeef', encodeURIComponent('../../etc/passwd'), 'null']) {
    const c = client(ORIGIN);
    const res = await c.get(`/invite/${bad}`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Link not usable/);
  }
});

// ---- reissuing and revoking ----

test('reissuing invalidates the previous link and keeps one invitation row', async () => {
  const tok = await issueAndGetToken('reissue@example.com', 'Reissue User');
  const inv = inviteOf('reissue@example.com');
  const hashBefore = inv.token_hash;

  const res = await admin.post(`/admin/invitations/${inv.id}/resend`, '');
  assert.strictEqual(res.status, 302);
  const fresh = decodeURIComponent(res.headers.get('location')).match(/token=([a-f0-9]+)/)[1];
  assert.notStrictEqual(fresh, tok);

  const after = inviteOf('reissue@example.com');
  assert.strictEqual(after.id, inv.id, 'same single row is reused (email is UNIQUE)');
  assert.notStrictEqual(after.token_hash, hashBefore, 'token hash rotated');

  const old = await client(ORIGIN).get(`/invite/${tok}`);
  assert.match(await old.text(), /Link not usable/, 'old link is dead');

  const ok = await client(ORIGIN).get(`/invite/${fresh}`);
  assert.match(await ok.text(), /Set your password/, 'new link works');
  assert.ok(auditActions(userOf('reissue@example.com').id).includes('invite_reissued'));
});

test('revoking an invitation kills the link', async () => {
  const tok = await issueAndGetToken('revoke@example.com', 'Revoke User');
  const inv = inviteOf('revoke@example.com');
  const res = await admin.post(`/admin/invitations/${inv.id}/revoke`, '');
  assert.strictEqual(res.status, 302);

  const gone = await client(ORIGIN).get(`/invite/${tok}`);
  assert.match(await gone.text(), /Link not usable/);
  assert.ok(inviteOf('revoke@example.com').revoked_at, 'revoked_at stamped');
});

test('inviting an address that already has an active account is refused', async () => {
  const res = await admin.post('/admin/users', 'email=accept@example.com&full_name=Accept User&role=viewer');
  assert.strictEqual(res.status, 400);
  assert.match(await res.text(), /already has an active account/);
});

// ---- enable / disable ----

test('disabling a user revokes their sessions immediately and blocks sign-in', async () => {
  const id = userOf('accept@example.com').id;
  const cli = await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.ok(activeSessions(id) >= 1, 'the user has a live session');

  const res = await admin.post(`/admin/users/${id}/active`, 'action=disable');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(userOf('accept@example.com').is_active, 0);
  assert.strictEqual(activeSessions(id), 0, 'every session revoked, not left to expire');

  const page = await cli.get('/');
  assert.strictEqual(page.status, 302, 'the live session is dead');

  const c = client(ORIGIN);
  await c.get('/login');
  assert.strictEqual((await c.post('/login',
    'email=accept@example.com&password=kalimatrahasiapanjang')).status, 401);
  assert.ok(auditActions(id).includes('user_disabled'));
  assert.ok(auditActions(id).includes('sessions_revoked'));
});

test('re-enabling a user restores sign-in without re-inviting', async () => {
  const id = userOf('accept@example.com').id;
  const res = await admin.post(`/admin/users/${id}/active`, 'action=enable');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(userOf('accept@example.com').is_active, 1);
  const cli = await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.strictEqual((await cli.get('/')).status, 200);
});

test('an unknown user id returns 404 rather than a crash', async () => {
  for (const p of ['/admin/users/99999/active', '/admin/users/99999/reset', '/admin/users/99999/role']) {
    const res = await admin.post(p, 'action=disable');
    assert.strictEqual(res.status, 404, `${p} should 404`);
  }
  const junk = await admin.post('/admin/users/not-a-number/active', 'action=disable');
  assert.strictEqual(junk.status, 404);
});

// ---- role changes ----

test('changing a role revokes the affected sessions', async () => {
  const id = userOf('accept@example.com').id;
  await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.ok(activeSessions(id) >= 1, 'the user has a live session');

  const res = await admin.post(`/admin/users/${id}/role`, 'role=procurement');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(activeSessions(id), 0, 'privilege change rotates sessions (TS-01)');

  const row = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ? AND project_id IS NULL').get(id);
  assert.strictEqual(row.role_code, 'procurement');
  assert.ok(auditActions(id).includes('role_changed'));
});

test('promoting to administrator sets the system flag the guard checks', async () => {
  const id = userOf('accept@example.com').id;
  await admin.post(`/admin/users/${id}/role`, 'role=administrator');
  assert.strictEqual(userOf('accept@example.com').is_system_admin, 1);
  const cli = await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.strictEqual((await cli.get('/admin/users')).status, 200, 'now actually an admin');

  // put it back so later assertions about "the only admin" stay meaningful
  await admin.post(`/admin/users/${id}/role`, 'role=viewer');
  assert.strictEqual(userOf('accept@example.com').is_system_admin, 0);
});

test('demoting an administrator clears the system flag', async () => {
  const id = userOf('accept@example.com').id;
  await admin.post(`/admin/users/${id}/role`, 'role=administrator');
  assert.strictEqual(userOf('accept@example.com').is_system_admin, 1);
  await admin.post(`/admin/users/${id}/role`, 'role=viewer');
  assert.strictEqual(userOf('accept@example.com').is_system_admin, 0);
  const cli = await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.strictEqual((await cli.get('/admin/users')).status, 403);
});

test('the last administrator cannot be demoted or disabled', async () => {
  const adminId = userOf('admin@example.com').id;
  assert.strictEqual(require('../src/db/queries').adminCount(), 1, 'precondition');

  const demote = await admin.post(`/admin/users/${adminId}/role`, 'role=viewer');
  assert.strictEqual(demote.status, 302);
  const row = db.prepare('SELECT role_code FROM user_roles WHERE user_id = ? AND project_id IS NULL').get(adminId);
  assert.strictEqual(row.role_code, 'administrator', 'demotion refused');
  assert.strictEqual(userOf('admin@example.com').is_system_admin, 1);

  const disable = await admin.post(`/admin/users/${adminId}/active`, 'action=disable');
  assert.strictEqual(disable.status, 302);
  assert.strictEqual(userOf('admin@example.com').is_active, 1, 'disable refused');
});

// ---- temporary password reset (TS-17) ----

test('reset issues a temporary password, revokes sessions and works to sign in', async () => {
  const id = userOf('accept@example.com').id;
  await loggedIn(ORIGIN, 'accept@example.com', 'kalimatrahasiapanjang');
  assert.ok(activeSessions(id) >= 1, 'the user has a live session');

  const res = await admin.post(`/admin/users/${id}/reset`, '');
  assert.strictEqual(res.status, 200);
  const htmlRes = await res.text();
  const temp = htmlRes.match(/class="mono">([A-Za-z0-9-]{19})</);
  assert.ok(temp, 'temporary password is rendered once');
  const password = temp[1];
  assert.ok(password.length >= 12, 'satisfies the 12-character minimum');

  assert.strictEqual(activeSessions(id), 0, 'reset revokes existing sessions');
  assert.ok(auditActions(id).includes('password_reset'));

  const cli = await loggedIn(ORIGIN, 'accept@example.com', password);
  assert.strictEqual((await cli.get('/')).status, 200, 'the temp password signs in');

  // the previous password no longer works
  const old = client(ORIGIN);
  await old.get('/login');
  assert.strictEqual((await old.post('/login',
    'email=accept@example.com&password=kalimatrahasiapanjang')).status, 401);
});

test('a reset also clears an active lockout', async () => {
  const id = userOf('accept@example.com').id;
  db.prepare(`UPDATE users SET failed_login_count = 5, locked_until = datetime('now','+15 minutes') WHERE id = ?`).run(id);

  const res = await admin.post(`/admin/users/${id}/reset`, '');
  const temp = (await res.text()).match(/class="mono">([A-Za-z0-9-]{19})</)[1];
  const u = userOf('accept@example.com');
  assert.strictEqual(u.failed_login_count, 0);
  assert.strictEqual(u.locked_until, null);

  const cli = await loggedIn(ORIGIN, 'accept@example.com', temp);
  assert.strictEqual((await cli.get('/')).status, 200);
});

// ---- audit trail ----

test('every administrative action is recorded in the audit log', async () => {
  const adminId = userOf('admin@example.com').id;
  // Actions are recorded against the affected USER with the acting admin as
  // actor, so the trail is queryable per account.
  for (const email of ['reissue@example.com', 'revoke@example.com']) {
    const acts = auditActions(userOf(email).id);
    assert.ok(acts.includes(email === 'reissue@example.com' ? 'invite_reissued' : 'invite_revoked'),
      `${email} has its invitation event on its own trail`);
  }

  const rows = db.prepare(`SELECT action, actor_id FROM audit_log WHERE entity_type='users'`).all();
  for (const act of ['invite_created', 'invite_reissued', 'invite_revoked', 'invite_accepted',
    'user_enabled', 'user_disabled', 'role_changed', 'password_reset', 'sessions_revoked']) {
    assert.ok(rows.some((r) => r.action === act), `${act} audited`);
  }
  assert.ok(rows.some((r) => r.action === 'password_reset' && r.actor_id === adminId),
    'the reset records who issued it');
  assert.ok(rows.some((r) => r.action === 'invite_created' && r.actor_id === adminId),
    'invitations record which admin issued them');
});
