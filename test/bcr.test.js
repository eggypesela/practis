// BC7-series: baseline freeze + the BCR change-control workflow (module 7, plan part 7.6;
// PRD §4.2 step 4, §4.4 lines 195–214).
//
// WHAT THIS FILE EXISTS FOR
//
// Part 7.5 built the one mutation path. This part is the workflow that decides who may use
// it and when — and the failure modes here are all about PERMISSION and STATE, which are
// exactly the things a test can pin and a comment cannot:
//
//   * THE SoD TRAP OF THIS MODULE (BC7.2). Everywhere else in this app an Administrator
//     passes every capability check by design. PRD §4.2 step 4 says the opposite for a
//     baseline. The obvious implementation — `canApproveBaseline = has('project_manager')` —
//     SILENTLY grants it to an admin-only account, and nothing else in the suite would
//     notice. So the refusal is asserted twice: once at the service, once over HTTP.
//
//   * A REJECTED REQUEST MUST CHANGE NOTHING (BC7.7). The strongest negative in the module:
//     compared as raw rows, ids and all, plus the PV curve a user would actually see.
//
//   * THE BASELINE DOES NOT MOVE UNTIL APPROVAL (BC7.14). A proposal is data on the
//     request. If a later refactor applied it on raise, every draft would be a live
//     change and the register would be decoration.
//
// And the POSITIVE case is asserted where a user would see it: the PV curve before and
// after approval, month by month (BC7.4) — the figure every SPI is a ratio of.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3918;   // allocated at build time; 3915 was already taken by two files
let fx;
let db;
let bcrsvc;
let csvc;
let capsOf;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-bc7-' });
  db = fx.db;
  const permissions = fx.load('src/lib/permissions.js');
  capsOf = (userId) => permissions.capabilities(
    db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  bcrsvc = fx.load('src/lib/bcr-service.js');
  csvc = fx.load('src/lib/cbs-service.js');

  // The seed lives HERE rather than in the first test that needs it, because almost every
  // test in this file depends on the project already having a reconciled baseline — the
  // freeze refuses to lock an empty one, and a change request cannot be raised against an
  // unfrozen project. Seeding inside a test would make the whole file depend on that
  // test's position in the list, which is the kind of order-coupling that shows up later
  // as a mysterious single failure after an unrelated edit.
  seedAccount({
    accountCode: '2.2.1', nodeCode: '3.2', rbsCode: 'O-SIT', rate: 500000, units: 2,
    months: [{ period_month: '2026-03', amount: 300000 }, { period_month: '2026-04', amount: 700000 }],
  });
});

after(() => fx && fx.stop());

// ---- helpers ---------------------------------------------------------------

const nodeByCode = (code, projectId = 1) => db.prepare(
  'SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? ORDER BY version LIMIT 1')
  .get(projectId, code);
const acctByCode = (code) => db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(code);

// The PV curve as a USER sees it: the EVM view, which is what every SPI divides by.
const pv = (month, projectId = 1) => db.prepare(
  'SELECT * FROM v_evm_period WHERE project_id = ? AND period_month = ?').get(projectId, month)?.pv ?? 0;

// Every cbs_plan row, byte for byte. Used for the "nothing changed" assertions — a sum
// would hide an inserted row that nets to zero, and an id/comparison is what makes
// "nothing was written" a fact rather than a plausible reading.
const cbsRows = (projectId = 1) => db.prepare(
  'SELECT * FROM cbs_plan WHERE project_id = ? ORDER BY id').all(projectId);
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const projectRow = (id = 1) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

// Audit rows are written against BOTH the register row (the decision) and the project (the
// fact that the baseline moved), so this counts across entity types rather than pinning
// one — pinning one is how a test starts passing for the wrong reason.
const auditCount = (action, entityId = null) => db.prepare(`SELECT COUNT(*) n FROM audit_log
  WHERE action = ? ${entityId === null ? '' : 'AND entity_id = ?'}`)
  .get(...(entityId === null ? [action] : [action, entityId])).n;

