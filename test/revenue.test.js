// RV8-series: revenue recognition (module 8, plan part 8.8). THIS IS PART 8.8'S GATE.
//
// WHAT THIS FILE DEFENDS. Four methods, one of which has a trap that makes the whole feature
// meaningless if it is got wrong:
//
//   1. **POC MUST USE BAST, NOT THE INTERNAL TICK %.** PRD §5.3 is emphatic. The fixture in this
//      file is built so the two numbers are DELIBERATELY DIFFERENT (BAST 40%, internal 50%), and
//      RV8.3 asserts the POC figure follows 40%. If they were equal the assertion would pass
//      whichever column the code read, and the test would prove nothing — which is the failure
//      mode this file exists to avoid.
//   2. **A SUBMITTED CERTIFICATE IS NOT ACCEPTANCE.** RV8.4 adds an accepted and a submitted
//      certificate and pins that only the accepted one moves the basis.
//   3. **RECOGNITION POSTS NO LEDGER LINE.** RV8.7 asserts the ledger row count is UNCHANGED —
//      revenue recognition is not a cash movement, and invariant 10 keeps billed / recognised /
//      received as three separate figures.
//   4. **A SECOND RECOGNITION IN THE SAME MONTH IS AN UPSERT, NOT A CRASH.** The UNIQUE
//      (project_id, period_month) constraint means the naive implementation throws a raw SQLite
//      error at the user. RV8.6 pins the deliberate choice (upsert, audited) AND that the
//      constraint still holds.
//   5. **`revenue_method` NULL IS ITS OWN STATE.** MEASURED: the live project is in this state, so
//      it is the first thing a real user meets. RV8.2 asserts it is NOT silently defaulted, and
//      RV8.9 asserts the screen states it rather than showing "0 recognised".
//
// Every expected number is hand-computed in a comment next to its assertion.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3928;
const PROJECT = 1;
const ACCOUNT = '1.1.1';
const LINE = '3.1';

// A contract value chosen so every hand-computation below is exact at whole-rupiah precision.
const CONTRACT = 10_000_000;
const MONTHLY = 1_000_000;
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  '2026-07', '2026-08', '2026-09', '2026-10'];
const BAC = MONTHLY * MONTHS.length;   // 10,000,000 — equals the contract, so percentages are clean

