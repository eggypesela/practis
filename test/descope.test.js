// DS7-series: de-scope — take a work line out of scope without deleting it (module 7, plan
// part 7.7; PRD §4.4, EIA-748 G-30).
//
// WHAT THIS FILE EXISTS FOR
//
// A de-scope is the one operation that REMOVES money from the plan, so every failure mode here
// is about history: the temptation is to delete the line, zero its plan and let the past look
// tidy. The PRD forbids all three. What these tests pin:
//
//   * DS7.1 / DS7.6  NOTHING IS DELETED. The line stays in the tree with a status and a
//     period; no `wbs_progress` row goes; no `accounting_ledger` row is touched. Cost already
//     booked to cancelled work is the money most likely to "disappear" in such a feature.
//
//   * DS7.4  PAST MONTHS ARE BYTE-IDENTICAL, asserted on `v_evm_period` — the curve a user
//     reads — not on `cbs_plan`. This is the PRD's G-30 rule and the strongest claim in the
//     part: the forward months lose the budget and the reported ones do not move at all.
//
//   * DS7.5  SPENT COST STAYS TAGGED, so "what did we spend on the cancelled part" is still
//     answerable afterwards. That is the whole point of not deleting.
//
//   * DS7.8  THE OTHER LINE'S FORWARD BUDGET SURVIVES. `applyBaselineChange` removes every
//     forward row for the PROJECT and re-inserts the set it is handed, so a de-scope that
//     computed its rows wrongly (or handed over an empty set) would silently wipe a
//     neighbouring account's future budget. That is the sharpest hazard in this part and it
//     gets its own test.
//
// THE FIXTURE, since the assertions are all about money moving between months:
//
//   line 3.1 → account 3.1.1, plan 1,000,000 (500,000 x 2), budgeted 300,000 Mar + 700,000 Apr
//   line 3.2 → account 3.2.1, plan   600,000 (200,000 x 3), budgeted 200,000 Mar + 400,000 Apr
//
//   so  March PV = 500,000 and April PV = 1,100,000 before anything is cancelled.
//
// DS7.4 cancels 3.2 from April: April loses its 400,000 and lands on 700,000, March does not
// move, and 3.2.1's plan drops to the 200,000 already reported while 3.1.1's stays at the full
// 1,000,000 — which is exactly what DS7.8 is watching.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3919;   // next free after 7.4's 3917 and 7.6's 3918
let fx;
let db;
let wbssvc;
let bcrsvc;
let progsvc;
let csvc;
let capsOf;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-ds7-' });
  db = fx.db;
  // Load them TOGETHER so they share ONE `db.js` connection. Calling `load()` once per module
  // clears the whole `src/` cache each time, giving each module its own connection; on a
  // 2 GB box they then contend for the write lock. One connection is also simply the truth —
  // the app has a single SQLite connection per process.
  const [permissions, wbs, bcr, prog, cbs] = fx.loadMany(
    'src/lib/permissions.js', 'src/lib/wbs-service.js', 'src/lib/bcr-service.js',
    'src/lib/progress-service.js', 'src/lib/cbs-service.js');
  wbssvc = wbs; bcrsvc = bcr; progsvc = prog; csvc = cbs;
  capsOf = (userId) => permissions.capabilities(
    db.prepare('SELECT * FROM users WHERE id = ?').get(userId));

  // The seed lives in `before` because almost every test depends on a frozen project with two
  // budgeted lines — one to cancel and one that must survive. Seeding inside a test would make
  // the file depend on that test's position, which surfaces later as one mysterious failure.
  seedLine({ accountCode: '3.1.1', nodeCode: '3.1', rbsCode: 'O-SIT', rate: 500000, units: 2,
    months: [{ period_month: '2026-03', amount: 300000 }, { period_month: '2026-04', amount: 700000 }] });
  seedLine({ accountCode: '3.2.1', nodeCode: '3.2', rbsCode: 'M-STL', rate: 200000, units: 3,
    months: [{ period_month: '2026-03', amount: 200000 }, { period_month: '2026-04', amount: 400000 }] });

  bcrsvc.freezeBaseline({ projectId: 1, actorId: fx.pmAdmin.id, caps: capsOf(fx.pmAdmin.id) });
});

after(() => fx && fx.stop());

// ---- helpers ---------------------------------------------------------------

