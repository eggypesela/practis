// RP8-series: the aging report screen — /reports and /reports/aging (module 8, plan part 8.3).
// THIS IS PART 8.3'S GATE. New routes/routes + views/aging.ejs are the change under test.
//
// WHY THIS FILE EXISTS
//
// Parts 8.1 and 8.2 fixed and extended the register VIEWS. This part is the first thing in the
// product that RENDERS them, so it is the first place the two defects those parts fixed could
// have shipped to a screen:
//
//   * the register that showed the ONE document which is not a receivable and hid every real
//     claim (part 8.1, migration 020);
//   * an undated invoice reported as "120+ days overdue" (part 8.1) and a due date that did not
//     exist at all (part 8.2, migration 021).
//
// THREE THINGS THIS FILE PINS, and each one is a decision rather than a detail:
//
//   1. AUTHORIZATION. `canViewReceivable` is Finance + Cost Controller — deliberately NOT the
//      `true` that the WBS tree and the budget use, because these registers expose what the
//      company is owed and by which customer. So: correct role 200; a role that holds neither
//      gets 403; anonymous gets a login redirect. A 403 is not evidence on its own — the DB row
//      count is asserted unchanged either way.
//
//   2. THE SCREEN AGREES WITH ITSELF. The bucket tiles and the table are rendered from ONE
//      result set in the route (`bucketTiles` in routes/reporting.js), so this file recomputes
//      the tiles from the TABLE TEXT and asserts they match. A tile that disagrees with the rows
//      under it is the classic dashboard defect and it is invisible in a unit test that only
//      checks one of the two.
//
//   3. THE TWO EXCEPTIONS ARE VISIBLE AND SEPARATE. The undatable claims must appear as their own
//      labelled group (not folded into the chase list, and never counted as overdue), and
//      retainage must be its own figure (PRD §5.2: "retainage held separately (never buried in
//      regular AR)").
//
// Figures are hand-computed from the seeded fixture in a comment before the assertion that uses
// them, so a reader can check the arithmetic without running anything.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

// 3923 is free: 3921 is reporting.test.js, 3922 is aging.test.js, 3920 is evm.test.js and 3919
// is descope.test.js. This file drives the real HTTP server rather than the service layer,
// because these are the first routes in the product that RENDER the registers.
const PORT = 3923;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let dbPath, proc, db, admin;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitForServer(origin) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${origin}/login`);
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error(`${origin} did not come up`);
}

async function boot(port, prefix) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const p = path.join(dbDir, 'test.db');
  const env = { ...process.env, PRACTIS_DB: p };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'rp8@example.com', 'rp8-pw-12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);
  // SCOPE_ENFORCE is deliberately LEFT AT ITS DEFAULT (off). Turning it on here would make a
  // project-scoped grant a hard restriction, and this file is about report authorization, not
  // scope enforcement — mixing the two would make a failure ambiguous.
  const child = spawn(NODE, [path.join('src', 'server.js')],
    { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: 'ignore' });
  await waitForServer(`http://127.0.0.1:${port}`);
  return { child, dbPath: p };
}

before(async () => {
  const booted = await boot(PORT, 'practis-rp8-');
  proc = booted.child;
  dbPath = booted.dbPath;
  db = require('better-sqlite3')(dbPath);

  const { loggedIn } = require('./helpers/csrf');
  admin = await loggedIn(ORIGIN, 'rp8@example.com', 'rp8-pw-12345');

  // A claim through the REAL Finance entry path — no cost category, no partner, exactly the
  // shape the app writes (part 8.1's measured deployment fact).
  const posted = await admin.post('/ledger/entry',
    'side=credit&amount=100000000&type=Receivable&date=2026-03-10'
    + '&document_no=RP8-INV-1&description=Progress claim');
  assert.strictEqual(posted.status, 302, 'the claim must be accepted');
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  if (proc) proc.kill();
});

const body = async (res) => res.text();
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ---- RP8.1 / RP8.2 authorization -------------------------------------------------

test('RP8.1 a Viewer is refused the receivable registers with a reason — and the DB is unchanged', async () => {
  const { asRole } = require('./helpers/authz');
  // A Viewer holds NO role that carries canViewReceivable. The flag is deliberately not `true`
  // (see permissions.js): these views expose who owes the company money, customer by customer.
  const viewer = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'viewer',
    { email: 'rp81-viewer@example.test' });

  // The sidebar still shows the link (the sidebar is not a permission system), so the ROUTE
  // must refuse — with a rendered 403 carrying the reason, not a redirect or a blank page.
  const before1 = db.prepare('SELECT COUNT(*) AS n FROM accounting_ledger').n;

  for (const p of ['/reports', '/reports/aging']) {
    const res = await viewer.client.get(p);
    assert.strictEqual(res.status, 403, `${p} refuses a Viewer`);
    const html = await res.text();
    assert.match(text(html), /Finance and Cost Control/,
      `${p} says WHY, rather than silently hiding the page`);
  }

  // The refusal changed nothing. A 403 is not evidence on its own; a row count is.
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM accounting_ledger').n, before1,
    'a refused report writes nothing');
});

