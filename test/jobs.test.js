// JB-series: the job runner (module 9 part 9.1). THIS IS PART 9.1'S GATE. TECH-SPEC §4.5.
//
// ============================================================================================
// WHAT THIS FILE DEFENDS
// ============================================================================================
// **JB8 IS THE POINT.** §4.5 says "crash recovery returns stale running jobs to queued". That is
// the requirement that cannot be satisfied by code that merely works when nothing goes wrong — it
// only matters when the process DIES mid-job. A runner without it silently loses work: the row sits
// in `running` forever and no alarm ever fires, because a stuck job is not a failed job.
//
// The second thing defended is that `attempts` is incremented AT CLAIM, not on failure. If it moved
// only on failure, a job that crashes the process would never be counted and crash recovery would
// re-queue it forever — an infinite loop that looks like liveness. JB8 proves the counter moves on
// a crash AND that max_attempts then stops it.
//
// The third: an UNHANDLED job type FAILS LOUDLY (JB7). A silent no-op would let the queue drain and
// report healthy while a job nobody implemented simply evaporated.
//
// ============================================================================================
// NOTE THERE IS NO PORT AND NO SERVER IN THIS FILE — DELIBERATELY
// ============================================================================================
// The other suites boot a real server through `startFixture()`. That would be WRONG here for two
// reasons measured while writing this: (1) the fixture spawns the server as a SEPARATE PROCESS, so
// the booted server's own ticker would be a second runner claiming the same rows as this file's
// in-process runner — a race, in a test about not racing; (2) a fixture boot costs ~40s. The job
// runner is pure service code, so this file migrates a temp database with `migrate.js`, points
// PRACTIS_DB at it, and drives the module in-process. That is why there is no port to reserve.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
let jobs;      // required AFTER PRACTIS_DB points at the temp database
let db;
let tmpDir;

// Every job this file creates is tagged, so `reset()` cannot delete a row another test needs and
// (more importantly) so the file can prove its own cleanup rather than assuming an empty table.
const TAG = 'jb-test';

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-jobs-'));
  const dbPath = path.join(tmpDir, 'test.db');
  execFileSync(process.execPath, [path.join('src', 'db', 'migrate.js')],
    { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });

  // TRAP: `src/db/db.js` opens the DEV database when PRACTIS_DB is unset, and it THROWS inside a
  // test process rather than letting that happen silently. This line must come before the require.
  process.env.PRACTIS_DB = dbPath;
  // Lower the ticker floor so JB10 can drive a REAL tick. `jobs.js` reads this at require time
  // (module-level const), so it has to be set BEFORE the require below, not before start().
  process.env.PRACTIS_JOB_MIN_TICK_MS = '20';

  jobs = require('../src/lib/jobs');
  db = require('../src/db/db');
});

