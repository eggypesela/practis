'use strict';
//
// Backup service — TECH-SPEC §4.2, TS-13, TS-14, TS-19.
//
// ============================================================================================
// WHAT THIS IS FOR
// ============================================================================================
// PRACTIS holds a real, auditable ledger. Until this part existed the application had NO
// recovery copy at all: the only backups on the box were hand-made `practis-before-NNN.db` files
// taken before individual migrations. TS-14 locks an RPO of one hour — "at most the work since
// the last successful hourly snapshot may be lost" — which is a promise the application could
// not keep. This module is that promise.
//
// ============================================================================================
// THE RULE THAT SHAPES EVERYTHING HERE: THE TARGET IS NEVER TOUCHED
// ============================================================================================
// §4.2: "Backup job never writes to or overwrites production DB." So this module only ever
// READS the live database and WRITES into the backups directory. It has no code path that
// opens the live database for writing, deletes a live file, or renames anything over the top of
// it. `test/backup.test.js` BA4 asserts the live DB's bytes are unchanged by a backup run.
//
// The snapshot itself is taken with better-sqlite3's `backup()`, which is SQLite's ONLINE BACKUP
// API. §4.2 is explicit that copying the live `.db`/`-wal`/`-shm` files is forbidden: a `cp` of a
// WAL database in the middle of a write produces a torn, unrecoverable file that looks fine
// until the day it is needed. `backup()` instead uses SQLite's own page-by-page copy under a
// read lock, so the result is transactionally consistent by construction.
//
// ============================================================================================
// VERIFY BEFORE TRUST (§4.2: "Verify new backup before retention cleanup")
// ============================================================================================
// A backup nobody has ever opened is a hope, not a backup. So creation is not "make a file"; it
// is "make a file and then PROVE it":
//
//   1. snapshot to a temporary name      (`*.db.part`, so an interrupted run cannot be mistaken
//                                         for a finished backup)
//   2. open the SNAPSHOT and check        `PRAGMA integrity_check` must be 'ok' and
//                                         `PRAGMA foreign_key_check` must be empty
//   3. gzip the snapshot
//   4. decompress the .gz back out and    proves the COMPRESSED artifact — the thing actually kept
//      check it again                     — is intact and still a valid DB, not just that the
//                                         pre-compression copy was
//   5. write the manifest LAST, atomically (write `*.json.part`, then rename). The manifest is the
//                                         "this backup is trustworthy" marker, so it must not exist
//                                         before the checks pass. `listBackups()` only reports
//                                         snapshots that HAVE a manifest.
//
// Every check that ran, and its result, is recorded in the manifest — so a later reader can tell
// what was actually proven about this file rather than assuming.
//
// ============================================================================================
// RETENTION: TIERING AND A REPORT, BUT NO DELETION — DELIBERATELY
// ============================================================================================
// §4.2: "Automatic retention deletion stays disabled until user explicitly approves deletion and
// tested restore. Proposed retention above is not deletion authority."
//
// So this module can DESCRIBE the retained set (which snapshots fill the 24 hourly / 7 daily /
// 4 weekly / 12 monthly tiers, and which are currently superseded) and it can COUNT what could
// be freed — but it contains no `unlink`. That is not an oversight and not a TODO: an automatic
// prune here would be the application quietly destroying the only recovery copies of a financial
// ledger, on the strength of a proposal that was never approved. Deleting is a separate,
// explicit, approved act, and it must come after a tested restore. `test/backup.test.js` BA7
// asserts the file count is unchanged by running the retention report.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const db = require('../db/db');

// ---------------------------------------------------------------------------------------------
// Locations and limits
// ---------------------------------------------------------------------------------------------

