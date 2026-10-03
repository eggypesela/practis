// AG8-series: due dates — `payment_terms_days` becomes real (module 8, plan part 8.2).
// THIS IS PART 8.2'S GATE. Migration 021 is the change under test.
//
// WHY THIS FILE EXISTS
//
// PRD §5.2 and R2-6 both promise "due date = ledger date + payment terms (from project register)".
// Before migration 021 nothing in the product computed a due date: `v_aging` bucketed on fixed
// 30/60/90/120 offsets from the INVOICE date, and the two stored `payment_terms_days` columns (on
// `projects` and on `clients`) were read by nothing — `src/lib/clients-service.js` states this in its
// own header. Medicine without a due date cannot answer the one question a collection call needs:
// "how long past its terms is this?"
//
// WHAT DECISION D3 (owner, 2026-10-03) FIXED
//
// The terms cascade project -> client -> system default (`app_settings.default_payment_terms_days`,
// 30 days), and the view EXPOSES which link applied (`terms_source`), because "30 days" that is
// really "nobody set this" is a different fact from "30 days, our terms".
//
// THE ASSERTION THAT MATTERS MOST HERE — and the reason this file is worth reading
//
// AG8.6 pins that migration 021 did NOT move the existing ageing contract. The plan for this part
// originally said aging should "age from `due_date`", which would have re-pointed the 30/60/90/120
// buckets at days-past-due and silently moved every aged figure in the product. `db/validate.py` and
// `test/reporting.test.js` RG8.6 (committed as 2fe33f8) pin those boundaries against the INVOICE
// date, so the change would have failed the suite rather than shipped. The buckets therefore stay on
// the invoice date and `due_date` / `overdue_days` are ADDED beside them. Both facts are real and
// they answer different questions: `days_aged` prioritises the collections list, `overdue_days`
// justifies the call. AG8.6 asserts they are genuinely independent, not derived from each other.
//
// Every expected date and figure below is computed BY HAND in a comment. Dates that must not rot are
// built from relative offsets (`date('now', '-N day')`) so the file measures the boundary rather than
// the calendar date the suite happens to run on.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3922;   // 3921 is held by reporting.test.js; fresh port for module 8 part 8.2
const PROJECT = 1;   // PRJ-2026 — seeded by seed-master.js

let fx;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-ag8-2-' });
});

after(() => { if (fx) fx.stop(); });

const one = (sql, ...p) => fx.db.prepare(sql).get(...p);
const all = (sql, ...p) => fx.db.prepare(sql).all(...p);

// Post a claim through the REAL Finance entry path, so the rows under test are ones the app itself
// can write (no cost category, no partner — both measured behaviour of `ledger-builder.js`).
async function claim({ documentNo, amount, date }) {
  const res = await fx.clients.get('finance').post('/ledger/entry',
    `side=credit&amount=${amount}&type=Receivable&date=${date}&document_no=${documentNo}&description=claim`);
  assert.strictEqual(res.status, 302, `expected the claim to be accepted, got ${res.status}`);
  return fx.db.prepare('SELECT * FROM accounting_ledger ORDER BY id DESC LIMIT 1').get();
}

const dueRow = (doc) => one('SELECT * FROM v_receivable_due WHERE document_no = ?', doc);

// ---- AG8.1 the system default exists, and it is a real setting ----