// A project with no budget at all, for the two rules that are about an UNFROZEN project
// (you cannot freeze nothing; you cannot raise a change against nothing). Kept separate
// from the main fixture so those tests do not depend on the order of the others.
function insertBareProject(code = 'PRJ-EMPTY') {
  return db.prepare(`INSERT INTO projects (code, name, status) VALUES (?, ?, 'active')`)
    .run(code, `Empty ${code}`).lastInsertRowid;
}

// Seed a resource plan AND its matching budget so the account reconciles before the test
// begins. `months` must sum to exactly rate x units, or the fixture itself would be lying.
function seedAccount({ accountCode, nodeCode, rbsCode, rate, units, months }) {
  const account = acctByCode(accountCode);
  const node = nodeByCode(nodeCode);
  const total = Math.round(rate * units);
  db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code, transaction_account_id,
      rate, units, unit_label, total_amount, version) VALUES (1, ?, ?, ?, ?, ?, 'day', ?, 1)`)
    .run(node.id, rbsCode, account.id, rate, units, total);
  csvc.spreadBaseline({ projectId: 1, accountId: account.id, wbsNodeId: node.id, months, actorId: 1 });
  return { account, node, total };
}

// Roles and the two admin variants the fixture builds for exactly this part.
const idOf = (role) => fx.users.get(role);
let adminId;         // system administrator, no project_manager role
let pmAdminId;       // system administrator who ALSO holds project_manager

// ---- 7.6.1 / 7.6.2 the freeze, and WHO may do it --------------------------

test('BC7.2 an Administrator-only user is REFUSED the baseline approval', async () => {
  // PRD §4.2 step 4: "Admin does NOT approve baselines." The capability is `hasExact`, so
  // an admin-only account does NOT pass it — asserted at the SERVICE here and again over
  // HTTP in BC7.11, because a route guard is one line a later refactor can drop while the
  // data keeps changing.
  adminId = fx.adminOnly.id;
  const caps = capsOf(adminId);
  assert.strictEqual(caps.isAdmin, true, 'the fixture user really is a system administrator');
  assert.strictEqual(caps.canApproveBaseline, false,
    'and is nonetheless NOT allowed to approve a baseline');

  assert.throws(
    () => bcrsvc.freezeBaseline({ projectId: 1, actorId: adminId, caps }),
    (e) => e.status === 403 && /Administrator does not approve baselines/.test(e.message));
  assert.strictEqual(projectRow(1).baseline_locked, 0, 'and the project is still unfrozen');
});

test('BC7.2b a Project Manager who ALSO administers the system IS allowed', () => {
  // The other half of `hasExact`, and the reason it is not simply "exclude admins": the
  // rule excludes the ADMIN ROLE, not the person. An operator who owns the install and is
  // the project's PM may freeze it. Without this test, `canApproveBaseline = false` would
  // pass BC7.2 and lock the owner out of their own install.
  pmAdminId = fx.pmAdmin.id;
  const caps = capsOf(pmAdminId);
  assert.strictEqual(caps.isAdmin, true, 'holds the admin flag');
  assert.strictEqual(caps.canApproveBaseline, true, 'and holds project_manager as well');
});

test('BC7.1 the PM freezes the baseline and the project records who and when', () => {
  const out = bcrsvc.freezeBaseline({ projectId: 1, actorId: pmAdminId, caps: capsOf(pmAdminId) });

  assert.strictEqual(out.baseline_locked, 1);
  assert.ok(out.baseline_locked_at, 'the moment is recorded');
  assert.strictEqual(out.baseline_locked_by, pmAdminId, 'and so is the person accountable for it');
  assert.strictEqual(auditCount('freeze_baseline', 1), 1, 'one audit row for the fact');

  // Frozen means frozen: the same request again is refused rather than re-stamped, because
  // re-stamping would erase who actually accepted the baseline.
  assert.throws(() => bcrsvc.freezeBaseline({ projectId: 1, actorId: pmAdminId, caps: capsOf(pmAdminId) }),
    (e) => e.status === 409 && /already has a frozen baseline/.test(e.message));
});

test('BC7.3 a freeze over an EMPTY baseline is refused — a lock over nothing locks nothing', () => {
  const empty = insertBareProject('PRJ-NOBUDGET');
  assert.throws(
    () => bcrsvc.freezeBaseline({ projectId: empty, actorId: pmAdminId, caps: capsOf(pmAdminId) }),
    (e) => e.status === 400 && /no budget to freeze/.test(e.message));
  assert.strictEqual(projectRow(empty).baseline_locked, 0,
    'refused, so the flag never claims a baseline exists');
});

// ---- 7.6.3 / 7.6.9 when a change request may be raised ---------------------

test('BC7.8 a BCR is refused while the baseline is NOT yet locked, and needs an effective month', () => {
  const empty = insertBareProject('PRJ-OPEN');
  const caps = capsOf(idOf('cost_controller'));

  assert.throws(() => bcrsvc.initiateBcr({
    projectId: empty, actorId: idOf('cost_controller'), caps,
    changeType: 'modify', title: 'too early', reason: 'nothing to change',
    effectivePeriod: '2026-05', wbsNodeId: nodeByCode('3.2', empty)?.id ?? null,
  }), (e) => e.status === 409 && /does not have a frozen baseline/.test(e.message));

  // A request with no effective month has no prospective form, and assuming "now" would
  // silently rewrite whichever month the assumption landed in.
  assert.throws(() => bcrsvc.initiateBcr({
    projectId: 1, actorId: idOf('cost_controller'), caps,
    changeType: 'modify', title: 'no month', reason: 'missing period',
    effectivePeriod: '', wbsNodeId: nodeByCode('3.2').id,
  }), (e) => e.status === 400 && /is not a month/.test(e.message));

  // A reason is what explains the movement later, when nobody remembers why.
  assert.throws(() => bcrsvc.initiateBcr({
    projectId: 1, actorId: idOf('cost_controller'), caps,
    changeType: 'modify', title: 'no reason', reason: '   ',
    effectivePeriod: '2026-05', wbsNodeId: nodeByCode('3.2').id,
  }), (e) => e.status === 400 && /needs a reason/.test(e.message));

  assert.strictEqual(count('bcr_register'), 0, 'and nothing was recorded by any of the three');
});

// ---- 7.6.5 the happy path, asserted on the curve a user reads --------------

test('BC7.4 an approved BCR moves PV from the effective month FORWARD', () => {
  // The fixture (seeded in `before`) is one account reconciled with its resource plan,
  // budget split across two months so a change can land after a reported one.
  const account = acctByCode('2.2.1');
  const node = nodeByCode('3.2');
  assert.strictEqual(pv('2026-03'), 300000, 'fixture: March is planned');
  assert.strictEqual(pv('2026-04'), 700000, 'fixture: April is planned');

  const ccId = idOf('cost_controller');
  const moved = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'add_scope', wbsNodeId: node.id,
    title: 'Client asked for extra site supervision',
    reason: 'ninety more supervised days were requested in writing',
    impactCost: 1000000, impactScheduleDays: 14, effectivePeriod: '2026-04',
    // The COMPLETE new set from 2026-04 forward: the old 700,000 for April is replaced,
    // not added to.
    proposedRows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-04', amount: 1700000 }],
    // The plan that supports the new money. Without it the approval could never
    // reconcile, which is why 7.5 refuses a money-moving change with no resource rows.
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'O-SIT', transaction_account_id: account.id,
      rate: 1000000, units: 2 }],
  });
  assert.strictEqual(moved.status, 'draft');
  assert.match(moved.bcr_no, /^BCR-\d{4}$/, 'the register numbers the request');

  // NOT yet: a draft is a proposal.
  assert.strictEqual(pv('2026-04'), 700000, 'a draft changes nothing');

  bcrsvc.verifyBcr({ projectId: 1, bcrId: moved.id, actorId: idOf('finance'),
    caps: capsOf(idOf('finance')) });
  assert.strictEqual(pv('2026-04'), 700000, 'nor does verifying it');

  const done = bcrsvc.approveBcr({ projectId: 1, bcrId: moved.id, actorId: pmAdminId,
    caps: capsOf(pmAdminId) });
  assert.strictEqual(done.bcr.status, 'approved');
  assert.ok(done.applied, 'the approval reported what it applied');

  // EIA-748 G-30, on the number a user actually sees.
  assert.strictEqual(pv('2026-04'), 1700000, 'April moved — it is at the effective month');
  assert.strictEqual(pv('2026-03'), 300000, 'and March did NOT — it was already reported');
  assert.strictEqual(done.bcr.old_baseline_json !== null, true, 'the prior figures are archived');
});

// ---- 7.6.6 separation of duties --------------------------------------------

test('BC7.5 the initiator cannot verify or approve their own BCR, and no state changes', () => {
  const node = nodeByCode('3.2');
  const pmId = idOf('project_manager');
  const bcr = bcrsvc.initiateBcr({
    projectId: 1, actorId: pmId, caps: capsOf(pmId),
    changeType: 'modify', wbsNodeId: node.id, title: 'PM raises and tries to approve',
    reason: 'testing the SoD rule', impactCost: 0, effectivePeriod: '2026-06',
  });

  assert.throws(() => bcrsvc.verifyBcr({ projectId: 1, bcrId: bcr.id, actorId: pmId, caps: capsOf(pmId) }),
    (e) => e.status === 403 && /you raised this request/.test(e.message));
  assert.throws(() => bcrsvc.approveBcr({ projectId: 1, bcrId: bcr.id, actorId: pmId, caps: capsOf(pmId) }),
    (e) => e.status === 403 && /you raised this change request/.test(e.message));

  assert.strictEqual(bcrsvc.byId(1, bcr.id).status, 'draft', 'still a draft after both refusals');
  assert.strictEqual(auditCount('approve', bcr.id), 0, 'no approval audit row');
});

// ---- 7.6.7 the illegal transitions ----------------------------------------

test('BC7.6 an approved BCR cannot be re-approved, rejected or reopened', () => {
  // The CHECK constraint bounds the VALUES of `status`, not the moves between them, so a
  // direct UPDATE can still walk `approved -> draft`. The service is what makes the
  // workflow a workflow.
  const node = nodeByCode('3.2');
  const ccId = idOf('cost_controller');
  const bcr = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'budget_only', wbsNodeId: node.id, title: 'Re-phasing, no money',
    reason: 'the same money lands a month later', impactCost: 0, effectivePeriod: '2026-06',
    proposedRows: [{ transaction_account_id: acctByCode('2.2.1').id, wbs_node_id: node.id,
      period_month: '2026-06', amount: 0 }],
  });
  bcrsvc.verifyBcr({ projectId: 1, bcrId: bcr.id, actorId: idOf('finance'), caps: capsOf(idOf('finance')) });
  bcrsvc.approveBcr({ projectId: 1, bcrId: bcr.id, actorId: pmAdminId, caps: capsOf(pmAdminId) });

  for (const move of ['verify', 'approve', 'reject', 'withdraw']) {
    assert.throws(() => bcrsvc[`${move}Bcr`]({ projectId: 1, bcrId: bcr.id, actorId: pmAdminId,
      caps: capsOf(pmAdminId), note: 'trying anyway' }),
    (e) => e.status === 409, `${move} must be refused on an approved request`);
  }
  assert.strictEqual(bcrsvc.byId(1, bcr.id).status, 'approved', 'unchanged by all four attempts');
});

// ---- 7.6.7 the strongest negative -----------------------------------------

test('BC7.7 a rejected BCR leaves the baseline byte-identical', () => {
  const node = nodeByCode('3.2');
  const account = acctByCode('2.2.1');
  const ccId = idOf('cost_controller');

  const before = cbsRows();
  const pvBefore = ['2026-03', '2026-04', '2026-06'].map((m) => [m, pv(m)]);

  const bcr = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'add_scope', wbsNodeId: node.id, title: 'Wanted, then turned down',
    reason: 'client asked for an extra floor', impactCost: 500000, effectivePeriod: '2026-05',
    proposedRows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-05', amount: 500000 }],
    rbsRows: [{ wbs_node_id: node.id, rbs_code: 'O-SIT', transaction_account_id: account.id,
      rate: 500000, units: 1 }],
  });
  assert.throws(() => bcrsvc.rejectBcr({ projectId: 1, bcrId: bcr.id, actorId: pmAdminId,
    caps: capsOf(pmAdminId), note: '   ' }), /Say why the request is being rejected/,
  'a rejection needs a reason — it is kept and shown to the person who raised it');

  const rejected = bcrsvc.rejectBcr({ projectId: 1, bcrId: bcr.id, actorId: pmAdminId,
    caps: capsOf(pmAdminId), note: 'not in the client budget this year' });
  assert.strictEqual(rejected.status, 'rejected');
  assert.ok(rejected.decided_at, 'the decision is stamped');

  assert.deepStrictEqual(cbsRows(), before, 'not one row of the baseline moved');
  assert.deepStrictEqual(['2026-03', '2026-04', '2026-06'].map((m) => [m, pv(m)]), pvBefore,
    'and the PV curve is untouched — the request never reached the mutation path');
  assert.strictEqual(bcrsvc.byId(1, bcr.id).new_baseline_json !== null, true,
    'the proposal is kept on the register as the record of what was asked for');
});

test('BC7.7b withdrawing your own request closes it and moves nothing', () => {
  const node = nodeByCode('3.2');
  const ccId = idOf('cost_controller');
  const other = idOf('project_controller');

  const mine = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'modify', wbsNodeId: node.id, title: 'Raised by mistake',
    reason: 'wrong line', impactCost: 0, effectivePeriod: '2026-07',
  });
  assert.throws(() => bcrsvc.withdrawBcr({ projectId: 1, bcrId: mine.id, actorId: other,
    note: null }), (e) => e.status === 403 && /Only the person who raised/.test(e.message),
  'only the raiser may withdraw');

  const before = cbsRows();
  const out = bcrsvc.withdrawBcr({ projectId: 1, bcrId: mine.id, actorId: ccId, note: 'wrong line' });
  assert.strictEqual(out.status, 'withdrawn');
  assert.deepStrictEqual(cbsRows(), before, 'withdrawing changes no money');
});

// ---- 7.6.5b a money-moving request must carry its supporting plan ----------

test('BC7.9 a change that moves money is refused without the resource plan behind it', () => {
  const node = nodeByCode('3.2');
  const account = acctByCode('2.2.1');
  const ccId = idOf('cost_controller');
  const before = cbsRows();

  assert.throws(() => bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'add_scope', wbsNodeId: node.id, title: 'Money, no plan',
    reason: 'forgot the resource rows', impactCost: 250000, effectivePeriod: '2026-08',
    proposedRows: [{ transaction_account_id: account.id, wbs_node_id: node.id,
      period_month: '2026-08', amount: 250000 }],
  }), (e) => e.status === 400 && /has to state the resource plan/.test(e.message),
  'refused at RAISE, not days later at approval to a different person');

  // And a money-moving request with no proposed rows at all is refused at approval, because
  // approving it would report a contract movement the budget never made.
  const empty = bcrsvc.initiateBcr({
    projectId: 1, actorId: ccId, caps: capsOf(ccId),
    changeType: 'budget_only', wbsNodeId: node.id, title: 'Impact but no rows',
    reason: 'nothing proposed', impactCost: 0, effectivePeriod: '2026-08',
  });
  db.prepare('UPDATE bcr_register SET impact_cost = 250000 WHERE id = ?').run(empty.id);
  assert.throws(() => bcrsvc.approveBcr({ projectId: 1, bcrId: empty.id, actorId: pmAdminId,
    caps: capsOf(pmAdminId) }),
  (e) => e.status === 400 && /states no new baseline rows/.test(e.message));

  assert.deepStrictEqual(cbsRows(), before, 'nothing moved in either case');
});

// ---- 7.6.10 the routes: a viewer may read, not write -----------------------

test('BC7.10 the register is readable by a Viewer and NOT writable by one', async () => {
  const viewer = fx.clients.get('viewer');

  const page = await viewer.get('/bcr');
  assert.strictEqual(page.status, 200, 'a Viewer can read the audit trail of changes');
  const html = await page.text();
  assert.match(html, /Change request/, 'and the register is on the page');

  const form = await viewer.get('/bcr/new');
  assert.ok(form.status === 403 || /Not allowed|Project Controller/i.test(await form.text()),
    'but may not open the form to raise one');

  const rows = count('bcr_register');
  const res = await fx.post(viewer, '/bcr', 'title=viewer+attempt&change_type=modify'
    + '&effective_period=2026-05&reason=nope&wbs_node_id=9&impact_cost=0');
  assert.ok(res.status === 403 || res.status === 302, 'the POST does not succeed');
  assert.strictEqual(count('bcr_register'), rows, 'and nothing was written');
});

test('BC7.11 over HTTP, an Administrator-only user is refused the freeze', async () => {
  // The same rule as BC7.2, at the layer an operator actually reaches. There is no fresh
  // project left to freeze on project 1 (BC7.1 already did), so this asserts the ROUTE
  // refuses: a 403 page, not a redirect, and the project is left as it was.
  const res = await fx.post(fx.adminOnly.client, '/projects/1/baseline/freeze', '');
  assert.strictEqual(res.status, 403, 'the admin-only user gets the 403 page');
  const html = await res.text();
  assert.match(html, /Not allowed/i, 'and it says so');
  assert.strictEqual(projectRow(1).baseline_locked, 1, 'the frozen project is unchanged');
});

test('BC7.12 over HTTP, the whole workflow runs: raise, verify, approve', async () => {
  const node = nodeByCode('3.1');
  const account = acctByCode('3.1.1');

  // A plain budget-only request through the form, exactly as the browser would post it.
  const raised = await fx.post(fx.clients.get('cost_controller'), '/bcr',
    'change_type=budget_only&wbs_node_id=' + node.id
    + '&title=HTTP+round+trip&effective_period=2026-09'
    + '&reason=exercising+the+routes&impact_cost=0');
  assert.strictEqual(raised.status, 302, 'raising redirects back to the register');
  const loc = decodeURIComponent(raised.headers.get('location') || '');
  assert.match(loc, /\/bcr\?msg=/, 'with a message: ' + loc);
  assert.ok(!/err=/.test(loc), 'and not a refusal');

  const bcr = db.prepare('SELECT * FROM bcr_register ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(bcr.status, 'draft');

  const verified = await fx.post(fx.clients.get('finance'), `/bcr/${bcr.id}/verify`, '');
  assert.strictEqual(verified.status, 302);
  assert.strictEqual(bcrsvc.byId(1, bcr.id).status, 'verified', 'Finance verified it');

  const approved = await fx.post(fx.pmAdmin.client, `/bcr/${bcr.id}/approve`, '');
  assert.strictEqual(approved.status, 302);
  assert.strictEqual(bcrsvc.byId(1, bcr.id).status, 'approved', 'the PM approved it');
  assert.strictEqual(account.id, acctByCode('3.1.1').id, 'the account is the one we seeded');
});

test('BC7.13 the sidebar link resolves — no dead href, and the route answers', async () => {
  // The plan asks for the nav links Module 7 owns. MS6.7/MS6.8 already assert that every
  // sidebar link goes somewhere real; this pins THIS link, so removing the route without
  // removing the link fails here rather than in a general sweep.
  const html = await (await fx.clients.get('project_manager').get('/')).text();
  assert.match(html, /href="\/bcr"/, 'the sidebar offers the register');
  assert.ok(!/href="#"/.test(html), 'and nothing on the page is a dead link');

  const page = await fx.clients.get('project_manager').get('/bcr');
  assert.strictEqual(page.status, 200);
});
