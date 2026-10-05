'use strict';
//
// Health and readiness — TECH-SPEC §4.3, TS-23.
//
// ============================================================================================
// WHY THE PUBLIC AND ADMIN SHAPES ARE SEPARATE FUNCTIONS
// ============================================================================================
// §4.3: `/health` "public returns MINIMAL status; no version stack, paths, or secrets to
// unauthenticated networks", while `/system/health` is the Administrator detail page carrying
// "backup age, disk free, queue depth". Those are two different audiences with two different
// threat models, so they are two functions — `ready()`/`live()` return a status word, `detail()`
// returns the diagnostics. A single function with a `verbose` flag is how a path leaks.
//
// ============================================================================================
// THE CHECK THAT ALMOST NEVER FIRES
// ============================================================================================
// /health/ready must report DISK FREE, and on this host the obvious way to write it is wrong.
// The root filesystem holds the Hermes runtime and is a small overlay that sits near-full; the
// repository, the database and therefore all future backups live on /opt/data, a much larger
// volume. Measuring `/` would alarm about a filesystem that PRACTIS does not write to and cannot
// fill. So the check measures free space on the filesystem holding THE DATABASE — read from the
// live connection's own path (`db.name`) rather than from a second copy of the path rule.

const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const jobs = require('./jobs');

// The schema the process is running against. Derived from db/migrations (the single source of
// truth migrate.js uses) rather than a hand-kept constant that silently drifts.
const MIG_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const SCHEMA_VERSION = (() => {
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.+\.sql$/.test(f));
  return Math.max(...files.map((f) => parseInt(f.split('_')[0], 10)));
})();

// Free space below which the box is treated as unable to take a backup safely (§4.2: "refuse or
// alert before a backup can exhaust the application disk"). Overridable so a drill can prove the
// check FIRES — a threshold that has never been seen to trip is not a tested threshold.
const DISK_WARN_BYTES = Number(process.env.PRACTIS_DISK_WARN_BYTES) || 512 * 1024 * 1024;

// A tick interval of 60s means a healthy runner's lastTickAt is at most ~a minute old. Five
// minutes of silence is stalled, not merely busy.
const RUNNER_STALL_MS = 5 * 60 * 1000;
// If the queue projects to more than this to clear, the runner is not keeping up.
const BACKLOG_MAX_MS = 5 * 60 * 1000;
// What one job costs when projecting drain time. Deliberately pessimistic: a false "not ready" is
// cheaper than a false "ready".
const PER_JOB_MS = 30_000;

const STARTED_AT = new Date();

function checkDbReachable() {
  try {
    db.prepare('SELECT 1 AS ok').get();
    return { name: 'database', ok: true, detail: 'reachable' };
  } catch (err) {
    return { name: 'database', ok: false, detail: (err && err.message) || 'unreachable' };
  }
}

function checkForeignKeys() {
  try {
    const on = db.pragma('foreign_keys', { simple: true }) === 1;
    return { name: 'foreign_keys', ok: on, detail: on ? 'on' : 'off' };
  } catch (err) {
    return { name: 'foreign_keys', ok: false, detail: (err && err.message) || 'unknown' };
  }
}

function checkSchemaVersion() {
  try {
    const at = db.pragma('user_version', { simple: true });
    const ok = at >= SCHEMA_VERSION;
    return { name: 'schema', ok, detail: `v${at} (expected v${SCHEMA_VERSION})` };
  } catch (err) {
    return { name: 'schema', ok: false, detail: (err && err.message) || 'unknown' };
  }
}

/** Free bytes on the filesystem holding the database. Exported so a drill can assert the value. */
function diskFreeBytes() {
  const s = fs.statfsSync(path.dirname(db.name));
  return s.bavail * s.bsize;
}

function checkDisk() {
  try {
    const free = diskFreeBytes();
    const ok = free >= DISK_WARN_BYTES;
    const mb = Math.round(free / 1048576);
    const need = Math.round(DISK_WARN_BYTES / 1048576);
    return { name: 'disk', ok, detail: ok ? `${mb} MB free` : `${mb} MB free (below ${need} MB)` };
  } catch (err) {
    return { name: 'disk', ok: false, detail: (err && err.message) || 'unstatable' };
  }
}

