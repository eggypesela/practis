// Shared PRACTIS test fixture.
//
// WHY THIS EXISTS
//
// Every module-7 test file needs the same thing: a migrated, seeded PRACTIS on its own
// port and its OWN database file, with a couple of logged-in roles. Written out per file
// that is ~100 lines of setup duplicated, and worse, it duplicates three traps this
// codebase has already paid for:
//
//   1. `seed-master.js` must run with PRACTIS_DB pointed at the test database. Run it
//      without that and it silently seeds `data/practis.db` — the dev database — while
//      the assertions read the test one. Nothing fails; the numbers are just absent.
//   2. Loading a service under test requires purging EVERY module under `src/`, not just
//      `src/db/db.js`. Leaving `queries.js` cached holds a second connection open, so a
//      transaction and its audit write land on different connections and the audit
//      blocks for the full 5s busy_timeout ("database is locked").
//   3. The server must be waited for by its actual readiness line, not a sleep.
//
// So the fixture exists to hold those three facts in one place.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const NODE = process.execPath;

// Roles a test commonly needs. Each is created with EXACTLY one role and
// is_system_admin = 0, so the admin bypass in capabilities() cannot mask a result.
const ROLES = ['cost_controller', 'viewer', 'project_admin'];

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Start a fixture. Returns { ORIGIN, dbPath, db, admin, asRole, load, refresh, post, stop }.
//
//   const fx = await startFixture({ port: 3915, prefix: 'practis-bs7-', roles: [...] });
//   after(() => fx.stop());
async function startFixture({ port, prefix = 'practis-fx-', roles = ROLES, adminEmail = 'e@example.com',
                              adminPassword = 'epw12345', seed = true } = {}) {
  if (!port) throw new Error('startFixture needs a port');
  const ORIGIN = `http://127.0.0.1:${port}`;
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'test.db');
  const env = { PRACTIS_DB: dbPath };

  sh([path.join('src', 'db', 'migrate.js')], env);
  if (seed) sh([path.join('src', 'db', 'seed.js'), adminEmail, adminPassword], env);
  // TRAP 1: PRACTIS_DB must be passed, or this seeds the dev database instead.
  sh([path.join('src', 'db', 'seed-master.js')], env);

  const proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    // TRAP 3: wait for the readiness line the server actually prints.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 20000);
      proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
      proc.stderr.on('data', (d) => process.stderr.write(d));
      proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`server on ${port} exited early (${c})`)); });
    });
  } catch (e) {
    proc.kill('SIGKILL');
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    throw e;
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const csrf = require('./csrf');
  const admin = await csrf.loggedIn(ORIGIN, adminEmail, adminPassword);

  const clients = new Map();
  if (roles.length) {
    const { asRole } = require('./authz');
    for (const code of roles) {
      const j = await asRole(Database, dbPath, ORIGIN, code, {
        email: `fx-${code}-${port}@example.test`,
      });
      clients.set(code, j.client);
    }
  }

  // TRAP 2, in one place: reload every module under src/ so they share ONE connection.
  function load(relPath) {
    process.env.PRACTIS_DB = dbPath;
    const prefixKey = path.join(ROOT, 'src') + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefixKey)) delete require.cache[key];
    }
    return require(path.join(ROOT, relPath));
  }

  // Re-run the master seed against THIS database (e.g. after a migration added a step).
  // Uses a fresh process, so it does not disturb the server's open connection.
  function refresh() {
    return sh([path.join('src', 'db', 'seed-master.js')], env);
  }

  const post = (client, url, body) => client.post(url, new URLSearchParams(body).toString());

  function stop() {
    proc.kill('SIGKILL');
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }

  return { ORIGIN, PORT: port, dbPath, db, admin, clients, load, refresh, post, stop, proc };
}

module.exports = { startFixture, ROLES, ROOT, NODE };
