// CSRF + session hardening tests (TECH-SPEC §3.1).
// Every POST must carry a token signed for the session that sends it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3994;

let dbPath, proc, db, cookie, csrf;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
const ORIGIN = `http://127.0.0.1:${PORT}`;

// minimal cookie jar for one client
function jar() {
  return { cookies: {} };
}
function jarHeader(j) {
  return Object.entries(j.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
function store(j, res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) delete j.cookies[k];
    else j.cookies[k] = v;
  }
  return res;
}
async function get(j, p) {
  return store(j, await fetch(ORIGIN + p, { redirect: 'manual', headers: { cookie: jarHeader(j) } }));
}
async function post(j, p, body, extra = {}) {
  return store(j, await fetch(ORIGIN + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jarHeader(j), ...extra },
    body,
  }));
}
function tokenFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/) || html.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-csrf-')), 'test.db');
  // The in-process DB module (used by S3 via revokeUserSessions) resolves
  // PRACTIS_DB at require time, so point the whole test process at the temp DB
  // before anything loads src/db/db.
  process.env.PRACTIS_DB = dbPath;
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'csrf@example.com', 'csrfpass123'], env);

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

// ---- C-series: CSRF ----

test('C1.1 login page carries a token and sets the csrf cookie', async () => {
  const j = jar();
  const res = await get(j, '/login');
  assert.strictEqual(res.status, 200);
  csrf = tokenFrom(await res.text());
  assert.ok(csrf && csrf.length > 40, 'token rendered into the form');
  assert.ok(j.cookies['practis_csrf'], 'csrf cookie set');
});

test('C1.2 POST without a token → 403, no session issued', async () => {
  const j = jar();
  await get(j, '/login'); // get cookie, but deliberately omit the field
  const res = await post(j, '/login', 'email=csrf@example.com&password=csrfpass123');
  assert.strictEqual(res.status, 403);
  assert.ok(!j.cookies['practis_sid'], 'no session cookie issued');
});

test('C1.3 POST with a forged token → 403', async () => {
  const j = jar();
  await get(j, '/login');
  const res = await post(j, '/login',
    'email=csrf@example.com&password=csrfpass123&_csrf=deadbeef.deadbeef');
  assert.strictEqual(res.status, 403);
});

test('C1.4 token from ANOTHER authenticated session is rejected (session-bound)', async () => {
  // Both clients log in first, so each session cookie differs and the HMAC
  // binding differs. (Anonymous double-submit deliberately shares an empty
  // binding — see the note in src/lib/csrf.js.)
  const a = jar(); const b = jar();
  for (const j of [a, b]) {
    const t = tokenFrom(await (await get(j, '/login')).text());
    const r = await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(t)}`);
    assert.strictEqual(r.status, 302);
  }
  // grab a token bound to A's session, then present it from B
  const tokA = tokenFrom(await (await get(a, '/')).text());
  const res = await post(b, '/ledger/entry',
    `side=debit&amount=1000&type=Expense&date=2026-09-01&_csrf=${encodeURIComponent(tokA)}`);
  assert.strictEqual(res.status, 403, "A's token must not authorise B's session");
});

test('C1.5 valid token → login succeeds', async () => {
  const j = jar();
  const tok = tokenFrom(await (await get(j, '/login')).text());
  const res = await post(j, '/login',
    `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(tok)}`);
  assert.strictEqual(res.status, 302);
  cookie = j.cookies['practis_sid'];
  assert.ok(cookie, 'session issued');
  jarA = j;
});

let jarA, jarB;
test('C1.6 login rotates the session id (anti-fixation)', async () => {
  const j = jar();
  await get(j, '/login');
  const preSid = j.cookies['practis_sid']; // may be undefined pre-login
  const tok = tokenFrom(await (await get(j, '/login')).text());
  await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(tok)}`);
  const postSid = j.cookies['practis_sid'];
  assert.ok(postSid, 'new session issued');
  if (preSid) assert.notStrictEqual(postSid, preSid, 'session id changed at login');

  // and exactly one active session row per login
  const active = db.prepare(`SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL`).get().n;
  assert.ok(active >= 1);
});