test('AG8.1 the default payment terms come from app_settings, not from a number baked into the view', async () => {
  // Why this is asserted first: `app_settings` was measured EMPTY of business settings on a seeded
  // database (only the argon2 tuning keys and csrf_secret). A view reading a missing setting would
  // return NULL terms on every real installation, and no screen could show or change the value.
  // Migration 021 seeds the row with INSERT OR IGNORE before the view that reads it.
  const s = one("SELECT value FROM app_settings WHERE key = 'default_payment_terms_days'");
  assert.ok(s, 'the default terms must exist as a row after migration 021');
  assert.strictEqual(s.value, '30');

  // It is read, not hard-coded: change the setting and an invoice with no project or client terms
  // must follow the new value. 45 days is the hand-computed expectation below.
  fx.db.prepare("UPDATE app_settings SET value = '45' WHERE key = 'default_payment_terms_days'").run();
  const r = dueRow('AG8-1');
  assert.strictEqual(r, undefined, 'nothing posted yet — sanity');

  await claim({ documentNo: 'AG8-1', amount: 1000000, date: '2026-03-01' });
  const after45 = dueRow('AG8-1');
  assert.strictEqual(after45.terms_days, 45, 'the view must follow app_settings, not a literal 30');
  assert.strictEqual(after45.terms_source, 'default');
  // Hand-computed: 2026-03-01 + 45 days = 2026-04-15 (March has 31 days: 30 days takes it to
  // 2026-03-31, +15 = 2026-04-15).
  assert.strictEqual(after45.due_date, '2026-04-15');

  // Put it back, so every later test sees the shipped default.
  fx.db.prepare("UPDATE app_settings SET value = '30' WHERE key = 'default_payment_terms_days'").run();
  assert.strictEqual(dueRow('AG8-1').terms_days, 30, 'restoring the setting must restore the terms');
  assert.strictEqual(dueRow('AG8-1').due_date, '2026-03-31');
});

// ---- AG8.2 an unknown default is reported as unknown, never invented ----

test('AG8.2 with no terms anywhere the due date is NULL — never an invented 30 days', async () => {
  // The rule migration 018 established for SPI/CPI applies here: a missing value must read as
  // "not measured", not as a confident figure. Deleting the setting is the only way to reach this
  // state, and it must not silently become "30 days".
  fx.db.prepare("DELETE FROM app_settings WHERE key = 'default_payment_terms_days'").run();
  await claim({ documentNo: 'AG8-2', amount: 2000000, date: '2026-03-10' });

  const r = dueRow('AG8-2');
  assert.strictEqual(r.terms_days, null, 'no terms anywhere means NULL terms, not 30');
  assert.strictEqual(r.due_date, null, 'and therefore no due date can be computed');
  // `terms_source` says 'default' — that is the link the cascade FELL THROUGH to, and the absence of
  // a value is visible in `terms_days` being NULL. The pair is what makes the screen honest.
  assert.strictEqual(r.terms_source, 'default');

  fx.db.prepare("INSERT INTO app_settings (key, value) VALUES ('default_payment_terms_days', '30')").run();
  assert.strictEqual(dueRow('AG8-2').due_date, '2026-04-09', '2026-03-10 + 30 days = 2026-04-09');
});

// ---- AG8.3 the client's terms are used when the project sets none ----

test('AG8.3 a project with no terms inherits the CLIENT terms, and says so', async () => {
  // The client register is where §5.2's "from project register" defaults from (R2-6: the project
  // column "overrides client default"). 60 days here.
  fx.db.prepare("INSERT INTO clients (id, code, name, payment_terms_days) VALUES (900, 'AG8-CLI', 'Client with terms', 60)").run();
  fx.db.prepare('UPDATE projects SET client_id = 900 WHERE id = ?').run(PROJECT);

  await claim({ documentNo: 'AG8-3', amount: 3000000, date: '2026-02-01' });
  const r = dueRow('AG8-3');
  assert.strictEqual(r.terms_days, 60);
  assert.strictEqual(r.terms_source, 'client', 'the client supplied the terms, and the view must say so');
  // Hand-computed: 2026-02-01 + 60 days. February 2026 has 28 days: +27 → 2026-02-28, +1 → 03-01,
  // +32 more → 2026-04-02. (60 = 27 + 1 + 32; 2026-03-01 + 32 days = 2026-04-02.)
  assert.strictEqual(r.due_date, '2026-04-02');
});

// ---- AG8.4 the project's terms BEAT the client's ----

test('AG8.4 the PROJECT terms win over the client terms (R2-6: overrides client default)', async () => {
  // Same client as AG8.3 (60 days) — the only change is the project's own value, so this isolates
  // the precedence rule rather than repeating AG8.3.
  fx.db.prepare('UPDATE projects SET payment_terms_days = 15 WHERE id = ?').run(PROJECT);

  await claim({ documentNo: 'AG8-4', amount: 4000000, date: '2026-03-01' });
  const r = dueRow('AG8-4');
  assert.strictEqual(r.terms_days, 15, 'the project column must take precedence');
  assert.strictEqual(r.terms_source, 'project');
  assert.strictEqual(r.due_date, '2026-03-16', '2026-03-01 + 15 days = 2026-03-16');

  // And the escalation is visible on a row that predates the change: AG8-3 was 'client' at 60 days,
  // and must now read 'project' at 15 — the cascade is evaluated per read, not frozen at entry.
  const older = dueRow('AG8-3');
  assert.strictEqual(older.terms_days, 15);
  assert.strictEqual(older.terms_source, 'project');
});

