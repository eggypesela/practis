// RG8-series: register honesty — the AR/AP join and the aging bucket (module 8, plan part 8.1).
// THIS IS PART 8.1'S GATE. Migration 020 is the change under test.
//
// WHY THIS FILE EXISTS
//
// Module 8 is the reporting module, and every screen it adds renders one of two views:
// `v_receivable` (who owes us money), `v_payable` (who we owe) and `v_aging` (Finance's
// collection priority list). Measured on the seeded dev database before migration 020,
// `v_receivable` returned exactly ONE row — and it was the one document that is NOT a
// receivable:
//
//   CASHOUT-0208 | billed 0 | paid 30,000,000 | outstanding MINUS 30,000,000  (a funding line)
//
// while every real claim was invisible (INV-0224 400M claim / 300M paid / 40M retainage,
// RET-0044 40M, CASHIN-0114 300M). So the collections list led with "one item, minus thirty
// million" and the company's entire receivable balance was hidden. PRD §5.2 names the rule that
// was not followed: "Receivable/payable are computed views over the ledger (filtered by type +
// document no)". `v_payable` followed it (it filters on `type`) and worked; `v_receivable`
// filtered on `cost_category_id` instead and did not.
//
// HOW BADLY IT WAS BROKEN, AND WHY IT COULD NEVER HAVE BEEN A PREFERENCE
//
// This file asserts the deployment fact that settles decision D1 (see the plan, §6): the app's
// own master seeder creates SIX cost categories and NOT ONE of them is receivable-capable —
// measured: `SELECT COUNT(*) FROM cost_categories WHERE is_receivable = 1` returns 0 on a
// database seeded by `src/db/seed-master.js`. The only receivable-capable categories in the
// repository belong to `db/seed-smoke.sql`, which is the validator's fixture, not a migration.
// So on any real installation the old view could not return a claim at all, and option D1-B
// ("make Finance set a cost category on every invoice") was not implementable — the category
// it required does not exist to be chosen. That is measured here, not argued.
//
// EVERY EXPECTED NUMBER IS COMPUTED BY HAND IN A COMMENT, and the one figure that is not
// hand-computed (the day counts in the bucket test) derives from dates the DB itself generates
// with explicit offsets, which is deterministic without being circular.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3921;   // 3920 is held by evm.test.js; fresh port for module 8 part 8.1
const PROJECT = 1;   // PRJ-2026 — seeded by seed-master.js (with a WBS tree)
const MONTH = '2026-09';  // a month no other fixture data occupies

let fx;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-rg8-1-' });
});

after(() => { if (fx) fx.stop(); });

// Read the registers through the fixture's own connection to the same file.
const one = (sql, ...p) => fx.db.prepare(sql).get(...p);
const all = (sql, ...p) => fx.db.prepare(sql).all(...p);

// Post a ledger line through the REAL Finance entry path (HTTP + CSRF + frozen-period check).
// Deliberately used instead of a direct INSERT wherever the line is something the app itself can
// write, because the defect lives in the gap between what the app writes and what the register
// reads: `ledger-builder.js` hard-codes `cost_category_id: null`, so an HTTP post is the honest
// way to reproduce the production condition.
async function post(body) {
  const res = await fx.clients.get('finance').post('/ledger/entry', body);
  assert.strictEqual(res.status, 302, `expected the entry to be accepted, got ${res.status}`);
  return fx.db.prepare('SELECT * FROM accounting_ledger ORDER BY id DESC LIMIT 1').get();
}

