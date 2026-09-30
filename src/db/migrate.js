// Migrate a fresh SQLite file to the latest schema.
// Single source of truth: db/migrations/*.sql (already tested via validate.py).
// Usage: node src/db/migrate.js [dbPath]   (default: data/practis.db)
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.argv[2] || process.env.PRACTIS_DB
  || path.join(__dirname, '..', '..', 'data', 'practis.db');
const MIG_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

function main() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Table rebuilds (rename → recreate → copy → drop old, the recipe 003 used)
  // are the danger here, and the pragmas matter:
  //
  //   * `ALTER TABLE x RENAME TO x_old` rewrites the FK clause of every OTHER
  //     table that references x, to point at x_old. Once x_old is dropped those
  //     tables reference a table that does not exist, and any query touching
  //     them fails with "no such table: main.x_old" — which reads like a query
  //     bug and is not one.
  //   * `foreign_keys = OFF` alone does NOT prevent that rewrite in SQLite 3.53
  //     (measured: the reference still becomes "x_old"). Only
  //     `legacy_alter_table = ON` leaves the text alone.
  //   * `foreign_keys` is a no-op inside a transaction, so it must be set out
  //     here; `legacy_alter_table` is not, but is applied before the work anyway.
  //
  // Both are set below as a safety net for inherited migrations, but the real
  // fix is the ORDER: 003 now builds the replacement under a temp name and only
  // renames it into place after the original is dropped, so the name the other
  // tables point at never moves. Do not rely on the pragmas — an app booting
  // with the default settings sees exactly the same rewrite.
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');

  const files = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const target = Math.max(...files.map(f => parseInt(f.split('_')[0], 10)));
  const current = db.pragma('user_version', { simple: true });

  if (current >= target) {
    console.log(`schema already at v${current} (target ${target}) — nothing to do`);
    db.close();
    return;
  }

  for (const f of files) {
    const v = parseInt(f.split('_')[0], 10);
    if (v <= current) continue;
    const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    // one transaction per migration, so a failure leaves the file unapplied
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v}`);
    })();
    console.log(`applied ${f} → v${v}`);
  }

  db.pragma('foreign_keys = ON');
  // instr(), not LIKE: in SQL `_` is a single-character wildcard, so a LIKE
  // '%_old%' would also match "hold"/"bold" and report damage that isn't there.
  const broken = db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND instr(COALESCE(sql, ''), '_old') > 0`).get().n;
  if (broken) {
    console.error(`WARNING: ${broken} table(s) still reference a _old table — the schema is damaged`);
  }
  db.close();
  console.log(`migrated ${DB_PATH} to v${target}`);
}

if (require.main === module) {
  main();
}