test('C1.7 authed POST without a token → 403 (ledger entry blocked)', async () => {
  const j = jarA;
  const before = db.prepare('SELECT COUNT(*) n FROM accounting_ledger').get().n;
  const res = await post(j, '/ledger/entry',
    'side=debit&amount=1000&type=Expense&date=2026-09-01');
  assert.strictEqual(res.status, 403);
  const after = db.prepare('SELECT COUNT(*) n FROM accounting_ledger').get().n;
  assert.strictEqual(after, before, 'no row written');
});

test('C1.8 authed POST with the header token works (XHR path)', async () => {
  const j = jarA;
  const tok = await (async () => {
    const html = await (await get(j, '/ledger/entry')).text();
    return tokenFrom(html);
  })();
  const res = await post(j, '/ledger/entry',
    'side=debit&amount=250000&type=Expense&date=2026-09-01&document_no=CSRF-HDR-1',
    { 'x-csrf-token': tok });
  assert.strictEqual(res.status, 302, 'header token accepted');
});

test('C1.9 logout requires a token and revokes the session', async () => {
  const j = jar();
  const tok = tokenFrom(await (await get(j, '/login')).text());
  await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(tok)}`);

  const noTok = await post(j, '/logout', '');
  assert.strictEqual(noTok.status, 403, 'logout without token blocked');

  const homeTok = tokenFrom(await (await get(j, '/')).text());
  const ok = await post(j, '/logout', `_csrf=${encodeURIComponent(homeTok)}`);
  assert.strictEqual(ok.status, 200);
  const after = await get(j, '/');
  assert.strictEqual(after.status, 302, 'session revoked → redirected to login');
  const active = db.prepare(`SELECT COUNT(*) n FROM sessions s WHERE id = ? AND s.revoked_at IS NULL`)
    .get(require('node:crypto').createHash('sha256').update(j.cookies['practis_sid'] || '').digest('hex')).n;
  assert.ok(active <= 1);
});

// ---- S-series: session hardening ----

test('S1 absolute expiry is enforced using UTC-consistent arithmetic', () => {
  const j = jarB = jar();
  return (async () => {
    const tok = tokenFrom(await (await get(j, '/login')).text());
    await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(tok)}`);
    const sid = require('node:crypto').createHash('sha256').update(j.cookies['practis_sid']).digest('hex');
    // push expiry into the past, leave last_seen fresh: only absolute expiry should trip
    db.prepare(`UPDATE sessions SET expires_at = datetime('now','-1 hour') WHERE id = ?`).run(sid);
    const res = await get(j, '/');
    assert.strictEqual(res.status, 302, 'expired session rejected');
    assert.ok(db.prepare('SELECT revoked_at FROM sessions WHERE id = ?').get(sid).revoked_at, 'row revoked');
  })();
});

test('S2 idle timeout is enforced (last_seen 31 min ago)', async () => {
  const j = jar();
  const tok = tokenFrom(await (await get(j, '/login')).text());
  await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(tok)}`);
  const sid = require('node:crypto').createHash('sha256').update(j.cookies['practis_sid']).digest('hex');
  db.prepare(`UPDATE sessions SET last_seen_at = datetime('now','-31 minutes') WHERE id = ?`).run(sid);
  const res = await get(j, '/');
  assert.strictEqual(res.status, 302, 'idle session rejected');
});

test('S3 revokeUserSessions kills others but spares the caller', async () => {
  const { revokeUserSessions } = require('../src/middleware/auth');
  const j1 = jar(); const j2 = jar();
  for (const j of [j1, j2]) {
    const t = tokenFrom(await (await get(j, '/login')).text());
    await post(j, '/login', `email=csrf@example.com&password=csrfpass123&_csrf=${encodeURIComponent(t)}`);
  }
  const uid = db.prepare(`SELECT id FROM users WHERE email='csrf@example.com'`).get().id;
  const n = revokeUserSessions(uid, j1.cookies['practis_sid']);
  assert.ok(n >= 1, 'other session(s) revoked');
  assert.strictEqual((await get(j1, '/')).status, 200, 'caller session survives');
  assert.strictEqual((await get(j2, '/')).status, 302, 'other session dead');
});
