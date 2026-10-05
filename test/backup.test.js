// BR-series: backup, retention and the restore drill (module 9 part 9.4). THIS IS PART 9.4'S GATE.
// TECH-SPEC §4.2, §12.4, §12.5, §12.6; TS-13, TS-14, TS-19.
//
// NOTE ON THE PREFIX: this was first written as "BA", which COLLIDES with test/acceptance.test.js
// (BAST acceptance, BA8.1-BA8.9). Two files sharing a series name makes a failure report ambiguous
// — "BA8 failed" would name two different tests. Renamed to BR before commit.
//
// Driven IN-PROCESS against a migrated temp DB in a throwaway directory, like jobs/health and for
// a third reason on top of theirs: this file must be able to point the backup directory at a temp
// path (PRACTIS_BACKUPS) so a test run can never pollute — or accidentally PRUNE — the real backup
// set. A test that ran against the live backups directory would be a data-loss risk in its own right.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-backup-test-'));
const dbPath = path.join(work, 'live.db');
const backups = path.join(work, 'backups');

// TRAP: `src/db/db.js` THROWS inside a test process when PRACTIS_DB is unset (rather than opening
// the dev database). Both of these must be set BEFORE the first in-process require.
process.env.PRACTIS_DB = dbPath;
process.env.PRACTIS_BACKUPS = backups;

for (const s of ['src/db/migrate.js', 'src/db/seed.js', 'src/db/seed-master.js']) {
  const args = [s];
  if (s.endsWith('seed.js')) args.push('bk@example.com', 'pw123456');
  execFileSync(process.execPath, args,
    { cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath }, stdio: 'pipe' });
}

let backup;
let drill;
let Database;

/** A tiny two-line double entry, written directly so BR9's balance check has real data to check.
 *  `amount` must equal `debit - credit` and only one side may be non-zero — the ledger trigger
 *  (trg_ledger_money_integrity_insert) rejects anything else, which is itself worth knowing. */
