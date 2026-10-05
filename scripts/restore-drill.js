#!/usr/bin/env node
// Restore drill — restore the newest verified snapshot to an ISOLATED path, prove it works, and
// record the result. TECH-SPEC §4.2, §12.4, §12.5, TS-19.
//
// Usage:
//   node scripts/restore-drill.js                 drill the newest backup (boots the app)
//   node scripts/restore-drill.js --no-server     skip the step-6 readiness check (faster)
//   node scripts/restore-drill.js --dir <path>    drill a specific backup set
//   node scripts/restore-drill.js --history       show previous drill records
//
// PRODUCTION IS NEVER TOUCHED. The drill decompresses into a fresh temporary directory, refuses
// any target inside the live data directory, and deletes its copy when it finishes.

const drill = require('../src/lib/restore-drill');

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--history')) {
    const runs = drill.listDrills();
    if (runs.length === 0) { console.log('no drill records yet'); return 0; }
    for (const r of runs) {
      console.log(`${r.drillAt}  ${r.outcome.padEnd(7)}  snapshot ${r.snapshot || '—'}  `
        + `${(r.elapsedMs / 1000).toFixed(1)}s  ${r.failed.length ? `FAILED: ${r.failed.join(', ')}` : ''}`);
    }
    return 0;
  }

  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
  const withServer = !args.includes('--no-server');

  const result = await drill.runDrill({ dir, withServer, log: (m) => console.log(m) });

  console.log('');
  console.log(`RESTORE DRILL: ${result.outcome.toUpperCase()}`);
  console.log(`  snapshot   ${result.snapshot || '— (none available)'}`);
  console.log(`  elapsed    ${(result.elapsedMs / 1000).toFixed(1)} s`);
  console.log(`  target     ${result.restorationTarget}`);
  for (const c of result.checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(20)} ${c.detail}`);
  }
  if (result.note) console.log(`  note       ${result.note}`);
  console.log('');
  console.log(`  RTO        NOT CLAIMED — ${result.rtoNote}`);
  return result.outcome === 'passed' ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`drill FAILED (${err.code || 'error'}): ${err.message}`);
    process.exitCode = 1;
  });
