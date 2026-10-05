'use strict';
//
// The job runner — TECH-SPEC §4.5.
//
// ============================================================================================
// WHY THIS EXISTS
// ============================================================================================
// The `jobs` table has existed since migration 002 and NOTHING ever read or wrote it. That is
// measured, not assumed: `grep -rn 'FROM jobs\|INTO jobs\|UPDATE jobs' src/` returned nothing.
// So the schema was a promise with no implementation behind it — and PRD §4.4's alert table, the
// backup requirement (§4.2, RPO 1 hour) and the staged-file cleanup all assume a scheduler exists.
//
// This is that scheduler, and nothing more. It does not decide WHAT to run; it claims due rows and
// calls a registered handler. Alerts, backups and cleanup each register their own handler later.
//
// ============================================================================================
// THE RULES FROM §4.5, AND HOW EACH IS KEPT
// ============================================================================================
// * "Single-process runner claims due jobs with one short transaction."
//     → `claimDue()` is ONE UPDATE whose row selection is a subquery, so two callers cannot claim
//       the same row: the second one's subquery no longer sees it. No SELECT-then-UPDATE window.
// * "One job at a time in v1."
//     → `runOne()` claims at most one row. `drain()` loops runOne so a burst is worked through
//       sequentially, never in parallel.
// * "Job handlers are idempotent."
//     → enforced by the RETRY design below (a job WILL be re-run after a crash), not by hoping.
// * "Jobs move running → completed or failed; crash recovery returns stale running jobs to queued."
//     → `settleFailed()` re-queues while attempts remain; `recoverStale()` is called on boot.
// * "Exponential backoff; max attempts prevents infinite retry."
//     → `backoffSeconds()` doubles from 30s, capped at 30min; `attempts` is incremented AT CLAIM so
//       a crash cannot re-run a job forever without the counter moving.
//
// ============================================================================================
// THE SUBTLE PART: `attempts` IS INCREMENTED WHEN THE JOB IS CLAIMED
// ============================================================================================
// If the counter only moved on failure, a job that CRASHES the process (not throws — the process
// dies) would never be counted, and crash recovery would re-queue it forever. Counting at claim
// means every run is counted, however it ends. The cost is that a job which succeeds on its 3rd
// attempt has attempts=3, which is why success is decided by `state`, never by `attempts`.

const db = require('../db/db');

// type -> handler. A handler is `async (payload, job) => void`. It should be idempotent: it may run
// again after a crash, because the run that crashed was already counted but produced no record.
const handlers = new Map();

// Set when a job's `type` has no handler. Exported so a deployment check can assert the wiring
// rather than discovering it when a job silently fails at 3am.
const UNKNOWN_TYPE = 'No handler is registered for this job type.';

function register(type, fn) {
  if (typeof type !== 'string' || !type) throw new TypeError('A job type must be a non-empty string.');
  if (typeof fn !== 'function') throw new TypeError(`The handler for "${type}" must be a function.`);
  handlers.set(type, fn);
  return fn;
}

function registeredTypes() {
  return [...handlers.keys()].sort();
}

// ---- time helpers -------------------------------------------------------------------------
// All job times are SQLite `datetime('now')` strings — 'YYYY-MM-DD HH:MM:SS' in UTC. They compare
// correctly as text, which is what lets the claim and the stale-recovery queries stay one-liners.

/** Exponential backoff for the NEXT attempt. attempts=1 → 30s, 2 → 60s, 3 → 120s … capped. */
function backoffSeconds(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(30 * (2 ** (n - 1)), 1800);
}

// ---- enqueue ------------------------------------------------------------------------------

/**
 * Add a job. `runAt` is an optional SQLite datetime string; omitting it means "due now".
 * Returns the new job id.
 */
