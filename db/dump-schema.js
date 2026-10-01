#!/usr/bin/env node
// Regenerate db/schema.sql from a MIGRATED database.
//
// WHY THIS EXISTS
// db/validate.py executes db/schema.sql (not db/migrations/), and the two had drifted:
// 21 triggers in the migrations vs 14 in schema.sql — 7 missing, including
// trg_ledger_reversal_must_negate and trg_lpb_checked_requires_cbs*. So the validator
// reported "ALL CHECKS PASS" while asserting invariants against a schema that lacked the
// guards. This script makes schema.sql a build artefact of the migrations, so the two
// cannot diverge silently again.
//
// TWO RULES, both learned the hard way (see the practis-development skill):
//   1. Copy DDL VERBATIM out of sqlite_master. Never retype it — retyping is how the
//      idx_ledger_import_dedupe WHERE clause was lost in migration 003.
//   2. Emit objects in dependency order: tables -> indexes -> triggers -> views LAST.
//      SQLite validates a view against its tables at CREATE time, so a view emitted
//      before its table fails. (Triggers are NOT validated for their referenced tables
//      at create time, but keeping them after tables is still the sane order.)
//
// Usage:
//   node db/dump-schema.js [--db <path>] [--out <path>] [--check]
//
//   --check  compare against the file and exit 1 if it differs (for CI / the test suite)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const CHECK = argv.includes('--check');
const OUT = flag('--out') || path.join(ROOT, 'db', 'schema.sql');
let dbPath = flag('--db');

// Default: build a throwaway DB by running the real migrator, so the artefact always
// reflects the migrations rather than whichever dev DB happens to be lying around.
let cleanup = null;
if (!dbPath || dbPath === true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practis-dump-'));
  dbPath = path.join(dir, 'schema.db');
  cleanup = dir;
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'db', 'migrate.js')], {
    cwd: ROOT,
    env: { ...process.env, PRACTIS_DB: dbPath },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

// Order is the whole game here: views read tables, so they go last.
const GROUPS = [
  { type: 'table',   sql: `SELECT name, sql FROM sqlite_master WHERE type='table'   AND name NOT LIKE 'sqlite_%' ORDER BY name` },
  { type: 'index',   sql: `SELECT name, sql FROM sqlite_master WHERE type='index'   AND sql IS NOT NULL     ORDER BY name` },
  { type: 'trigger', sql: `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name` },
  { type: 'view',    sql: `SELECT name, sql FROM sqlite_master WHERE type='view'    AND name NOT LIKE 'sqlite_%' ORDER BY name` },
];

const parts = [];
const counts = {};
for (const g of GROUPS) {
  const rows = db.prepare(g.sql).all();
  counts[g.type] = rows.length;
  if (rows.length) {
    parts.push(`-- ${g.type.toUpperCase()}S (${rows.length})`);
    for (const r of rows) {
      // Emitted verbatim, plus a terminating semicolon. sqlite_master.sql carries no
      // trailing ';', and a view's body needs one.
      parts.push(`${r.sql.trim().replace(/;\s*$/, '')};`);
    }
    parts.push('');
  }
}
db.close();
if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });

const header = `-- PRACTIS schema (GENERATED — do not hand-edit)
--
-- This file is a build artefact of db/migrations/*.sql, produced by:
--     node db/dump-schema.js
--
-- It exists so db/validate.py can assert invariants against the schema the app
-- ACTUALLY runs. Before this was generated, the two had drifted (14 triggers here
-- vs 21 in the migrations) and the validator passed against a schema missing the
-- reversal and CBS guards.
--
-- Objects are emitted in dependency order: tables, indexes, triggers, then views.
-- DDL is copied verbatim out of sqlite_master. To change it, write a migration and
-- re-run the generator — never edit this file directly.
--
-- Composition: ${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers, ${counts.view} views.

`;
const text = header + parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current === text) {
    console.log(`schema.sql is up to date with the migrations (${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers, ${counts.view} views)`);
    process.exit(0);
  }
  console.error('schema.sql has DRIFTED from the migrations — regenerate with: node db/dump-schema.js');
  console.error(`  expected ${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers, ${counts.view} views`);
  process.exit(1);
}

fs.writeFileSync(OUT, text);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers, ${counts.view} views`);