// A funding line is inserted directly, and the reason is stated rather than hidden: NO app code
// path writes `line_role = 'funding'`. Measured — the only occurrences in the repository are
// `src/db/seed-demo.js` (a demo seeder), `db/seed-smoke.sql` (the validator fixture), and
// `db/validate.py` (which inserts one to test netting). `ledger-builder.js` maps the UI's six
// Types to receivable/expense/dropping only. So the payment leg of every test below is fixture
// data standing in for a workflow the product does not yet have — which is itself part of
// finding F1 and is not something this test can fix.
function insertFunding({ documentNo, amount, date = '2026-09-20', partnerType = null, partnerId = null }) {
  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, partner_type, partner_id, date, type, line_role, in_cost_basis,
       amount, debit, credit, currency, description, source, cost_checked)
    VALUES (?, ?, ?, ?, ?, 'Receivable', 'funding', 0, ?, ?, 0, 'IDR', 'payment', 'manual', 0)`)
    .run(PROJECT, documentNo, partnerType, partnerId, date, amount, amount);
}

// ---- RG8.1 the register identifies a claim by TYPE, not by cost category ----

test('RG8.1 a claim written by the manual entry path IS a receivable — with no cost category anywhere', async () => {
  // The deployment fact behind decision D1: the seeded master catalog is NOT receivable-capable.
  // Hand-checked: seed-master.js COST_CATEGORIES is MAT/LAB/EQP/SUB/OVH/TAX, and its INSERT sets
  // only (code, name) — every is_* flag takes the column default of 0.
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM cost_categories WHERE is_receivable = 1').n, 0,
    'the app seed must create no receivable-capable cost category — this is why D1-B was impossible');

  // Invoice the client Rp 250,000,000 (credit → negative amount, per the ledger's sign rule).
  const row = await post('side=credit&amount=250000000&type=Receivable'
    + `&date=2026-09-10&document_no=INV-8A1&description=Progress claim`);
  assert.strictEqual(row.cost_category_id, null, 'the entry path must leave the cost category unset');
  assert.strictEqual(row.line_role, 'receivable');
  // The entry path also leaves the partner unset — there is no client field on the entry form and
  // no trigger fills one. Recorded rather than asserted away: it is a real (smaller) gap in the
  // same family, it does not affect any figure in this part, and it is left to part 8.3 to decide
  // whether the aging screen needs a named customer or an id-only listing.
  assert.strictEqual(row.partner_type, null, 'no app path sets a partner on a manual claim');

  // It was invisible to the OLD filter, by construction: NULL never joins a cost category.
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM cost_categories cc '
    + 'JOIN accounting_ledger l ON l.cost_category_id = cc.id '
    + "WHERE cc.is_receivable = 1 AND l.document_no = 'INV-8A1'").n, 0);

  // It IS visible to the corrected register. Hand-computed: billed = |−250,000,000| = 250,000,000;
  // no payment and no retainage, so outstanding = 250,000,000 − 0 − 0 = 250,000,000.
  const r = one("SELECT billed_amount, paid_amount, retainage_amount, outstanding_amount, invoice_date, line_count "
    + "FROM v_receivable WHERE document_no = 'INV-8A1'");
  assert.strictEqual(r.billed_amount, 250000000);
  assert.strictEqual(r.paid_amount, 0);
  assert.strictEqual(r.retainage_amount, 0);
  assert.strictEqual(r.outstanding_amount, 250000000);
  assert.strictEqual(r.invoice_date, '2026-09-10');
  assert.strictEqual(r.line_count, 1);
});

// ---- RG8.2 a funding-only document is NOT a receivable (the measured symptom) ----

test('RG8.2 a cash movement with no claim on its own document is not a receivable, and is not aged', async () => {
  // F1's visible symptom. Before 020 this document was the ONLY row in v_receivable, reported at
  // minus its own amount. It has no claim line on it, so it is a cash movement, not a receivable.
  insertFunding({ documentNo: 'PAY-ONLY-8A2', amount: 30000000, date: '2026-09-15' });

  const inLedger = one("SELECT line_role, type FROM accounting_ledger WHERE document_no = 'PAY-ONLY-8A2'");
  assert.strictEqual(inLedger.line_role, 'funding', 'the fixture line must genuinely be a funding line');

  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_receivable WHERE document_no = 'PAY-ONLY-8A2'").n, 0,
    'a funding-only document must not appear in the receivable register');
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_aging WHERE document_no = 'PAY-ONLY-8A2'").n, 0,
    'and it must not appear in the collections list');
  // Nothing invented in its place: no row means no figures at all, rather than a plausible zero.
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_receivable WHERE outstanding_amount < 0").n, 0,
    'no document may report a negative amount owed to us');
});

// ---- RG8.3 a payment nets ONLY against a claim on the same document ----

test('RG8.3 a same-document payment nets the claim; a different-document payment does not', async () => {
  // Hand-computed. Claim: billing 100,000,000 with 10,000,000 held as retainage.
  //   billed = 100,000,000 | retainage = 10,000,000
  //   outstanding = billed − paid − retainage = 100,000,000 − 40,000,000 − 10,000,000 = 50,000,000
  const claim = await post('side=credit&amount=100000000&type=Receivable'
    + '&date=2026-09-05&document_no=INV-8A3&description=Claim with retainage&retainage=10000000');
  assert.strictEqual(claim.retainage_amount, 10000000);

  insertFunding({ documentNo: 'INV-8A3', amount: 40000000, date: '2026-09-18' });

  const r = one("SELECT billed_amount, paid_amount, retainage_amount, outstanding_amount, line_count "
    + "FROM v_receivable WHERE document_no = 'INV-8A3'");
  assert.strictEqual(r.billed_amount, 100000000);
  assert.strictEqual(r.paid_amount, 40000000);
  assert.strictEqual(r.retainage_amount, 10000000);
  assert.strictEqual(r.outstanding_amount, 50000000);
  assert.strictEqual(r.line_count, 2);
  // The retainage is surfaced, not buried (PRD §5.2: "retainage held separately").
  assert.strictEqual(one("SELECT has_retainage FROM v_aging WHERE document_no = 'INV-8A3'").has_retainage, 1);

  // The validator's rule, re-asserted at the register level: a payment on a DIFFERENT document
  // must not reduce this invoice. Before the fix this could not even be expressed, because no
  // claim was visible to test against.
  insertFunding({ documentNo: 'OTHER-8A3', amount: 99999999, date: '2026-09-19' });
  assert.strictEqual(
    one("SELECT outstanding_amount FROM v_receivable WHERE document_no = 'INV-8A3'").outstanding_amount,
    50000000, 'a payment on another document must leave this claim untouched');
  // And the payment's own document, having no claim, joins no register at all.
  // (Written as its own document earlier with `type='Receivable', line_role='funding'` — a
  // payment carrying a claim's TYPE. It must still not be admitted: a payment is never a claim,
  // whatever its type says. This assertion is what caught the first draft of migration 020
  // treating the type test as sufficient.)
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_receivable WHERE document_no = 'OTHER-8A3'").n, 0);
});

// ---- RG8.4 a settled document leaves the collection list ----

test('RG8.4 an invoice paid in full drops out of the aging list (outstanding 0 is not a priority)', async () => {
  // Hand-computed: billing 10,000,000, paid 10,000,000, retainage 0 → outstanding 0.
  await post('side=credit&amount=10000000&type=Receivable'
    + '&date=2026-09-06&document_no=INV-8A4&description=Settled in full');
  insertFunding({ documentNo: 'INV-8A4', amount: 10000000, date: '2026-09-21' });

  const r = one("SELECT billed_amount, paid_amount, outstanding_amount FROM v_receivable WHERE document_no = 'INV-8A4'");
  assert.strictEqual(r.billed_amount, 10000000);
  assert.strictEqual(r.paid_amount, 10000000);
  assert.strictEqual(r.outstanding_amount, 0);

  // `v_aging` is a collection priority list: a document with nothing outstanding is not on it.
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_aging WHERE document_no = 'INV-8A4'").n, 0);
});

// ---- RG8.5 an undatable row is excluded, not reported as 120+ days overdue ----

test('RG8.5 a blank invoice date is excluded from aging, and cannot blank a document that has a real date', async () => {
  // THE CORRECTION THIS TEST EXISTS FOR. The first draft of migration 020 guarded on
  // `invoice_date IS NULL`, and measurement showed it does not fire: `accounting_ledger.date` is
  // NOT NULL, which blocks an ABSENT date but not a BLANK one — `date = ''` is accepted, and
  // `julianday('')` is NULL, so the row sorted before every real date while `1 <= NULL` was false
  // and it fell through the whole CASE to '120_plus'. An undated row led the collection list as
  // the most overdue item: the same "missing value becomes an alarming value" defect as F1.
  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'INV-8A5-BLANK', '', 'Receivable', 'receivable', 0, -7000000, 0, 7000000,
       'IDR', 'no date on the invoice', 'import', 0)`).run(PROJECT);

  // Visible in the register — it is a real claim, and Finance must be able to find it to fix it.
  const reg = one("SELECT invoice_date, outstanding_amount FROM v_receivable WHERE document_no = 'INV-8A5-BLANK'");
  assert.strictEqual(reg.invoice_date, null, 'a blank date must read as NULL, not as an empty string');
  assert.strictEqual(reg.outstanding_amount, 7000000);

  // Excluded from aging. `1 <= julianday('')` = `1 <= NULL` = NULL, so an unfiltered CASE here is
  // a run of NULLs ending in ELSE '120_plus' — the false alarm this test forbids.
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_aging WHERE document_no = 'INV-8A5-BLANK'").n, 0,
    'an undatable row must not be aged at all');
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_aging WHERE aging_bucket = 'no_date'").n, 0,
    'the no_date bucket is not populated by v_aging — the screen queries v_receivable for it');

  // And the second half of the trap: a document whose lines MIX a blank and a real date.
  // Plain `MIN(date)` returns the blank string — one undated line drags the whole document's
  // invoice date to '' and it then ages as nothing. Hand-checked: MIN over {a real date, ''} in
  // SQLite is '' (the empty string sorts first), so NULLIF is required in the register.
  //
  // The dated line uses a RELATIVE date on purpose. An absolute one would make this assertion
  // depend on the calendar date the suite happens to run on (a document dated 2026-08-01 is
  // '61_90' in October 2026 and '120_plus' a few months later), which is a test that rots rather
  // than a test that measures. 45 days lands mid-bucket in '31_60' whatever today is.
  const inserted = fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'INV-8A5-MIXED', date('now', '-45 day'), 'Receivable', 'receivable', 0,
       -3000000, 0, 3000000, 'IDR', 'dated claim line', 'import', 0)`).run(PROJECT);
  assert.strictEqual(inserted.changes, 1);
  const datedLine = one("SELECT date FROM accounting_ledger WHERE document_no = 'INV-8A5-MIXED'").date;

  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'INV-8A5-MIXED', '', 'Receivable', 'receivable', 0, -4000000, 0, 4000000,
       'IDR', 'undated claim line', 'import', 0)`).run(PROJECT);

  const mixed = one("SELECT invoice_date, billed_amount, outstanding_amount FROM v_receivable WHERE document_no = 'INV-8A5-MIXED'");
  assert.strictEqual(mixed.invoice_date, datedLine, 'the real date must survive a blank line');
  assert.notStrictEqual(mixed.invoice_date, '', 'the blank line must not become the document date');
  assert.strictEqual(mixed.billed_amount, 7000000);   // 3,000,000 + 4,000,000
  assert.strictEqual(mixed.outstanding_amount, 7000000);
  // Having a real date, it IS aged — 45 days aged is '31_60', and it is aged as the DOCUMENT's
  // date, not the undated line's missing one.
  assert.strictEqual(one("SELECT aging_bucket FROM v_aging WHERE document_no = 'INV-8A5-MIXED'").aging_bucket, '31_60');
});

