// BS7-series: the one baseline mutation path (module 7, plan part 7.5; PRD §5.2, §5.5).
//
// WHAT THIS FILE EXISTS FOR
//
// Two properties, both about not lying, and both hard to notice when broken:
//
//   PROSPECTIVE (BS7.1) — a change never rewrites a month already reported. The failure is
//   silent: last month's SPI would quietly move, and nothing would say why.
//
//   ATOMIC (BS7.2-BS7.6) — either the whole new baseline is in place or nothing happened.
//   A half-applied baseline is the worst state in the product: PV part old and part new,
//   so every later SPI and CPI is wrong in a way no screen explains.
//
// The post-condition that guarantees atomicity RE-READS the table, comparing every current
// bucket of each touched account against that account's resource plan — the level at which
// an over- or under-spread actually sits. So there is a case for each way the table can
// disagree with what the caller believed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3915;   // F7 allocation for part 7.5
let fx;
let db;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-bs7-', roles: ['cost_controller'] });
  db = fx.db;
});

after(() => fx && fx.stop());

// ---- helpers ---------------------------------------------------------------
const bsvc = () => fx.load('src/lib/baseline-service.js');
const csvc = () => fx.load('src/lib/cbs-service.js');

const nodeByCode = (code) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = 1 AND wbs_code = ? ORDER BY version LIMIT 1').get(code);
const acctByCode = (code) => db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(code);
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

// Every CURRENT baseline bucket (all periods), as plain rows. This is what a change is
// judged against, and what must be untouched below the effective period.
const currentBuckets = (from = null, to = null) => db.prepare(`SELECT c.period_month,
    c.transaction_account_id, c.wbs_node_id, c.version, c.amount
  FROM cbs_plan c
  WHERE c.project_id = 1 AND c.plan_type = 'baseline'
    AND c.version = (SELECT MAX(c2.version) FROM cbs_plan c2
      WHERE c2.project_id = c.project_id
        AND c2.transaction_account_id = c.transaction_account_id
        AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
        AND c2.plan_type = c.plan_type AND c2.period_month = c.period_month)
    ${from ? 'AND c.period_month < ?' : ''} ${to ? 'AND c.period_month >= ?' : ''}
  ORDER BY c.period_month, c.transaction_account_id, c.wbs_node_id`)
  .all(...(from ? [from] : []).concat(to ? [to] : []));

// The account's resource plan, summed current-version-per-bucket — written out here so the
// test does not check the service against itself.
const planned = (accountId) => db.prepare(`SELECT COALESCE(SUM(r.total_amount), 0) s FROM rbs_load r
  WHERE r.project_id = 1 AND r.transaction_account_id = ?
    AND r.version = (SELECT COALESCE(MAX(r2.version), 1) FROM rbs_load r2
      WHERE r2.project_id = r.project_id AND r2.wbs_node_id = r.wbs_node_id
        AND r2.rbs_code = r.rbs_code
        AND COALESCE(r2.transaction_account_id, 0) = COALESCE(r.transaction_account_id, 0))`)
  .get(accountId).s;

// The account's budget, summed over the CURRENT baseline buckets of that account alone.
// (Summing every account's buckets is an easy way to write a test that proves nothing.)
const bucketTotal = (accountId) => currentBuckets()
  .filter((r) => r.transaction_account_id === accountId)
  .reduce((s, r) => s + r.amount, 0);