// ---- AG8.5 an invoice inside its terms is not "negative days overdue" ----

test('AG8.5 an invoice inside its terms has overdue_days 0, not a negative number', async () => {
  // CLAUDE'S RULE: a negative here would sort AHEAD of genuinely overdue invoices and invent a
  // priority that Finance would act on. `overdue_days` is clamped at 0.
  fx.db.prepare('UPDATE projects SET payment_terms_days = 90 WHERE id = ?').run(PROJECT);
  // Dated 10 days ago with 90-day terms: due in 80 days, so 0 overdue.
  const tenDaysAgo = one("SELECT date('now', '-10 day') AS d").d;
  await claim({ documentNo: 'AG8-5', amount: 5000000, date: tenDaysAgo });

  const r = one('SELECT * FROM v_aging WHERE document_no = ?', 'AG8-5');
  assert.ok(r, 'a current, outstanding claim belongs on the collections list');
  assert.strictEqual(r.overdue_days, 0, 'not-yet-due is 0 overdue, never negative');
  // `days_aged` is `julianday('now') - julianday(invoice_date)` and `date('now','-10 day')` lands at
  // MIDNIGHT while `now` carries the time of day, so the figure is 10.x, not exactly 10. Asserted as
  // a range so the test measures the offset rather than the clock.
  assert.ok(r.days_aged >= 10 && r.days_aged < 11, `expected 10-11 days aged, got ${r.days_aged}`);
  // Hand-computed bucket: 10 days from the invoice date is 1_30, which is exactly the point — it is
  // an old invoice that is not yet overdue. Buckets stay on the invoice date (see AG8.6).
  assert.strictEqual(r.aging_bucket, '1_30');
});

// ---- AG8.6 the ageing contract did NOT move (the trap the plan nearly walked into) ----

test('AG8.6 the 30/60/90/120 buckets still measure from the INVOICE date — due_date did not move them', async () => {
  // THE CORRECTION THIS TEST EXISTS FOR. The plan for part 8.2 said "aging then ages from due_date".
  // Had that shipped, the 30/60/90/120 labels would have started meaning "days past due" and every
  // aged figure in the product would have moved silently. TECH-SPEC §13 and PRD §5.2 define the
  // buckets as offsets from the invoice date, and `test/reporting.test.js` RG8.6 + `db/validate.py`
  // pin them there.
  //
  // This test proves the two are genuinely independent by CONSTRUCTING a row where they disagree:
  // an invoice 75 days old whose terms make it only 15 days overdue. A view that aged from due_date
  // would call that '1_30'; the contract says '61_90' (75 days from the invoice date), and the
  // overdue figure lands independently at 15.
  fx.db.prepare('UPDATE projects SET payment_terms_days = 60 WHERE id = ?').run(PROJECT);
  const seventyFiveDaysAgo = one("SELECT date('now', '-75 day') AS d").d;
  await claim({ documentNo: 'AG8-6', amount: 6000000, date: seventyFiveDaysAgo });

  const r = one('SELECT * FROM v_aging WHERE document_no = ?', 'AG8-6');
  assert.strictEqual(r.aging_bucket, '61_90',
    '75 days from the invoice date is 61_90 — the bucket must NOT have moved to days-past-due');
  assert.ok(r.days_aged >= 75 && r.days_aged < 76, `expected 75-76 days aged, got ${r.days_aged}`);
  assert.strictEqual(r.terms_days, 60);
  assert.strictEqual(r.overdue_days, 15, '75 days old, 60-day terms → 15 days overdue');
  // The two figures differ, and that is the whole point: one prioritises, one justifies.
  assert.notStrictEqual(Math.floor(r.days_aged), r.overdue_days);

  // And the five boundaries themselves are untouched — a direct re-assertion of RG8.6's contract,
  // on due dates that now also exist, so a future edit to either view fails here.
  const cases = [
    ['AG8-6-A', -15, '1_30'],
    ['AG8-6-B', -45, '31_60'],
    ['AG8-6-C', -75, '61_90'],
    ['AG8-6-D', -105, '91_120'],
    ['AG8-6-E', -200, '120_plus'],
  ];
  for (const [doc, offset] of cases) {
    fx.db.prepare(`INSERT INTO accounting_ledger
        (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
         currency, description, source, cost_checked)
      VALUES (?, ?, date('now', ?), 'Receivable', 'receivable', 0, -1000000, 0, 1000000,
         'IDR', 'boundary probe', 'import', 0)`).run(PROJECT, doc, `${offset} day`);
  }
  for (const [doc, , expected] of cases) {
    const got = one('SELECT aging_bucket FROM v_aging WHERE document_no = ?', doc);
    assert.strictEqual(got.aging_bucket, expected, `${doc} at its offset`);
    // Every one of these now also carries a due date and an overdue figure — and the overdue figure
    // is exactly `days_aged - terms`, or 0 when that is negative. Asserted, not assumed.
    const aged = one('SELECT days_aged, due_date, overdue_days FROM v_aging WHERE document_no = ?', doc);
    assert.ok(aged.due_date, `${doc} must have a due date: terms are set and the invoice is dated`);
    const expectedOverdue = Math.max(0, Math.floor(aged.days_aged) - 60);
    assert.strictEqual(aged.overdue_days, expectedOverdue,
      `${doc}: overdue_days must be max(0, days_aged - terms)`);
  }
});

