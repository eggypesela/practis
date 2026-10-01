// FX-series: the REAL-LEDGER FIXTURE regression test.
//
// TECH-SPEC §8.3: "The real-ledger fixture (`fixture-ledger-export.tsv`, 26 rows) is
// regression-checked on EVERY run." Until now that fixture existed and was referenced by
// ZERO tests — the spec claimed a guarantee the suite did not provide.
//
// WHY THIS TEST IS WORTH ITS WEIGHT: it drives the canonical real-world export end to
// end (parse → stage → preview → confirm → ledger rows), and it immediately caught two
// defects the CSV unit tests could not, because every CSV test in the suite is
// comma-separated with ISO dates while the real export is neither:
//
//   1. No TAB delimiter support. The fixture is tab-separated; the parser only split on
//      `,`/`;`, so each row collapsed to ONE cell and all 26 rows quarantined as
//      "missing transaction_id" — a confusing symptom for a delimiter problem.
//   2. No Excel serial dates. The fixture carries `45200` (Excel's raw serial for
//      2023-10-01), which `toIsoDate` rejected, so every row also failed on a bad date.
//
// Both fixed in src/lib/csv.js. This file is the guarantee they stay fixed.
//
// Real data, so the fixture's own codes must be seeded: project `SYN-24-001` and its
// chart-of-accounts / cashflow / transaction-account codes do NOT exist in seed-master
// (which is PRJ-2026-shaped). Lookup misses are row errors by design, so seeding them is
// what makes the theft of "did the real file import cleanly" answerable at all.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = 3908;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const FIXTURE = path.join(ROOT, 'db', 'fixture-ledger-export.tsv');
// §8.3 states 26 rows. Asserted below, so a fixture edit that changes the row count
// forces a conscious update rather than silently shifting the baseline.
const EXPECTED_ROWS = 26;

const csv = require('../src/lib/csv');

let dbPath, proc, cookie, csrf, db;

function sh(args, env) {
  return execFileSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}

async function upload(text, filename = 'ledger.tsv') {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/tab-separated-values' }), filename);
  const res = await fetch(`${ORIGIN}/api/imports`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'x-csrf-token': csrf },
    body: fd,
  });
  return { status: res.status, body: await res.json() };
}

const preview = async (id) => {
  const res = await fetch(`${ORIGIN}/api/imports/${id}/preview`, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};

const confirm = async (id) => {
  const res = await fetch(`${ORIGIN}/api/imports/${id}/confirm`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'x-csrf-token': csrf },
  });
  return { status: res.status, body: await res.json() };
};

// Master data the fixture needs. Written through the test's OWN handle — never
// require('../src/db/...'), which would bind the default DB file rather than this temp one.
const FIXTURE_ACCOUNTS = ['510100001', '110100002', '210100003', '110100004_BPC',
  '111700005', '111300006', '110100007_BPC', '210500008'];
const FIXTURE_CASHFLOW = ['B1', 'B2'];
// Column 12 (sub_rbs_code) — the fixture's transaction-account codes. TX03P lives HERE,
// not in cashflow: reading the column order wrong is how a row quarantines as
// "unknown transaction account 'TX03P'".
const FIXTURE_TX = ['TX01', 'TX01P', 'TX02', 'TX03P'];

function seedFixtureMasters(handle) {
  handle.prepare(`INSERT INTO projects (id, code, name, currency, status)
                  VALUES (9001, 'SYN-24-001', 'Site Utama real-ledger fixture project', 'IDR', 'active')`).run();
  const acct = handle.prepare(`INSERT INTO chart_of_accounts (id, code, name, account_type, normal_side)
                               VALUES (?, ?, ?, 'expense', 'debit')`);
  FIXTURE_ACCOUNTS.forEach((c, i) => acct.run(9000 + i, c, `fixture account ${c}`));
  const cf = handle.prepare(`INSERT INTO cashflow_categories (id, code, name) VALUES (?, ?, ?)`);
  FIXTURE_CASHFLOW.forEach((c, i) => cf.run(9100 + i, c, `fixture cashflow ${c}`));
  const tx = handle.prepare(`INSERT INTO transaction_accounts (id, code, name) VALUES (?, ?, ?)`);
  FIXTURE_TX.forEach((c, i) => tx.run(9200 + i, c, `fixture tx account ${c}`));
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'practis-fx-')), 'test.db');
  const env = { PRACTIS_DB: dbPath, PRACTIS_IMPORTS: path.join(path.dirname(dbPath), 'imports') };
  sh([path.join('src', 'db', 'migrate.js')], env);
  sh([path.join('src', 'db', 'seed.js'), 'fx@example.com', 'fxpw12345'], env);
  sh([path.join('src', 'db', 'seed-master.js')], env);

  db = new (require('better-sqlite3'))(dbPath);
  seedFixtureMasters(db);

  proc = spawn(NODE, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    proc.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) { clearTimeout(t); resolve(); } });
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
  const cli = await require('./helpers/csrf').loggedIn(ORIGIN, 'fx@example.com', 'fxpw12345');
  cookie = `practis_sid=${cli.j.c['practis_sid']}`;
  csrf = cli.token();
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  if (db) db.close();
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const ledgerCount = () => db.prepare('SELECT COUNT(*) n FROM accounting_ledger').get().n;
const importedCount = () => db.prepare("SELECT COUNT(*) n FROM accounting_ledger WHERE source='import'").get().n;