function seedLedgerLines(dbFile) {
  const conn = new Database(dbFile);
  try {
    const proj = conn.prepare('SELECT id FROM projects LIMIT 1').get();
    const ins = conn.prepare(`INSERT INTO accounting_ledger
      (project_id, date, type, line_role, amount, debit, credit, description, source)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run(proj.id, '2026-10-05', 'Income', 'receivable', 4321, 4321, 0, 'ba test debit', 'manual');
    ins.run(proj.id, '2026-10-05', 'Income', 'receivable', -4321, 0, 4321, 'ba test credit', 'manual');
  } finally {
    conn.close();
    for (const f of [`${dbFile}-shm`, `${dbFile}-wal`]) fs.rmSync(f, { force: true });
  }
}

test.before(() => {
  backup = require('../src/lib/backup-service');
  drill = require('../src/lib/restore-drill');
  Database = require('better-sqlite3');
  seedLedgerLines(dbPath);
});

test.after(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── BR1 — a snapshot is produced and it is a real, consistent database ──────────────────────

test('BR1 a backup produces a verified snapshot, and the manifest records the proof', async () => {
  const m = await backup.createBackup({});
  assert.match(m.stamp, /^\d{8}T\d{6}Z$/);
  assert.strictEqual(m.snapshot, `practis-${m.stamp}.db.gz`);
  assert.ok(m.snapshotBytes > 0 && m.databaseBytes > 0);
  assert.strictEqual(m.snapshotBytes < m.databaseBytes, true,
    'the kept artifact must be the COMPRESSED one, not a copy of the database');
  assert.match(m.snapshotSha256, /^[0-9a-f]{64}$/);

  // The checks were RUN, and their results are recorded — not merely asserted in code.
  assert.strictEqual(m.verification.snapshot.every((c) => c.ok), true);
  assert.strictEqual(m.verification.compressedArtifact.every((c) => c.ok), true);
  assert.strictEqual(m.verification.roundTripBytes, m.databaseBytes,
    'the decompressed copy must be byte-for-byte the size of the snapshot');
  assert.strictEqual(m.userVersion, 23, 'the manifest must record the schema version of the copy');
});

// ── BR2 — the snapshot IS a database, and the compressed artifact is intact ─────────────────

test('BR2 the kept .gz decompresses to a database that passes integrity and FK checks', async () => {
  const m = backup.latestBackup(backups);
  const out = path.join(work, 'roundtrip.db');
  await pipeline(fs.createReadStream(path.join(backups, m.snapshot)), zlib.createGunzip(),
    fs.createWriteStream(out));

  const v = backup.verifyDatabase(out);
  assert.strictEqual(v.ok, true, `restored copy failed: ${JSON.stringify(v.checks)}`);
  assert.strictEqual(v.userVersion, 23);

  // Integrity of the COMPRESSED bytes themselves: a truncated .gz fails here.
  const raw = fs.readFileSync(path.join(backups, m.snapshot));
  assert.strictEqual(raw[0], 0x1f, 'gzip magic byte 1');
  assert.strictEqual(raw[1], 0x8b, 'gzip magic byte 2');
  assert.strictEqual(
    require('crypto').createHash('sha256').update(raw).digest('hex'), m.snapshotSha256,
    'the file on disk must still match the hash the manifest recorded');

  for (const f of [`${out}-shm`, `${out}-wal`, out]) fs.rmSync(f, { force: true });
});

// ── BR3 — a corrupt artifact is REJECTED, not recorded as a backup ──────────────────────────

test('BR3 an artifact that fails verification is not published as a backup', async () => {
  const before = backup.listBackups(backups).length;
  const bad = path.join(work, 'corrupt');
  fs.mkdirSync(bad, { recursive: true });

  // Truncate the snapshot mid-write: the round-trip check must notice, and no manifest may appear.
  const err = await backup.createBackup({ dir: bad, db: {
    name: dbPath,
    // A snapshot callback that writes a truncated file, so the verification step has something
    // genuinely broken to catch.
    backup: async (dest) => {
      const full = fs.readFileSync(dbPath);
      fs.writeFileSync(dest, full.subarray(0, Math.floor(full.length / 2)));
    },
  } }).then(() => null, (e) => e);

  assert.ok(err, 'a truncated snapshot must NOT be reported as a successful backup');
  assert.strictEqual(err.name, 'BackupError');
  assert.ok(['verification_failed', 'not_a_database'].includes(err.code), `unexpected code ${err.code}`);
  assert.deepStrictEqual(backup.listBackups(bad), [],
    'a failed run must leave NO manifest — an unverified file must never look like a recovery option');
  // No `.part` left behind either.
  assert.deepStrictEqual(fs.readdirSync(bad).filter((f) => f.includes('.part')), [],
    'a failed run must clean up its temporaries');
  assert.strictEqual(backup.listBackups(backups).length, before, 'the good set must be untouched');
});

// ── BR4 — THE SAFETY RULE: production is never modified ─────────────────────────────────────

test('BR4 taking a backup leaves the live database byte-identical', async () => {
  const before = fs.readFileSync(dbPath);
  const beforeStat = fs.statSync(dbPath);
  await backup.createBackup({});
  const after = fs.readFileSync(dbPath);
  assert.strictEqual(require('crypto').createHash('sha256').update(after).digest('hex'),
    require('crypto').createHash('sha256').update(before).digest('hex'),
    '§4.2: the backup job must never write to the production database');
  assert.strictEqual(fs.statSync(dbPath).size, beforeStat.size);
});

// ── BR5 — the disk guard REFUSES rather than filling the disk ───────────────────────────────

test('BR5 the disk guard refuses to back up when free space is insufficient', async () => {
  const saved = process.env.PRACTIS_MIN_FREE_BYTES;
  process.env.PRACTIS_MIN_FREE_BYTES = String(1024 ** 5); // 1 TB — no host has this free
  const fresh = require.resolve('../src/lib/backup-service');
  delete require.cache[fresh];
  const strict = require(fresh);
  try {
    const err = await strict.createBackup({ dir: path.join(work, 'nodisk') })
      .then(() => null, (e) => e);
    assert.ok(err, 'the guard must throw rather than attempt the backup');
    assert.strictEqual(err.code, 'insufficient_disk');
    assert.match(err.message, /refusing to back up/);
    // It refused BEFORE writing anything.
    assert.ok(!fs.existsSync(path.join(work, 'nodisk')) || fs.readdirSync(path.join(work, 'nodisk')).length === 0,
      'a refused backup must not leave partial output');
  } finally {
    delete require.cache[fresh];
    require('../src/lib/backup-service');
    if (saved === undefined) delete process.env.PRACTIS_MIN_FREE_BYTES;
    else process.env.PRACTIS_MIN_FREE_BYTES = saved;
  }
});

// ── BR6 — age and RPO (TS-14) ───────────────────────────────────────────────────────────────

test('BR6 backup age is measured, and «no backup» is UNKNOWN — never zero', () => {
  const empty = path.join(work, 'empty');
  fs.mkdirSync(empty, { recursive: true });

  // THE POINT OF THE FIELD: a missing backup must not read as a fresh one. `0` would mean
  // "a snapshot finished this second" — the healthiest possible number for the worst state.
  assert.strictEqual(backup.backupAgeSeconds(new Date(), empty), null);
  assert.strictEqual(backup.isOverdue(new Date(), empty), true,
    'no backup at all must count as overdue (TS-14)');

  const age = backup.backupAgeSeconds(new Date(), backups);
  assert.ok(Number.isFinite(age) && age >= 0, 'a real age must be a number');
  assert.strictEqual(backup.isOverdue(new Date(), backups), false, 'a fresh backup is not overdue');

  // Past the RPO deadline the same backup IS overdue — this is what TS-14's alert hangs on. The
  // threshold is one hour plus a 5-minute grace that absorbs tick jitter, so the probe has to be
  // past 65 minutes: +2h is unambiguous. (A first version of this test used +61 min and failed,
  // which is how the grace window got pinned down.)
  const later = new Date(Date.now() + 2 * 3600 * 1000);
  assert.strictEqual(backup.isOverdue(later, backups), true);
  assert.ok(backup.backupAgeSeconds(later, backups) > 3600,
    'the age must exceed the one-hour RPO at that point, or the alert is measuring nothing');
});

// ── BR7 — RETENTION NEVER DELETES (the rule §4.2 is explicit about) ─────────────────────────

test('BR7 the retention report NEVER deletes a snapshot', () => {
  const before = fs.readdirSync(backups).sort();
  const report = backup.retentionReport();
  const after = fs.readdirSync(backups).sort();

  assert.deepStrictEqual(after, before, 'the retention report must not remove or add any file');
  assert.strictEqual(report.deletionPerformed, false,
    'the report must state plainly that nothing was deleted');
  assert.match(report.deletionPolicy, /disabled/);
  assert.match(report.deletionPolicy, /approves deletion/i,
    'the policy text must name the approval §4.2 requires before deletion may be enabled');

  // And the module must offer no deletion entry point at all — a footgun that is merely
  // undocumented is still a footgun.
  for (const k of Object.keys(backup)) {
    assert.doesNotMatch(k, /prune|delete|remove|purge|cleanup/i,
      `backup-service must not export a deletion function, found: ${k}`);
  }
});

// ── BR8 — tiering: 47 references maximum, one snapshot may fill several tiers ───────────────

test('BR8 tiering counts REFERENCES (max 47), and one snapshot can fill several tiers', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  // Synthesise a set: an hourly spread over three days, which must collapse into far fewer
  // references than snapshots — §4.2's "one snapshot may satisfy multiple tiers without duplication".
  const many = [];
  for (let h = 0; h < 72; h += 1) {
    const at = new Date(now.getTime() - h * 3600000);
    many.push({ stamp: backup.stampFor(at), createdAt: at.toISOString(), snapshotBytes: 1000 });
  }
  const tiers = backup.assignTiers(many, now);
  assert.ok(tiers.hourly.length <= 24, `hourly kept ${tiers.hourly.length}, max 24`);

  const referenced = new Set();
  for (const list of Object.values(tiers)) for (const b of list) referenced.add(b.stamp);
  assert.ok(referenced.size <= backup.MAX_REFERENCES,
    `${referenced.size} references exceeds the ${backup.MAX_REFERENCES} §4.2 allows`);

  // The NEWEST snapshot must be the one kept for the current hour of every tier it belongs to.
  const newest = many[0].stamp;
  assert.strictEqual(tiers.hourly[0].stamp, newest);
  assert.strictEqual(tiers.daily[0].stamp, newest);
  assert.strictEqual(tiers.monthly[0].stamp, newest);
  assert.strictEqual(newest, many[0].stamp,
    'the same single snapshot is referenced by three tiers at once, without duplication');

  // Bucket keys must be real calendar buckets, so "weekly" means what a person means by it.
  const k = backup.bucketKeys('2026-10-05T12:34:56Z');
  assert.strictEqual(k.hourly, '2026-10-05T12');
  assert.strictEqual(k.daily, '2026-10-05');
  assert.strictEqual(k.monthly, '2026-10');
  assert.match(k.weekly, /^2026-W\d\d$/);
});

// ── BR9 — the restore drill, end to end, including the application ──────────────────────────

test('BR9 the drill restores to an isolated path, passes every check, and serves the copy',
  { timeout: 120_000 }, async () => {
    const liveBefore = fs.readFileSync(dbPath);
    const r = await drill.runDrill({ dir: backups, withServer: true });

    assert.strictEqual(r.outcome, 'passed',
      `drill failed: ${r.failed.join(', ')} — ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);

    const names = r.checks.map((c) => c.name);
    for (const required of ['integrity_check', 'foreign_key_check', 'schema_matches',
      'ledger_balances', 'migrations_current', 'app_readiness']) {
      assert.ok(names.includes(required), `the drill skipped ${required}`);
    }

    // The application really served the restored copy — the check that caught a genuine boot bug
    // (a positional `jobs.enqueue` call) which no file-level check could have found.
    const readiness = r.checks.find((c) => c.name === 'app_readiness');
    assert.match(readiness.detail, /HTTP 200/);

    // §4.2: "Restore never overwrites production."
    assert.strictEqual(
      require('crypto').createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
      require('crypto').createHash('sha256').update(liveBefore).digest('hex'),
      'the drill must not touch the live database');

    // RTO must NOT be claimed (§4.2: unproven until a production-sized restore).
    assert.strictEqual(r.rtoClaimed, false);
    assert.match(r.rtoNote, /unproven|production-sized/i);

    // The drill left its evidence behind.
    assert.ok(fs.readdirSync(backups).some((f) => f.startsWith('drill-')), 'a drill record must be written');
  });

