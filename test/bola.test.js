// BOLA-series: per-project scope (PRD §2.3, plan task 0.9, audit 2026-09-30).
//
// THE HOLE THIS CLOSES
// `projectContext` resolved the current project from a raw `?project=N` query
// parameter with no authorization check:
//
//     all.find(p => p.id === Number(req.query.project)) || all[0]
//
// so ANY signed-in user could read — and write — ANY project by changing one
// number. `user_roles.project_id`, the junction PRD §2.3 specifies for exactly
// this ("users are assigned a role PER PROJECT"), existed since migration 001 and
// was NULL in every row and read by zero code. It was latent only because a single
// project existed; Module 6 creates the second one and makes it live.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A STATUS CODE
// Every deny-case asserts the DATA the response carries (which project's rows are
// rendered, whether a row was written), never just the status. The original five
// authorization bugs all returned 302/200 *while writing*. A status-only test
// passes on the bug.
//
// ENFORCEMENT IS OFF BY DEFAULT (decision 4A: backfill first, enforce second), so
// this file exercises BOTH modes:
//   * gate off  — an unauthorised ?project=B must FALL BACK to the user's own
//     project. The switcher must not even offer B. The write path must still
//     refuse, because "not enforced" must never mean "cross-project writes
//     allowed".
//   * gate on   — the same request must be a 403 with a reason.
//
// Ports: 3902 (gate off) and 3903 (gate on), per TEST_PLAN §12.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const argon2 = require('argon2');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3902;          // SCOPE_ENFORCE unset
const PORT_ON = 3903;       // SCOPE_ENFORCE=1
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ORIGIN_ON = `http://127.0.0.1:${PORT_ON}`;

const PW = 'bola-pw-12345';

// Markers, not project names: a name like "Second Bridge" could appear in a page
// title for unrelated reasons. These only ever appear in their own project's rows.
const A_LINE = 'ALPHAONLY';
const B_LINE = 'BRAVOONLY';

let dbPath, db, srvOff, srvOn, ids = {};

