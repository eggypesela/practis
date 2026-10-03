// Shared SQLite connection (WAL, busy timeout, FK on).
// Singleton per process — better-sqlite3 is synchronous and single-connection.
//
// THIS DEFAULT PATH IS A FOOTGUN IN TESTS. When `PRACTIS_DB` is unset the connection opens
// `data/practis.db` — the DEV database — so an in-process `require('../../src/…')` inside a test
// file reads and writes real development data instead of that file's temp database. It stays
// invisible until a migration changes a view and the test then prepares a statement against a
// dev database that is a version behind.
//
// That is exactly what module 8 migration 021 did: it added columns to `v_aging`, and four test
// files that had been quietly reading the dev database failed with "no such column: terms_days".
// The stale read was always wrong; the migration only made the consequence visible. Those files
// now set `process.env.PRACTIS_DB = dbPath` in their `before()`; the guard below keeps the class
// from coming back, because on a dev machine the dev database is perfectly openable and the
// mistake is otherwise silent.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.PRACTIS_DB || path.join(__dirname, '..', '..', 'data', 'practis.db');

// `node --test` runs every test file in a child process with this marker set (measured: the value
// is `child-v8`). A test file that reaches this module without having chosen a database is about
// to read the dev database, so say so at the point of the mistake rather than at the assertion
// that follows, which reads like a query bug and is not one.
if (!process.env.PRACTIS_DB && process.env.NODE_TEST_CONTEXT) {
  throw new Error(
    "db.js: PRACTIS_DB is unset in a test process, so this would open the DEV database "
    + `(${DB_PATH}). Set it to the fixture's temp path BEFORE the first in-process require, e.g. `
    + "`process.env.PRACTIS_DB = dbPath;` in the test file's before() — the fixture helper "
    + '(test/helpers/practis-fixture.js) already does this.',
  );
}

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