after(() => {
  jobs.stop();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reset() {
  db.prepare('DELETE FROM jobs').run();
  jobs.stop();
}

/** Insert a job directly, so a test can control state/run_at/attempts exactly. */
function seed({ type = `${TAG}-ok`, payload = {}, state = 'queued', runAt = null,
  attempts = 0, maxAttempts = 3, startedAt = null } = {}) {
  return Number(db.prepare(`
    INSERT INTO jobs (type, payload_json, state, run_at, attempts, max_attempts, started_at)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)`).run(
    type, JSON.stringify(payload), state, runAt, attempts, maxAttempts, startedAt,
  ).lastInsertRowid);
}

const row = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

// ---- JB1 — the basic path ------------------------------------------------------------------

test('JB1 a due job is claimed once, counted, and completed', async () => {
  reset();
  jobs.register(`${TAG}-ok`, async () => {});

  const id = jobs.enqueue({ type: `${TAG}-ok`, payload: { hello: 'world' } });
  const before = row(id);
  assert.strictEqual(before.state, 'queued');
  assert.strictEqual(before.attempts, 0, 'a queued job has not been attempted');

  const res = await jobs.runOne();
  assert.strictEqual(res.id, id);
  assert.strictEqual(res.state, 'completed');

  const after = row(id);
  assert.strictEqual(after.state, 'completed');
  assert.strictEqual(after.attempts, 1, 'the run is counted at claim');
  assert.ok(after.started_at, 'started_at is recorded');
  assert.ok(after.finished_at, 'finished_at is recorded');
  assert.strictEqual(after.last_error, null, 'a success clears last_error');

  // The payload survived the round trip through TEXT.
  let seen = null;
  jobs.register(`${TAG}-echo`, async (p) => { seen = p; });
  jobs.enqueue({ type: `${TAG}-echo`, payload: { n: 42 } });
  await jobs.runOne();
  assert.deepStrictEqual(seen, { n: 42 }, 'the handler receives the parsed payload');
});

test('JB2 a job scheduled for the future is NOT claimed early', async () => {
  reset();
  const id = seed();
  db.prepare("UPDATE jobs SET run_at = datetime('now', '+1 hour') WHERE id = ?").run(id);

  assert.strictEqual(jobs.claimDue(), null, 'a future job is not due');
  assert.strictEqual(row(id).state, 'queued');

  db.prepare("UPDATE jobs SET run_at = datetime('now', '-1 second') WHERE id = ?").run(id);
  assert.ok(jobs.claimDue(), 'once due it is claimed');
});

test('JB3 the same job cannot be claimed twice', async () => {
  reset();
  const id = seed();
  const first = jobs.claimDue();
  assert.strictEqual(first.id, id);
  assert.strictEqual(jobs.claimDue(), null,
    'the claim is one atomic statement, so a second caller finds nothing');
});

// ---- JB4/JB5 — success, failure, backoff, real retry ---------------------------------------

test('JB4 a failing handler re-queues the job with backoff rather than losing it', async () => {
  reset();
  jobs.register(`${TAG}-boom`, async () => { throw new Error('disk on fire'); });

  const id = jobs.enqueue({ type: `${TAG}-boom` });
  const res = await jobs.runOne();

  assert.strictEqual(res.state, 'queued', 'attempts remain, so it goes back to the queue');
  const r = row(id);
  assert.strictEqual(r.state, 'queued');
  assert.strictEqual(r.attempts, 1);
  assert.match(r.last_error, /disk on fire/, 'the reason is kept for the operator');
  assert.ok(r.run_at > new Date(Date.now() + 20_000).toISOString().slice(0, 19).replace('T', ' '),
    'run_at was pushed into the future — the backoff actually delayed it');
});

test('JB5 a re-queued job really runs again, and exhausting max_attempts ends it', async () => {
  reset();
  let calls = 0;
  jobs.register(`${TAG}-flaky`, async () => { calls += 1; throw new Error(`fail ${calls}`); });

  const id = jobs.enqueue({ type: `${TAG}-flaky`, maxAttempts: 2 });

  await jobs.runOne();
  assert.strictEqual(calls, 1);
  assert.strictEqual(row(id).state, 'queued');

  // The backoff pushed run_at forward; a scheduler would wait. Make it due to prove the retry is a
  // real second execution and not a row that merely looks re-queued.
  db.prepare("UPDATE jobs SET run_at = datetime('now') WHERE id = ?").run(id);
  const second = await jobs.runOne();
  assert.strictEqual(calls, 2, 'the handler ran a SECOND time');
  assert.strictEqual(second.state, 'failed', 'max_attempts reached → terminal, not another retry');

  const r = row(id);
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.attempts, 2);
  assert.match(r.last_error, /fail 2/, 'the LAST error is what an operator needs');
  assert.ok(r.finished_at, 'a terminal state is timestamped');
});

test('JB6 backoff grows exponentially and is capped', () => {
  assert.strictEqual(jobs.backoffSeconds(1), 30);
  assert.strictEqual(jobs.backoffSeconds(2), 60);
  assert.strictEqual(jobs.backoffSeconds(3), 120);
  assert.strictEqual(jobs.backoffSeconds(50), 1800, 'capped at 30 minutes');
  assert.strictEqual(jobs.backoffSeconds(0), 30, 'a nonsense attempt count still yields a delay');
});

// ---- JB7 — an unhandled type fails loudly --------------------------------------------------

test('JB7 a job with no handler FAILS, it does not silently disappear', async () => {
  reset();
  const id = jobs.enqueue({ type: 'no-such-handler-exists' });
  const res = await jobs.runOne();

  assert.strictEqual(res.state, 'failed');
  assert.strictEqual(res.error, jobs.UNKNOWN_TYPE);
  const r = row(id);
  assert.strictEqual(r.state, 'failed');
  assert.match(r.last_error, /No handler is registered/,
    'the operator can see WHY without reading the source');
});

// ---- JB8 — crash recovery (the point of this file) -----------------------------------------

test('JB8 a job orphaned by a crash returns to the queue, and the staleness window is respected', async () => {
  reset();
  const staleId = seed({ state: 'running', attempts: 1, startedAt: null });
  db.prepare("UPDATE jobs SET started_at = datetime('now', '-20 minutes') WHERE id = ?").run(staleId);

  const freshId = seed({ state: 'running', attempts: 1 });
  db.prepare("UPDATE jobs SET started_at = datetime('now') WHERE id = ?").run(freshId);

  const recovered = jobs.recoverStale({ staleMinutes: 15 });
  assert.strictEqual(recovered, 1, 'exactly the orphaned job is recovered');

  assert.strictEqual(row(staleId).state, 'queued', 'the orphan is runnable again');
  assert.match(row(staleId).last_error, /Interrupted/,
    'and it says why, so it is not mistaken for a normal retry');
  assert.strictEqual(row(freshId).state, 'running',
    'a job that may still be legitimately running is LEFT ALONE — recovery must not double-run');
});

test('JB8b a job that crashes repeatedly cannot loop forever', async () => {
  reset();
  // max_attempts 1: the claim counts the attempt, so a single crash exhausts it. This is the
  // property that makes crash recovery safe — recovery alone would re-queue for ever.
  const id = seed({ type: 'crashes-the-process', attempts: 0, maxAttempts: 1,
    state: 'running', startedAt: null });
  db.prepare("UPDATE jobs SET started_at = datetime('now', '-20 minutes') WHERE id = ?").run(id);

  jobs.recoverStale({ staleMinutes: 15 });
  assert.strictEqual(row(id).state, 'queued');

  const res = await jobs.runOne();   // no handler → fails
  assert.strictEqual(res.state, 'failed',
    'attempts (1) >= max_attempts (1), so it terminates instead of looping');
  assert.strictEqual(row(id).state, 'failed');
});

// ---- JB9 — drain, one at a time, and the counters ------------------------------------------

test('JB9 drain works one job at a time and reports queue depth', async () => {
  reset();
  let concurrent = 0;
  let maxConcurrent = 0;
  jobs.register(`${TAG}-slow`, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    concurrent -= 1;
  });

  for (let i = 0; i < 4; i += 1) jobs.enqueue({ type: `${TAG}-slow` });

  const done = await jobs.drain();
  assert.strictEqual(done.length, 4);
  assert.strictEqual(maxConcurrent, 1, '§4.5: ONE job at a time in v1 — never overlap');

  const s = jobs.stats();
  assert.strictEqual(s.completed, 4);
  assert.strictEqual(s.queued, 0);
  assert.strictEqual(s.due, 0);
  assert.strictEqual(s.failed, 0);

  // An empty queue is not an error, and drain must bound its work.
  assert.deepStrictEqual(await jobs.drain(), []);
});