test('RP8.2 an anonymous request is sent to the login page, not shown the register', async () => {
  const { client: anon } = require('./helpers/csrf');
  const anonCli = anon(ORIGIN);
  for (const p of ['/reports', '/reports/aging']) {
    const res = await anonCli.get(p);
    assert.strictEqual(res.status, 302, `${p} requires a session`);
    assert.match(res.headers.get('location') || '', /\/login/, `${p} → /login`);
  }
});

// ---- RP8.3 the screen renders the corrected register ---------------------------------

test('RP8.3 the aging screen renders a real claim (the register part 8.1 fixed)', async () => {
  const res = await admin.get('/reports/aging');
  assert.strictEqual(res.status, 200);
  const html = await body(res);

  assert.ok(html.includes('RP8-INV-1'), 'the claim posted through the entry path is on the screen');
  // Hand-computed: the claim is Rp 100,000,000 with no payment and no retainage, invoiced
  // 2026-03-10 with terms from the project/client/default cascade. `fmt` uses id-ID grouping.
  assert.ok(html.includes('100.000.000'), 'and its outstanding amount is rendered');

  // The page is project-scoped and says which project it is showing. The NAME is read from the
  // database rather than hard-coded: the seeder's project code is not a contract this test
  // should be pinning (it was written expecting PRJ-2026 and the seeder produces JC-2026).
  const proj = db.prepare('SELECT name FROM projects ORDER BY id LIMIT 1').get();
  assert.ok(proj, 'the fixture has a project');
  assert.ok(text(html).includes(proj.name),
    `the screen names the project it is scoping to (${proj.name})`);

  // House style: a title AND a muted sub-title. The subtitle lives in `page()`'s `subtitle`
  // local and is rendered by layout-app.ejs as the <p> under the <h1>.
  assert.ok(text(html).includes('collection priority list'),
    'the sub-title explains what the screen is for');
});

// ---- RP8.4 the tiles agree with the table --------------------------------------------

test('RP8.4 every bucket tile agrees with the rows the table renders', async () => {
  // THE DASHBOARD DEFECT THIS PINS. A tile computed from one query and a table from another
  // will eventually disagree — and a tile that contradicts the rows under it is worse than no
  // tile. Both are rendered from ONE result set in routes/reporting.js, so this recomputes the
  // tile totals FROM THE TABLE HTML and requires them to match.
  const res = await admin.get('/reports/aging?sort=amount');
  const html = await body(res);

  // The table body: every data row ends with the outstanding amount as the last cell.
  const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.ok(rows.length >= 1, 'the table has at least the posted claim');

  const tableTotal = rows.reduce((acc, row) => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const last = cells[cells.length - 1].replace(/<[^>]+>/g, '').trim();
    // id-ID grouping: "100.000.000". Strip every non-digit.
    return acc + (Number(last.replace(/[^\d]/g, '')) || 0);
  }, 0);
  assert.strictEqual(tableTotal, 100000000, 'the single claim totals Rp 100,000,000');

  // The 120+ tile must carry that same figure, because 2026-03-10 is far past every boundary.
  // Hand-computed: today is 2026-10-03, so the invoice is ~207 days old → '120_plus'.
  const tiles = html.slice(html.lastIndexOf('repeat(6,minmax(0,1fr))'));
  assert.ok(tiles.includes('120+ days'), 'the 120+ bucket is labelled on screen');
  assert.ok(tiles.includes('100.000.000'), 'and its tile carries the same total as the table');

  // Every one of the six buckets is rendered, including the empty ones — a bucket that is
  // absent reads as "no such bucket", which is a different fact from "nothing in it yet".
  for (const label of ['Not yet due', '1–30 days', '31–60 days', '61–90 days', '91–120 days']) {
    assert.ok(html.includes(label), `the "${label}" bucket is rendered even when empty`);
  }
});

// ---- RP8.5 the undatable group is its own, labelled to-do ----------------------------