// ---- AG8.7 the register shape is preserved, and the undatable rows stay reachable ----

test('AG8.7 v_aging still excludes undatable and settled rows, and the register still surfaces them', async () => {
  // Part 8.3 renders the "no date" to-do list by querying the REGISTER, not the ageing view — so the
  // register has to keep showing an undatable claim while the ageing view keeps excluding it. If
  // either half regressed, the screen would lose its to-do list or ship the F2 false alarm again.
  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'AG8-7-NODATE', '', 'Receivable', 'receivable', 0, -7000000, 0, 7000000,
       'IDR', 'no date', 'import', 0)`).run(PROJECT);

  const reg = dueRow('AG8-7-NODATE');
  assert.strictEqual(reg.invoice_date, null, 'a blank date reads as NULL in the register');
  assert.strictEqual(reg.outstanding_amount, 7000000);
  assert.strictEqual(reg.due_date, null, 'no date means no due date — cannot be invented');
  assert.strictEqual(reg.terms_days, 60, 'the terms are still known; only the date is missing');

  assert.strictEqual(one('SELECT COUNT(*) AS n FROM v_aging WHERE document_no = ?', 'AG8-7-NODATE').n, 0,
    'an undatable row must not be aged');
  // The to-do list 8.3 will render is expressible on the register, and finds exactly this row.
  const todo = all("SELECT document_no FROM v_receivable_due WHERE invoice_date IS NULL OR invoice_date = ''");
  assert.ok(todo.some(r => r.document_no === 'AG8-7-NODATE'),
    'the no-date to-do list must be queryable from the register');

  // A settled claim leaves the ageing list but keeps its due date on the register for the record.
  await claim({ documentNo: 'AG8-7-PAID', amount: 8000000, date: '2026-03-01' });
  fx.db.prepare(`INSERT INTO accounting_ledger
      (project_id, document_no, date, type, line_role, in_cost_basis, amount, debit, credit,
       currency, description, source, cost_checked)
    VALUES (?, 'AG8-7-PAID', '2026-03-20', 'Receivable', 'funding', 0, 8000000, 8000000, 0,
       'IDR', 'payment', 'manual', 0)`).run(PROJECT);
  const paid = dueRow('AG8-7-PAID');
  assert.strictEqual(paid.outstanding_amount, 0);
  assert.ok(paid.due_date, 'a settled claim keeps its due date — it is a fact about the invoice');
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM v_aging WHERE document_no = ?', 'AG8-7-PAID').n, 0,
    'a settled claim is not a collection priority');
});