function enqueue({ type, payload = {}, runAt = null, maxAttempts = 3 } = {}) {
  if (typeof type !== 'string' || !type) throw new TypeError('enqueue needs a job type.');
  const info = db.prepare(`
    INSERT INTO jobs (type, payload_json, run_at, max_attempts)
    VALUES (@type, @payload_json, COALESCE(@run_at, datetime('now')), @max_attempts)`).run({
    type,
    payload_json: JSON.stringify(payload || {}),
    run_at: runAt,
    max_attempts: Number(maxAttempts) || 3,
  });
  return Number(info.lastInsertRowid);
}

// ---- claim --------------------------------------------------------------------------------

/**
 * Claim the next due job, or return null.
 *
 * ONE statement: the UPDATE both chooses and takes the row. A SELECT followed by an UPDATE would
 * leave a window in which a second process claims the same job, which is exactly the bug §4.5's
 * "one short transaction" wording is warning about.
 *
 * `attempts` is incremented HERE (see the note at the top of the file).
 */
function claimDue() {
  const row = db.prepare(`
    UPDATE jobs
       SET state = 'running',
           started_at = datetime('now'),
           attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs
                  WHERE state = 'queued' AND run_at <= datetime('now')
                  ORDER BY run_at, id
                  LIMIT 1)
    RETURNING *`).get();
  if (!row) return null;
  // Payload is text in the table; a corrupt value must not kill the runner before the handler is
  // even reached, so a bad parse becomes an empty object and the handler decides what to do.
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return { ...row, payload };
}

// ---- settle -------------------------------------------------------------------------------

function settleCompleted(id) {
  db.prepare(`UPDATE jobs SET state = 'completed', finished_at = datetime('now'),
                 last_error = NULL WHERE id = ?`).run(id);
}

/**
 * A run failed. Re-queue with backoff while attempts remain, otherwise fail for good.
 * Returns the state it moved to, so a caller (and a test) can assert which happened.
 *
 * `permanent: true` means "do not retry" — used for a job type nobody handles, where every retry
 * is certain to fail again. Retrying it would burn three attempts and ~90s of backoff to reach the
 * same conclusion, and would make a wiring bug look like a flaky job.
 */
function settleFailed(id, attempts, maxAttempts, message, { permanent = false } = {}) {
  const text = String(message || 'Job failed.').slice(0, 2000);
  if (!permanent && Number(attempts) < Number(maxAttempts)) {
    db.prepare(`UPDATE jobs
                   SET state = 'queued',
                       last_error = ?,
                       run_at = datetime('now', ?)
                 WHERE id = ?`).run(text, `+${backoffSeconds(attempts)} seconds`, id);
    return 'queued';
  }
  db.prepare(`UPDATE jobs SET state = 'failed', finished_at = datetime('now'),
                 last_error = ? WHERE id = ?`).run(text, id);
  return 'failed';
}

// ---- run ----------------------------------------------------------------------------------

/**
 * Claim and run at most one job. Returns a result object, or null when nothing was due.
 * Never throws for a handler's failure: a failing job must not take the runner down with it.
 */
async function runOne() {
  const job = claimDue();
  if (!job) return null;

  const handler = handlers.get(job.type);
  if (!handler) {
    // Deliberately a FAILURE, not a silent no-op. A job nobody handles is a wiring bug, and a
    // no-op would hide it while the queue drained and looked healthy. It is also PERMANENT: no
    // retry can conjure a handler into existence, so retrying would only delay the diagnosis.
    const state = settleFailed(job.id, job.attempts, job.max_attempts, UNKNOWN_TYPE,
      { permanent: true });
    return { id: job.id, type: job.type, state, error: UNKNOWN_TYPE };
  }

  try {
    await handler(job.payload, job);
    settleCompleted(job.id);
    return { id: job.id, type: job.type, state: 'completed' };
  } catch (err) {
    const message = (err && err.message) || String(err);
    const state = settleFailed(job.id, job.attempts, job.max_attempts, message);
    return { id: job.id, type: job.type, state, error: message };
  }
}

/**
 * Work through everything due, one at a time. Bounded by `limit` so a runaway enqueue loop cannot
 * hold the tick open forever.
 */