// Seed a resource plan AND its matching budget, so the account reconciles before the test
// begins. `months` must sum to exactly rate x units, or the fixture would be lying.
function seedAccount({ accountCode, nodeCode, rbsCode, rate, units, months }) {
  const account = acctByCode(accountCode);
  const node = nodeByCode(nodeCode);
  assert.ok(account, `fixture: account ${accountCode} must exist`);
  assert.ok(node, `fixture: WBS line ${nodeCode} must exist`);
  const total = Math.round(rate * units);
  db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code, transaction_account_id,
      rate, units, unit_label, total_amount, version) VALUES (1, ?, ?, ?, ?, ?, 'day', ?, 1)`)
    .run(node.id, rbsCode, account.id, rate, units, total);

  const sum = months.reduce((s, m) => s + m.amount, 0);
  assert.strictEqual(sum, total, `fixture: months must total the plan (${sum} != ${total})`);
  csvc().spreadBaseline({ projectId: 1, accountId: account.id, wbsNodeId: node.id, months, actorId: 1 });
  return { account, node, total };
}

let bcrSeq = 0;
const newBcr = (node, fields = {}) => db.prepare(`INSERT INTO bcr_register (bcr_no, project_id,
    change_type, wbs_node_id, title, impact_cost, effective_period, status, initiated_by)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1)`)
  .run(`BCR-BS7-${++bcrSeq}`, fields.change_type || 'modify', node.id,
    fields.title || 'Test change', fields.impact_cost || 0, fields.effective_period || '2026-06',
    fields.status || 'draft').lastInsertRowid;

// ---- 5.1 PROSPECTIVE: the past is never rewritten --------------------------

test('BS7.1 past months are byte-identical after a change effective later (EIA-748 G-30)', () => {
  const account = acctByCode('1.1.1');
  const node = nodeByCode('2.1');
  seedAccount({ accountCode: '1.1.1', nodeCode: '2.1', rbsCode: 'L-CAR', rate: 1000000, units: 6,
    months: [{ period_month: '2026-03', amount: 2000000 }, { period_month: '2026-04', amount: 2000000 },
             { period_month: '2026-05', amount: 2000000 }] });

  const before = currentBuckets('2026-06');
  assert.strictEqual(before.length, 3, 'three reported months are on the books');
  assert.strictEqual(planned(account.id), 6000000);

  const { applyBaselineChange } = bsvc();
  // ADDED SCOPE from June, so the plan rises to 8,000,000 and the new money sits in June.
  //
  // Deliberately an addition and not a reduction. A reduction that lands in a month already
  // reported cannot be prospective at all: the money is already earned against, and taking
  // it out of March would rewrite a month whose SPI was published. That is not a gap in
  // this function — it is the rule working, and the correct treatment for an overspend is
  // variance reporting, not a quieter baseline.
  applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-06', actorId: 1, reason: 'added scope: extra span',
    impactCost: 2000000,
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'L-CAR', transaction_account_id: account.id,
      rate: 1000000, units: 8 }],
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-06', amount: 2000000 }],
  });

  assert.deepStrictEqual(currentBuckets('2026-06'), before,
    'the three reported months are untouched — same rows, same versions, same amounts');
  assert.strictEqual(planned(account.id), 8000000, 'the plan moved');
  assert.strictEqual(bucketTotal(account.id), 8000000,
    'and March+April+May+June still add up to the plan');
});

test('BS7.1b a change may not name a month before its own effective period', () => {
  const { applyBaselineChange } = bsvc();
  const account = acctByCode('1.1.1');
  const node = nodeByCode('2.1');
  const before = currentBuckets();

  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-06', actorId: 1, reason: 'try to rewrite history',
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-04', amount: 1 }],
  }), /already reported are never rewritten/);

  assert.deepStrictEqual(currentBuckets(), before, 'nothing moved');
});

// ---- 5.2 it archives before it replaces ------------------------------------

test('BS7.2 the archive is what was actually there, not a fresh calculation', () => {
  const account = acctByCode('1.2.1');
  const node = nodeByCode('2.2');
  seedAccount({ accountCode: '1.2.1', nodeCode: '2.2', rbsCode: 'L-CON', rate: 1000000, units: 4,
    months: [{ period_month: '2026-03', amount: 2000000 }, { period_month: '2026-04', amount: 2000000 }] });

  const bcr = newBcr(node, { title: 'Reduce concreting', effective_period: '2026-05' });

  // The raw pre-change table, ALL versions — the archive is the whole prior baseline.
  const rawBefore = db.prepare(`SELECT transaction_account_id, wbs_node_id, plan_type, version,
      period_month, amount FROM cbs_plan WHERE project_id = 1 AND plan_type IN ('baseline','bcr')
      ORDER BY period_month, transaction_account_id, wbs_node_id, version`).all();

  const { applyBaselineChange, archivedBaseline } = bsvc();
  applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-05', actorId: 1, reason: 're-plan', bcrId: bcr,
    impactCost: 2000000,
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'L-CON', transaction_account_id: account.id,
      rate: 1000000, units: 6 }],
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-05', amount: 2000000 }],
  });

  const archived = archivedBaseline(bcr);
  assert.ok(archived, 'the archive exists');
  assert.strictEqual(archived.length, rawBefore.length, 'row for row');
  assert.deepStrictEqual(
    archived.map((r) => [r.period_month, r.transaction_account_id, r.amount]),
    rawBefore.map((r) => [r.period_month, r.transaction_account_id, r.amount]),
    'and it is the values that were really there');
});

// ---- 5.3/5.4 ATOMICITY ----------------------------------------------------

test('BS7.3 a change that does not reconcile leaves the baseline COMPLETELY intact', () => {
  const account = acctByCode('2.1.1');
  const node = nodeByCode('3.1');
  seedAccount({ accountCode: '2.1.1', nodeCode: '3.1', rbsCode: 'L-SIT', rate: 500000, units: 4,
    months: [{ period_month: '2026-03', amount: 1000000 }, { period_month: '2026-04', amount: 1000000 }] });

  const bucketsBefore = currentBuckets();
  const planBefore = planned(account.id);
  const cbsRows = count('cbs_plan');

  const { applyBaselineChange } = bsvc();
  // The buckets would say 4,000,000 while the plan says 2,000,000, with no resource plan
  // stated to support the difference. The post-condition fails, so the DELETE is undone
  // too — the classic half-applied baseline.
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-05', actorId: 1, reason: 'over-budget re-plan',
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-05', amount: 4000000 }],
  }), /rolled back in full/);

  assert.deepStrictEqual(currentBuckets(), bucketsBefore, 'every bucket is back as it was');
  assert.strictEqual(planned(account.id), planBefore, 'and the resource plan too');
  assert.strictEqual(count('cbs_plan'), cbsRows, 'not one row was left deleted or added');
});

test('BS7.4 the rollback closes the transaction — nothing is left holding a write lock', () => {
  const { applyBaselineChange } = bsvc();
  const account = acctByCode('2.1.1');
  const node = nodeByCode('3.1');

  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-05', actorId: 1, reason: 'fails again',
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-05', amount: 999 }],
  }));

  // db.inTransaction is better-sqlite3's own view of the connection: false means the
  // transaction was properly closed rather than abandoned mid-flight.
  assert.strictEqual(db.inTransaction, false, 'no transaction is left open');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM cbs_plan').get().n > 0, 'the table still reads');
});

test('BS7.5 an untagged row is refused and changes nothing (015 is the backstop)', () => {
  const before = currentBuckets();
  const { applyBaselineChange } = bsvc();
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-05', actorId: 1, reason: 'account total row',
    rows: [{ transaction_account_id: acctByCode('2.1.1').id, wbs_node_id: null,
      period_month: '2026-05', amount: 500 }],
  }), /must name a work line/);
  assert.deepStrictEqual(currentBuckets(), before, 'nothing moved');
});

test('BS7.6 a money-moving change must carry the resource plan that supports it', () => {
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  seedAccount({ accountCode: '2.2.1', nodeCode: '3.2', rbsCode: 'O-SIT', rate: 500000, units: 2,
    months: [{ period_month: '2026-03', amount: 1000000 }] });

  const before = currentBuckets();
  const { applyBaselineChange } = bsvc();

  // States an impact but no resource plan: the budget would be adjusted against a plan
  // that still says the old figure, so the change is refused outright. Stated as a
  // REDUCTION, which needs no room beyond what is already planned — so the refusal that
  // follows can only be about the missing resource plan.
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-04', actorId: 1, reason: 'scope down, no plan',
    impactCost: -500000,
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-04', amount: 500000 }],
  }), /has to state the resource plan/);
  assert.deepStrictEqual(currentBuckets(), before, 'nothing moved');

  // And a change that ADDS money with no room left for it is refused by the sum, even
  // though it names the right account: the account's whole history must equal the plan.
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-04', actorId: 1, reason: 'scope up, no room',
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-04', amount: 2000000 }],
  }), /rolled back in full/);
  assert.deepStrictEqual(currentBuckets(), before, 'nothing moved');

  // With both halves it applies — extra site supervision, plan 1,000,000 -> 2,000,000, and
  // the March figure stays exactly where it was.
  const res = applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-04', actorId: 1, reason: 'extra site supervision',
    impactCost: 1000000,
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'O-SIT', transaction_account_id: account.id,
      rate: 1000000, units: 2 }],
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-04', amount: 1000000 }],
  });
  assert.strictEqual(res.rbsWritten, 1, 'the resource plan moved with the budget');
  assert.strictEqual(planned(account.id), 2000000, 'the plan is the new figure');
  assert.strictEqual(bucketTotal(account.id), 2000000, 'and so is the budget');
  assert.strictEqual(currentBuckets(null, '2026-04')[0].amount, 1000000, 'March is untouched');
});

test('BS7.7 a resource plan put on the WRONG account rolls the whole change back', () => {
  // A mis-keyed resource row shows up as a shortfall on BOTH accounts, so the change is
  // rolled back rather than passing as "close enough".
  const account = acctByCode('2.2.1');
  const other = acctByCode('4.1.1');
  const node = nodeByCode('3.2');

  const bucketsBefore = currentBuckets();
  const planBefore = planned(account.id);
  const otherPlanBefore = planned(other.id);
  const rbsRows = count('rbs_load');

  const { applyBaselineChange } = bsvc();
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-05', actorId: 1, reason: 'wrong account on the plan',
    impactCost: 500000,
    // The extra money is put on a DIFFERENT account from the one whose budget rises.
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'O-SAF', transaction_account_id: other.id,
      rate: 500000, units: 1 }],
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-05', amount: planned(account.id) + 500000 }],
  }), /rolled back in full/);

  assert.deepStrictEqual(currentBuckets(), bucketsBefore, 'buckets untouched');
  assert.strictEqual(planned(account.id), planBefore, 'plan untouched');
  assert.strictEqual(planned(other.id), otherPlanBefore, 'the other account was not altered either');
  assert.strictEqual(count('rbs_load'), rbsRows, 'the mis-keyed plan row was rolled back too');
});

// ---- the proposal side ---------------------------------------------------

test('BS7.8 a proposal does not move the live baseline until it is approved', () => {
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  const bcr = newBcr(node, { title: 'Drop a section', effective_period: '2026-06' });

  const bucketsBefore = currentBuckets();
  const { setProposedBaseline, proposedBaseline, applyBaselineChange } = bsvc();

  setProposedBaseline({ projectId: 1, bcrId: bcr, actorId: 1,
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-06', amount: 0 }] });

  assert.strictEqual(proposedBaseline(bcr).length, 1, 'the proposal is recorded');
  assert.deepStrictEqual(currentBuckets(), bucketsBefore,
    'but the LIVE baseline has not moved — a proposal is not an approval');

  // Applying it is a separate act, and it is the one that moves the baseline.
  applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-06', actorId: 1, reason: 'approved: months re-phased',
    bcrId: bcr,
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-06', amount: 0 }],
  });
  assert.notDeepStrictEqual(currentBuckets(), bucketsBefore, 'now it has moved');
});

test('BS7.9 a proposal may not be edited once the request has moved on', () => {
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  const bcr = newBcr(node, { title: 'Already verified', effective_period: '2026-07',
    status: 'verified' });

  const { setProposedBaseline } = bsvc();
  assert.throws(() => setProposedBaseline({ projectId: 1, bcrId: bcr, actorId: 1,
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-07', amount: 1 }] }),
  /only be set while the request is a draft/);
});

test('BS7.10 a change with no reason is refused, and a blank one too', () => {
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  const before = currentBuckets();
  const { applyBaselineChange } = bsvc();
  const rows = [{ transaction_account_id: account.id, wbs_node_id: node.id,
    period_month: '2026-08', amount: 1 }];

  assert.throws(() => applyBaselineChange({ projectId: 1, effectivePeriod: '2026-08', actorId: 1, rows }),
    /needs a reason/);
  assert.throws(() => applyBaselineChange({ projectId: 1, effectivePeriod: '2026-08', actorId: 1,
    reason: '   ', rows }), /needs a reason/);
  assert.deepStrictEqual(currentBuckets(), before, 'nothing moved');
});

test('BS7.11 versions CONTINUE across a change, so the archive still reads in order', () => {
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  const maxBefore = db.prepare('SELECT MAX(version) v FROM cbs_plan WHERE project_id = 1').get().v;

  const { applyBaselineChange } = bsvc();
  // Effective from the account's FIRST month, so every existing bucket is in scope and the
  // restated total still equals the plan. (A later effective period would have to leave the
  // earlier months alone, and then the total would no longer add up.)
  const first = currentBuckets().filter((r) => r.transaction_account_id === account.id)[0].period_month;
  applyBaselineChange({
    projectId: 1, effectivePeriod: first, actorId: 1, reason: 'further re-plan',
    rows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: first, amount: planned(account.id) }],
  });

  // No bucket may end up with two rows claiming to be current.
  const dupes = db.prepare(`SELECT transaction_account_id, wbs_node_id, period_month, version,
      COUNT(*) n FROM cbs_plan WHERE project_id = 1 AND plan_type = 'baseline'
    GROUP BY transaction_account_id, wbs_node_id, period_month, version HAVING n > 1`).all();
  assert.deepStrictEqual(dupes, [], 'no duplicate current rows');

  const after = db.prepare('SELECT MAX(version) v FROM cbs_plan WHERE project_id = 1').get().v;
  assert.ok(after > maxBefore, `versions kept rising (${maxBefore} -> ${after})`);
});

test('BS7.12 the archive is not written by a change that never happened', () => {
  const node = nodeByCode('3.2');
  const bcr = newBcr(node, { title: 'Will fail', effective_period: '2026-09' });

  const { applyBaselineChange, archivedBaseline } = bsvc();
  assert.throws(() => applyBaselineChange({
    projectId: 1, effectivePeriod: '2026-09', actorId: 1, reason: 'fails on the sum', bcrId: bcr,
    rows: [{ transaction_account_id: acctByCode('2.2.1').id, wbs_node_id: node.id,
      period_month: '2026-09', amount: 99999999999 }],
  }), /rolled back in full/);

  // The archive write is INSIDE the transaction, so a rolled-back change leaves no archive
  // claiming a state that was never committed.
  assert.strictEqual(archivedBaseline(bcr), null, 'no archive survives a change that rolled back');
});

test('BS7.13 the fixture itself is a real install (guards the shared harness)', () => {
  // If the fixture regressed — e.g. seed-master.js seeding the dev database instead of the
  // test one — the WBS tree would be empty and most tests above would pass vacuously.
  assert.ok(count('wbs_nodes') >= 15, 'the seeded WBS tree is present');
  assert.ok(count('transaction_accounts') > 0, 'the chart of accounts is present');
  assert.ok(count('rbs_code') >= 20, 'the resource list is present');
  assert.ok(count('progress_milestones') >= 60, 'and the milestones were backfilled');
  assert.strictEqual(db.pragma('foreign_keys', { simple: true }), 1, 'FKs are on');
});
