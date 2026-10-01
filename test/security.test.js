// Security hardening tests (TEST_PLAN §12, SCH-series). Ports 3905–3907.
//
// Covers the three hardening tasks from the 2026-09-30 audit:
//   0.3  synchronous = FULL
//   0.4  security headers + CSP nonce
//   0.5  rate limiting
//
// The rate-limit tests spawn their OWN server with deliberately tight limits via
// PRACTIS_RL_* env vars, rather than hammering the shared server (many tests log
// in from 127.0.0.1, so a shared per-IP bucket would make unrelated tests flaky).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3905;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// A second server, tight limits, for proving the limiter fires.
const TIGHT_PORT = 3906;
const TIGHT_ORIGIN = `http://127.0.0.1:${TIGHT_PORT}`;

let dbPath, proc, tightProc, cli;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

async function boot(port, env) {
  const p = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    p.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    p.stderr.on('data', (d) => process.stderr.write(d));
  });
  return p;
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-sch-')), 'test.db');
  const env = { PRACTIS_DB: dbPath, PRACTIS_IMPORTS: path.join(path.dirname(dbPath), 'imports') };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 's@example.test', 'spw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  proc = await boot(PORT, env);
  cli = await require('./helpers/csrf').loggedIn(ORIGIN, 's@example.test', 'spw12345');
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (tightProc) tightProc.kill('SIGKILL');
});

// =============================================================================
// SCH-SYNC — synchronous = FULL (task 0.3)
// =============================================================================

test('SCH-SYNC.1 the app connection runs with synchronous = FULL', () => {
  // In WAL mode `synchronous` is PER-CONNECTION and is NOT persisted in the file,
  // so this must be asserted on the connection the app actually opens. Opening a
  // separate readonly handle would report that handle's default and prove nothing.
  const saved = process.env.PRACTIS_DB;
  process.env.PRACTIS_DB = dbPath;
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'db', 'db.js'))];
  const db = require(path.join(ROOT, 'src', 'db', 'db.js'));
  assert.strictEqual(db.pragma('synchronous', { simple: true }), 2, '2 = FULL');
  assert.strictEqual(db.pragma('journal_mode', { simple: true }), 'wal');
  if (saved === undefined) delete process.env.PRACTIS_DB; else process.env.PRACTIS_DB = saved;
});

// =============================================================================
// SCH-HDR — security headers (task 0.4)
// =============================================================================

test('SCH-HDR.1 every response carries the security headers', async () => {
  const res = await fetch(`${ORIGIN}/login`);
  assert.strictEqual(res.status, 200);

  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('referrer-policy'), 'same-origin');

  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'a CSP must be sent');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('SCH-HDR.2 the CSP uses a per-response nonce, not unsafe-inline scripts', async () => {
  const a = await fetch(`${ORIGIN}/login`);
  const b = await fetch(`${ORIGIN}/login`);
  const cspA = a.headers.get('content-security-policy');
  const cspB = b.headers.get('content-security-policy');

  const nonceA = cspA.match(/'nonce-([^']+)'/);
  const nonceB = cspB.match(/'nonce-([^']+)'/);
  assert.ok(nonceA, 'script-src must carry a nonce');
  assert.ok(nonceB);
  assert.notStrictEqual(nonceA[1], nonceB[1], 'the nonce must change every response');

  assert.ok(!/script-src[^;]*unsafe-inline/.test(cspA),
    'scripts must NOT be allowed unsafe-inline — that defeats the CSP');
});

test('SCH-HDR.3 the served app page carries the nonce on its inline script tags', async () => {
  // A nonce in the header is useless if the inline <script> does not carry it —
  // the browser would block the app's own JavaScript. /queue has a real inline
  // <script>, and every app page carries the layout's inline <style>.
  const res = await cli.get('/queue');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  const nonce = res.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];

  const scriptTags = html.match(/<script[^>]*>/g) || [];
  assert.ok(scriptTags.length > 0, '/queue ships an inline script');
  for (const tag of scriptTags) {
    assert.ok(tag.includes(`nonce="${nonce}"`),
      `every inline <script> must carry the response nonce; found: ${tag}`);
  }
});

test('SCH-HDR.4 HSTS is NOT sent over plain HTTP (it would break local dev)', async () => {
  const res = await fetch(`${ORIGIN}/login`);
  assert.strictEqual(res.headers.get('strict-transport-security'), null,
    'HSTS on plain HTTP pins browsers to a scheme that is not served here');
});

test('SCH-HDR.5 headers survive a CSRF rejection (403 rendered before the routes)', async () => {
  // The CSRF middleware sits after the header middleware. If the order were
  // reversed, this 403 would ship without a CSP — an attacker-triggerable page
  // with no protections. Assert on a token-less POST, which CSRF always rejects.
  const res = await fetch(`${ORIGIN}/logout`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'nothing=1',
  });
  assert.strictEqual(res.status, 403, 'a token-less POST is rejected by CSRF');
  assert.ok(res.headers.get('content-security-policy'), 'the 403 page must also carry the CSP');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
});

test('SCH-HDR.6 the CSP nonce is on an authenticated app page, not just login', async () => {
  const res = await cli.get('/ledger');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /<style nonce="[^"]+">/,
    'the layout inline <style> must carry the nonce or x-cloak hiding breaks');
});