/** Where snapshots live. Overridable so a test (or a restore drill) can use a throwaway
 *  directory and never pollute the real backup set.
 *
 *  The default is derived from THE DATABASE'S OWN LOCATION rather than hard-coded, and that is a
 *  correctness fix rather than a convenience. The backup job runs on every boot, and 26 test files
 *  in this suite boot the real server against a temp database; a hard-coded `data/backups` default
 *  meant each of them wrote throwaway snapshots into the REAL backup set — and, within the same
 *  second, could have produced several identically-named snapshots. Deriving it from `db.name`
 *  gives the production path (`<data>/backups`, i.e. exactly the documented location) while every
 *  test's snapshots land inside that test's own temporary directory and are cleaned up with it. */
function backupsDir() {
  if (process.env.PRACTIS_BACKUPS) return process.env.PRACTIS_BACKUPS;
  try {
    const live = db.name; // better-sqlite3 resolves the path it actually opened
    // `:memory:` and any non-absolute path have no directory to put a sibling in.
    if (live && live !== ':memory:' && path.isAbsolute(live)) {
      return path.join(path.dirname(live), 'backups');
    }
  } catch { /* fall through to the fixed default */ }
  return path.join(__dirname, '..', '..', 'data', 'backups');
}

function importsDir() {
  return process.env.PRACTIS_IMPORTS || path.join(__dirname, '..', '..', 'data', 'imports');
}

/** §4.2's tiers. A maximum of 24 + 7 + 4 + 12 = 47 REFERENCES, though the same snapshot may
 *  satisfy several tiers at once (see `assignTiers`) — so this is a ceiling on the report, not a
 *  count of files to keep. */
const TIERS = { hourly: 24, daily: 7, weekly: 4, monthly: 12 };
const MAX_REFERENCES = TIERS.hourly + TIERS.daily + TIERS.weekly + TIERS.monthly; // 47

/**
 * The floor of free space a backup needs before it will start.
 *
 * §4.2: "Refuse/alert before backup can exhaust application disk." A full snapshot needs room for
 * the snapshot copy AND the gzip output AND (during verification) a decompressed copy — so the
 * requirement scales with the database, it is not a fixed number. `MIN_FREE_BYTES` is the
 * absolute floor; `FREE_FACTOR` covers the working copies of a large database.
 */
function minFreeBytes() {
  return Number(process.env.PRACTIS_MIN_FREE_BYTES) || 512 * 1024 * 1024;
}
function freeFactor() {
  return Number(process.env.PRACTIS_BACKUP_FREE_FACTOR) || 3;
}

// ---------------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------------

/** `20261005T043000Z` — UTC, filesystem-safe, lexicographically sortable, so `ls` is chronological
 *  and a plain string sort is a time sort. (SQLite's own `datetime()` uses a space, which is
 *  awkward in filenames.) */
function stampFor(at = new Date()) {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** The stamp of a snapshot filename, or null when the name is not ours. */
function stampOf(file) {
  const m = /^practis-(\d{8}T\d{6}Z)\.db\.gz$/.exec(file);
  return m ? m[1] : null;
}

function snapshotPath(stamp) {
  return path.join(backupsDir(), `practis-${stamp}.db.gz`);
}
function manifestPath(stamp) {
  return path.join(backupsDir(), `practis-${stamp}.manifest.json`);
}

class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------------------------

function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function dirSizeBytes(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    // `.part` files are transient working copies — they are excluded so the reported size and the
    // disk guard's arithmetic describe the KEPT backup set, not a mid-run snapshot of it.
    if (f.includes('.part')) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) total += st.size;
    } catch { /* a file removed mid-listing is not an error here */ }
  }
  return total;
}

/** The checks §12.4 steps 4–5 require of any copy before it is trusted. Exported because the
 *  restore drill must run EXACTLY this, not a re-implementation of it. */
