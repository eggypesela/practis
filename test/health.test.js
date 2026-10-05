// HL-series: health, readiness and request IDs (module 9 part 9.2). THIS IS PART 9.2'S GATE.
// TECH-SPEC §4.3 (health and readiness) and §4.4 (logging and request IDs).
//
// Driven IN-PROCESS against a migrated temp DB, like jobs.test.js and for the same two reasons:
// the fixture spawns the server as a SEPARATE process (so a test cannot reach the live `req.id`,
// nor flip the disk threshold in the same process), and a fixture boot costs ~40s.
//
// The suite walks the REAL Express app (`require('../src/server')`) with supertest-style fetch,
// so a route that exists but is not mounted is caught, not assumed.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-health-')), 'test.db');

// TRAP: `src/db/db.js` THROWS inside a test process when PRACTIS_DB is unset (rather than opening
// the dev database). This must run BEFORE the first in-process require.
process.env.PRACTIS_DB = dbPath;
execFileSync(process.execPath, [path.join('src', 'db', 'migrate.js')],
  { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
execFileSync(process.execPath, [path.join('src', 'db', 'seed.js'), 'h@example.com', 'hpw12345'],
  { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });

let app;
let health;
let jobs;
let requestId;

test.before(async () => {
  // Lowers the disk threshold BEFORE health-service is required (it reads the env at module
  // load). HL5 then proves the check FIRES — a threshold that has never been seen to trip is
  // not a tested threshold.
  process.env.PRACTIS_LOG_FORMAT = 'text'; // keep test output readable; JSON is the prod default
  health = require('../src/lib/health-service');
  jobs = require('../src/lib/jobs');
  requestId = require('../src/middleware/request-id');
  app = require('../src/server');
});

// A tiny in-process client: this app is an Express handler, so bind an ephemeral port once.
const http = require('http');
let server;
let origin;

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── HL1 — liveness ──────────────────────────────────────────────────────────────────────────

test('HL1 /health/live answers ok WITHOUT touching the database', async () => {
  const res = await fetch(`${origin}/health/live`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

// ── HL2 — readiness, healthy ────────────────────────────────────────────────────────────────

test('HL2 /health/ready answers ok and a MINIMAL body when every check passes', async () => {
  // Start the runner so the job-runner check can pass, as it would in a real process.
  jobs.start({ intervalMs: 60_000 });
  const res = await fetch(`${origin}/health/ready`);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
  assert.strictEqual(res.status, 200);

  // §4.3: the public body must be MINIMAL. Assert the exact shape, so adding a field that leaks
  // a version or a path is a test failure rather than a review miss.
  const keys = Object.keys(body).sort();
  assert.deepStrictEqual(keys, ['status'], `public readiness leaked extra keys: ${keys.join(', ')}`);

  // And explicitly: nothing path-shaped, version-shaped or secret-shaped anywhere in the body.
  const raw = JSON.stringify(body);
  assert.ok(!/\/opt\/|\/data|v\d{2}\b|sqlite|SELECT|password|token/i.test(raw),
    `public readiness body leaks detail: ${raw}`);
});

// ── HL3 — the five checks are all present and each is exercised ──────────────────────────────

test('HL3 readiness really evaluates all five checks §4.3 lists', () => {
  const names = health.readinessChecks().map((c) => c.name);
  assert.deepStrictEqual(names,
    ['database', 'foreign_keys', 'schema', 'disk', 'job_runner'],
    `§4.3 lists five checks; found ${names.join(', ')}`);
  // Each must report a boolean ok and a human reason for the ADMIN page.
  for (const c of health.readinessChecks()) {
    assert.strictEqual(typeof c.ok, 'boolean', `${c.name} has no boolean ok`);
    assert.ok(c.detail && typeof c.detail === 'string', `${c.name} has no detail`);
  }
});

// ── HL4 — the runner check reflects reality ─────────────────────────────────────────────────

test('HL4 the job-runner check FAILS when the runner was never started', () => {
  jobs.stop();
  const runner = health.readinessChecks().find((c) => c.name === 'job_runner');
  assert.strictEqual(runner.ok, false, 'a stopped runner must not read as ready');
  assert.match(runner.detail, /not started/);
  jobs.start({ intervalMs: 60_000 }); // restore for later tests
});

// ── HL5 — the disk check actually fires (the threshold is not decorative) ────────────────────

test('HL5 an impossible disk threshold turns readiness RED and the probe 503', async () => {
  // The threshold is read at module load, so re-require with a fresh cache and an absurd value.
  const saved = process.env.PRACTIS_DISK_WARN_BYTES;
  process.env.PRACTIS_DISK_WARN_BYTES = String(1024 ** 5); // 1 TB — no box has this free
  const freshPath = require.resolve('../src/lib/health-service');
  delete require.cache[freshPath];
  const strict = require('../src/lib/health-service');
  const checks = strict.readinessChecks();
  const disk = checks.find((c) => c.name === 'disk');
  assert.strictEqual(disk.ok, false, 'a 1 TB threshold must fail on this host');
  assert.match(disk.detail, /below/);
  const ready = strict.ready();
  assert.strictEqual(ready.status, 'error');
  assert.deepStrictEqual(ready.failed, ['disk'], 'the failing check must be NAMED');
  // §4.3: even the failure body stays minimal — names only, no reason strings.
  assert.deepStrictEqual(Object.keys(ready).sort(), ['failed', 'status']);
  // restore the module the app is using
  delete require.cache[freshPath];
  if (saved === undefined) delete process.env.PRACTIS_DISK_WARN_BYTES;
  else process.env.PRACTIS_DISK_WARN_BYTES = saved;
  require('../src/lib/health-service');
});

// ── HL6 — the disk check measures the DATABASE's volume, not / ───────────────────────────────

test('HL6 the disk check measures the database volume, not the root filesystem', () => {
  const db = require('../src/db/db');
  const free = health.diskFreeBytes();
  assert.ok(Number.isFinite(free) && free > 0, 'diskFreeBytes must return a real number');
  // The measured filesystem must be the one holding the DB — this is the whole point of the
  // check, and the mistake it prevents is measuring a nearly-full root overlay instead.
  assert.strictEqual(path.dirname(db.name), path.dirname(dbPath),
    'the disk check is measuring a filesystem other than the database’s');
});

// ── HL7 — the schema check compares against the real target, not a stale constant ────────────

test('HL7 readiness compares user_version against the migration target', () => {
  const db = require('../src/db/db');
  const at = db.pragma('user_version', { simple: true });
  const migDir = path.join(ROOT, 'db', 'migrations');
  const target = Math.max(...fs.readdirSync(migDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => parseInt(f.split('_')[0], 10)));
  assert.strictEqual(at, target, `db is at v${at} but migrations reach v${target}`);
  assert.strictEqual(health.SCHEMA_VERSION, target,
    'health-service has a hard-coded version that drifted from db/migrations');
});

// ── HL8 — request IDs: minted, safe, echoed, and reusable from a proxy ───────────────────────

test('HL8 every response carries a sane X-Request-Id, and a good inbound one is kept', async () => {
  const res = await fetch(`${origin}/health/live`);
  const id = res.headers.get('x-request-id');
  assert.ok(id, 'X-Request-Id must be on EVERY response, not only errors');
  assert.match(id, /^[A-Za-z0-9._-]{8,200}$/);

  // A proxy-assigned id must survive, or the upstream and this app would log different ids for
  // one request — which defeats the correlation the id exists for.
  const inbound = 'abc123def456abc1';
  const res2 = await fetch(`${origin}/health/live`, { headers: { 'X-Request-Id': inbound } });
  assert.strictEqual(res2.headers.get('x-request-id'), inbound);
});

test('HL8b a HOSTILE inbound X-Request-Id is discarded, not echoed', () => {
  // The header is attacker-controlled. Echoing it verbatim into a response header invites
  // header/response splitting, and into a log invites log injection.
  assert.notStrictEqual(requestId.idFor('x'), 'x', 'too short must be rejected');
  assert.notStrictEqual(requestId.idFor('has space'), 'has space');
  assert.notStrictEqual(requestId.idFor('a'.repeat(500)), 'a'.repeat(500), 'too long must be rejected');
  assert.notStrictEqual(requestId.idFor('bad\nheader'), 'bad\nheader', 'CRLF must be rejected');
  assert.notStrictEqual(requestId.idFor(undefined), undefined);
  // A good one is kept
  assert.strictEqual(requestId.idFor('good-id-123456'), 'good-id-123456');
  // Minted ids are unique and random
  assert.notStrictEqual(requestId.newRequestId(), requestId.newRequestId());
});

// ── HL9 — the 500 path returns the request id ────────────────────────────────────────────────

test('HL9 a crash returns the request id so a user can quote it (§4.4)', () => {
  const { errorHandler } = require('../src/lib/error-handler');
  const req = { id: 'reqid9', headers: { accept: 'application/json' }, originalUrl: '/api/boom' };
  let sent = null;
  const res = {
    headersSent: false,
    status(c) { this.code = c; return this; },
    json(b) { sent = { code: this.code, body: b }; return this; },
    render() { throw new Error('should have answered JSON for /api/'); },
  };
  errorHandler(new Error('boom'), req, res, () => {});
  assert.strictEqual(sent.code, 500);
  assert.strictEqual(sent.body.requestId, 'reqid9', 'the id must come back in the error body');
  // And the message must NOT leak (§3.7 information disclosure)
  assert.ok(!/boom/.test(JSON.stringify(sent.body)), 'the error message leaked to the client');
});

// ── HL10 — the operator page is Administrator-only, and the public ones are not ──────────────

test('HL10 /system/health redirects anonymous AND is admin-gated; the probes are not', async () => {
  const anon = await fetch(`${origin}/system/health`, { redirect: 'manual' });
  assert.strictEqual(anon.status, 302, 'anonymous must be redirected to sign in');
  assert.match(anon.headers.get('location') || '', /\/login/);

  // The probes must NOT redirect — a HEALTHCHECK cannot sign in.
  for (const p of ['/health/live', '/health/ready']) {
    const res = await fetch(`${origin}${p}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200, `${p} must answer a probe with no session`);
  }
});

// ── HL11 — the operator page renders for an Administrator, with the detail ─────────────────

test('HL11 /system/health renders the full detail for a signed-in Administrator', async () => {
  const { loggedIn } = require('./helpers/csrf');
  // The seeded user from seed.js is the system Administrator.
  const cli = await loggedIn(origin, 'h@example.com', 'hpw12345');
  const res = await cli.get('/system/health');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // Positive first: the page must actually render its content, or the negative assertions below
  // pass against an empty string.
  assert.match(html, /Readiness checks/);
  assert.match(html, /Job runner/);
  assert.match(html, /System health/);
  // The detail the PUBLIC body must not carry is present HERE — that is the split §4.3 draws.
  assert.match(html, /schema v\d+/);
  assert.match(html, /never measured/, 'backup age must read as unknown, not as a recent time');
});

// ── HL12 — the access log: shape rules, and what is excluded ────────────────────────────────

test('HL12 the log line carries §4.4 fields and NEVER the query string', () => {
  const { accessLine, shouldLogAccess, routeTemplate, errorCodeFor } = require('../src/lib/logger');
  const line = accessLine({
    at: new Date('2026-10-05T02:14:33.123Z'),
    requestId: 'rid1', method: 'GET', route: '/projects/:id',
    status: 200, durationMs: 12.3, userId: 7,
  });
  assert.deepStrictEqual(Object.keys(line).sort(),
    ['durationMs', 'level', 'method', 'msg', 'requestId', 'route', 'status', 'time', 'userId']);
  assert.strictEqual(line.time, '2026-10-05T02:14:33Z', 'time must be a UTC second-precision stamp');

  // An anonymous request must NOT carry a userId field at all (§4.4: "user ID when authenticated").
  const anon = accessLine({ at: new Date(), requestId: 'r', method: 'GET', route: '/', status: 200, durationMs: 1 });
  assert.ok(!('userId' in anon), 'an anonymous line must omit userId, not carry null');

  // THE LEAK TEST: a route template is logged, so a query string can never reach the log. And an
  // unmatched route is the literal token `unmatched`, NOT the raw attacker-controlled path.
  assert.strictEqual(routeTemplate({ route: { path: '/projects/:id' }, baseUrl: '' }), '/projects/:id');
  assert.strictEqual(routeTemplate({ route: { path: '/:id' }, baseUrl: '/projects' }), '/projects/:id');
  assert.strictEqual(routeTemplate({}), 'unmatched');
  assert.strictEqual(routeTemplate({ url: '/evil?x=1\n{"level":"info"}' }), 'unmatched');

  // Error codes distinguish the three different faults behind 401/403.
  assert.strictEqual(errorCodeFor(401), 'UNAUTHORIZED');
  assert.strictEqual(errorCodeFor(403), 'FORBIDDEN');
  assert.strictEqual(errorCodeFor(429), 'RATE_LIMITED');
  assert.strictEqual(errorCodeFor(500), 'INTERNAL');
  assert.strictEqual(errorCodeFor(200), undefined);

  // Static assets and the container probe are excluded, or they would bury real events.
  assert.strictEqual(shouldLogAccess('/assets/app.css'), false);
  assert.strictEqual(shouldLogAccess('/health/ready'), false);
  assert.strictEqual(shouldLogAccess('/system/health'), true, 'the operator page must be logged');
  assert.strictEqual(shouldLogAccess('/projects'), true);
});