let fx;
let revenue;
let cbs;
let progress;
let ids = {};

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-rv8-' });
  [revenue, cbs, progress] = fx.loadMany('src/lib/revenue-service.js',
    'src/lib/cbs-service.js', 'src/lib/progress-service.js');

  // The project under test: a clean contract value and a window that makes time_based exact.
  fx.db.prepare(`UPDATE projects SET contract_amount = ?, start_date = '2026-01-01',
      end_date = '2026-10-31' WHERE id = ?`).run(CONTRACT, PROJECT);

  const node = fx.db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? LIMIT 1')
    .get(PROJECT, LINE);
  const acct = fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
  ids.node = node.id;
  ids.acct = acct.id;

  // A budget of 1,000,000 a month across the same 10 months: BAC = 10,000,000.
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, ?, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, acct.id, MONTHLY, MONTHS.length, BAC);

  cbs.spreadBaseline({
    projectId: PROJECT, accountId: acct.id, wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: MONTHLY })),
  });

  // INTERNAL progress: 2 of 4 milestones ticked = 50%. This is the number POC must NOT use.
  const ms = progress.milestones(node.id);
  const actor = fx.users.get('project_controller');
  for (let i = 0; i < 2; i += 1) {
    progress.setMilestoneTick({ projectId: PROJECT, actorId: actor, milestoneId: ms[i].id,
      ticked: true, period: '2026-03' });
  }
  // Confirm the internal figure really is 50%, so "BAST 40 vs internal 50" is a measured fact
  // and not an assumption about the fixture.
  const internalRow = fx.db.prepare(`SELECT ev_cum FROM v_evm_period
      WHERE project_id = ? AND period_month = '2026-03'`).get(PROJECT);
  assert.strictEqual(Number(internalRow.ev_cum), 5_000_000,
    'fixture: 2 of 4 equal milestones = 50% of the 10,000,000 budget = 5,000,000 earned');
  assert.strictEqual(revenue.internalPct(PROJECT, '2026-03').pct, 50,
    'fixture: the INTERNAL percentage is 50%');

  // BAST: one ACCEPTED certificate at 40%. Deliberately DIFFERENT from the internal 50%.
  ids.accepted = Number(fx.db.prepare(`INSERT INTO acceptance_register (project_id, wbs_node_id,
      certificate_no, sequence, description, percentage_progress, document_date, accepted_date, status)
      VALUES (?, ?, 'BAST-001', 1, 'First handover', 40, '2026-03-10', '2026-03-20', 'accepted')`)
    .run(PROJECT, node.id).lastInsertRowid);

  // And a SUBMITTED one at a further 25% — it must NOT count.
  ids.submitted = Number(fx.db.prepare(`INSERT INTO acceptance_register (project_id, wbs_node_id,
      certificate_no, sequence, description, percentage_progress, document_date, status)
      VALUES (?, ?, 'BAST-002', 2, 'Second handover, not yet accepted', 25, '2026-04-05', 'submitted')`)
    .run(PROJECT, node.id).lastInsertRowid);

  const b = revenue.bastPct(PROJECT, '2026-06');
  assert.strictEqual(b.pct, 40, 'fixture: accepted BAST is 40%, the submitted 25% is excluded');
  assert.strictEqual(b.certificates, 1, 'fixture: exactly one accepted certificate');

  // Invoices: 3,000,000 billed in March, 2,000,000 of it received. The three invariant-10
  // figures must then be provably different: recognised 4,000,000, billed 3,000,000, received 2,000,000.
  // The ledger enforces `amount = debit - credit`, one side only, both non-negative
  // (trg_ledger_money_integrity_insert). So a claim debits and a payment CREDITS — the payment's
  // amount is therefore NEGATIVE, which is what `v_receivable` reads with ABS() to get paid_amount.
  // Getting this sign wrong is rejected by the trigger rather than stored, which is the point of it.
  const ledger = fx.db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`);
  ledger.run(PROJECT, '2026-03-15', 'Receivable', 'receivable', 0, 3_000_000, 3_000_000, 0,
    node.id, acct.id, 'RV8-INV-1', 'rv8 claim');
  ledger.run(PROJECT, '2026-03-25', 'Expense', 'funding', 0, -2_000_000, 0, 2_000_000,
    null, null, 'RV8-INV-1', 'rv8 payment against the same document');

  ids.other = Number(fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, status)
      VALUES ('RV8-OTHER', 'No method yet', 5000000, 'active')`).run().lastInsertRowid);
});

after(() => { if (fx) fx.stop(); });

const cc = () => fx.clients.get('cost_controller');

// ---------------------------------------------------------------------------
// RV8.1 — the four methods exist and nothing else does
// ---------------------------------------------------------------------------

test('RV8.1 exactly the four PRD methods are recognised, and an unknown one is refused', () => {
  assert.deepStrictEqual(revenue.METHODS, ['milestone', 'poc', 'time_based', 'on_billing'],
    'the four methods of PRD §5.3, in the order the schema CHECK lists them');

  // Each has a label for the screen, and the labels are distinct — a screen showing the same
  // words for POC and milestone would leave the reader unable to tell which is in force.
  const names = revenue.METHODS.map((m) => revenue.METHOD_LABELS[m].name);
  assert.strictEqual(new Set(names).size, 4, 'four distinct method names');

  assert.throws(() => revenue.setMethod({ projectId: PROJECT, method: 'cash_basis', actorId: 1 }),
    (e) => e instanceof revenue.RevenueError && e.status === 400,
    'a method outside the four is refused with a 400, not written');
});

// ---------------------------------------------------------------------------
// RV8.2 — no method configured is its OWN state, not a default
// ---------------------------------------------------------------------------

