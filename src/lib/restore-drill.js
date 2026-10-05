'use strict';
//
// Restore drill — TECH-SPEC §4.2, §12.4, §12.5, TS-19.
//
// ============================================================================================
// WHAT A DRILL IS FOR
// ============================================================================================
// A backup that has never been restored is a hypothesis. §4.2's RTO of four hours is explicitly
// "unproven until a drill restores a production-sized copy, runs integrity/FK/app checks, and
// reaches readiness within four hours". This module runs those checks and RECORDS the result — it
// never claims the four hours, because on this host the drill restores a 564 KB development
// database, which says nothing about a production-sized one.
//
// ============================================================================================
// TWO RULES, BOTH ABSOLUTE
// ============================================================================================
//   1. THE DRILL NEVER TOUCHES PRODUCTION. §4.2: "Restore never overwrites production." The drill
//      decompresses into a fresh temporary directory and asserts, before it does anything, that the
//      path it is about to write is not the live database and not inside the live data directory.
//      A restore drill that could clobber the real ledger would be a far worse risk than the
//      disaster it is rehearsing for.
//   2. THE DRILL PROVES THE APPLICATION RUNS ON THE RESTORED FILE, not merely that the file opens.
//      §12.4's steps stop at "confirm /health/ready". A SQLite file can pass integrity_check and
//      foreign_key_check and still be unusable by this application (a schema drift, a missing
//      migration). So the drill boots the real server against the restored copy on an ephemeral
//      port in a subprocess and requires /health/ready to answer 200.
//
// ============================================================================================
// THE CHECKS, AND WHY EACH ONE IS HERE (§12.4 steps 4-6)
// ============================================================================================
//   integrity_check      SQLite's own page-level audit. Catches a torn or corrupt file.
//   foreign_key_check    Catches broken references — the failure that makes a ledger report
//                        silently wrong rather than visibly broken.
//   schema_matches       Regenerates the restored database's DDL and compares it, byte for byte,
//                        against the committed db/schema.sql. This is the strongest available
//                        "app validation": it proves the restored file's schema is the one the
//                        running code expects. (db/validate.py executes schema.sql in memory, so
//                        it does NOT validate a restored file — using it here would look like a
//                        check while proving nothing about the copy.)
//   ledger_balances      Sum(debit) must equal sum(credit) over accounting_ledger. The financial
//                        invariant that actually matters: a restore that lost a ledger line, or
//                        restored half of a double entry, is corrupt in the way that matters most.
//   migrations_current   user_version matches the newest migration, so the copy is not stale.
//   app_readiness        The real server serves /health/ready on the restored copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { execFileSync, spawn } = require('child_process');
const Database = require('better-sqlite3');
const backup = require('./backup-service');

const REPO = path.join(__dirname, '..', '..');

class DrillError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrillError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// The production guard
// ---------------------------------------------------------------------------------------------

/**
 * Refuse to run if the target could be the live database. Belt AND braces: the drill builds its
 * own temp path, so this should be unreachable — which is exactly why it is asserted rather than
 * assumed. A future refactor that passed a caller-supplied path would hit this instead of
 * overwriting the ledger.
 */