const nodeByCode = (code, projectId = 1) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(projectId, code);
const acctByCode = (code) => db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(code);
const idOf = (role) => fx.users.get(role);
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const bcrById = (id) => db.prepare('SELECT * FROM bcr_register WHERE id = ?').get(id);

// The PV curve as a USER sees it. Every claim about "past months" and "forward months" is
// made against this, because it is the number every SPI divides by — a change that left the
// plan table tidy while moving the curve would be the exact defect this part guards.
const pv = (month, projectId = 1) => db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(projectId, month)?.pv ?? 0;

const planTotal = (accountId, projectId = 1) => csvc.resourceTotalFor(projectId, accountId);

// Seed a resource plan AND its matching budget, so the account reconciles before the test
// begins. `months` must sum to exactly rate x units or the fixture itself would be lying.
function seedLine({ accountCode, nodeCode, rbsCode, rate, units, months }) {
  const account = acctByCode(accountCode);
  const node = nodeByCode(nodeCode);
  const total = Math.round(rate * units);
  db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code, transaction_account_id,
      rate, units, unit_label, total_amount, version) VALUES (1, ?, ?, ?, ?, ?, 'day', ?, 1)`)
    .run(node.id, rbsCode, account.id, rate, units, total);
  csvc.spreadBaseline({ projectId: 1, accountId: account.id, wbsNodeId: node.id, months, actorId: 1 });
  return { account, node, total };
}

// Raise a de-scope request for one line. The initiator is a Cost Controller and the approver is
// the PM, so the SoD rule is SATISFIED rather than bypassed — a fixture that approved its own
// request would be testing a flow the product refuses.
function raiseDeScope(nodeId, period, title = 'Client cancelled the remaining work') {
  const ccId = idOf('cost_controller');
  return bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'de_scope', wbsNodeId: nodeId, title,
    reason: 'the client cancelled this part of the works in writing',
    effectivePeriod: period,
  });
}

const approve = (bcrId) => bcrsvc.approveBcr({
  projectId: 1, bcrId, actorId: fx.pmAdmin.id, caps: capsOf(fx.pmAdmin.id) });

// Book a cost against a line. Goes through the same integrity triggers as the real ledger:
// whole rupiah, amount = debit - credit, non-zero, so a fixture row that production would
// reject is rejected here too.
// NOTE ON WHY THIS FILE TAKES ~40 SECONDS, in case it looks like a hang. Measured by
// instrumenting the hooks: ~41 s of it is `startFixture()` BOOT (migrate + seed + seed-master
// against a fresh temp DB), not the tests — DS7.2's own body, refusals included, is 65 ms.
// It is not specific to 7.7: `bcr.test.js` alone is ~42 s and the full suite ~810 s, which is
// line-for-line the same fixture boot. The cause is the box — 2 GB, no swap, and
// `PRAGMA synchronous = FULL` (TECH-SPEC §4.1) — so the seeds' fsyncs queue up. Nothing here
// is waiting on a lock; `busy_timeout = 5000` never fires. Do not "fix" it by weakening
// `synchronous`, which is a deliberate durability setting.
function bookCost(nodeId, amount, accountId, documentNo) {
  return db.prepare(`INSERT INTO accounting_ledger (project_id, date, type, line_role,
      in_cost_basis, source, amount, debit, credit, wbs_node_id, transaction_account_id,
      document_no, description)
      VALUES (1, '2026-03-15', 'Expense', 'expense', 1, 'manual', ?, ?, 0, ?, ?, ?, 'custody')`)
    .run(amount, amount, nodeId, accountId, documentNo).lastInsertRowid;
}

// ---- 7.7.2 the door: an approved de-scope BCR, and nothing less -------------

test('DS7.2 a de-scope without an approved BCR is refused, and nothing changes', () => {
  const node = nodeByCode('3.1');
  const before = { rows: count('cbs_plan'), status: node.status, plan: planTotal(acctByCode('3.1.1').id) };

  // (a) No request at all. The refusal names the way out, because the operator has to raise one.
  assert.throws(() => wbssvc.deScope({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: node.id, period: '2026-04', bcrId: null,
  }), (e) => e.status === 403 && /needs a change request/.test(e.message));

  // (b) A request that EXISTS but is still a draft. This is what a stale browser tab reaches,
  // and the check has to be on the register's STATE — not on the caller's word for it.
  const draft = raiseDeScope(node.id, '2026-04', 'still a draft');
  assert.throws(() => wbssvc.deScope({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: node.id, period: '2026-04', bcrId: draft.id,
  }), (e) => e.status === 409 && /is draft\. Removing scope needs it approved/.test(e.message));

  // (c) An APPROVED request of the wrong kind. Approved here on purpose: while the request is
  // a draft the STATUS check refuses first, so this rule would never be the one exercised and
  // the test would pass whether or not the rule existed.
  const pmId = idOf('project_manager');
  const rePhase = bcrsvc.initiateBcr({
    projectId: 1, actorId: pmId, caps: capsOf(pmId),
    changeType: 'budget_only', wbsNodeId: node.id, title: 'not a de-scope',
    reason: 're-phasing only', impactCost: 0, effectivePeriod: '2026-04',
  });
  approve(rePhase.id);
  assert.strictEqual(bcrById(rePhase.id).status, 'approved', 'the wrong-kind request really is approved');
  assert.throws(() => wbssvc.deScope({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: node.id, period: '2026-04', bcrId: rePhase.id,
  }), (e) => e.status === 400 && /not a de-scope/.test(e.message),
  'an approved budget_only request cannot stand in for a de-scope');

  // The world is exactly as it was: same plan, same status, same number of rows.
  assert.strictEqual(nodeByCode('3.1').status, before.status);
  assert.strictEqual(count('cbs_plan'), before.rows, 'no baseline row was written or removed');
  assert.strictEqual(planTotal(acctByCode('3.1.1').id), before.plan);
  assert.strictEqual(nodeByCode('3.1').de_scope_period, null, 'and no period was stamped');
});

test('DS7.9 the request and the line must agree about the line AND the month', () => {
  // Both refusals are only reachable once the request IS approved, because the status check
  // fires first otherwise. So the approved state is STAGED directly here rather than by
  // approving: that is what a retry looks like after an application that failed part-way, and
  // it is the only way to reach these two rules at all.
  const lineA = nodeByCode('3.1');
  const lineB = nodeByCode('3.2');
  const bcr = raiseDeScope(lineA.id, '2026-04', 'cancels 3.1 from April');
  db.prepare(`UPDATE bcr_register SET status = 'approved', approved_by = ?,
      decided_at = datetime('now') WHERE id = ?`).run(fx.pmAdmin.id, bcr.id);

  // Wrong MONTH: the money would leave the curve in one period while the line is reported out
  // of scope from another, so the two would disagree about a month nobody could explain.
  assert.throws(() => wbssvc.deScope({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: lineA.id, period: '2026-05', bcrId: bcr.id,
  }), (e) => e.status === 400 && /takes effect from 2026-04/.test(e.message));

  // Wrong LINE: each request takes out one named line, so pointing it at another must not work.
  assert.throws(() => wbssvc.deScope({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: lineB.id, period: '2026-04', bcrId: bcr.id,
  }), (e) => e.status === 400 && /removes 3\.1 from scope, not 3\.2/.test(e.message));

  // Neither attempt touched anything.
  assert.strictEqual(nodeByCode('3.1').status, 'active');
  assert.strictEqual(nodeByCode('3.2').status, 'active');
  assert.strictEqual(pv('2026-04'), 1100000, 'and April still holds both lines');
});

// ---- 7.7.4 THE test for this part: past months do not move ------------------

test('DS7.4 past v_evm_period rows are byte-identical; forward months lose the budget', () => {
  assert.strictEqual(pv('2026-03'), 500000, 'fixture: March is 300,000 + 200,000');
  assert.strictEqual(pv('2026-04'), 1100000, 'fixture: April is 700,000 + 400,000');

  const pastBefore = db.prepare(`SELECT * FROM v_evm_period
      WHERE project_id = ? AND period_month < '2026-04'`).all(1);
  assert.ok(pastBefore.length, 'there is a reported month to protect');

  const bcr = raiseDeScope(nodeByCode('3.2').id, '2026-04', 'Client cancelled girder fabrication');
  const done = approve(bcr.id);

  // EIA-748 G-30, asserted the strongest way available: the entire past row, every column,
  // byte for byte — including the id, so a delete-and-reinsert that happened to produce the
  // same numbers is still caught.
  assert.deepStrictEqual(
    db.prepare(`SELECT * FROM v_evm_period WHERE project_id = ? AND period_month < '2026-04'`).all(1),
    pastBefore, 'G-30: reported months are untouched, down to the row ids');

  // And the money DID leave, from the effective month forward. Without this half the test
  // would pass for a de-scope that did nothing at all.
  assert.strictEqual(pv('2026-04'), 700000, 'April loses the cancelled 400,000');
  assert.strictEqual(pv('2026-03'), 500000, 'March is unchanged');

  assert.strictEqual(done.deScoped.node.status, 'de_scoped');
  assert.strictEqual(done.deScoped.budgetRemoved, 400000,
    'the approval reports the money that actually left the curve');
});

test('DS7.1 a de-scoped line stays in the tree and in history, with its period', () => {
  const node = wbssvc.tree(1).lines.find((n) => n.wbs_code === '3.2');
  assert.ok(node, 'the line is still in the tree — a de-scope is not a delete');
  assert.strictEqual(node.status, 'de_scoped');
  assert.strictEqual(node.de_scope_period, '2026-04', 'and says from when it was out of scope');

  // Still there in the DATABASE, not merely filtered into visibility by one query.
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM wbs_nodes WHERE wbs_code = ?').get('3.2').n, 1);

  // And the register keeps the request that took it out, approved, with who decided it.
  const bcr = db.prepare(`SELECT * FROM bcr_register WHERE change_type = 'de_scope'
      AND status = 'approved' AND impact_cost <> 0 LIMIT 1`).get();
  assert.ok(bcr, 'the applied request is on the register');
  assert.strictEqual(bcr.approved_by, fx.pmAdmin.id, 'with the PM who accepted the consequence');
  assert.ok(bcr.decided_at, 'and when');
});

test('DS7.6 no progress row and no ledger row is deleted or altered by the de-scope', () => {
  // NOTHING IN THIS PART DELETES FROM EITHER TABLE, and this is the test that says so.
  //
  // It runs its OWN de-scope (line 6.1, untouched by every other test in this file) so the
  // before/after is genuine evidence rather than a value compared against itself. The
  // temptation a de-scope creates is to tidy away the money booked to the cancelled work;
  // the rule is that it stays, tagged and whole.
  //
  // First, positively: the de-scope path contains no DELETE against either table, so the
  // claim does not rest only on the absence of a visible change.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'baseline-service.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'wbs-service.js'), 'utf8');
  assert.ok(!/DELETE\s+FROM\s+accounting_ledger/i.test(src),
    'the de-scope path contains no ledger delete at all');
  assert.ok(!/DELETE\s+FROM\s+wbs_progress/i.test(src),
    'nor a progress delete — progress freezes where it stood, it is not rolled back');

  // Then the evidence. A cost is booked to the line BEFORE it is cancelled.
  const node = nodeByCode('6.1');
  const account = acctByCode('6.1.1');
  const spent = 88000;
  bookCost(node.id, spent, account.id, 'INV-BEFORE-CANCEL');
  const before = {
    progress: count('wbs_progress'),
    ledger: count('accounting_ledger'),
    ledgerSum: db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM accounting_ledger').get().s,
    onLine: db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM accounting_ledger WHERE wbs_node_id = ?')
      .get(node.id).s,
  };

  approve(raiseDeScope(node.id, '2026-04', 'cancel 6.1 to watch what happens to the money').id);

  // Nothing was removed, nothing was rewritten.
  assert.strictEqual(count('wbs_progress'), before.progress, 'no progress row disappeared');
  assert.strictEqual(count('accounting_ledger'), before.ledger, 'no ledger row disappeared');
  assert.strictEqual(
    db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM accounting_ledger').get().s,
    before.ledgerSum, 'and no amount changed');
  assert.strictEqual(
    db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM accounting_ledger WHERE wbs_node_id = ?')
      .get(node.id).s,
    before.onLine, 'the cost is still tagged to the line that was cancelled');

  // And it is still readable as "spent on the cancelled part", which is the whole reason the
  // rule exists — a de-scope that erased this would make the question unanswerable.
  const row = db.prepare('SELECT * FROM v_descoped_lines WHERE id = ?').get(node.id);
  assert.strictEqual(row.cost_incurred, spent);
});

test('DS7.8 a de-scope leaves the OTHER line\'s forward budget alone', () => {
  // THE SHARPEST HAZARD IN THIS PART. `applyBaselineChange` removes every forward row for the
  // project and re-inserts the set it is handed, so a de-scope that passed an empty or
  // wrongly-built set would wipe the neighbouring account's future budget — and the post-
  // condition would NOT catch it, because the plan would have been reduced to match.
  const survivor = acctByCode('3.1.1');
  const cancelled = acctByCode('3.2.1');

  assert.strictEqual(planTotal(survivor.id), 1000000,
    'the untouched line keeps its WHOLE plan, including the 700,000 still forward of April');
  assert.strictEqual(planTotal(cancelled.id), 200000,
    'and the cancelled line keeps only the plan for the month already reported');
});

// ---- 7.7.5 spent cost stays tagged -----------------------------------------

test('DS7.5 cost already booked to the cancelled line is still reported', () => {
  const node = nodeByCode('3.2');
  const account = acctByCode('3.2.1');
  const spent = 175000;
  bookCost(node.id, spent, account.id, 'INV-CANCEL-001');

  const row = db.prepare('SELECT * FROM v_descoped_lines WHERE id = ?').get(node.id);
  assert.ok(row, 'the cancelled line is on the de-scoped list');
  assert.strictEqual(row.cost_incurred, spent,
    'and the cost booked to it is still there to be asked about');
  // `budget_removed` on this view is the line's REMAINING current baseline — the money still
  // standing on a line that is no longer in scope, i.e. what the de-scope leaves behind, not
  // what it took out of the forward months. That is the view's pre-existing meaning and 7.7
  // does not redefine it; the movement itself is on the register (`DS7.10`) and in the
  // approval's own report (`DS7.4`), which is where a number that has to be exact belongs.
  assert.strictEqual(row.budget_removed, 200000,
    'the view reports the 200,000 of baseline still standing on the dead line, not the forward cut');
  assert.strictEqual(row.de_scope_period, '2026-04');

  // The READ view is the deliverable here, so the property is stated the way a report reads:
  // "we spent this much on the part that was cancelled".
  assert.strictEqual(row.wbs_code, '3.2');

  // The ledger row itself is untouched: same amount, same line tag.
  const line = db.prepare('SELECT * FROM accounting_ledger WHERE document_no = ?').get('INV-CANCEL-001');
  assert.strictEqual(line.amount, spent);
  assert.strictEqual(line.wbs_node_id, node.id, 'and still tagged to the cancelled line');
});

// ---- 7.7.3 / 7.7.7 progress freezes; the line cannot come back --------------

test('DS7.3 after a de-scope no further progress can be reported against the line', () => {
  const node = nodeByCode('3.2');
  const ccId = idOf('cost_controller');
  const rowsBefore = count('wbs_progress');

  // A manual report for a LATER period — the figure nobody is performing any more.
  assert.throws(() => progsvc.writePeriod({
    projectId: 1, actorId: ccId, nodeId: node.id, period: '2026-06',
  }), (e) => e.status === 403 && /out of scope in 2026-04/.test(e.message));

  // And a milestone tick, which reaches the same refusal through its own path. Both are
  // covered because the gate lives in loadNode, which both of them call.
  const ms = db.prepare('SELECT * FROM progress_milestones WHERE wbs_node_id = ? ORDER BY seq LIMIT 1')
    .get(node.id);
  assert.ok(ms, 'the line has a milestone to try to tick');
  assert.throws(() => progsvc.setMilestoneTick({
    projectId: 1, actorId: ccId, milestoneId: ms.id, ticked: true, period: '2026-06',
  }), (e) => e.status === 403 && /out of scope/.test(e.message));

  assert.strictEqual(count('wbs_progress'), rowsBefore, 'and neither attempt wrote a row');
  assert.strictEqual(db.prepare('SELECT ticked FROM progress_milestones WHERE id = ?').get(ms.id).ticked,
    0, 'nor ticked the milestone');
});

test('DS7.7 a de-scoped line cannot be reopened from the tree screen', () => {
  // Reopening scope puts contract value BACK, so it is a contract change: it needs its own
  // approved BCR, the same door that took the line out. Without this refusal the tree's status
  // control would be a way to put work back that the baseline does not fund — the line would
  // be tickable again while every SPI said the money was gone.
  const node = nodeByCode('3.2');
  assert.throws(() => wbssvc.setStatus({
    projectId: 1, actorId: idOf('cost_controller'), nodeId: node.id, status: 'active',
    reason: 'trying to reopen it',
  }), (e) => e.status === 403 && /needs an approved change request/.test(e.message));

  assert.strictEqual(nodeByCode('3.2').status, 'de_scoped', 'and it is still out of scope');
  assert.strictEqual(nodeByCode('3.2').de_scope_period, '2026-04', 'with its period intact');
});

// ---- 7.7.8 the register records what actually moved ------------------------

test('DS7.10 the approval writes the real movement back onto the register', () => {
  // At raise the impact is 0: 7.7 derives the figure from the baseline, so there is nothing
  // for the operator to state. Left at 0, the register would record "no cost impact" for a
  // de-scope that moved 400,000, and every report built on the register would understate it.
  const bcr = db.prepare(`SELECT * FROM bcr_register WHERE change_type = 'de_scope'
      AND status = 'approved' AND impact_cost <> 0 ORDER BY id DESC LIMIT 1`).get();
  assert.strictEqual(bcr.impact_cost, -400000,
    'the register carries the movement, signed as a reduction');

  const audit = db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'bcr_register'
      AND entity_id = ? AND action = 'approve'`).get(bcr.id);
  assert.ok(audit, 'the decision is in the audit trail');
  assert.match(audit.after_json, /budget_removed/, 'and records how much left the curve');
});