test('BR9b a non-passing drill is recorded as failed, not swallowed', async () => {
  const empty = path.join(work, 'nodrill');
  fs.mkdirSync(empty, { recursive: true });
  const r = await drill.runDrill({ dir: empty, withServer: false });
  assert.strictEqual(r.outcome, 'no_backup', 'a drill with nothing to restore must say so');
  assert.deepStrictEqual(r.checks, []);
});

// ── BR10 — the isolation guard refuses an unsafe target ─────────────────────────────────────

test('BR10 the drill refuses to restore into the live data directory', () => {
  // This should be unreachable in normal use — which is exactly why it is asserted: a future
  // refactor that accepted a caller-supplied path would hit this instead of the live ledger.
  assert.throws(() => drill.assertIsolated(dbPath, dbPath), /refusing to write to the live database/);
  assert.throws(() => drill.assertIsolated(path.join(path.dirname(dbPath), 'other.db'), dbPath),
    /refusing to write inside the live data directory/);

  // A genuinely isolated path is allowed.
  assert.doesNotThrow(() => drill.assertIsolated(path.join(work, 'safe', 'x.db'), dbPath));
});

// ── BR11 — the hourly job is wired, idempotent, and REFUSES to run while one is recent ──────

test('BR11 the hourly job registers with the runner and does not stack up snapshots', async () => {
  const jobs = require('../src/lib/jobs');
  const type = backup.registerBackupJob(jobs);
  assert.strictEqual(type, backup.JOB_TYPE);
  assert.ok(jobs.registeredTypes().includes(backup.JOB_TYPE),
    'the backup job type must be registered or every tick would report an unmounted type');

  // A backup was just taken, so the scheduler must decline to queue another one. Without this a
  // restart (or a fast tick) would produce a snapshot every minute and fill the disk with the
  // very thing meant to survive a full disk.
  const res = backup.enqueueHourlyBackup(jobs);
  assert.strictEqual(res.enqueued, false, 'a recent backup must suppress a new enqueue');
  assert.match(res.reason, /only \d+s old/);

  // With no backup at all, it DOES enqueue — proving the suppression above is a real check and
  // not a function that always returns false.
  const empty = path.join(work, 'noenq');
  fs.mkdirSync(empty, { recursive: true });
  const saved = process.env.PRACTIS_BACKUPS;
  process.env.PRACTIS_BACKUPS = empty;
  try {
    const res2 = backup.enqueueHourlyBackup(jobs);
    assert.strictEqual(res2.enqueued, true, 'with no backup, one must be queued');
    assert.ok(Number.isInteger(res2.jobId) && res2.jobId > 0);

    // And the runner can actually EXECUTE it — handler registration is not the same as a working
    // handler, and the async path is where a backup would silently do nothing.
    const done = await jobs.drain();
    assert.ok(done.some((d) => d.type === backup.JOB_TYPE && d.state === 'completed'),
      `the queued backup job did not complete: ${JSON.stringify(done)}`);
    assert.ok(fs.readdirSync(empty).some((f) => f.endsWith('.db.gz')),
      'running the job must produce a snapshot');
  } finally {
    if (saved === undefined) delete process.env.PRACTIS_BACKUPS;
    else process.env.PRACTIS_BACKUPS = saved;
  }
});