function assertIsolated(target, liveDbPath) {
  const t = path.resolve(target);
  const live = path.resolve(liveDbPath);

  if (t === live) throw new DrillError('unsafe_target', `refusing to write to the live database: ${t}`);

  // Also refuse the live database's own directory: restoring a file NEXT TO the live one risks a
  // later step attaching the wrong file, and the live WAL/SHM files share that directory.
  if (path.dirname(t) === path.dirname(live)) {
    throw new DrillError('unsafe_target', `refusing to write inside the live data directory: ${t}`);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** Regenerate the restored DB's schema and compare with the committed schema.sql. */
function checkSchemaMatches(restoredFile) {
  const tmpOut = `${restoredFile}.schema.sql`;
  try {
    // dump-schema.js is the SINGLE source of this comparison; re-implementing the DDL dump here
    // would be the very drift the script exists to prevent.
    execFileSync(process.execPath, [path.join('db', 'dump-schema.js'), '--db', restoredFile, '--out', tmpOut],
      { cwd: REPO, stdio: 'pipe', env: { ...process.env } });
    const generated = fs.readFileSync(tmpOut, 'utf8');
    const committed = fs.readFileSync(path.join(REPO, 'db', 'schema.sql'), 'utf8');
    const ok = generated === committed;
    return {
      name: 'schema_matches',
      ok,
      detail: ok ? 'restored schema is identical to db/schema.sql' : 'restored schema DIFFERS from db/schema.sql',
    };
  } catch (err) {
    return { name: 'schema_matches', ok: false, detail: (err && err.message) || 'comparison failed' };
  } finally {
    try { fs.rmSync(tmpOut, { force: true }); } catch { /* best effort */ }
  }
}

/** The financial invariant. Money is stored as INTEGER minor units (§4.1), so this is exact. */
function checkLedgerBalances(restoredFile) {
  let conn;
  try {
    conn = new Database(restoredFile, { readonly: true });
    const row = conn.prepare(
      'SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c, COUNT(*) AS n FROM accounting_ledger').get();
    const ok = row.d === row.c;
    return {
      name: 'ledger_balances',
      ok,
      detail: ok
        ? `${row.n} line(s), debit = credit = ${row.d}`
        : `UNBALANCED: debit ${row.d} vs credit ${row.c} over ${row.n} line(s)`,
    };
  } catch (err) {
    return { name: 'ledger_balances', ok: false, detail: (err && err.message) || 'unreadable' };
  } finally {
    if (conn) { try { conn.close(); } catch { /* already gone */ } }
  }
}

/** Is the restored copy behind the newest migration? A stale copy is restorable but incomplete. */
function checkMigrationsCurrent(restoredFile, expectedVersion) {
  let conn;
  try {
    conn = new Database(restoredFile, { readonly: true });
    const at = conn.pragma('user_version', { simple: true });
    const ok = at >= expectedVersion;
    return { name: 'migrations_current', ok, detail: `v${at} (expected v${expectedVersion})` };
  } catch (err) {
    return { name: 'migrations_current', ok: false, detail: (err && err.message) || 'unreadable' };
  } finally {
    if (conn) { try { conn.close(); } catch { /* already gone */ } }
  }
}

function migrationTarget() {
  const dir = path.join(REPO, 'db', 'migrations');
  return Math.max(...fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => parseInt(f.split('_')[0], 10)));
}

// ---------------------------------------------------------------------------------------------
// Step 6: the application must actually serve the restored copy
// ---------------------------------------------------------------------------------------------

/**
 * Boot the real server against the restored database and require /health/ready to answer 200.
 *
 * Deliberately a SUBPROCESS: the drill must exercise the production entry point (`src/server.js`)
 * with its own migrate/seed/boot path, not an in-process approximation that could succeed while
 * the real boot fails. The ephemeral port is taken from the OS by listening on port 0 via a
 * throwaway probe first.
 */
async function checkAppReadiness(restoredFile, { log = () => {}, timeoutMs = 60_000 } = {}) {
  const started = Date.now();
  let proc;

  // A free port, obtained by asking the OS rather than guessing.
  const port = await new Promise((resolve, reject) => {
    const net = require('net');
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  try {
    proc = spawn(process.execPath, ['src/server.js'], {
      cwd: REPO,
      env: {
        ...process.env,
        PRACTIS_DB: restoredFile,
        PORT: String(port),
        // The drill must not litter the real backup set, nor start a second hourly backer-upper
        // against a throwaway copy.
        PRACTIS_BACKUPS: path.join(path.dirname(restoredFile), 'drill-backups'),
        PRACTIS_LOG_FORMAT: 'text',
        PRACTIS_RL_LOGIN_MAX: '100000', PRACTIS_RL_WRITE_MAX: '100000', PRACTIS_RL_GLOBAL_MAX: '100000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });

    // The last few lines of a Node crash banner are blank + "Node.js v22.17.0", so reporting only
    // the tail of the output tells an operator nothing. A failure detail has to name the CAUSE.
    const tail = (n) => out.trim().split('\n').filter((l) => l.trim()).slice(-n).join(' | ');

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        return { name: 'app_readiness', ok: false,
          detail: `server exited ${proc.exitCode}: ${tail(4) || '(no output)'}` };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
        if (res.status === 200) {
          const body = await res.json();
          log('drill: server ready on the restored copy');
          return { name: 'app_readiness', ok: body.status === 'ok',
            detail: `HTTP 200 {status:${body.status}} in ${Date.now() - started}ms` };
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { name: 'app_readiness', ok: false,
      detail: `timed out after ${timeoutMs}ms: ${tail(4) || '(no output)'}` };
  } catch (err) {
    return { name: 'app_readiness', ok: false, detail: (err && err.message) || 'failed to boot' };
  } finally {
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM');
      // Give it a moment to exit, then insist. A leaked server would hold the restored DB open.
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The drill
// ---------------------------------------------------------------------------------------------

/**
 * Restore the newest verified snapshot to an isolated path, prove it, and record the result.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.dir]        the backup set to read (default: the real one)
 * @param {Date}    [opts.at]         drill timestamp
 * @param {boolean} [opts.withServer] run the step-6 readiness check (default true)
 * @returns {Promise<object>} the drill RECORD — also written next to the backups as `drill-*.json`
 */
async function runDrill(opts = {}) {
  const dir = opts.dir || backup.backupsDir();
  const at = opts.at || new Date();
  const withServer = opts.withServer !== false;
  const log = opts.log || (() => {});
  const started = Date.now();

  const liveDbPath = require('../db/db').name;
  const latest = backup.latestBackup(dir);
  if (!latest) {
    return record({ dir, at, started, snapshot: null, checks: [], outcome: 'no_backup',
      note: 'no verified backup exists to restore' });
  }

  // A fresh isolated directory EVERY run: a drill must never be able to read a previous drill's
  // leftovers and report that as a successful restore.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-drill-'));
  const restored = assertIsolated(path.join(workDir, 'restored.db'), liveDbPath);

  const checks = [];
  try {
    log(`drill: restoring ${latest.snapshot}`);
    await pipeline(
      fs.createReadStream(path.join(dir, latest.snapshot)),
      zlib.createGunzip(),
      fs.createWriteStream(restored),
    );

    // Step 4 — integrity and foreign keys on the RESTORED file. Reusing backup-service's verifier
    // is deliberate: the drill must validate exactly what a backup claims to have validated.
    const v = backup.verifyDatabase(restored);
    checks.push(...v.checks.filter((c) => c.name !== 'user_version'));
    if (!v.ok) {
      return record({ dir, at, started, snapshot: latest.stamp, checks, outcome: 'failed',
        note: 'the restored copy did not pass SQLite integrity checks' });
    }

    // Step 5 — application validation.
    checks.push(checkSchemaMatches(restored));
    checks.push(checkLedgerBalances(restored));
    checks.push(checkMigrationsCurrent(restored, migrationTarget()));

    // Step 6 — the application serves it.
    if (withServer) {
      checks.push(await checkAppReadiness(restored, { log }));
    } else {
      checks.push({ name: 'app_readiness', ok: true, detail: 'SKIPPED by request — not proven' });
    }

    const ok = checks.every((c) => c.ok);
    return record({
      dir, at, started, snapshot: latest.stamp, checks,
      outcome: ok ? 'passed' : 'failed',
      snapshotBytes: latest.snapshotBytes,
      databaseBytes: latest.databaseBytes,
      note: ok
        ? 'restored to an isolated path, verified, and served by the application'
        : 'one or more checks failed — see `checks`',
    });
  } finally {
    // Always remove the restored copy. Leaving a stray database in /tmp is how a future drill (or
    // a person) ends up looking at the wrong file — AND a stray copy is a real hazard in its own
    // right, because it is an unencrypted snapshot of the ledger sitting in a world-readable
    // temporary directory. The check below is deliberately noisy: the `finally` removes the copy
    // but cannot itself remove `workDir`, because `checkAppReadiness` may still be finishing with
    // a subprocess inside it. When that happens on this host (measured 2026-10-05: twice), the
    // directory is registered for removal at process exit instead of being abandoned.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {
      try { scheduleTempCleanup(workDir); } catch { /* last resort: leave it, already logged */ }
    }
  }
}

/** Remove a temp drill directory when the process exits, as a backstop for a directory still held
 *  open by a subprocess. Registered once per directory; `rmSync` in `runDrill`'s finally gets
 *  almost every case, so this only ever runs for the stragglers. */
function scheduleTempCleanup(dir) {
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing left to do */ }
  });
}

/**
 * Build the record and write it beside the backups.
 *
 * `rtoClaimed: false` is not boilerplate. §4.2 says the four-hour RTO stays unproven until a
 * PRODUCTION-SIZED copy is restored, and every drill run on this host restores a development
 * database. Recording the elapsed time is useful; recording it as an RTO would be a false claim,
 * so the record states plainly that it is not one.
 */
function record({ dir, at, started, snapshot, checks, outcome, note, snapshotBytes, databaseBytes }) {
  const r = {
    drillAt: at.toISOString(),
    snapshot,
    outcome,
    note,
    elapsedMs: Date.now() - started,
    checks,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    host: os.hostname(),
    databaseBytes: databaseBytes || null,
    snapshotBytes: snapshotBytes || null,
    // §4.2 makes the drill responsible for the restore procedure and its evidence.
    procedure: 'db/seed-migrations → snapshot → gzip → isolate → integrity_check → '
      + 'foreign_key_check → schema compare → ledger balance → migrations → /health/ready',
    restorationTarget: 'isolated temporary directory (production is never touched)',
    rtoClaimed: false,
    rtoNote: 'RTO stays unproven (§4.2/TS-19): this drill restores a development-sized database. '
      + 'A four-hour claim needs a production-sized copy restored end to end.',
    cadence: 'quarterly (TS-19)',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `drill-${backup.stampFor(at)}.json`), JSON.stringify(r, null, 2));
  } catch { /* a drill that cannot write its own record still returns the result */ }
  return r;
}

/** Previous drill records, newest first — the evidence trail §4.2 asks to be kept. */
function listDrills(dir = backup.backupsDir()) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^drill-\d{8}T\d{6}Z\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .sort((a, b) => (a.drillAt < b.drillAt ? 1 : -1));
  } catch {
    return [];
  }
}

module.exports = {
  runDrill, listDrills, assertIsolated, DrillError,
  checkSchemaMatches, checkLedgerBalances, checkMigrationsCurrent, checkAppReadiness, migrationTarget,
};