function verifyDatabase(file) {
  const checks = [];
  let conn;
  try {
    conn = new Database(file, { readonly: true });
    const integrity = conn.pragma('integrity_check', { simple: true });
    checks.push({ name: 'integrity_check', ok: integrity === 'ok', detail: String(integrity) });

    const fk = conn.pragma('foreign_key_check');
    checks.push({
      name: 'foreign_key_check',
      ok: fk.length === 0,
      detail: fk.length === 0 ? 'no violations' : `${fk.length} violation(s)`,
    });

    const version = conn.pragma('user_version', { simple: true });
    checks.push({ name: 'user_version', ok: true, detail: `v${version}`, version });
    return { ok: checks.every((c) => c.ok), checks, userVersion: version };
  } catch (err) {
    checks.push({ name: 'open', ok: false, detail: (err && err.message) || 'unreadable' });
    return { ok: false, checks, userVersion: null };
  } finally {
    if (conn) { try { conn.close(); } catch { /* already gone */ } }
  }
}

/** Remove a file and any `-shm`/`-wal` sidecars SQLite leaves next to it.
 *
 *  TRAP: opening a database — even `readonly: true` — causes SQLite to create `<file>-shm` and
 *  `<file>-wal` beside it. So removing only the path you passed leaves two small files behind on
 *  every run, and because the verification steps open TWO databases per backup (the snapshot and
 *  the decompressed round-trip) that is four stray files each hour, forever. They are invisible to
 *  readers but they are counted by `dirSizeBytes`, so the disk guard's arithmetic drifts upward. */
