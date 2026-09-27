// Shared SQLite connection (WAL, busy timeout, FK on).
// Singleton per process — better-sqlite3 is synchronous and single-connection.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.PRACTIS_DB || path.join(__dirname, '..', '..', 'data', 'practis.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

module.exports = db;