// SCH-ERR: the error path must be usable by a BROWSER.
//
// The 500 handler answered `res.json({error:'internal error'})` for every request,
// so a user hitting a crashing page saw the raw string {"error":"internal error"}
// in the browser — no page, no navigation, no explanation. Content negotiation is
// the fix: JSON for fetch/XHR, an HTML page for a browser.
//
// The handlers were inline in server.js where no test could reach them, which is
// exactly why the defect survived a 266-test suite. They now live in
// src/lib/error-handler.js and these tests call them directly.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PORT = 3933;                       // fresh port (grepped test/*.test.js first)
const ORIGIN = `http://localhost:${PORT}`;
let proc, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-scherr-'));
  const dbPath = path.join(tmp, 't.db');
  const env = { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT),
    PRACTIS_RL_LOGIN_MAX: '100000', PRACTIS_RL_WRITE_MAX: '100000', PRACTIS_RL_GLOBAL_MAX: '100000' };
  for (const script of ['src/db/migrate.js', 'src/db/seed.js', 'src/db/seed-master.js']) {
    await new Promise((res, rej) => {
      const p = spawn('node', [script, ...(script.includes('seed.js') ? ['e@example.com', 'epw12345'] : [])],
        { cwd: REPO, env, stdio: 'ignore' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${script} exit ${c}`))));
    });
  }
  proc = spawn('node', ['src/server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start: ${err}`)), 20000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); res(); } });
  });
});

after(() => { if (proc) proc.kill(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

// Minimal response double: records what the handler chose to do.
function fakeRes() {
  const r = { statusCode: null, kind: null, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.kind = 'json'; r.body = b; return r; };
  r.render = (v, o) => { r.kind = 'render'; r.body = { view: v, locals: o }; return r; };
  return r;
}

test('SCH-ERR.1 a browser hitting a crashing page gets HTML, not raw JSON', () => {
  const { errorHandler } = require(path.join(REPO, 'src/lib/error-handler.js'));
  const err = new Error('boom: table accounting_ledger has no column x');

  const browser = fakeRes();
  errorHandler(err, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } }, browser, () => {});
  assert.strictEqual(browser.statusCode, 500, 'status stays 500');
  assert.strictEqual(browser.kind, 'render', 'browser receives an HTML error page, not JSON');
  assert.strictEqual(browser.body.view, '500', 'renders the 500 view');

  // The error text must NOT leak to the client — it names internals.
  assert.doesNotMatch(JSON.stringify(browser.body), /accounting_ledger/,
    'the internal error message is not disclosed to the user');
});

test('SCH-ERR.2 a fetch()/XHR client keeps receiving JSON', () => {
  const { errorHandler } = require(path.join(REPO, 'src/lib/error-handler.js'));

  // An explicit JSON preference.
  const api = fakeRes();
  errorHandler(new Error('boom'), { headers: { accept: 'application/json' }, url: '/ledger' }, api, () => {});
  assert.strictEqual(api.statusCode, 500);
  assert.strictEqual(api.kind, 'json', 'an explicit JSON Accept still gets JSON');
  // The body gained `requestId` in module 9 part 9.2 (§4.4: "request id returned on errors; user
  // can quote it"). This request double carries no `id`, and the handler omits the field rather
  // than emitting `requestId: undefined` — so the shape here is still exactly the base error. The
  // WITH-id case is asserted in test/health.test.js HL9.
  assert.deepStrictEqual(api.body, { error: 'internal error' });

  // THE CASE ACCEPT ALONE GETS WRONG: fetch() defaults to `Accept: */*`, and the
  // import UI parses JSON. If this route threw and we answered HTML, JSON.parse
  // would choke on "<!DOCTYPE" — so the /api/ URL space decides, not the header.
  const star = fakeRes();
  errorHandler(new Error('boom'), { headers: { accept: '*/*' }, originalUrl: '/api/imports/1/confirm' }, star, () => {});
  assert.strictEqual(star.kind, 'json', 'an /api/ route always answers JSON, whatever Accept says');
});

test('SCH-ERR.3 a request with no Accept header still gets an HTML page', () => {
  const { errorHandler } = require(path.join(REPO, 'src/lib/error-handler.js'));
  const none = fakeRes();
  errorHandler(new Error('boom'), { headers: {} }, none, () => {});
  assert.strictEqual(none.kind, 'render', 'browsers occasionally omit Accept — default to HTML');
});

test('SCH-ERR.4 a response that already started is handed back, never half-written', () => {
  const { errorHandler } = require(path.join(REPO, 'src/lib/error-handler.js'));
  let handedBack = null;
  const started = fakeRes();
  started.headersSent = true;
  errorHandler(new Error('mid-stream'), { headers: { accept: 'text/html' } }, started, (e) => { handedBack = e; });
  assert.ok(handedBack, 'delegates to next(err) so Express destroys the socket');
  assert.strictEqual(started.kind, null, 'does not attempt to write a body after headers were sent');
});

test('SCH-ERR.5 an anonymous visitor gets a real 404 page, not a redirect', async () => {
  const res = await fetch(`${ORIGIN}/definitely-not-a-route`, { redirect: 'manual' });
  assert.strictEqual(res.status, 404, 'unknown URL is 404, never a 302 to /login');
  const html = await res.text();
  assert.match(html, /Not found/);
  assert.doesNotMatch(html.trimStart(), /^\{/, 'is HTML, not a JSON blob');
});

test('SCH-ERR.6 the 404 page renders without a signed-in user', async () => {
  // layout-app renders the sidebar from user-derived locals; with no session those
  // must degrade to empty rather than throw.
  const res = await fetch(`${ORIGIN}/nope`, { redirect: 'manual' });
  assert.strictEqual(res.status, 404);
  const html = await res.text();
  assert.ok(html.length > 1000, 'a full layout rendered (not a bare error string)');
  assert.doesNotMatch(html, /Cannot read propert|is not a function/, 'no template crash leaked');
});
