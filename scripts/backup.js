#!/usr/bin/env node
// Take one verified backup now, and print what happened.
//
// Usage:
//   node scripts/backup.js              take a backup
//   node scripts/backup.js --list       list the backup set and the retention report
//
// The hourly job calls the same service (src/lib/backup-service.js); this wrapper exists so an
// operator can take one on demand — before a risky migration, say — without waiting for the tick.

const backup = require('../src/lib/backup-service');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log(JSON.stringify(backup.retentionReport(), null, 2));
    return 0;
  }

  const m = await backup.createBackup({ log: (line) => console.log(line) });
  console.log('');
  console.log(`backup OK  ${m.stamp}`);
  console.log(`  snapshot   ${m.snapshot}  ${m.snapshotBytes} bytes`);
  console.log(`  sha256     ${m.snapshotSha256}`);
  console.log(`  database   ${m.databaseBytes} bytes, schema v${m.userVersion}, app ${m.appVersion}`);
  console.log(`  took       ${m.durationMs} ms`);
  console.log(`  disk free  ${Math.round(m.diskFreeBytesAfter / 1048576)} MB after `
    + `(backups dir now ${Math.round(m.backupsDirBytesAfter / 1024)} KB)`);
  for (const c of m.components) {
    console.log(`  component  ${c.included ? 'yes' : 'NO '}  ${c.name}: ${c.detail}`);
  }
  return 0;
}

// `process.exitCode`, not `process.exit(...)`: exiting hard can truncate stdout that is still
// buffered, which is how a script reports success and prints nothing.
main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`backup FAILED (${err.code || 'error'}): ${err.message}`);
    process.exitCode = 1;
  });