// Boot one server against the shared temp DB. Sequential (never concurrent):
// each boot runs migrate+seed, and two at once would race the migrator.
async function boot(port, extraEnv = {}) {
  const proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server on ${port} did not start`)), 20000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); }
    });
  });
  return proc;
}

function sh(args, env) {
  return execFileSync(NODE, args, {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, ...env }, encoding: 'utf8',
  });
}

// Make a user holding a GLOBAL role, optionally plus a project-scoped grant.
async function makeUser(email, globalRole, scopedProjectId = null) {
  const hash = await argon2.hash(PW);
  const info = db.prepare(
    'INSERT INTO users (email, full_name, password_hash, is_system_admin) VALUES (?, ?, ?, 0)')
    .run(email, email, hash);
  if (globalRole) {
    db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, NULL)')
      .run(info.lastInsertRowid, globalRole);
  }
  if (scopedProjectId != null) {
    db.prepare('INSERT INTO user_roles (user_id, role_code, project_id) VALUES (?, ?, ?)')
      .run(info.lastInsertRowid, globalRole || 'project_manager', scopedProjectId);
  }
  return info.lastInsertRowid;
}

const { loggedIn } = require('./helpers/csrf');

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-bola-')), 'test.db');
  sh([path.join('src', 'db', 'migrate.js')]);
  sh([path.join('src', 'db', 'seed.js'), 'bola-admin@example.test', 'bolapw12345']);
  sh([path.join('src', 'db', 'seed-master.js')]);

  db = new (require('better-sqlite3'))(dbPath);

  // A SECOND project is the whole point: with one project there is no cross-tenant
  // boundary to leak across, which is why this flaw stayed latent.
  const aId = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;
  const bId = db.prepare(`INSERT INTO projects (code, name, contract_amount, status, start_date, end_date)
                          VALUES ('SB-2027', 'Second Bridge', 5000000000, 'active', '2026-01-01', '2027-06-30')`)
    .run().lastInsertRowid;
  ids = { aId, bId };

  // One posted line per project, so "which project's data did you just read?" is
  // answerable from the HTML rather than inferred from a status code.
  const insLine = db.prepare(`INSERT INTO accounting_ledger
      (project_id, date, type, amount, debit, credit, description, source)
      VALUES (?, '2026-05-01', 'Expense', 100000, 100000, 0, ?, 'manual')`);
  insLine.run(aId, A_LINE);
  insLine.run(bId, B_LINE);

  // Fixtures, one per rule in projectsFor().
  ids.fin = await makeUser('bola-fin@example.test', 'finance');            // org-wide
  ids.pma = await makeUser('bola-pma@example.test', 'project_manager', aId); // scoped → A only
  ids.pmnone = await makeUser('bola-pmnone@example.test', 'project_manager'); // global, unassigned
  ids.norole = await makeUser('bola-norole@example.test', null);            // no role at all

  ids.admin = db.prepare('SELECT id FROM users WHERE email = ?').get('bola-admin@example.test').id;

  srvOff = await boot(PORT);
  srvOn = await boot(PORT_ON, { SCOPE_ENFORCE: '1' });

  ids.clients = {
    fin: await loggedIn(ORIGIN, 'bola-fin@example.test', PW),
    pma: await loggedIn(ORIGIN, 'bola-pma@example.test', PW),
    pmnone: await loggedIn(ORIGIN, 'bola-pmnone@example.test', PW),
    norole: await loggedIn(ORIGIN, 'bola-norole@example.test', PW),
    pmaOn: await loggedIn(ORIGIN_ON, 'bola-pma@example.test', PW),
    finOn: await loggedIn(ORIGIN_ON, 'bola-fin@example.test', PW),
    admin: await loggedIn(ORIGIN, 'bola-admin@example.test', 'bolapw12345'),
  };
});

after(() => {
  for (const p of [srvOff, srvOn]) if (p) p.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const ledgerCount = (projectId) =>
  db.prepare('SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?').get(projectId).n;

// ---- BOLA1.1 / 1.2: the sidebar offers only authorised projects --------------

test('BOLA1.1 the switcher lists every project for an org-wide role', async () => {
  const res = await ids.clients.fin.get('/');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="pc-menu"/, 'a user with 2+ projects gets a real switcher, not a dead button');
  assert.match(html, /PRJ-2026/);
  assert.match(html, /SB-2027/);
});

test('BOLA1.2 the switcher does NOT offer a project the user is not assigned to', async () => {
  const res = await ids.clients.pma.get('/');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // The decisive assertion: the OTHER project must not be a selectable option.
  // With one authorised project there is no menu at all — the button renders
  // disabled — so assert on whichever shape appears.
  assert.ok(!html.includes('href="/?project=' + ids.bId + '"'),
    'a project-scoped user must not be offered another project in the switcher');
  assert.ok(!/\?project=2\b/.test(html), 'nor any link carrying the other project id');
  assert.match(html, /PRJ-2026/, 'their own project still renders');
  // And the page BODY carries no other project's ledger line.
  assert.ok(!html.includes(B_LINE));
});

test('BOLA1.2b a multi-project user IS offered each authorised project', async () => {
  // The mirror of 1.2: the menu must actually work for someone entitled to more
  // than one, or "hidden from the switcher" proves nothing.
  const res = await ids.clients.fin.get('/');
  const html = await res.text();
  const start = html.indexOf('id="pc-menu"');
  assert.ok(start > -1, 'an org-wide role with 2+ projects gets a real menu');
  const menu = html.slice(start, html.indexOf('</div>', start));
  // Match the project NAMES, which is what a user reads in the dropdown.
  assert.match(menu, /Second Bridge/, 'both projects appear in the menu');
  assert.match(menu, /Citarum Bridge/);
  // And each is a working link carrying its own id.
  assert.match(menu, /data-project="1"/);
  assert.match(menu, /data-project="2"/);
});

// ---- BOLA1.3: the read path ---------------------------------------------------

test('BOLA1.3 gate OFF: ?project=other falls back instead of leaking', async () => {
  const res = await ids.clients.pma.get(`/ledger?project=${ids.bId}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes(B_LINE),
    'the other project’s ledger line must not appear — this is the read leak the audit found');
  assert.ok(html.includes(A_LINE), 'the request falls back to the user’s own project');
});

test('BOLA1.4 gate ON: ?project=other is refused with a reason', async () => {
  const res = await ids.clients.pmaOn.get(`/ledger?project=${ids.bId}`);
  assert.strictEqual(res.status, 403, 'enforcement is what makes the parameter authoritative');
  const html = await res.text();
  assert.ok(!html.includes(B_LINE), 'a 403 must not carry the data it is refusing');
  assert.match(html, /not assigned/i, 'the page explains WHY, rather than a blank 403');
  // And it must explain the RIGHT thing. views/403.ejs hardcoded the CSRF message,
  // so every denial — including this one — advised "reload the page and try again",
  // which never fixes a scope refusal.
  assert.ok(!/could not be verified/i.test(html),
    'a scope denial must not be told as a CSRF failure; the fix is an assignment, not a reload');
});

test('BOLA1.5 gate ON: the user’s OWN project still works (the guard is not a blanket deny)', async () => {
  const res = await ids.clients.pmaOn.get('/ledger');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(A_LINE));
});

