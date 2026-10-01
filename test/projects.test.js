// PR-series: portfolio register (plan task 6.1, finishes TECH-SPEC §10 step 3).
//
// WHY THIS FILE EXISTS
// `/projects` is linked from the sidebar of every page and returned **404** —
// there was no route. The register also has to answer the scope question: a
// project-scoped user must see their projects and nothing else, asserted as
// DATA (which projects render), never as a bare status code.
//
// The switcher test seeds a SECOND project on purpose. With one authorised
// project the sidebar renders a disabled button and no <a href> at all, so an
// "offers every project" assertion would be vacuous rather than passing.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3904;   // 3901 authz · 3902/3903 bola · 3905-3907 security · 3908 fixture · 3910 periods

let dbPath, proc, cookie, db;
const { client } = require('./helpers/csrf');
const ORIGIN = `http://127.0.0.1:${PORT}`;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
async function req(pathname, opts = {}) {
  return fetch(`${ORIGIN}${pathname}`, { redirect: 'manual', ...opts });
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-projects-')), 'test.db');
  const env = { PRACTIS_DB: dbPath };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'e@example.com', 'epw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  // A second project, inserted with the test's OWN handle (never
  // require('../src/...'), which would bind the default DB file).
  db = new (require('better-sqlite3'))(dbPath);
  db.prepare(`INSERT INTO projects (code, name, contract_amount, status, start_date, end_date)
              VALUES (?, ?, ?, 'active', '2026-03-01', '2027-12-31')`)
    .run('PRJ-2027', 'Merauke Access Road', 4_250_000_000);
  db.close();

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, PRACTIS_DB: dbPath, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
  const cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'e@example.com', 'epw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;
  db = new (require('better-sqlite3'))(dbPath);
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

// ---- PR1.1 the route exists and lists the register ----

test('PR1.1 GET /projects renders the portfolio register (was 404)', async () => {
  const res = await req('/projects', { headers: { cookie } });
  assert.strictEqual(res.status, 200, 'the sidebar links /projects on every page — it must not 404');
  const html = await res.text();
  assert.match(html, /PRJ-2026/, 'the seeded project code is listed');
  assert.match(html, /Citarum Bridge/, 'and its name');
  assert.match(html, /PRJ-2027/, 'and every other project the user may see');
});

test('PR1.2 the register shows each project with its contract value and baseline state', async () => {
  const res = await req('/projects', { headers: { cookie } });
  const html = await res.text();
  // 12,480,000,000 grouped id-ID. Assert the number, not just a label.
  assert.match(html, /12\.480\.000\.000/, 'contract amount is rendered grouped, not raw');
  // baseline_locked = 0 for both seeded projects, so the register must say so
  // rather than showing a blank cell (PRD §4.1 step 6 language).
  assert.match(html, /not baselined|Not baselined|no baseline/i,
    'an un-baselined project is labelled, not silently blank (EVM depends on this)');
});

test('PR1.3 the page follows the house UI contract (title + muted subtitle)', async () => {
  const res = await req('/projects', { headers: { cookie } });
  const html = await res.text();
  // Every app page renders through layout-app's `.hd` block: an <h1> title plus
  // a muted sub-title <p>. (`.sub` exists only on the auth pages, which use a
  // different layout — asserting it here would test a class this layout never
  // emits.)
  assert.match(html, /<div class="hd">\s*<div><h1>Projects<\/h1><p>[^<]+<\/p>/,
    'title and a non-empty sub-title, in the shared header block');
});

// ---- PR1.4 the switcher actually offers the projects ----

test('PR1.4 the sidebar switcher offers every authorised project as a real link', async () => {
  const res = await req('/', { headers: { cookie } });
  const html = await res.text();
  const p1 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2026'`).get().id;
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  assert.match(html, new RegExp(`href="/\\?project=${p1}"`), 'first project is a link, not a dead button');
  assert.match(html, new RegExp(`href="/\\?project=${p2}"`), 'second project too');
});

// ---- PR1.5 authorization: the seam case ----

test('PR1.5 anonymous GET /projects is sent to /login, not rendered', async () => {
  const res = await req('/projects');
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location') || '', /\/login/);
});

test('PR1.6 a project-scoped user sees ONLY their assigned project', async () => {
  // The scope layer's job. Asserted as DATA: which codes render, and which do
  // NOT — a status-only test would pass on a page that leaked everything.
  const { asRole } = require('./helpers/authz');
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  const scoped = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { projectId: p2, email: 'pr16-scoped@example.test' });

  const res = await scoped.client.get('/projects');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /PRJ-2027/, 'their own project is listed');
  assert.doesNotMatch(html, /Citarum Bridge/, 'and the project they are NOT on is not');
});

test('PR1.7 the register counts what it shows (no whole-portfolio query leaking in)', async () => {
  // A scoped user's page must not be built from q.projects() — the whole-
  // portfolio query. Same class of bug as the dashboard leak (audit BOLA).
  const { asRole } = require('./helpers/authz');
  const p2 = db.prepare(`SELECT id FROM projects WHERE code='PRJ-2027'`).get().id;
  const scoped = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'project_manager',
    { projectId: p2, email: 'pr17-scoped@example.test' });

  const res = await scoped.client.get('/projects');
  const html = await res.text();
  const rows = (html.match(/PRJ-20\d\d/g) || []).length;
  assert.strictEqual(rows, 1, `exactly one project row for a one-project user (saw ${rows})`);
});