// ---- RG8.6 the five real bucket boundaries are unchanged ----

test('RG8.6 the 30/60/90/120 bucket boundaries still mean what they meant', async () => {
  // Offsets are mid-bucket on purpose, not exactly 30/60/90/120: `days_aged` is
  // `julianday('now') − julianday(invoice_date)`, and `date('now', '-60 day')` lands at midnight
  // while `julianday('now')` carries the time of day — so a document dated exactly 60 days ago
  // measures 60.x and belongs to 61_90, not 31_60. Mid-bucket offsets keep the assertion about
  // the boundary rather than about the clock. Hand-computed, one row each:
  //   −15 days  →  15.x ≤ 30   → '1_30'
  //   −45 days  →  45.x ≤ 60   → '31_60'
  //   −75 days  →  75.x ≤ 90   → '61_90'
  //   −105 days → 105.x ≤ 120  → '91_120'
  //   −200 days →  > 120       → '120_plus'
  //   +10 days  →  future      → 'current'
  const cases = [
    ['B-A-15', -15, '1_30'],
    ['B-B-45', -45, '31_60'],
    ['B-C-75', -75, '61_90'],
    ['B-D-105', -105, '91_120'],
    ['B-E-200', -200, '120_plus'],
    ['B-F-FUTURE', 10, 'current'],
  ];
  for (const [doc, offset, expected] of cases) {
    // amount 1,000,000 each so every row has a non-zero outstanding and is not filtered out.
    fx.db.prepare(`INSERT INTO accounting_ledger
        (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
         currency, description, source, cost_checked)
      VALUES (?, ?, date('now', ?), 'Receivable', 'receivable', 0, -1000000, 0, 1000000,
         'IDR', 'bucket probe', 'import', 0)`).run(PROJECT, doc, `${offset} day`);
  }

  for (const [doc, offset, expected] of cases) {
    const got = one('SELECT aging_bucket FROM v_aging WHERE document_no = ?', doc);
    assert.ok(got, `${doc} (${offset} days) should be aged`);
    assert.strictEqual(got.aging_bucket, expected, `${doc} at ${offset} days`);
  }

  // Ordering sanity: the six buckets are six distinct labels, so no two offsets collapsed.
  assert.strictEqual(new Set(cases.map(c => c[2])).size, 6);
});