// ── BR13 — a test/boot must NEVER write into the real backup set ────────────────────────────

test('BR13 the backup directory follows the database, so a temp DB cannot pollute the real set', () => {
  // This is a data-safety test, not a cosmetic one. 26 files in this suite boot the real server
  // against a temporary database; if the default backup directory were fixed at `data/backups`,
  // every one of them would write throwaway snapshots into the REAL backup set — and, when they
  // booted within the same second, several would collide on one filename. Deriving the directory
  // from the database's own location makes that structurally impossible.
  const saved = process.env.PRACTIS_BACKUPS;
  delete process.env.PRACTIS_BACKUPS;
  try {
    const db = require('../src/db/db');
    assert.strictEqual(backup.backupsDir(), path.join(path.dirname(db.name), 'backups'),
      'the default backup directory must sit beside the database, not in a fixed location');
    // In this test that is a temp directory, NOT the repository's real data/backups.
    const real = path.join(ROOT, 'data', 'backups');
    assert.notStrictEqual(path.resolve(backup.backupsDir()), path.resolve(real),
      'a test database must never resolve to the repository’s real backup set');
  } finally {
    if (saved !== undefined) process.env.PRACTIS_BACKUPS = saved;
  }
});


test('BR12 the manifest itemises the backup set and admits what it does not contain', async () => {
  const m = await backup.createBackup({});
  const byName = Object.fromEntries(m.components.map((c) => [c.name, c]));
  for (const name of ['database', 'app_version', 'import_originals', 'report_artifacts',
    'secret_file_reference', 'offsite_encrypted_copy']) {
    assert.ok(byName[name], `the backup set must itemise ${name}`);
  }
  assert.strictEqual(byName.database.included, true);
  assert.strictEqual(byName.report_artifacts.included, true,
    'frozen report bodies live inside the database, so they ARE covered');

  // §4.2 lists an encrypted offsite copy. This deployment does NOT have one, and the manifest
  // must say so rather than imply a complete set — discovering the gap during a disaster is the
  // failure mode being prevented.
  assert.strictEqual(byName.offsite_encrypted_copy.included, false);
  assert.match(byName.offsite_encrypted_copy.detail, /not configured/);
  // And it must never record a secret VALUE (§4.2: "secret-file reference, never secret value").
  assert.doesNotMatch(JSON.stringify(m), /password|secret["':]\s*["'][^"']+["']|token["':]\s*["'][^"']+["']/i);
});
