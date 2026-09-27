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

  // current schema version = max user_version across migration files
  const files = fs.readdirSync(MIG_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const target = Math.max(...files.map(f => parseInt(f.split('_')[0], 10)));
  const current = db.pragma('user_version', { simple: true });

  if (current >= target) {
    console.log(`schema already at v${current} (target ${target}) — nothing to do`);
    db.close();
    return;
  }

  const tx = db.transaction(() => {
    for (const f of files) {
      const v = parseInt(f.split('_')[0], 10);
      if (v <= current) continue;
      const sql = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
      db.exec(sql);
      db.pragma(`user_version = ${v}`);
      console.log(`applied ${f} → v${v}`);
    }
  });
  tx();
  db.close();
  console.log(`migrated ${DB_PATH} to v${target}`);
}

if (require.main === module) {
  main();
}