test('DS7.11 a de-scope request cannot carry proposed months — derived, not stated', () => {
  // Two competing statements of what should happen, and which one won would depend on the
  // order of two statements in approveBcr. Refused rather than silently ignored.
  const fresh = nodeByCode('4.1');
  const ccId = idOf('cost_controller');
  const bcr = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'de_scope', wbsNodeId: fresh.id, title: 'trying to state rows too',
    reason: 'should be refused', effectivePeriod: '2026-04',
    proposedRows: [{ transaction_account_id: acctByCode('4.1.1').id, wbs_node_id: fresh.id,
      period_month: '2026-04', amount: 1000 }],
  });
  assert.throws(() => approve(bcr.id),
    (e) => e.status === 400 && /does not take proposed months/.test(e.message));

  assert.strictEqual(bcrById(bcr.id).status, 'draft',
    'and the request is left exactly where it was');
  assert.strictEqual(nodeByCode('4.1').status, 'active', 'nor was the line touched');
});

test('DS7.12 a line with no budget leaves scope without inventing a saving', () => {
  // No plan to reduce, so the de-scope would look successful while moving no money. The
  // honest outcome: the line is out of scope and the movement is reported as ZERO rather than
  // as a made-up figure.
  const spare = nodeByCode('5.1');
  const bcr = raiseDeScope(spare.id, '2026-04', 'a line with no budget');
  const before = count('cbs_plan');

  const done = approve(bcr.id);
  assert.strictEqual(done.deScoped.budgetRemoved, 0, 'no budget left the curve');
  assert.strictEqual(count('cbs_plan'), before, 'and the baseline is untouched');
  assert.strictEqual(bcrById(bcr.id).impact_cost, 0,
    'so the register records no movement either');
  assert.strictEqual(nodeByCode('5.1').status, 'de_scoped', 'while the line really is out of scope');
});

test('DS7.13 the account still reconciles after the de-scope', () => {
  // The invariant 7.5 enforces, checked from OUTSIDE the service at the end of the part: the
  // buckets a user can see must equal the resource plan, on both accounts. This is the check
  // that makes the plan-reduction arithmetic in planDeScope safe to trust.
  for (const code of ['3.1.1', '3.2.1']) {
    const account = acctByCode(code);
    const buckets = db.prepare(`SELECT COALESCE(SUM(c.amount), 0) s FROM cbs_plan c
      WHERE c.project_id = 1 AND c.transaction_account_id = ? AND c.plan_type = 'baseline'
        AND c.version = (SELECT MAX(c2.version) FROM cbs_plan c2
          WHERE c2.project_id = c.project_id
            AND c2.transaction_account_id = c.transaction_account_id
            AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
            AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)`)
      .get(account.id).s;
    assert.strictEqual(buckets, planTotal(account.id),
      `${code} must reconcile: buckets == resource plan`);
  }
});
