// Shared SQLite connection (WAL, busy timeout, FK on).
// Singleton per process — better-sqlite3 is synchronous and single-connection.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.PRACTIS_DB || path.join(__dirname, '..', '..', 'data', 'practis.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// TECH-SPEC §4.1 requires FULL. Under WAL, NORMAL only syncs at checkpoints, so a
// power loss can drop the last committed transactions — unacceptable for a book of
// record. FULL fsyncs every commit; the write cost is paid on import runs, not on
// reads. Verify with a fresh connection: PRAGMA synchronous must return 2.
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');

module.exports = db;