// ---- FX1: the parser reads the real file's SHAPE ----------------------------

test('FX1.1 the fixture is tab-separated and parses to its real 14 columns', async () => {
  const parsed = csv.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.strictEqual(parsed.delimiter, '\t',
    'the real export is TAB-separated; a comma/semicolon guess collapses every row to one cell');
  assert.strictEqual(parsed.headers.length, 14, 'header must split into 14 column names');
  assert.strictEqual(parsed.rows.length, EXPECTED_ROWS, `§8.3 states ${EXPECTED_ROWS} rows`);
  // Rows are RAGGED by design: a TSV export drops trailing empty cells, so a row whose
  // optional columns are blank (cashflow_code, Type, reference_no…) legitimately ends
  // early. The mapper reads optional columns by header INDEX, so a missing trailing cell
  // must read as "absent", not "shift the columns". Assert that the values land in the
  // right columns rather than that every row is rectangular.
  parsed.rows.forEach((r, i) => {
    assert.ok(r.length >= 5 && r.length <= 14, `row ${i + 1} must have 5–14 cells, got ${r.length}`);
  });
  // Anti-shift check: the last column present on the widest row is still date_adjustment,
  // and column 0 is the legacy id — if the delimiter were wrong, column 0 would hold the
  // entire line.
  const widest = parsed.rows.find((r) => r.length === 14);
  assert.ok(widest, 'at least one row fills all 14 columns');
  assert.match(widest[0], /^\d+$/, 'column 0 is the legacy numeric id');
  assert.match(widest[1], /^\w+$/, 'column 1 is transaction_id');
  assert.match(widest[3], /^\d{6,}[A-Z_]*$/, 'column 3 is account_code');
});

test('FX1.2 descriptions containing commas do not split the row', async () => {
  // The trap that makes naive "split on , or ;" wrong: real descriptions carry commas.
  // The parser must split on TAB only, so a comma stays inside its own cell.
  const parsed = csv.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const i = parsed.rows.findIndex((r) => r.some((c) => c.includes(',')));
  assert.ok(i >= 0, 'the fixture is expected to contain at least one comma-bearing description');
  const row = parsed.rows[i];
  assert.ok(row[8].includes(','), 'the comma belongs to the description column, unsplit');
  assert.ok(row.length >= 9, 'the row keeps the columns that follow the description');
});

test('FX1.3 Excel serial dates decode to the right calendar day', async () => {
  // 45200 is Excel's raw serial for 2023-10-01 (1900 date system). Verified against
  // the anchor 1899-12-30, which absorbs Excel's deliberate 1900-leap-year bug.
  assert.strictEqual(csv.toIsoDate('45200'), '2023-10-01');
  assert.strictEqual(csv.toIsoDate('45214'), '2023-10-15');
  // ISO and DD/MM/YYYY inputs must keep working — the fix must not over-capture.
  assert.strictEqual(csv.toIsoDate('2023-10-01'), '2023-10-01');
  assert.strictEqual(csv.toIsoDate('01/10/2023'), '2023-10-01');
  assert.strictEqual(csv.toIsoDate(''), null);
});

// ---- FX2/FX3: the whole import path over real data --------------------------

test('FX2.1 every one of the 26 real rows stages clean (0 quarantined)', async () => {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const up = await upload(text);
  assert.strictEqual(up.status, 201, `stage should accept the real file, got ${up.status}`);
  assert.strictEqual(up.body.rowCount, EXPECTED_ROWS);

  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.status, 200);
  assert.strictEqual(pv.body.newCount, EXPECTED_ROWS,
    'all real rows must be importable — any invalid row means master seed or parsing is wrong');
  assert.strictEqual(pv.body.invalid.length, 0,
    `no row should quarantine: ${JSON.stringify(pv.body.invalid.slice(0, 3))}`);

  // Confirm the real rows actually land, and only as import-sourced lines.
  const before = ledgerCount();
  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.status, 200);
  assert.strictEqual(cf.body.inserted, EXPECTED_ROWS);
  assert.strictEqual(ledgerCount(), before + EXPECTED_ROWS);
  assert.strictEqual(importedCount(), EXPECTED_ROWS);
});