test('RV8.2 no revenue method is its own state \u2014 never silently defaulted', () => {
  // The project under test starts with NULL, which is the state the live project is in.
  const p = fx.db.prepare('SELECT revenue_method FROM projects WHERE id = ?').get(ids.other);
  assert.strictEqual(p.revenue_method, null, 'this project has no method set');

  const reg = revenue.register(ids.other);
  assert.strictEqual(reg.method, null, 'the register reports no method');
  assert.strictEqual(reg.methodLabel, null, 'and has no label to show');
  assert.strictEqual(reg.rows.length, 0, 'and nothing has been recognised');
  assert.strictEqual(reg.recognizedTo, 0, 'the recognised total is zero');

  // RECOGNISING is refused with a reason, rather than defaulting to one of the four.
  assert.throws(() => revenue.recognize({ projectId: ids.other, month: '2026-03', actorId: 1 }),
    (e) => e instanceof revenue.RevenueError && /no revenue method configured/i.test(e.message),
    'recognition without a method is refused, not defaulted');

  // And the refusal left the register untouched.
  assert.strictEqual(fx.db.prepare('SELECT COUNT(*) n FROM revenue_recognized WHERE project_id = ?')
    .get(ids.other).n, 0, 'the refusal wrote nothing');
});

// ---------------------------------------------------------------------------
// RV8.3 — THE CENTRAL ASSERTION: POC follows BAST, not the internal tick %
// ---------------------------------------------------------------------------

test('RV8.3 POC recognises the BAST percentage, NOT the internal tick percentage', () => {
  // The two numbers, established by the fixture and asserted above:
  //   internal tick %  = 50%  (2 of 4 milestones)   -> would recognise 5,000,000
  //   BAST accepted %  = 40%  (one accepted cert)   -> recognises      4,000,000
  // A test that read either column would pass if they were equal. They are not, so this asserts
  // WHICH NUMBER the POC method used, not merely that it produced something.
  const internal = revenue.internalPct(PROJECT, '2026-03');
  const bast = revenue.bastPct(PROJECT, '2026-03');
  assert.strictEqual(internal.pct, 50, 'the internal percentage is 50%');
  assert.strictEqual(bast.pct, 40, 'the BAST percentage is 40%');
  assert.notStrictEqual(internal.pct, bast.pct,
    'the fixture is only meaningful because these two differ');

  const t = revenue.target(PROJECT, 'poc', '2026-03');
  assert.strictEqual(t.pct, 40, 'POC took the BAST figure');
  assert.notStrictEqual(t.pct, internal.pct, 'and specifically NOT the internal figure');
  // 40% of 10,000,000 = 4,000,000
  assert.strictEqual(t.amount, 4_000_000, 'POC cumulative = 40% x 10,000,000 = 4,000,000');

  // The internal figure is carried alongside for the screen to COMPARE, and is used for nothing.
  assert.strictEqual(t.detail.internalForComparison, 50,
    'the internal figure is exposed for comparison only');

  // Writing it: the register records the basis actually used, so the row is self-explaining.
  // The method has to be SET first — recognising without one is refused (RV8.2), so this asserts
  // the configured path rather than relying on a method some earlier test happened to leave behind.
  revenue.setMethod({ projectId: PROJECT, method: 'poc', actorId: fx.users.get('cost_controller') });
  const out = revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(out.method, 'poc');
  assert.strictEqual(out.basisPct, 40, 'the stored basis is the BAST percentage');
  assert.strictEqual(out.amount, 4_000_000, 'and the amount follows it');
  assert.strictEqual(out.cumulative, 4_000_000);

  const row = fx.db.prepare(`SELECT * FROM revenue_recognized WHERE project_id = ? AND period_month = '2026-03'`)
    .get(PROJECT);
  assert.strictEqual(row.method, 'poc');
  assert.strictEqual(row.basis_pct, 40, 'the ROW records 40, not 50 \u2014 checkable after the fact');
  assert.strictEqual(row.acceptance_id, ids.accepted,
    'and points at the certificate that carried the basis, not just the number');

  // Clean up so the remaining method assertions start from a known register.
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
});

// ---------------------------------------------------------------------------
// RV8.4 — a submitted certificate is not acceptance
// ---------------------------------------------------------------------------

