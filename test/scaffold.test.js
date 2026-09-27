// Scaffold tests (TEST_PLAN S1 + A1). Fresh temp DB per file; server started as
// a child process against that DB so tests never touch dev data.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3999;

let dbPath, proc, cookie;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

async function req(pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { redirect: 'manual', ...opts });
  return res;
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-test-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 't@example.com', 'testpw123'], env);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for listen
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- S1 scaffold boot ----

test('S1.3 unauthenticated GET / redirects to /login', async () => {
  const res = await req('/');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /\/login$/);
});

test('S1.3 GET /login renders the sign-in form', async () => {
  const res = await req('/login');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sign in/);
});

test('A1.1 wrong password → 401, no session', async () => {
  const res = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=t@example.com&password=wrong',
  });
  assert.strictEqual(res.status, 401);
  assert.match(await res.text(), /Invalid email or password/);
});

test('A1.2 unknown email → 401', async () => {
  const res = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=nobody@example.com&password=testpw123',
  });
  assert.strictEqual(res.status, 401);
});

test('S1.4 login with seed creds → 302 and session cookie', async () => {
  const res = await req('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=t@example.com&password=testpw123',
  });
  assert.strictEqual(res.status, 302);
  const setCookie = res.headers.get('set-cookie') || '';
  assert.match(setCookie, /practis_sid=/);
  cookie = setCookie.split(';')[0];
});

test('S1.5 authed GET / renders dashboard with project data', async () => {
  const res = await req('/', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Dashboard/);
  assert.match(html, /Citarum Bridge/);
});

test('S1.6 authed GET /ledger renders the ledger screen', async () => {
  const res = await req('/ledger', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Ledger/);
  assert.match(html, /Total debit/);
});

test('S1.6 ledger amounts are whole rupiah with dot grouping', async () => {
  const res = await req('/ledger', { headers: { cookie } });
  const html = await res.text();
  // any "Rp <n>" rendered must be a plain integer group, never a float
  const amounts = [...html.matchAll(/Rp ([0-9.]+)/g)].map(m => m[1]);
  for (const a of amounts) assert.match(a, /^\d{1,3}(\.\d{3})*$/, `bad amount format: ${a}`);
});

test('S1.7 logout revokes the session', async () => {
  const res = await req('/logout', { method: 'POST', headers: { cookie } });
  assert.strictEqual(res.status, 200);
  const after = await req('/', { headers: { cookie } });
  assert.strictEqual(after.status, 302);
});