test('JB9b stats and oldestFailure describe a broken queue', async () => {
  reset();
  jobs.register(`${TAG}-dies`, async () => { throw new Error('nope'); });
  const id = jobs.enqueue({ type: `${TAG}-dies`, maxAttempts: 1 });
  await jobs.runOne();

  const s = jobs.stats();
  assert.strictEqual(s.failed, 1);
  const oldest = jobs.oldestFailure();
  assert.strictEqual(oldest.id, id);
  assert.strictEqual(oldest.type, `${TAG}-dies`);
  assert.match(oldest.last_error, /nope/);
  assert.ok(oldest.finished_at, 'so a screen can say how long it has been broken');
});

// ---- JB10 — the ticker ---------------------------------------------------------------------

test('JB10 the ticker can be started, is idempotent, and stops', async () => {
  reset();
  assert.strictEqual(jobs.runnerStatus().started, false, 'not running until asked');
  assert.strictEqual(jobs.runnerStatus().lastTickAt, null);

  let ticks = 0;
  jobs.register(`${TAG}-tick`, async () => { ticks += 1; });
  // The interval floor is lowered via env var in this file's header so a real tick can be driven.
  // `start()` reads it at call time, so it must be set before this line — not at require time.
  const started = jobs.start({
    intervalMs: 20,
    onTick: () => { jobs.enqueue({ type: `${TAG}-tick` }); },
  });
  assert.strictEqual(started, true);
  assert.strictEqual(jobs.runnerStatus().started, true);

  // Starting twice must not create a second timer: two timers would double every recurring enqueue.
  assert.strictEqual(jobs.start({ intervalMs: 20 }), false, 'a second start is refused');

  // Wait for a tick to actually happen, rather than sleeping a fixed guess. A fixed sleep makes
  // this test either flaky (too short) or slow (too long); polling makes it exact and fast.
  const deadline = Date.now() + 3000;
  while (ticks < 1 && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- polling a real timer
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(ticks >= 1, `the ticker actually ran (ticks=${ticks})`);
  assert.ok(jobs.runnerStatus().lastTickAt, 'a completed tick is timestamped for readiness');

  jobs.stop();
  assert.strictEqual(jobs.runnerStatus().started, false);
  const settled = ticks;
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(ticks, settled, 'after stop, nothing keeps running');
});

test('JB11 register refuses nonsense, and lists what is wired', () => {
  assert.throws(() => jobs.register('', () => {}), /non-empty string/);
  assert.throws(() => jobs.register(`${TAG}-x`, 'not a function'), /must be a function/);
  assert.ok(jobs.registeredTypes().includes(`${TAG}-ok`), 'registered types are discoverable');
});