test('RV8.4 a submitted certificate does not count \u2014 only an accepted one does', () => {
  // The fixture holds one accepted (40%) and one submitted (25%). Only the accepted counts, so
  // the basis is 40 — NOT 65. This is the difference between "the client approved it" and
  // "we sent it", and PRD §5.3 recognises revenue on the former.
  const b = revenue.bastPct(PROJECT, '2026-06');
  assert.strictEqual(b.pct, 40, 'only the accepted certificate counts');
  assert.notStrictEqual(b.pct, 65, 'the submitted 25% is NOT added');

  // Now ACCEPT the second one and watch the basis move to 65%.
  fx.db.prepare(`UPDATE acceptance_register SET status = 'accepted', accepted_date = '2026-05-15'
      WHERE id = ?`).run(ids.submitted);
  const after = revenue.bastPct(PROJECT, '2026-06');
  assert.strictEqual(after.pct, 65, 'accepting it moves the basis to 40 + 25 = 65%');
  assert.strictEqual(after.certificates, 2, 'and both are now counted');

  // The milestone method reads the SAME register, which is why they share `bastPct` — but the
  // milestone method reports nothing approved yet when the register has no accepted rows.
  assert.strictEqual(revenue.target(PROJECT, 'milestone', '2026-06').pct, 65,
    'milestone recognises the accepted total too');

  // Revert, so the rest of the file sees 40%.
  fx.db.prepare(`UPDATE acceptance_register SET status = 'submitted', accepted_date = NULL
      WHERE id = ?`).run(ids.submitted);
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-06').pct, 40, 'and reverting restores 40%');
});

// ---------------------------------------------------------------------------
// RV8.5 — the other two methods, hand-computed
// ---------------------------------------------------------------------------

test('RV8.5 time_based and on_billing are hand-computed and independent of BAST', () => {
  // TIME BASED. Window 2026-01 .. 2026-10 inclusive = 10 months.
  //   at 2026-01: 1/10 = 10%  -> 1,000,000
  //   at 2026-03: 3/10 = 30%  -> 3,000,000
  //   at 2026-10: 10/10 = 100% -> 10,000,000
  const j = revenue.target(PROJECT, 'time_based', '2026-01');
  assert.strictEqual(j.pct, 10, '1 of 10 months elapsed = 10%');
  assert.strictEqual(j.amount, 1_000_000, '10% of 10,000,000');
  assert.strictEqual(j.detail.totalMonths, 10, 'the window is 10 months inclusive');

  const m = revenue.target(PROJECT, 'time_based', '2026-03');
  assert.strictEqual(m.pct, 30, '3 of 10 months = 30%');
  assert.strictEqual(m.amount, 3_000_000);

  const last = revenue.target(PROJECT, 'time_based', '2026-10');
  assert.strictEqual(last.pct, 100, 'the final month is the whole contract');
  assert.strictEqual(last.amount, CONTRACT);

  // Nothing is recognised before the window opens, and the reason says so.
  const before = revenue.target(PROJECT, 'time_based', '2025-12');
  assert.strictEqual(before.pct, 0, 'before the window opens, 0%');
  assert.strictEqual(before.amount, 0);
  assert.match(before.reason, /has not started/i, 'and the reason is stated');

  // ON BILLING. 3,000,000 invoiced and 2,000,000 received; only the BILLED figure counts.
  const ob = revenue.target(PROJECT, 'on_billing', '2026-03');
  assert.strictEqual(ob.amount, 3_000_000, 'on_billing = what was invoiced, 3,000,000');
  assert.notStrictEqual(ob.amount, 2_000_000, 'NOT the received figure \u2014 billed and received differ');
  assert.strictEqual(ob.pct, 30, '3,000,000 of a 10,000,000 contract = 30%');

  // And the two methods genuinely disagree, which is the point of having four.
  assert.notStrictEqual(ob.amount, revenue.target(PROJECT, 'poc', '2026-03').amount,
    'on_billing and POC are different answers for the same month');
});

// ---------------------------------------------------------------------------
// RV8.6 — same-month recognition is an upsert, and the constraint holds
// ---------------------------------------------------------------------------

