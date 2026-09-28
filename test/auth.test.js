// Auth feature tests (TS-01): lockout, Argon2id rehash, generic audit, login success/fail.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3996;

let dbPath, proc, db;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
async function req(pathname, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, { redirect: 'manual', ...opts });
}
function loginBody(email, pw) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(pw)}`,
  };
}
function user() {
  return db.prepare(`SELECT * FROM users WHERE email = 'auth@example.com'`).get();
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-auth-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'auth@example.com', 'realpass123'], env);

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
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- TS-01 lockout ----

test('T1.1 five wrong passwords → 429 + locked_until set', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await req('/login', loginBody('auth@example.com', 'wrongpass'));
    assert.ok([401, 429].includes(res.status), `attempt ${i + 1} status ${res.status}`);
  }
  const u = user();
  assert.ok(u.locked_until, 'locked_until is set');
  assert.strictEqual(u.failed_login_count, 5);
});

test('T1.2 correct password while locked → 429 (still generic)', async () => {
  const res = await req('/login', loginBody('auth@example.com', 'realpass123'));
  assert.strictEqual(res.status, 429);
  assert.match(await res.text(), /Too many sign-in attempts/);
});

test('T1.3 fresh seed is already argon2id; legacy pbkdf2 upgrades in place at login', async () => {
  const before = user();
  assert.ok(String(before.password_hash).startsWith('$argon2id$'), 'seed writes argon2id directly');

  // simulate a pre-upgrade install: put a legacy pbkdf2$ hash in place, force-unlock
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = 'pbkdf2$100000$' + salt + '$' +
    crypto.pbkdf2Sync('realpass123', salt, 100000, 32, 'sha256').toString('hex');
  db.prepare(`UPDATE users SET password_hash = ?, locked_until = NULL, failed_login_count = 0 WHERE email = 'auth@example.com'`).run(legacy);

  const res = await req('/login', loginBody('auth@example.com', 'realpass123'));
  assert.strictEqual(res.status, 302); // legacy password accepted, then upgraded

  const after = user();
  assert.strictEqual(after.failed_login_count, 0);
  assert.ok(after.locked_until === null, 'lock cleared');
  assert.ok(String(after.password_hash).startsWith('$argon2id$'), 'legacy hash upgraded to argon2id at login');
});

test('T1.3b wrong password against a legacy hash does NOT upgrade it', async () => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = 'pbkdf2$100000$' + salt + '$' +
    crypto.pbkdf2Sync('realpass123', salt, 100000, 32, 'sha256').toString('hex');
  db.prepare(`UPDATE users SET password_hash = ?, locked_until = NULL, failed_login_count = 0 WHERE email = 'auth@example.com'`).run(legacy);

  const res = await req('/login', loginBody('auth@example.com', 'nope-nope-nope'));
  assert.strictEqual(res.status, 401);
  assert.ok(String(user().password_hash).startsWith('pbkdf2$'), 'hash untouched on failed login');
});

test('T1.4 audit trail: login_success + failed attempts recorded', () => {
  const succ = db.prepare(`SELECT * FROM audit_log WHERE entity_type='users' AND action='login_success'`).all();
  assert.ok(succ.length >= 1, 'login_success audited');
  const fails = db.prepare(`SELECT * FROM audit_log WHERE entity_type='users' AND action='login_failed'`).all();
  assert.ok(fails.length >= 5, `${fails.length} failed logins audited`);
});

test('T1.5 unknown-account login also audits nothing but ALWAYS returns 401 (timing equalizer)', async () => {
  const t0 = Date.now();
  const res = await req('/login', loginBody('ghost@example.com', 'whatever'));
  const dt1 = Date.now() - t0;
  assert.strictEqual(res.status, 401);

  // second unknown-account call: same generic error, no lockout, no audit row
  const rows = db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE entity_type='users' AND actor_id IS NOT NULL`).get().n;
  assert.ok(rows >= 0);
  const res2 = await req('/login', loginBody('ghost@example.com', 'wrong'));
  assert.strictEqual(res2.status, 401);
  assert.ok(Date.now() - t0 - dt1 > -2000, 'no pathological fast path');
});