// ---- RG8.7 the register's arithmetic is an identity, on hand-computed figures ----

test('RG8.7 billed, paid, retainage and outstanding satisfy the identity on a mixed document', async () => {
  // The validator pins four figures on `db/seed-smoke.sql`; this pins the identity itself on data
  // this test controls, so a future edit to the expressions fails here even if the smoke fixture
  // is not re-run. Hand-computed, on ONE document with three lines:
  //   claim      credit 200,000,000, retainage 25,000,000  → billed 200,000,000, retainage 25,000,000
  //   claim      credit  50,000,000, retainage  0          → billed  50,000,000
  //   funding    debit   80,000,000                        → paid    80,000,000
  //   billed      = 200,000,000 + 50,000,000                 = 250,000,000
  //   paid        = 80,000,000                               =  80,000,000
  //   retainage   = 25,000,000 + 0                           =  25,000,000
  //   outstanding = 250,000,000 − 80,000,000 − 25,000,000    = 145,000,000
  await post('side=credit&amount=200000000&type=Receivable'
    + '&date=2026-09-02&document_no=INV-8A7&description=Main claim&retainage=25000000');
  await post('side=credit&amount=50000000&type=Receivable'
    + '&date=2026-09-03&document_no=INV-8A7&description=Variation claim');
  insertFunding({ documentNo: 'INV-8A7', amount: 80000000, date: '2026-09-22' });

  const r = one("SELECT billed_amount, paid_amount, retainage_amount, outstanding_amount, line_count "
    + "FROM v_receivable WHERE document_no = 'INV-8A7'");
  assert.strictEqual(r.line_count, 3);
  assert.strictEqual(r.billed_amount, 250000000);
  assert.strictEqual(r.paid_amount, 80000000);
  assert.strictEqual(r.retainage_amount, 25000000);
  assert.strictEqual(r.outstanding_amount, 145000000);
  // And net_amount is outstanding plus the retainage still held.
  assert.strictEqual(
    one("SELECT net_amount FROM v_receivable WHERE document_no = 'INV-8A7'").net_amount,
    170000000, 'net_amount = outstanding + retainage held = 145,000,000 + 25,000,000');
});

