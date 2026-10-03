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
//
// `project_manager` is here because part 7.6 has a capability that ADMINS ARE
// DELIBERATELY EXCLUDED FROM (`canApproveBaseline`), so tests have to be able to log in
// as a PM, an admin-only user, and a PM-who-also-admins them, separately.
const ROLES = ['cost_controller', 'viewer', 'project_admin', 'project_manager', 'finance',
  'project_controller'];

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Start a fixture. Returns { ORIGIN, PORT, dbPath, db, admin, clients, users, pmAdmin,
// adminOnly, load, loadMany, refresh, post, stop }.
//
//   `clients`  role code → logged-in HTTP client (each user holds EXACTLY that one role)
//   `users`    role code → user id (for service calls and SoD comparisons)
//   `pmAdmin`  { id, client } — a system administrator who ALSO holds project_manager
//   `adminOnly`{ id, client } — a system administrator with NO project_manager role
//
// The last two exist for part 7.6: `canApproveBaseline` is `hasExact`, so they must get
// different answers, and asserting that needs both.
//
//   `load(p)`       one module under src/, freshly required
//   `loadMany(...p)` several, SHARING ONE CONNECTION — use this whenever a test touches more
//                    than one service (see the note on `loadMany`)
//
//   const fx = await startFixture({ port: 3918, prefix: 'practis-bc7-' });
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
  const users = new Map();
  if (roles.length) {
    const { asRole } = require('./authz');
    for (const code of roles) {
      const j = await asRole(Database, dbPath, ORIGIN, code, {
        email: `fx-${code}-${port}@example.test`,
      });
      clients.set(code, j.client);
      // The user id matters for the service-level tests: `applyBaselineChange` and the
      // BCR workflow take an actorId, and SoD is a comparison between two of them.
      users.set(code, j.userId);
    }
  }

  // A user who holds `project_manager` AND is a system administrator, and one who is
  // ONLY a system administrator. Part 7.6's `canApproveBaseline` is `hasExact`, so these
  // two must produce DIFFERENT answers — that difference is the whole point of the
  // capability, and it cannot be tested without both.
  let pmAdmin = null;
  let adminOnly = null;
  if (roles.includes('project_manager')) {
    const argon2 = require('argon2');
    const Database2 = Database;
    const d2 = new Database2(dbPath);
    const hash = await argon2.hash('fx-admin-pw-12345');

    const mk = (email) => d2.prepare('INSERT INTO users (email, full_name, password_hash, '
      + 'is_system_admin) VALUES (?, ?, ?, 1)').run(email, `Fx ${email}`, hash).lastInsertRowid;
    const adminId = mk(`fx-adminonly-${port}@example.test`);
    const pmAdminId = mk(`fx-pmadmin-${port}@example.test`);
    d2.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, NULL)')
      .run(pmAdminId, 'project_manager');
    d2.close();

    const csrf = require('./csrf');
    adminOnly = { id: adminId, client: await csrf.loggedIn(ORIGIN, `fx-adminonly-${port}@example.test`, 'fx-admin-pw-12345') };
    pmAdmin = { id: pmAdminId, client: await csrf.loggedIn(ORIGIN, `fx-pmadmin-${port}@example.test`, 'fx-admin-pw-12345') };
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

  // Load SEVERAL modules so they share one connection.
  //
  // Calling `load()` once per module is a trap worth stating: each call clears the whole
  // `src/` cache and re-requires, so every module gets its OWN `db.js` and therefore its own
  // better-sqlite3 connection. Two services under test then write through different
  // connections and contend for the same write lock — which shows up not as an error but as
  // a test that takes 5 seconds (the `busy_timeout`) and then fails, looking like a logic
  // bug. Measured: a 4-service file went from 36s to well under a second once they shared
  // one connection. So load them TOGETHER.
  //
  //   const [wbs, bcr] = fx.loadMany('src/lib/wbs-service.js', 'src/lib/bcr-service.js');
  function loadMany(...relPaths) {
    process.env.PRACTIS_DB = dbPath;
    const prefixKey = path.join(ROOT, 'src') + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefixKey)) delete require.cache[key];
    }
    return relPaths.map((p) => require(path.join(ROOT, p)));
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

  return { ORIGIN, PORT: port, dbPath, db, admin, clients, users, pmAdmin, adminOnly,
    load, loadMany, refresh, post, stop, proc };
}

module.exports = { startFixture, ROLES, ROOT, NODE };