// The runner is responsive when it was started, does not have jobs waiting behind a dead tick,
// and is not facing a projected drain longer than BACKLOG_MAX_MS.
function checkRunner() {
  try {
    const status = jobs.runnerStatus();
    const queue = jobs.stats();
    if (!status.started) {
      return { name: 'job_runner', ok: false, detail: 'not started' };
    }
    const ageMs = status.lastTickAt ? Date.now() - Date.parse(status.lastTickAt) : null;
    if (queue.due > 0 && ageMs !== null && ageMs > RUNNER_STALL_MS) {
      return {
        name: 'job_runner', ok: false,
        detail: `${queue.due} due job(s) and the last tick was ${Math.round(ageMs / 1000)}s ago`,
      };
    }
    const drainMs = queue.due * PER_JOB_MS;
    if (drainMs > BACKLOG_MAX_MS) {
      return {
        name: 'job_runner', ok: false,
        detail: `${queue.due} due job(s) project to ${Math.round(drainMs / 1000)}s to clear`,
      };
    }
    return { name: 'job_runner', ok: true, detail: `idle, ${queue.due} due, ${queue.failed} failed` };
  } catch (err) {
    return { name: 'job_runner', ok: false, detail: (err && err.message) || 'unknown' };
  }
}

/** Liveness: is the process up? Deliberately touches NOTHING — no DB, no disk (§4.3). */
function live() {
  return { status: 'ok' };
}

/**
 * Readiness: the five checks §4.3 lists. Minimal body — a status word and, when it fails, the
 * NAMES of the failing checks (never their detail, which can name paths and versions).
 */
function ready() {
  const checks = readinessChecks();
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return failed.length === 0
    ? { status: 'ok' }
    : { status: 'error', failed };
}

function readinessChecks() {
  return [checkDbReachable(), checkForeignKeys(), checkSchemaVersion(), checkDisk(), checkRunner()];
}

/**
 * The Administrator detail view (§4.3/TS-23): every check with its reason, plus queue depth,
 * backup age, uptime and migration version.
 *
 * `backupAgeSeconds` is the REAL age measured from the backup set (module 9 part 9.4). It is null
 * when no backup exists, and the page must render that as UNKNOWN rather than as 0 — `0` would mean
 * "a backup finished this second", so reporting a missing backup as `0` would show the healthiest
 * possible number for the most dangerous state. `backupOverdue` is TS-14's RPO of one hour
 * expressed as a flag, and is what part 9.3 turns into an alert.
 */
function detail(extra = {}) {
  const checks = readinessChecks();
  return {
    status: checks.every((c) => c.ok) ? 'ok' : 'error',
    checks,
    queue: jobs.stats(),
    oldestFailure: jobs.oldestFailure(),
    runner: jobs.runnerStatus(),
    schemaVersion: SCHEMA_VERSION,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    diskFreeBytes: (() => { try { return diskFreeBytes(); } catch { return null; } })(),
    backupAgeSeconds: backupAgeSeconds(),
    backupOverdue: isBackupOverdue(),
    backup: backupSummary(),
    registeredJobTypes: jobs.registeredTypes(),
  };
}

/** Age of the newest verified backup, in seconds, or null when there is none. */
function backupAgeSeconds() {
  try {
    return require('./backup-service').backupAgeSeconds();
  } catch {
    // A failure to read the backup directory must not take the health page down — the page is
    // what an operator opens when something is already wrong.
    return null;
  }
}

function isBackupOverdue() {
  try {
    return require('./backup-service').isOverdue();
  } catch {
    return true; // unknown is reported as overdue, never as fine
  }
}

/** The backup set, summarised for the admin page. */
function backupSummary() {
  try {
    const b = require('./backup-service');
    const r = b.retentionReport();
    const latest = b.latestBackup();
    return {
      total: r.totalSnapshots,
      newest: r.newest,
      oldest: r.oldest,
      totalBytes: r.totalBytes,
      supersededCount: r.supersededCount,
      withinLimit: r.withinLimit,
      referenceCount: r.referenceCount,
      maxReferences: r.maxReferences,
      tiers: r.tiers,
      latestUserVersion: latest ? latest.userVersion : null,
      latestComponents: latest ? latest.components : [],
      dir: b.backupsDir(),
    };
  } catch (err) {
    return { error: (err && err.message) || 'unreadable', total: 0 };
  }
}

module.exports = {
  live, ready, detail, readinessChecks, diskFreeBytes,
  SCHEMA_VERSION, DISK_WARN_BYTES, RUNNER_STALL_MS, PER_JOB_MS, STARTED_AT,
};