test('RV8.6 a second recognition in the same month updates rather than crashing', () => {
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
  revenue.setMethod({ projectId: PROJECT, method: 'poc', actorId: fx.users.get('cost_controller') });

  const first = revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(first.updated, false, 'the first write inserts');
  assert.strictEqual(first.amount, 4_000_000);

  // THE CONSTRAINT IS REAL: a raw second INSERT would throw. Asserted so the upsert is understood
  // to be a deliberate choice rather than an accident of the code path.
  assert.throws(() => fx.db.prepare(`INSERT INTO revenue_recognized (project_id, period_month,
      method, basis_pct, amount, cumulative) VALUES (?, '2026-03', 'poc', 40, 1, 1)`)
    .run(PROJECT), /UNIQUE|constraint/i, 'the table really does refuse a duplicate month');

  // Now change the basis (the client accepts more) and re-recognise the SAME month.
  fx.db.prepare(`UPDATE acceptance_register SET percentage_progress = 60 WHERE id = ?`).run(ids.accepted);
  const second = revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(second.updated, true, 'the second write UPDATES the existing row');
  // 60% of 10,000,000 = 6,000,000
  assert.strictEqual(second.basisPct, 60, 'the basis moved to 60%');
  assert.strictEqual(second.amount, 6_000_000, 'and the figure followed it');

  const rows = fx.db.prepare('SELECT * FROM revenue_recognized WHERE project_id = ?').all(PROJECT);
  assert.strictEqual(rows.length, 1, 'still ONE row for the month \u2014 an update, not an addition');
  assert.strictEqual(rows[0].amount, 6_000_000);

  // THE UPSERT IS AUDITED, with the before and the after, so the change is not silent.
  const audit = fx.db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'revenue_recognized'
      AND action = 'update' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(audit, 'the re-recognition is recorded in the audit log');
  assert.strictEqual(JSON.parse(audit.before_json).amount, 4_000_000, 'the before figure is kept');
  assert.strictEqual(JSON.parse(audit.after_json).amount, 6_000_000, 'and the after figure');

  // A FROZEN month cannot be rewritten. No trigger covers revenue_recognized (migration 011
  // covers the ledger and LPB), so this check is the only thing enforcing it.
  fx.db.prepare(`INSERT INTO frozen_periods (project_id, period_month, frozen_by)
      VALUES (?, '2026-03', ?)`).run(PROJECT, fx.users.get('cost_controller'));
  assert.throws(() => revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') }),
    (e) => e instanceof revenue.RevenueError && /closed/i.test(e.message),
    'a closed month cannot be re-recognised');
  fx.db.prepare('DELETE FROM frozen_periods WHERE project_id = ?').run(PROJECT);

  // Restore the certificate and clear the register for the following tests.
  fx.db.prepare(`UPDATE acceptance_register SET percentage_progress = 40 WHERE id = ?`).run(ids.accepted);
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
});

// ---------------------------------------------------------------------------
// RV8.7 — recognition posts NO ledger line, and the three figures stay three
// ---------------------------------------------------------------------------

test('RV8.7 recognition posts no ledger line \u2014 billed, recognised and received stay separate', () => {
  const ledgerBefore = fx.db.prepare('SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?')
    .get(PROJECT).n;

  revenue.setMethod({ projectId: PROJECT, method: 'poc', actorId: fx.users.get('cost_controller') });
  const out = revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(out.amount, 4_000_000, 'recognised 40% of the contract = 4,000,000');

  const ledgerAfter = fx.db.prepare('SELECT COUNT(*) n FROM accounting_ledger WHERE project_id = ?')
    .get(PROJECT).n;
  assert.strictEqual(ledgerAfter, ledgerBefore,
    'recognising revenue wrote NO ledger line \u2014 it is not a cash movement');

  // INVARIANT 10, as three DIFFERENT numbers for the same period:
  //   recognised 4,000,000  (40% of the contract, from BAST)
  //   billed     3,000,000  (the invoice)
  //   received   2,000,000  (cash in)
  const reg = revenue.register(PROJECT);
  assert.strictEqual(reg.recognizedTo, 4_000_000, 'recognised');
  assert.strictEqual(reg.billedTo, 3_000_000, 'billed');
  assert.strictEqual(reg.receivedTo, 2_000_000, 'received');
  assert.strictEqual(new Set([reg.recognizedTo, reg.billedTo, reg.receivedTo]).size, 3,
    'three DIFFERENT figures \u2014 if any two matched, this assertion would prove nothing');
});