test('BOLA1.6 gate ON: an org-wide role reaches BOTH projects', async () => {
  const a = await ids.clients.finOn.get(`/ledger?project=${ids.aId}`);
  const b = await ids.clients.finOn.get(`/ledger?project=${ids.bId}`);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200, 'Finance sees all cost data (PRD §2.3) — scoping it would break the role');
  assert.ok((await a.text()).includes(A_LINE));
  assert.ok((await b.text()).includes(B_LINE));
});

// ---- BOLA1.7: the write path -------------------------------------------------

test('BOLA1.7 gate OFF: a cross-project WRITE still does not land', async () => {
  // The most important test in the file. "Not enforced" must never mean
  // "cross-project writes allowed" — the audit proved a POST with ?project=2
  // wrote into project 2 while answering a cheerful 302.
  const before = ledgerCount(ids.bId);
  const res = await ids.clients.pma.post(`/ledger/entry?project=${ids.bId}`,
    `side=debit&amount=999000&type=Expense&date=2026-05-02&description=${B_LINE}-WRITE`);
  assert.strictEqual(ledgerCount(ids.bId), before,
    `nothing may be written into a project the user is not assigned to (status was ${res.status})`);
});

test('BOLA1.8 gate ON: the same cross-project write is refused', async () => {
  const before = ledgerCount(ids.bId);
  const res = await ids.clients.pmaOn.post(`/ledger/entry?project=${ids.bId}`,
    `side=debit&amount=999000&type=Expense&date=2026-05-02&description=${B_LINE}-WRITE2`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(ledgerCount(ids.bId), before);
});

test('BOLA1.9 gate ON: the permitted role can still write into its own project', async () => {
  const before = ledgerCount(ids.aId);
  const res = await ids.clients.finOn.post(`/ledger/entry?project=${ids.aId}`,
    `side=debit&amount=123000&type=Expense&date=2026-05-03&description=${A_LINE}-WRITE`);
  assert.strictEqual(res.status, 302, 'a scope guard that blocks everyone is also a bug');
  assert.strictEqual(ledgerCount(ids.aId), before + 1);
});

// ---- BOLA1.10: fail closed ----------------------------------------------------

test('BOLA1.10 a user with NO role at all sees no project data (fail closed)', async () => {
  // A project-scoped role with no assignment, or an account stripped of roles,
  // must resolve to NOTHING. Granting the whole portfolio instead is the
  // "cannot verify ⇒ grant" failure mode.
  const res = await ids.clients.norole.get('/ledger');
  assert.strictEqual(res.status, 302, 'with no project to show, /ledger redirects rather than rendering data');
  const home = await ids.clients.norole.get('/');
  assert.strictEqual(home.status, 200);
  const html = await home.text();
  assert.ok(!html.includes(A_LINE) && !html.includes(B_LINE),
    'a role-less account must not see either project’s ledger');
});

// ---- BOLA1.11: no scoped grant ⇒ the global role's default (documented) ------

test('BOLA1.11 an unassigned global role keeps full visibility (v1 fallback)', async () => {
  // Documented, deliberate: with enforcement on, a global `project_manager` who
  // has no project assignment still sees every project. This is the plan's
  // recorded fallback for "any user left with a NULL project_id after backfill".
  // It is asserted so the behaviour is a decision on record, not an accident —
  // and so that changing it is a deliberate edit to this test.
  const res = await ids.clients.pmnone.get('/');
  const on = await loggedIn(ORIGIN_ON, 'bola-pmnone@example.test', PW);
  const resOn = await on.get(`/ledger?project=${ids.bId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(resOn.status, 200);
  assert.ok((await resOn.text()).includes(B_LINE));
});

// ---- BOLA1.12: the assignment is recorded, and it is recorded CORRECTLY ------

test('BOLA1.12 the admin screen records a per-project assignment', async () => {
  // Until this route existed, `user_roles.project_id` could not be populated at
  // all from the UI — so enforcement could never be switched on safely.
  const res = await ids.clients.admin.post(`/admin/users/${ids.pmnone}/projects`,
    `project_id=${ids.aId}`);
  assert.strictEqual(res.status, 302);

  const rows = db.prepare(
    'SELECT role_code, project_id FROM user_roles WHERE user_id = ? ORDER BY project_id IS NOT NULL')
    .all(ids.pmnone);
  assert.strictEqual(rows.length, 2, 'the GLOBAL grant must survive the scoped one being added');
  assert.strictEqual(rows[0].project_id, null, 'the global grant is untouched');
  assert.strictEqual(rows[1].project_id, Number(ids.aId), 'the scoped grant points at the right project');

  // And it takes effect: the newly assigned user is now scoped to A.
  const cli = await loggedIn(ORIGIN_ON, 'bola-pmnone@example.test', PW);
  const bNow = await cli.get(`/ledger?project=${ids.bId}`);
  assert.strictEqual(bNow.status, 403, 'the assignment the Administrator just made is enforced');
});

test('BOLA1.13 clearing the assignment restores the global default (no lock-out)', async () => {
  const res = await ids.clients.admin.post(`/admin/users/${ids.pmnone}/projects`, 'project_id=');
  assert.strictEqual(res.status, 302);
  const rows = db.prepare(
    'SELECT project_id FROM user_roles WHERE user_id = ? AND project_id IS NOT NULL').all(ids.pmnone);
  assert.strictEqual(rows.length, 0, 'clearing removes the scoped grant');
  const cli = await loggedIn(ORIGIN_ON, 'bola-pmnone@example.test', PW);
  assert.strictEqual((await cli.get(`/ledger?project=${ids.bId}`)).status, 200,
    'an Administrator must be able to undo an assignment without locking the user out of every project');
});

test('BOLA1.14 an Administrator keeps every project (cannot be scoped)', async () => {
  // A per-project grant for an Administrator would be a no-op that LOOKS like a
  // restriction, so the route refuses it outright rather than pretending.
  const res = await ids.clients.admin.post(`/admin/users/${ids.admin}/projects`,
    `project_id=${ids.aId}`);
  assert.strictEqual(res.status, 302);
  const rows = db.prepare(
    'SELECT COUNT(*) n FROM user_roles WHERE user_id = ? AND project_id IS NOT NULL').get(ids.admin).n;
  assert.strictEqual(rows, 0);
  const home = await ids.clients.admin.get('/');
  const html = await home.text();
  assert.match(html, /SB-2027/, 'an Administrator still sees the whole portfolio');
});

// ---- BOLA1.15: the backfilled install keeps working ---------------------------

test('BOLA1.15 migration 010 leaves every existing account able to reach its project', async () => {
  // The reason for the backfill-then-enforce order (decision 4A): enforcing
  // "assigned only" against an all-NULL column refuses EVERY existing account.
  // Assert the real dev DB's shape from its copy: the org-wide rows stay global,
  // and each scoped role gets a grant for every project that existed.
  const copy = path.join(path.dirname(dbPath), 'backfill.db');
  fs.copyFileSync(path.join(ROOT, 'data', 'practis.db'), copy);
  sh([path.join('src', 'db', 'migrate.js')], { PRACTIS_DB: copy });
  const c = new (require('better-sqlite3'))(copy, { readonly: true });

  const orgWideStillGlobal = c.prepare(`
    SELECT COUNT(*) n FROM user_roles
     WHERE project_id IS NOT NULL
       AND role_code IN ('administrator','finance','human_capital','procurement')`).get().n;
  assert.strictEqual(orgWideStillGlobal, 0, 'org-wide roles must stay global, or Finance breaks');

  // Every non-org-wide role must now have a project grant for each project that
  // existed. The GLOBAL row is deliberately KEPT alongside it: the roster
  // (q.allUsers / q.userWithRole) and the sidebar role name both join on
  // `project_id IS NULL`, so deleting it would blank out every user's displayed
  // role. The scoped row is what the scope layer reads; the global row is what
  // the UI reads as "this account's role".
  const unassigned = c.prepare(`
    SELECT u.email, ur.role_code FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
     WHERE ur.project_id IS NULL AND u.is_system_admin = 0
       AND ur.role_code NOT IN ('administrator','finance','human_capital','procurement')
       AND NOT EXISTS (SELECT 1 FROM user_roles s
                        WHERE s.user_id = ur.user_id AND s.project_id IS NOT NULL)`).all();
  assert.deepStrictEqual(unassigned, [],
    'every scoped role must end with at least one project grant, or enforcement locks it out');

  // And each scoped grant must cover EVERY project that exists at migration time.
  const projectCount = c.prepare('SELECT COUNT(*) n FROM projects').get().n;
  const shortGrants = c.prepare(`
    SELECT u.email, ur.role_code, COUNT(DISTINCT s.project_id) AS n
      FROM user_roles ur JOIN users u ON u.id = ur.user_id
      LEFT JOIN user_roles s ON s.user_id = ur.user_id AND s.project_id IS NOT NULL
     WHERE ur.project_id IS NULL AND u.is_system_admin = 0
       AND ur.role_code NOT IN ('administrator','finance','human_capital','procurement')
     GROUP BY ur.user_id, ur.role_code
    HAVING n < ?`).all(projectCount);
  assert.deepStrictEqual(shortGrants, [],
    `each scoped role needs all ${projectCount} pre-existing project(s), so no account loses access`);

  const adminsGlobal = c.prepare(`
    SELECT COUNT(*) n FROM user_roles ur JOIN users u ON u.id = ur.user_id
     WHERE u.is_system_admin = 1 AND ur.project_id IS NOT NULL`).get().n;
  assert.strictEqual(adminsGlobal, 0, 'an Administrator must not be pinned to one project');
  c.close();
});