test('SCH-HDR.7 no inline event-handler attributes survive the CSP', async () => {
  // A nonce authorises <script> ELEMENTS. It does NOT authorise inline handler
  // ATTRIBUTES (onclick=, onchange=…): those need 'unsafe-inline' and are blocked
  // even when a nonce is present. Since the policy deliberately has no
  // unsafe-inline, any surviving onclick= is silently dead UI — the button simply
  // stops working with no visible error. This test walks every page and fails on
  // the first one, which is the only reliable way to catch it.
  //
  // HTML comments and <script> bodies are stripped first: a comment explaining
  // this very rule (or a script string mentioning "onclick=") is not an inline
  // handler, and matching it would be a false positive.
  const pages = ['/', '/ledger', '/queue', '/import', '/advances', '/expenses', '/reconciliation', '/admin/users'];
  const handlerRe = /\son(click|change|submit|input|load|keyup|focus|blur|mouseover|mousedown)\s*=/i;

  const strip = (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  for (const p of pages) {
    const res = await cli.get(p);
    if (res.status !== 200) continue; // /admin/users is admin-only; skip non-200s
    const body = strip(await res.text());
    const m = body.match(handlerRe);
    assert.strictEqual(m, null,
      `${p} still ships an inline handler "${m && m[0].trim()}" — the CSP blocks it and the control will be dead. Bind it with addEventListener in the nonce'd script instead.`);
  }
});

// =============================================================================
// SCH-RL — rate limiting (task 0.5)
// =============================================================================

// The limiter sits BEFORE the CSRF middleware, so these POSTs only need a valid
// token to reach the route — but the point of the test is that the LIMIT fires, so
// each attempt carries the token from a fresh page fetch. If the ordering ever
// regressed (CSRF first), a token-less spray would sail past the limiter and these
// tests would fail, which is exactly the regression worth catching.
async function loginAttempt(origin, email, { withToken = true } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  let body = `email=${encodeURIComponent(email)}&password=wrong`;
  if (withToken) {
    const page = await fetch(`${origin}/login`);
    const html = await page.text();
    const token = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1]
      || (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    const cookie = (page.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    if (token) body += `&_csrf=${encodeURIComponent(token)}`;
    if (cookie) headers.cookie = cookie;
  }
  return fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers, body });
}

test('SCH-RL.1 repeated login attempts from one IP are eventually 429', async () => {
  tightProc = await boot(TIGHT_PORT, {
    PRACTIS_DB: dbPath,
    PRACTIS_RL_LOGIN_MAX: '3',
    PRACTIS_RL_LOGIN_WINDOW_MS: '60000',
    PRACTIS_RL_GLOBAL_MAX: '5000',   // keep the global backstop out of the way
  });

  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = await loginAttempt(TIGHT_ORIGIN, `nobody${i}@example.test`);
    codes.push(res.status);
    if (res.status === 429) {
      assert.ok(res.headers.get('retry-after') || res.headers.get('ratelimit'),
        'a 429 must tell the client when to retry');
    }
  }
  assert.ok(codes.includes(429),
    `the limiter must fire; got ${codes.join(',')} — BEFORE this task a single host could spray unlimited accounts`);
});

test('SCH-RL.2 a token-less spray still hits the limiter (ordering regression guard)', async () => {
  // This is the subtle one. A limiter only counts requests that flow through it.
  // If CSRF were placed before the limiter, an attacker could omit the token,
  // get a cheap 403, and never be counted — an unlimited spray. The limiter must
  // therefore sit BEFORE CSRF, and this test proves that ordering holds.
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${TIGHT_ORIGIN}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `email=spray-${i}-${Date.now()}@example.test&password=wrong`,
    });
    codes.push(res.status);
  }
  assert.ok(codes.includes(429),
    `token-less requests must still be counted by the limiter; got ${codes.join(',')} — if this is all 403, the limiter is behind CSRF and bypassable`);
});

test('SCH-RL.3 the import API is rate limited and answers JSON, not an HTML page', async () => {
  const env = {
    PRACTIS_DB: dbPath,
    PRACTIS_RL_WRITE_MAX: '2',
    PRACTIS_RL_WRITE_WINDOW_MS: '60000',
    PRACTIS_RL_GLOBAL_MAX: '5000',
  };
  const p = await boot(3907, env);
  try {
    const version = await require('./helpers/csrf').loggedIn(`http://127.0.0.1:3907`, 's@example.test', 'spw12345');
    const codes = [];
    let lastBody = null;
    for (let i = 0; i < 5; i++) {
      const fd = new FormData();
      fd.append('file', new Blob(['date,debit\n2026-01-01,1000'], { type: 'text/csv' }), 'x.csv');
      const res = await fetch('http://127.0.0.1:3907/api/imports', {
        method: 'POST', redirect: 'manual',
        headers: { cookie: version.cookieHeader(), 'x-csrf-token': version.token() },
        body: fd,
      });
      codes.push(res.status);
      if (res.status === 429) lastBody = await res.json();
    }
    assert.ok(codes.includes(429), `import endpoint must be limited; got ${codes.join(',')}`);
    assert.strictEqual(lastBody.error.code, 'RATE_LIMITED',
      'a fetch() client needs JSON — an HTML 429 surfaces as "unexpected token <"');
  } finally {
    p.kill('SIGKILL');
  }
});

test('SCH-RL.4 ordinary browsing is not throttled by the global backstop', async () => {
  // The default global limit (300/min) must not interfere with normal use; this
  // asserts the backstop is generous on the SHARED server with default settings.
  for (let i = 0; i < 25; i++) {
    const res = await cli.get('/ledger');
    assert.strictEqual(res.status, 200, `request ${i + 1} was throttled — the global limit is too tight`);
  }
});