test('FX3.1 the imported rows satisfy the ledger invariants', async () => {
  const rows = db.prepare(`SELECT transaction_id, date, effective_date, amount, debit, credit,
                                  line_role, in_cost_basis, source, project_id
                             FROM accounting_ledger WHERE source='import'`).all();
  assert.strictEqual(rows.length, EXPECTED_ROWS);
  for (const r of rows) {
    assert.strictEqual(r.project_id, 9001, `${r.transaction_id} must resolve to the fixture project`);
    // §8.4: amount = debit - credit, one side only, whole rupiah.
    assert.strictEqual(r.amount, r.debit - r.credit, `${r.transaction_id}: amount = debit - credit`);
    assert.ok(Number.isInteger(r.amount), `${r.transaction_id}: whole rupiah`);
    assert.ok(r.debit === 0 || r.credit === 0, `${r.transaction_id}: one side only`);
    // Credit lines must carry a NEGATIVE amount, which is what makes the pair net to zero.
    if (r.credit > 0) assert.ok(r.amount < 0, `${r.transaction_id}: a credit line has a negative amount`);
    if (r.debit > 0) assert.ok(r.amount > 0, `${r.transaction_id}: a debit line has a positive amount`);
  }
});

test('FX3.2 the decoded dates land in the real October 2023 window', async () => {
  const rows = db.prepare(`SELECT date, effective_date FROM accounting_ledger WHERE source='import'`).all();
  const dates = rows.map((r) => r.date).sort();
  assert.strictEqual(dates[0], '2023-10-01', 'the earliest real posting date');
  assert.strictEqual(dates[dates.length - 1], '2023-10-25', 'the latest real posting date');
  // date_adjustment is populated on the real export; it must survive as effective_date.
  const withAdj = rows.filter((r) => r.effective_date).length;
  assert.strictEqual(withAdj, 13, 'the real export carries date_adjustment on 13 rows');
});

test('FX3.3 the type column maps to the legacy vocabulary decision', async () => {
  // Decision B: legacy 'Revenue' stays 'Revenue' with line_role 'receivable' and
  // in_cost_basis 0 — a Finance revenue marker, NOT project cost. The fixture carries
  // Payable/Expense/Dropping, so assert the mapping that IS present.
  const byType = db.prepare(`SELECT type, line_role, in_cost_basis, COUNT(*) n
                               FROM accounting_ledger WHERE source='import'
                              GROUP BY type, line_role, in_cost_basis ORDER BY type`).all();
  const map = Object.fromEntries(byType.map((r) => [r.type, r]));
  assert.deepStrictEqual({ role: map.Expense.line_role, cb: map.Expense.in_cost_basis },
    { role: 'expense', cb: 1 }, 'Expense is project cost');
  assert.deepStrictEqual({ role: map.Payable.line_role, cb: map.Payable.in_cost_basis },
    { role: 'payable', cb: 1 }, 'Payable is project cost');
  assert.deepStrictEqual({ role: map.Dropping.line_role, cb: map.Dropping.in_cost_basis },
    { role: 'dropping', cb: 0 }, 'Dropping is a cash advance, NOT cost basis');
});

test('FX4.2 the extension allowlist widened to .tsv but still rejects anything else', async () => {
  // Adding .tsv must not turn into "accept anything". A reviewer should see the boundary
  // is still a boundary.
  const up = await upload(fs.readFileSync(FIXTURE, 'utf8'), 'ledger.xlsx');
  assert.strictEqual(up.status, 400);
  assert.strictEqual(up.body.error.code, 'BAD_EXTENSION');
});

test('FX4.1 re-importing the same real file adds nothing (dedupe holds)', async () => {
  // §8.4: "Import never overwrites existing tagged lines; duplicates skipped/counted."
  // The dedupe index is keyed on (transaction_id, document_no, date, amount, project).
  const before = ledgerCount();
  const up = await upload(fs.readFileSync(FIXTURE, 'utf8'));
  assert.strictEqual(up.status, 201);
  const pv = await preview(up.body.batchId);
  assert.strictEqual(pv.body.newCount, 0, 'every real row is already present');
  assert.strictEqual(pv.body.skippedCount, EXPECTED_ROWS, 'all 26 counted as duplicates');
  const cf = await confirm(up.body.batchId);
  assert.strictEqual(cf.body.inserted, 0, 'nothing re-applied');
  assert.strictEqual(ledgerCount(), before, 'the ledger did not grow');
});