// ---- RG8.8 the payable register keeps working (it was correct before — it must not regress) ----

test('RG8.8 the payable register still reports real payables, and drops a funding-only document', async () => {
  // v_payable already followed the PRD rule (it filters on `type`), which is exactly why it was
  // the control case in the diagnosis. The only change 020 makes is the same funding gate, so the
  // two registers answer one question one way.
  await post('side=debit&amount=90000000&type=Payable'
    + '&date=2026-09-04&document_no=PO-8A8&description=Cement delivery');

  const r = one("SELECT billed_amount, paid_amount, outstanding_amount, line_count FROM v_payable WHERE document_no = 'PO-8A8'");
  assert.strictEqual(r.billed_amount, 90000000);
  assert.strictEqual(r.paid_amount, 0);
  assert.strictEqual(r.outstanding_amount, 90000000);
  assert.strictEqual(r.line_count, 1);

  // A funding-only document must not be admitted here either (it is a cash movement).
  insertFunding({ documentNo: 'PAY-ONLY-8A8', amount: 5000000, date: '2026-09-23' });
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM v_payable WHERE document_no = 'PAY-ONLY-8A8'").n, 0,
    'a funding-only document is not a payable');

  // And a same-document payment DOES net the payable — the validator's rule, at register level.
  // Hand-computed: billed 90,000,000 − paid 30,000,000 = 60,000,000.
  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'PO-8A8', '2026-09-25', 'Payable', 'funding', 0, -30000000, 0, 30000000,
       'IDR', 'payment on the cement invoice', 'manual', 0)`).run(PROJECT);
  const after8 = one("SELECT billed_amount, paid_amount, outstanding_amount FROM v_payable WHERE document_no = 'PO-8A8'");
  assert.strictEqual(after8.billed_amount, 90000000);
  assert.strictEqual(after8.paid_amount, 30000000);
  assert.strictEqual(after8.outstanding_amount, 60000000);
});