function removeDbFiles(base) {
  for (const f of [base, `${base}-shm`, `${base}-wal`, `${base}-journal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Creating a backup
// ---------------------------------------------------------------------------------------------

/**
 * Take, verify, compress and record one snapshot.
 *
 * Order matters and is deliberate: the manifest is written LAST, because its presence is what
 * `listBackups()` treats as "this backup passed verification". An interrupted run leaves a
 * `.part` file and no manifest, which is invisible to every reader — a half-written backup that
 * looks usable is far more dangerous than no backup, because it is only discovered during a
 * recovery.
 *
 * @returns {Promise<object>} the manifest of the completed, verified backup
 * @throws  {BackupError} code `insufficient_disk` | `verification_failed` | `not_a_database`
 */
async function createBackup(opts = {}) {
  const at = opts.at || new Date();
  const source = opts.db || db;
  const dest = opts.dir || backupsDir();
  const log = opts.log || (() => {});

  fs.mkdirSync(dest, { recursive: true });

  const stamp = stampFor(at);
  const finalGz = path.join(dest, `practis-${stamp}.db.gz`);
  const manifestFile = path.join(dest, `practis-${stamp}.manifest.json`);
  // Temporary names carry `.part`. Nothing reads them, and a crash leaves one behind rather than
  // something that could be mistaken for a finished backup.
  const partDb = path.join(dest, `practis-${stamp}.db.part`);
  const partGz = `${finalGz}.part`;
  const partManifest = `${manifestFile}.part`;
  // Where the decompressed round-trip check is written. Removed in `finally`.
  const roundTrip = path.join(dest, `practis-${stamp}.verify.part`);

  const dbBytes = fs.statSync(source.name).size;

  // ---- the disk guard (§4.2) -------------------------------------------------------------
  // Checked BEFORE any writing, and against the filesystem that will RECEIVE the files — which is
  // the backups volume, not necessarily the database's. A backup that runs the disk out of space
  // takes the application down with it, so refusing is the safe failure.
  const need = Math.max(minFreeBytes(), dbBytes * freeFactor());
  const have = freeBytes(dest);
  if (have < need) {
    throw new BackupError('insufficient_disk',
      `refusing to back up: ${Math.round(have / 1048576)} MB free in ${dest}, ` +
      `need ${Math.round(need / 1048576)} MB (db is ${Math.round(dbBytes / 1024)} KB × ` +
      `${freeFactor()}, floor ${Math.round(minFreeBytes() / 1048576)} MB)`);
  }

  const started = Date.now();
  try {
    // ---- 1. the consistent snapshot, via SQLite's own online backup API ------------------
    // NOT a file copy: §4.2 forbids copying a live WAL database, and rightly — a copy taken
    // mid-write is torn in a way that is silent until recovery.
    log('backup: snapshotting');
    await source.backup(partDb);

    // ---- 2. prove the SNAPSHOT is a consistent database ----------------------------------
    log('backup: verifying snapshot');
    const snapshotCheck = verifyDatabase(partDb);
    if (!snapshotCheck.ok) {
      const why = snapshotCheck.checks.filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`).join('; ');
      throw new BackupError('verification_failed', `snapshot failed verification — ${why}`);
    }

    const rawBytes = fs.statSync(partDb).size;
    const rawSha = sha256File(partDb);

    // ---- 3. compress ---------------------------------------------------------------------
    // Streamed, not read into a Buffer: this box has 2 GB of RAM and no swap, and a
    // production-sized database would not fit in memory.
    log('backup: compressing');
    await pipeline(fs.createReadStream(partDb), zlib.createGzip({ level: 6 }),
      fs.createWriteStream(partGz));

    // ---- 4. prove the COMPRESSED artifact round-trips ------------------------------------
    // The file we keep is the .gz, so that is the one that has to be proven. Verifying only the
    // pre-compression copy would leave the possibility that the compression itself was corrupt.
    log('backup: verifying compressed artifact');
    await pipeline(fs.createReadStream(partGz), zlib.createGunzip(),
      fs.createWriteStream(roundTrip));
    const roundBytes = fs.statSync(roundTrip).size;
    const roundCheck = verifyDatabase(roundTrip);
    if (roundBytes !== rawBytes || !roundCheck.ok) {
      const why = roundBytes !== rawBytes
        ? `decompressed to ${roundBytes} bytes, expected ${rawBytes}`
        : roundCheck.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
      throw new BackupError('verification_failed', `compressed artifact failed verification — ${why}`);
    }

    // ---- 5. publish, then record ---------------------------------------------------------
    fs.renameSync(partGz, finalGz);

    const gzBytes = fs.statSync(finalGz).size;
    const manifest = {
      stamp,
      createdAt: at.toISOString(),
      snapshot: path.basename(finalGz),
      snapshotBytes: gzBytes,
      snapshotSha256: sha256File(finalGz),
      databaseBytes: rawBytes,
      databaseSha256: rawSha,
      userVersion: snapshotCheck.userVersion,
      appVersion: readAppVersion(),
      // §4.2: the backup SET includes the database, a secret-file reference (never the value),
      // the confirmed import originals, report artifacts, and the app version. What is actually
      // present on this deployment is recorded honestly rather than implied — an absent component
      // is listed with `included: false` and the reason, so a reader is never misled about what
      // a restore would recover.
      components: describeComponents(dest),
      verification: {
        snapshot: snapshotCheck.checks,
        compressedArtifact: roundCheck.checks,
        roundTripBytes: roundBytes,
      },
      durationMs: Date.now() - started,
      backupsDirBytesAfter: dirSizeBytes(dest),
      diskFreeBytesAfter: freeBytes(dest),
      host: require('os').hostname(),
    };
    fs.writeFileSync(partManifest, JSON.stringify(manifest, null, 2));
    fs.renameSync(partManifest, manifestFile);

    log(`backup: done ${stamp} (${Math.round(gzBytes / 1024)} KB)`);
    return manifest;
  } finally {
    // Remove every temporary, whatever happened. `.part` files are invisible to readers, but
    // leaving them would slowly fill the disk that backups are supposed to be surviving. The
    // `-shm`/`-wal` sidecars matter too — see `removeDbFiles`.
    removeDbFiles(partDb);
    removeDbFiles(roundTrip);
    for (const f of [partDb, partGz, partManifest, roundTrip]) {
      try { fs.rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  }
}

/** The app version, for the manifest. Read defensively: a missing or malformed package.json must
 *  not be able to fail a backup. */
function readAppVersion() {
  try {
    return require('../../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * §4.2's backup SET, itemised with what this deployment actually has.
 *
 * This is deliberately explicit about absences. "Backup set includes an encrypted offsite copy"
 * is in the spec, and this deployment does NOT have one — it needs a destination host and a key,
 * which is an open decision (§3.8). Recording `included: false` with the reason means a future
 * reader (or a restore drill) can see the gap from the backup itself, instead of discovering it
 * during a disaster when the offsite copy turns out never to have existed.
 */
function describeComponents(dest) {
  const components = [];

  components.push({ name: 'database', included: true, detail: 'consistent snapshot, verified' });

  // Import originals: the confirmed CSVs an import was built from. Small, and without them an
  // import cannot be re-derived after a restore.
  const imports = importsDir();
  let importCount = 0;
  try {
    importCount = fs.readdirSync(imports).filter((f) => f.endsWith('.csv')).length;
  } catch { importCount = 0; }
  components.push({
    name: 'import_originals',
    included: importCount > 0,
    detail: importCount > 0 ? `${importCount} CSV file(s) in ${imports}` : `none present in ${imports}`,
  });

  // Report artifacts: the frozen Project Update Report bodies live INSIDE the database
  // (`project_reports.payload_json`), so the snapshot covers them. There is no separate artifact
  // store yet — that is the same open storage decision noted in the 8.11 work.
  components.push({
    name: 'report_artifacts',
    included: true,
    detail: 'frozen report bodies are inside the database snapshot (project_reports.payload_json)',
  });

  // Secret-file REFERENCE only, never a value (§4.2). Sessions in this app are database-backed
  // rows, not signed with an application secret, so there is no secret FILE to reference — which
  // is recorded as such rather than as a path that does not exist.
  components.push({
    name: 'secret_file_reference',
    included: false,
    detail: 'none: sessions are database rows, so the app holds no secret file',
  });

  components.push({ name: 'app_version', included: true, detail: readAppVersion() });

  components.push({
    name: 'offsite_encrypted_copy',
    included: false,
    detail: 'not configured — needs an offsite destination and a key decision (§3.8)',
  });

  return components;
}

// ---------------------------------------------------------------------------------------------
// Reading the backup set
// ---------------------------------------------------------------------------------------------

/** Every COMPLETE backup, newest first. A snapshot without a manifest was never verified and is
 *  not reported: an unverified file must not be presented as a recovery option. */
function listBackups(dir = backupsDir()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const stamp = /^practis-(\d{8}T\d{6}Z)\.manifest\.json$/.exec(f);
    if (!stamp) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Cross-check that the snapshot the manifest names is still there. A manifest whose .gz has
      // been removed by hand is not a backup, and reporting it as one would hide a real loss.
      if (!fs.existsSync(path.join(dir, m.snapshot))) continue;
      out.push(m);
    } catch {
      // An unreadable manifest is a damaged record; skipping it is right, and it will show up as
      // a missing snapshot in the retention report rather than as a phantom recovery option.
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function latestBackup(dir = backupsDir()) {
  return listBackups(dir)[0] || null;
}

/**
 * How stale the newest backup is — the number TS-14's RPO of one hour is measured against.
 *
 * Returns null when there is no backup at all, and the caller must render that as UNKNOWN rather
 * than as zero. This distinction is the whole point of the field: `0` means "a backup finished
 * this second", so reporting a missing backup as `0` would show the healthiest possible value for
 * the most dangerous state.
 */
function backupAgeSeconds(now = new Date(), dir = backupsDir()) {
  const latest = latestBackup(dir);
  if (!latest) return null;
  return Math.max(0, Math.round((now.getTime() - Date.parse(latest.createdAt)) / 1000));
}

/** TS-14: the pipeline must alert on a failed OR OVERDUE hourly snapshot. This is the overdue
 *  half; the failure half is the job runner's `failed` state. */
function isOverdue(now = new Date(), dir = backupsDir(), graceSeconds = 300) {
  const age = backupAgeSeconds(now, dir);
  return age === null || age > 3600 + graceSeconds;
}

// ---------------------------------------------------------------------------------------------
// Retention: describe, never delete
// ---------------------------------------------------------------------------------------------

/** UTC bucket keys. Week buckets are ISO-8601 week-starting-Monday, so "weekly" means the same
 *  thing here as it does to a person reading a calendar. */
function bucketKeys(at) {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');

  // ISO week: shift to the Thursday of this week, which always falls in the ISO week-year.
  const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow);
  const week = Math.floor((t - week1Mon) / (7 * 86400000)) + 1;

  return {
    hourly: `${y}-${m}-${day}T${hour}`,
    daily: `${y}-${m}-${day}`,
    weekly: `${isoYear}-W${String(week).padStart(2, '0')}`,
    monthly: `${y}-${m}`,
  };
}

/**
 * Assign snapshots to §4.2's tiers.
 *
 * "One snapshot may satisfy multiple tiers without duplication" — so each tier keeps the NEWEST
 * snapshot in each of its buckets and the retained set is the UNION, counted once. A snapshot
 * from 02:00 today can simultaneously be today's daily, this week's weekly, and this month's
 * monthly, and it occupies ONE reference, not three.
 *
 * TRAP — the window is bucket-shaped, not duration-shaped. A naive `now - createdAt <= 24h` admits
 * 25 distinct hour-buckets: the snapshot from 24h and one minute ago is in a DIFFERENT bucket from
 * the one taken now, so both are "the newest in their hour" and both are kept — one over §4.2's
 * stated maximum of 24. So the retention window is counted in BUCKETS, using the same key that
 * groups the snapshots (`bucketKeys`). Different tiers use different bucket shapes and therefore
 * different windows: hours for hourly, days for daily and weekly, months for monthly.
 * (Found by test BA8, which asserted the count and got 25.)
 */
function assignTiers(backups, now = new Date()) {
  const out = { hourly: [], daily: [], weekly: [], monthly: [] };
  if (backups.length === 0) return out;

  // How many buckets back each tier may reach.
  const windows = {
    hourly: TIERS.hourly,   // 24 hours
    daily: TIERS.daily,     // 7 days
    weekly: TIERS.weekly,   // 4 weeks
    monthly: TIERS.monthly, // 12 months
  };

  // The bucket each snapshot falls in, computed once per snapshot per tier.
  const keys = new Map();
  for (const b of backups) keys.set(b, bucketKeys(b.createdAt));

  for (const tier of Object.keys(out)) {
    // Collect the DISTINCT buckets that exist, newest first, and keep only the most recent
    // `windows[tier]` of them. Everything older is out of the window by definition.
    const buckets = [];
    for (let i = 0; i < backups.length; i += 1) {
      const k = keys.get(backups[i])[tier];
      if (!buckets.includes(k)) buckets.push(k);
    }
    const inWindow = new Set(buckets.slice(0, windows[tier]));

    const seen = new Map(); // bucketKey → the newest backup in it
    for (const b of backups) {
      const key = keys.get(b)[tier];
      if (!inWindow.has(key)) continue;
      const held = seen.get(key);
      if (!held || held.createdAt < b.createdAt) seen.set(key, b);
    }
    out[tier] = [...seen.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  return out;
}

/**
 * The retention REPORT. It counts and it explains; it does not delete.
 *
 * `supersededCount` is the number of snapshots that currently fill no tier — the set that a
 * future, explicitly-approved pruning step WOULD be able to free. It is reported so the user can
 * make that decision with real numbers, and it is deliberately not acted upon here (§4.2: the
 * proposed retention is "not deletion authority").
 */
function retentionReport(now = new Date(), dir = backupsDir()) {
  const backups = listBackups(dir);
  const tiers = assignTiers(backups, now);

  const referenced = new Set();
  for (const list of Object.values(tiers)) for (const b of list) referenced.add(b.stamp);

  const superseded = backups.filter((b) => !referenced.has(b.stamp));
  const bytes = (list) => list.reduce((n, b) => n + (b.snapshotBytes || 0), 0);

  return {
    generatedAt: now.toISOString(),
    totalSnapshots: backups.length,
    referenceCount: referenced.size,
    maxReferences: MAX_REFERENCES,
    withinLimit: referenced.size <= MAX_REFERENCES,
    tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, {
      limit: TIERS[k],
      kept: v.length,
      newest: v[0] ? v[0].stamp : null,
      oldest: v.length ? v[v.length - 1].stamp : null,
    }])),
    supersededCount: superseded.length,
    supersededStamps: superseded.map((b) => b.stamp),
    totalBytes: dirSizeBytes(dir),
    retainedBytes: bytes([...referenced].map((s) => backups.find((b) => b.stamp === s)).filter(Boolean)),
    supersededBytes: bytes(superseded),
    newest: backups[0] ? backups[0].stamp : null,
    oldest: backups.length ? backups[backups.length - 1].stamp : null,
    ageSeconds: backupAgeSeconds(now, dir),
    overdue: isOverdue(now, dir),
    // Stated in the payload rather than only in a comment, so anyone reading the report (or a
    // future UI built on it) is told plainly that nothing was removed.
    deletionPerformed: false,
    deletionPolicy: 'disabled — §4.2: automatic retention deletion stays disabled until the user '
      + 'explicitly approves deletion AND a restore has been tested and recorded',
    diskFreeBytes: (() => { try { return freeBytes(dir); } catch { return null; } })(),
  };
}

// ---------------------------------------------------------------------------------------------
// The hourly job
// ---------------------------------------------------------------------------------------------

const JOB_TYPE = 'backup.database';

/** Keeps the recurring enqueue idempotent: a tick that arrives while the previous snapshot is
 *  still recent must not queue a second one. Five minutes of slack absorbs clock drift between
 *  the tick and the snapshot's timestamp without letting a genuinely missed hour be skipped. */
const MIN_GAP_SECONDS = 55 * 60;

/**
 * Enqueue an hourly backup, unless one was taken recently.
 *
 * The runner is a separate concern (`src/lib/jobs.js`); this only decides WHETHER work is due and
 * hands it over. Registration is separate (`registerBackupJob`).
 */
function enqueueHourlyBackup(jobs, now = new Date()) {
  const age = backupAgeSeconds(now);
  if (age !== null && age < MIN_GAP_SECONDS) {
    return { enqueued: false, reason: `latest backup is only ${age}s old` };
  }
  const id = jobs.enqueue({ type: JOB_TYPE });
  return { enqueued: true, jobId: id };
}

/** Register the handler with the runner. `idempotent: true` because taking a second snapshot of an
 *  unchanged database is harmless — the file is separately named and separately verified, and one
 *  more recovery copy is never the wrong answer. */
function registerBackupJob(jobs) {
  jobs.register(JOB_TYPE, async () => {
    const m = await createBackup();
    return { stamp: m.stamp, bytes: m.snapshotBytes };
  }, { idempotent: true });
  return JOB_TYPE;
}

module.exports = {
  // creation
  createBackup, verifyDatabase, BackupError,
  // reading
  listBackups, latestBackup, backupAgeSeconds, isOverdue,
  // retention (describe only — no deletion exists in this module)
  retentionReport, assignTiers, bucketKeys, TIERS, MAX_REFERENCES,
  // job
  JOB_TYPE, registerBackupJob, enqueueHourlyBackup, MIN_GAP_SECONDS,
  // paths & limits (exported for tests and the restore drill)
  backupsDir, importsDir, stampFor, stampOf, snapshotPath, manifestPath,
  freeBytes, dirSizeBytes, minFreeBytes, freeFactor, describeComponents,
};