async function drain({ limit = 100 } = {}) {
  const done = [];
  for (let i = 0; i < limit; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- one job at a time is the §4.5 rule
    const res = await runOne();
    if (!res) break;
    done.push(res);
  }
  return done;
}

// ---- crash recovery -----------------------------------------------------------------------

/**
 * Return jobs left `running` by a process that died to `queued`.
 *
 * §4.5: "crash recovery returns stale running jobs to queued". This runs at boot, before the
 * ticker starts. The staleness window matters: too short and a slow handler's job is yanked out
 * from under it and run twice, too long and a crashed job waits. 15 minutes is well beyond any
 * handler this app has, and the handler must be idempotent either way.
 */
function recoverStale({ staleMinutes = 15 } = {}) {
  const info = db.prepare(`
    UPDATE jobs
       SET state = 'queued',
           last_error = COALESCE(last_error, 'Interrupted: the process stopped while this job ran.')
     WHERE state = 'running'
       AND started_at IS NOT NULL
       AND started_at <= datetime('now', ?)`).run(`-${Math.max(1, Number(staleMinutes) || 15)} minutes`);
  return info.changes;
}

// ---- status -------------------------------------------------------------------------------

/** Queue depth by state. `/health/ready` and `/system/health` read this (§4.3). */
function stats() {
  const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`).all();
  const out = { queued: 0, running: 0, failed: 0, completed: 0 };
  for (const r of rows) out[r.state] = r.n;
  out.due = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND run_at <= datetime('now')`)
    .get().n;
  return out;
}

/** Oldest still-failed job, so a UI can say HOW LONG something has been broken. */
function oldestFailure() {
  return db.prepare(
    `SELECT id, type, attempts, last_error, finished_at FROM jobs
      WHERE state = 'failed' ORDER BY finished_at LIMIT 1`).get() || null;
}

// ---- the ticker ---------------------------------------------------------------------------

// The floor on the tick interval. A caller may not schedule a hot loop by accident. It is also
// overridable by env var SPECIFICALLY so a test can drive a real tick without waiting 60 seconds —
// a ticker test that only asserts "start() returned true" proves the timer object was made, not
// that the tick does anything.
const MIN_TICK_MS = Number(process.env.PRACTIS_JOB_MIN_TICK_MS) || 1000;

let timer = null;
let lastTickAt = null;
let ticking = false;

/**
 * Start the recurring tick. `onTick` is where a caller enqueues its own recurring work (alert
 * checks, the hourly backup) — this module deliberately does not know what they are.
 *
 * The timer is `unref()`d: a scheduler must never be the reason a process refuses to exit, which
 * matters because the test harness boots the real server and then wants it to stop.
 */
function start({ intervalMs = 60_000, onTick = null } = {}) {
  if (timer) return false;
  timer = setInterval(async () => {
    // A tick that overruns its interval must not overlap the next one: overlapping runs would
    // break "one job at a time" and could double-enqueue the recurring work.
    if (ticking) return;
    ticking = true;
    try {
      if (typeof onTick === 'function') await onTick();
      await drain();
      lastTickAt = new Date().toISOString();
    } catch (err) {
      // A failed tick is logged and survived. The runner must not die because a producer did.
      console.error('[jobs] tick failed:', (err && err.message) || err);
    } finally {
      ticking = false;
    }
  }, Math.max(MIN_TICK_MS, Number(intervalMs) || 60_000));
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return true;
}

/**
 * Is the runner responsive? §4.3 puts "job runner responsive" in the readiness check.
 * `started` is false when the ticker was never started (the migration/test path).
 */
function runnerStatus() {
  return { started: !!timer, lastTickAt, ticking };
}

module.exports = {
  register,
  registeredTypes,
  enqueue,
  claimDue,
  settleCompleted,
  settleFailed,
  runOne,
  drain,
  recoverStale,
  backoffSeconds,
  stats,
  oldestFailure,
  start,
  stop,
  runnerStatus,
  UNKNOWN_TYPE,
};