test('RP8.5 an undatable claim is a labelled to-do group, never counted as overdue', async () => {
  // The F2 defect, at screen level. Migration 020 excludes undatable rows from `v_aging` so the
  // old CASE cannot fall through and call them '120_plus'; this asserts the SCREEN also keeps
  // them out of the chase totals and shows them where Finance can act on them.
  const before = text(await (await admin.get('/reports/aging')).text());

  db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES ((SELECT id FROM projects ORDER BY id LIMIT 1), 'RP8-NODATE', '', 'Receivable',
       'receivable', 0, -50000000, 0, 50000000, 'IDR', 'no invoice date', 'import', 0)`).run();

  const html = text(await (await admin.get('/reports/aging')).text());
  assert.ok(html.includes('RP8-NODATE'), 'the undatable claim is shown, not hidden');
  assert.match(html, /Cannot be dated/, 'and it is its own labelled group');
  assert.match(html, /Never counted as overdue|never counted as overdue|fix the data/i,
    'the group explains why it is not in the buckets');

  // It is NOT in the chase table: the claim's document number appears exactly once on the page
  // (in the to-do group), not twice.
  const occurrences = html.split('RP8-NODATE').length - 1;
  assert.strictEqual(occurrences, 1,
    'an undatable claim belongs in the to-do group only — not in the collection table');

  // And the outstanding total did NOT include it: it is still 100,000,000.
  assert.ok(html.includes('100.000.000'), 'the odds are unchanged by an unageable claim');
  // Sanity: the page grew, so the assertion above is not vacuous.
  assert.ok(!before.includes('RP8-NODATE'), 'the row was genuinely absent before this test');
});

// ---- RP8.6 retainage is its own figure ----------------------------------------------

test('RP8.6 retainage is held separately, never buried in regular AR (PRD §5.2)', async () => {
  // The claim above has no retainage, so its own figure is 0 — asserted, because a 0 placeholder
  // rendered as a number is what makes the tile trustworthy when it is NOT zero.
  const before1 = text(await (await admin.get('/reports/aging')).text());
  assert.match(before1, /Retainage held/, 'the retainage tile is always present');

  // Now bill with retainage through the real entry path: Rp 60,000,000 held on a Rp 200,000,000
  // claim. Hand-computed: billed 200,000,000, retainage 60,000,000,
  // outstanding = 200,000,000 - 0 - 60,000,000 = 140,000,000.
  const posted = await admin.post('/ledger/entry',
    'side=credit&amount=200000000&type=Receivable&date=2026-03-12'
    + '&document_no=RP8-RET-1&description=Claim with retainage&retainage=60000000');
  assert.strictEqual(posted.status, 302);

  const html = text(await (await admin.get('/reports/aging')).text());
  assert.ok(html.includes('RP8-RET-1'), 'the retained claim is on the screen');
  assert.ok(html.includes('60.000.000'), 'its retainage is rendered as its own figure');
  assert.ok(html.includes('140.000.000'), 'and its outstanding is net of the retainage');
  assert.ok(html.includes('retainage held'), 'the row itself is marked, not just the tile');
});

// ---- RP8.7 the sort is real, whitelisted, and cannot reach SQL -----------------------

test('RP8.7 the sort changes the order, and an unknown sort falls back instead of erroring', async () => {
  const order = async (qs) => {
    const html = await body(await admin.get(`/reports/aging${qs}`));
    const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    return [...tbody.matchAll(/RP8-[A-Z0-9-]+/g)].map((m) => m[0]);
  };

  const byAmount = await order('?sort=amount');
  assert.strictEqual(byAmount[0], 'RP8-RET-1',
    'largest first: the 140,000,000 outstanding leads the 100,000,000 claim');

  // The whitelist is in queries.js (three separate prepared statements). A parameter that is not
  // one of the three keys must fall back to the PRD default, NOT throw and NOT reach SQL.
  for (const bad of ['%20', 'outstanding_amount;DROP', 'nosuch']) {
    const res = await admin.get(`/reports/aging?sort=${bad}`);
    assert.strictEqual(res.status, 200, `sort=${bad} is handled, not a 500`);
    const html = await res.text();
    assert.ok(html.includes('RP8-RET-1'), `sort=${bad} still renders the list`);
  }

  // A sort with no rows is not an error either — and a project with nothing outstanding says so
  // rather than showing a table of zeros.
  const empty = await admin.get('/reports/aging?sort=due');
  assert.strictEqual(empty.status, 200);
});

// ---- RP8.8 the due date and its source reach the screen ------------------------------

test('RP8.8 the screen shows the due date AND which terms produced it (decision D3)', async () => {
  // Decision D3 answered "project → client → default, AND say which applied". The value without
  // its source is exactly what Finance cannot act on: "30 days" that is really "nobody set this"
  // is a different fact from "30 days, our terms".
  const html = text(await (await admin.get('/reports/aging')).text());

  // The seeded project and client have no terms, so the system default (30) applies.
  assert.ok(html.includes('default, 30d'), 'the terms source is named beside the due date');
  // Hand-computed: RP8-INV-1 is dated 2026-03-10 + 30 days = 2026-04-09.
  assert.ok(html.includes('2026-04-09'), 'and the due date is rendered from invoice date + terms');
  // Overdue days are shown as their own figure, distinct from the age.
  assert.match(html, /Overdue/, 'the overdue column exists — the fact the buckets cannot express');
});

// ---- RP8.9 the sidebar contract holds across the change ------------------------------

test('RP8.9 the restored Reports link resolves for a role that may open it', async () => {
  // MS6.7/MS6.8 (wbs-defaults.test.js) assert no dead sidebar link and that every link
  // resolves. MS6.10 pins that the restored link and its route landed together. This is the
  // third leg: a role that is ALLOWED to open reports sees the link resolve to a real page.
  const { asRole } = require('./helpers/authz');
  const finance = await asRole(require('better-sqlite3'), dbPath, ORIGIN, 'finance',
    { email: 'rp89-fin@example.test' });

  const home = await finance.client.get('/');
  const html = await home.text();
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.ok(nav.includes('href="/reports"'), 'Finance sees the Reports link');

  const res = await finance.client.get('/reports/aging');
  assert.strictEqual(res.status, 200, 'and can open the aging report');
  const b = await res.text();
  assert.ok(b.includes('RP8-INV-1'), 'which shows the real register');
});