// ---------------------------------------------------------------------------
// RV8.8 — cumulative is carried forward, and the period amount is the delta
// ---------------------------------------------------------------------------

test('RV8.8 cumulative carries forward and each month posts only its own increment', () => {
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
  revenue.setMethod({ projectId: PROJECT, method: 'time_based', actorId: fx.users.get('cost_controller') });

  // Straight line, 10 months, 10,000,000: 1,000,000 a month.
  //   Jan -> cumulative 10% = 1,000,000, period 1,000,000 - 0       = 1,000,000
  //   Feb -> cumulative 20% = 2,000,000, period 2,000,000 - 1,000,000 = 1,000,000
  //   Mar -> cumulative 30% = 3,000,000, period 3,000,000 - 2,000,000 = 1,000,000
  const jan = revenue.recognize({ projectId: PROJECT, month: '2026-01', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(jan.cumulative, 1_000_000, 'January cumulative');
  assert.strictEqual(jan.amount, 1_000_000, 'January period amount');

  const feb = revenue.recognize({ projectId: PROJECT, month: '2026-02', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(feb.cumulative, 2_000_000, 'February cumulative is 20%');
  assert.strictEqual(feb.amount, 1_000_000, 'and the period amount is the INCREMENT, not the cumulative');

  const mar = revenue.recognize({ projectId: PROJECT, month: '2026-03', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(mar.cumulative, 3_000_000);
  assert.strictEqual(mar.amount, 1_000_000);

  // A SKIPPED month does not break the series: recognising April after February (no March) still
  // uses the April cumulative against the sum of the earlier rows.
  fx.db.prepare("DELETE FROM revenue_recognized WHERE project_id = ? AND period_month = '2026-03'").run(PROJECT);
  const apr = revenue.recognize({ projectId: PROJECT, month: '2026-04', actorId: fx.users.get('cost_controller') });
  assert.strictEqual(apr.cumulative, 4_000_000, 'April cumulative = 40%');
  assert.strictEqual(apr.amount, 2_000_000,
    'and the period amount is 4,000,000 - (1,000,000 + 1,000,000) = 2,000,000 \u2014 covering both months');

  // The sum of the period amounts equals the last cumulative. This is what makes the series a
  // series rather than a set of unrelated numbers.
  const rows = fx.db.prepare('SELECT * FROM revenue_recognized WHERE project_id = ? ORDER BY period_month').all(PROJECT);
  const sumPeriods = rows.reduce((s, r) => s + r.amount, 0);
  const last = rows[rows.length - 1];
  assert.strictEqual(sumPeriods, last.cumulative,
    'the period amounts add up to the cumulative \u2014 to the rupiah');

  // The running total used for the NEXT month is the LATEST row's cumulative, which is the bug
  // this test found: the first draft SUMMED the column, so a straight-line project posted
  // 1,000,000 / 1,000,000 / 0 and then went negative.
  assert.strictEqual(revenue.priorCumulative(PROJECT, '2026-05'), 4_000_000,
    'the prior running total is the last cumulative (April 40%), not the sum of the column');

  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
});

// ---------------------------------------------------------------------------
// RV8.9 — the screen over HTTP: states, the write boundary, and the rendered figures
// ---------------------------------------------------------------------------

test('RV8.9 the screen renders each state, and only a writer may change anything', async () => {
  const client = cc();

  // A browser-like POST: the client's `post()` attaches the CSRF cookie automatically, but a POST
  // needs a FRESH token minted by a rendered page — the token is bound to the session and a plain
  // service-call sequence never minted one. So every write is preceded by a GET, the way a person
  // filling in the form would have arrived at the page.
  const postAfter = async (c, getUrl, postUrl, body) => {
    await c.get(getUrl);
    return c.post(postUrl, body);
  };

  // (a) NOT CONFIGURED — the state the LIVE project is in. The method is cleared here explicitly
  // rather than assumed: earlier tests in this file legitimately leave a method set, and a test
  // that depends on what a previous test happened to leave behind is a test that passes or fails
  // by accident.
  fx.db.prepare('UPDATE projects SET revenue_method = NULL WHERE id = ?').run(PROJECT);
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);

  const unset = await client.get('/reports/revenue?month=2026-03');
  assert.strictEqual(unset.status, 200, 'the screen renders');
  const unsetHtml = await unset.text();
  assert.match(unsetHtml, /No revenue method is set|Not configured/i,
    'the unconfigured state is stated, rather than the page showing only zeroes');
  assert.match(unsetHtml, /Set method/, 'and the four methods are offered');
  // The tile legitimately reads "0% of contract" — nothing IS recognised, and the sentence above
  // it says why. What must NOT happen is an unexplained zero, so assert the explanation is there.
  assert.match(unsetHtml, /not defaulted to a method on purpose/i,
    'and the reason it was not guessed is stated');

  // (b) CONFIGURED, with the figures. Set POC and recognise March.
  const setRes = await postAfter(client, '/reports/revenue', '/reports/revenue/method', 'method=poc');
  assert.strictEqual(setRes.status, 302, 'setting the method redirects (PRG)');
  const rec = await postAfter(client, '/reports/revenue', '/reports/revenue/recognize', 'period_month=2026-03');
  assert.strictEqual(rec.status, 302, 'recognising redirects');

  const page = await client.get('/reports/revenue?month=2026-03');
  const html = await page.text();
  // 40% of 10,000,000 = 4,000,000, rendered through the locale formatter.
  assert.match(html, /4\.000\.000/, 'the recognised figure is on the page');
  assert.match(html, /Percentage of completion/i, 'and the method in force is named');
  // The POC explanation must show BOTH numbers, which is the whole reason the screen carries them.
  assert.match(html, /accepted <b[^>]*>40%|accepted 40%/i, 'the BAST percentage is shown');
  assert.match(html, /50%/, 'and the internal percentage is shown beside it for comparison');
  assert.match(html, /not our own optimism|never the basis/i,
    'with the rule stated: POC follows acceptance');

  // (c) INVARIANT 10 on the page: the three figures appear as three separate columns.
  assert.match(html, /Recognised/i);
  assert.match(html, /Invoiced/i);
  assert.match(html, /Received/i);

  // (d) THE WRITE BOUNDARY. A Viewer may READ the page and must get a 403 on both writes, with
  // the database unchanged \u2014 the Module 8 rule that a deny-case asserts the DB, not just a status.
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), fx.dbPath, fx.ORIGIN, 'viewer',
    { email: 'rv89-viewer@example.test' });

  const readAsViewer = await viewer.client.get('/reports/revenue?month=2026-03');
  assert.strictEqual(readAsViewer.status, 200, 'a Viewer MAY read the revenue report');

  const before = fx.db.prepare('SELECT COUNT(*) n FROM revenue_recognized WHERE project_id = ?')
    .get(PROJECT).n;
  const methodBefore = fx.db.prepare('SELECT revenue_method m FROM projects WHERE id = ?').get(PROJECT).m;

  const wrote = await postAfter(viewer.client, '/reports/revenue', '/reports/revenue/recognize', 'period_month=2026-04');
  assert.strictEqual(wrote.status, 403, 'a Viewer may not recognise');
  const setWrote = await postAfter(viewer.client, '/reports/revenue', '/reports/revenue/method', 'method=on_billing');
  assert.strictEqual(setWrote.status, 403, 'nor change the method');

  assert.strictEqual(fx.db.prepare('SELECT COUNT(*) n FROM revenue_recognized WHERE project_id = ?')
    .get(PROJECT).n, before, 'the refused write added NO row');
  assert.strictEqual(fx.db.prepare('SELECT revenue_method m FROM projects WHERE id = ?').get(PROJECT).m,
    methodBefore, 'and the method is unchanged in the database');

  // And the viewer's page does NOT offer the forms it cannot submit.
  const viewerHtml = await readAsViewer.text();
  assert.ok(!/name="method"/.test(viewerHtml),
    'the method form is not offered to a role that cannot submit it');
  assert.match(viewerHtml, /Only the Cost Controller or the Project Manager/i,
    'and the reason is stated instead');
});
