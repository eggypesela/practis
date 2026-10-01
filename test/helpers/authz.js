// Authorization test harness (audit 2026-09-30, blocker B1–B5).
//
// WHY THIS EXISTS
// The 148-test suite tested AUTHENTICATION (is anyone signed in?) but never
// AUTHORIZATION (is this ROLE allowed?). That gap let a read-only Viewer post a
// ledger entry, reverse a real line, mark cost as checked and confirm an import
// while the whole suite stayed green. See docs/AUDIT-2026-09-30.md.
//
// This harness makes "wrong role is denied" a mechanical assertion: create a user
// holding exactly one role, log in as them, then attempt the mutation and assert
// the DATABASE did not change. A 302 is not evidence; a row count is.
//
// It deliberately uses its OWN better-sqlite3 handle against the test DB. Never
// require('../src/db/db') here — that binds the default database path and the
// assertions would silently read the wrong file.

'use strict';

const argon2 = require('argon2');
const { loggedIn } = require('./csrf');

const PASSWORD = 'authz-pw-12345';

// Create a user holding EXACTLY `roleCode` (is_system_admin = 0, so the admin
// bypass in capabilities() cannot mask the result), then return a logged-in
// client. `projectId` is left NULL by default — project scoping (BOLA) is a
// separate concern with its own test file.
async function asRole(Database, dbPath, origin, roleCode, opts = {}) {
  const db = new Database(dbPath);
  const email = opts.email || `authz-${roleCode}@example.test`;
  const hash = await argon2.hash(PASSWORD);

  const info = db.prepare(
    'INSERT INTO users (email, full_name, password_hash, is_system_admin) VALUES (?, ?, ?, 0)'
  ).run(email, `Authz ${roleCode}`, hash);

  db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, roleCode, opts.projectId ?? null);

  db.close();

  const client = await loggedIn(origin, email, PASSWORD);
  return { client, userId: info.lastInsertRowid, email, password: PASSWORD };
}

module.exports = { asRole, PASSWORD };
