// BA8-series: the BAST acceptance register (module 8, plan part 8.9). THIS IS PART 8.9'S GATE.
//
// WHAT THIS FILE DEFENDS. Part 8.8 built revenue recognition on a table nothing could write to, so
// the POC basis could only ever be zero. This part supplies the input. The rules that make the
// input trustworthy:
//
//   1. A CERTIFICATE CANNOT BE CREATED AS `accepted` (owner decision A, 2026-10-04). The posted
//      status is IGNORED — `record()` hard-codes 'draft'. BA8.2 posts `status=accepted` and proves
//      the row still lands as a draft, because a form-level check is not a control.
//   2. ONLY `accepted` COUNTS. BA8.4 submits a certificate and pins that the revenue basis does NOT
//      move, then accepts it and pins that it does.
//   3. THE ACCEPTOR IS NOT THE RECORDER. Recording/submitting and accepting carry DIFFERENT
//      capabilities. BA8.5 pins that a viewer and a cost_controller both get 403 on accept AND that
//      the database is unchanged — a status code alone is not evidence.
//   4. AN ACCEPTED CERTIFICATE IS FROZEN. BA8.7 refuses a transition out of it and proves the
//      percentage is still what it was.
//   5. A REJECTED CERTIFICATE IS TERMINAL. BA8.6 pins that it never counts and cannot be revived.
//   6. BA8.9 IS THE POINT: record → submit → accept → and then read 8.8's `/reports/revenue` PAGE
//      and see the revenue. That is the only assertion in the file that proves the two parts
//      actually connect. Everything above could pass with the two halves unconnected.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3929;
const PROJECT = 1;
const CONTRACT = 10_000_000;
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
  '2026-07', '2026-08', '2026-09', '2026-10'];
const ACCOUNT = '1.1.1';
const LINE = '3.1';

let fx;
let acc;
let revenue;
let cbs;
let ids = {};

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-ba8-' });
  [acc, revenue, cbs] = fx.loadMany('src/lib/acceptance-service.js',
    'src/lib/revenue-service.js', 'src/lib/cbs-service.js');

  fx.db.prepare(`UPDATE projects SET contract_amount = ?, start_date = '2026-01-01',
      end_date = '2026-10-31', revenue_method = NULL WHERE id = ?`).run(CONTRACT, PROJECT);
  fx.db.prepare('DELETE FROM acceptance_register WHERE project_id = ?').run(PROJECT);

  const node = fx.db.prepare('SELECT * FROM wbs_nodes WHERE project_id = ? AND wbs_code = ? LIMIT 1')
    .get(PROJECT, LINE);
  const acct = fx.db.prepare('SELECT * FROM transaction_accounts WHERE code = ?').get(ACCOUNT);
  ids.node = node.id;
  ids.acct = acct.id;

  // A baseline so the revenue screen is a real screen rather than an empty-state, and so the POC
  // percentage can be seen against a contract value.
  //
  // `rbs_load` FIRST, and it must total the same figure as the buckets: `spreadBaseline` refuses a
  // baseline that disagrees with the resource plan (the plan's own Σ invariant, part 7.4). Without
  // this row the spread is rejected outright — a trap worth naming because the error reads like a
  // data problem rather than a missing fixture row.
  fx.db.prepare(`INSERT INTO rbs_load (project_id, wbs_node_id, rbs_code,
      transaction_account_id, rate, units, unit_label, total_amount, version)
      VALUES (?, ?, 'M-CEM', ?, 1000000, ?, 'day', ?, 1)`)
    .run(PROJECT, node.id, acct.id, MONTHS.length, MONTHS.length * 1_000_000);

  cbs.spreadBaseline({
    projectId: PROJECT, accountId: acct.id, wbsNodeId: node.id,
    actorId: fx.users.get('cost_controller'),
    months: MONTHS.map((m) => ({ period_month: m, amount: 1_000_000 })),
  });
});

after(() => { if (fx) fx.stop(); });

const actor = () => fx.users.get('project_controller');
const pm = () => fx.users.get('project_manager');

// Every test that writes through the service needs the register in a known state, because these
// tests share one fixture and a certificate left `accepted` by an earlier test would silently
// change a later one's basis. This clears it.
function resetRegister() {
  fx.db.prepare('DELETE FROM acceptance_register WHERE project_id = ?').run(PROJECT);
  fx.db.prepare('DELETE FROM revenue_recognized WHERE project_id = ?').run(PROJECT);
}

// ---------------------------------------------------------------------------
// BA8.1 — record lands as a draft and counts for nothing
// ---------------------------------------------------------------------------

test('BA8.1 a recorded certificate is a draft and moves no revenue', () => {
  resetRegister();

  const out = acc.record({
    projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-A1', percentage_progress: '30', document_date: '2026-03-10' },
  });
  assert.strictEqual(out.ok, true, 'the certificate was recorded');
  assert.strictEqual(out.certificate.status, 'draft', 'and it landed as a DRAFT');
  assert.strictEqual(out.certificate.percentage_progress, 30, 'with the percentage recorded');
  assert.strictEqual(out.certificate.sequence, 1, 'and sequence 1, it is the first');
  assert.strictEqual(out.certificate.created_by, actor(), 'stamped with who recorded it');

  // THE POINT: a draft is not revenue. The basis is unchanged.
  const b = revenue.bastPct(PROJECT, '2026-03');
  assert.strictEqual(b.pct, 0, 'a DRAFT certificate contributes nothing to the revenue basis');
  assert.strictEqual(b.certificates, 0, 'and is not counted as an accepted certificate');

  // The audit row exists, so the recording is on the record.
  const audit = fx.db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'acceptance_register'
      AND entity_id = ? AND action = 'create'`).get(out.certificate.id);
  assert.ok(audit, 'the recording is audited');
  assert.strictEqual(JSON.parse(audit.after_json).status, 'draft', 'and the audit shows the draft');
});

// ---------------------------------------------------------------------------
// BA8.2 — a certificate cannot be CREATED as accepted
// ---------------------------------------------------------------------------

test('BA8.2 a posted status=accepted is IGNORED \u2014 the row still lands as a draft', () => {
  resetRegister();

  // This is the heart of decision A. Someone posting the form with a tampered status field must not
  // be able to skip the acceptance step. The service hard-codes 'draft', so the check is not in the
  // form — and BA8.2 is what proves that.
  const out = acc.record({
    projectId: PROJECT, actorId: actor(),
    input: {
      certificate_no: 'BAST-A2', percentage_progress: '95',
      status: 'accepted',            // <- tampered
      accepted_date: '2026-01-01',   // <- tampered
    },
  });

  assert.strictEqual(out.certificate.status, 'draft',
    'the posted status=accepted was IGNORED; the row is a draft');
  assert.strictEqual(out.certificate.accepted_date, null,
    'and no accepted_date was written from the form');
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 0,
    'so it still contributes nothing to revenue');

  // And the same via the SERVICE's transition path: draft -> accepted is not a legal move.
  assert.throws(
    () => acc.transition({ projectId: PROJECT, id: out.certificate.id, to: 'accepted', actorId: pm() }),
    (e) => e instanceof acc.AcceptanceError && e.status === 409,
    'even the PM cannot jump a draft straight to accepted');

  const row = fx.db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(out.certificate.id);
  assert.strictEqual(row.status, 'draft', 'and the refused move left the row untouched');
});

// ---------------------------------------------------------------------------
// BA8.3 — the three-step walk works, and only the last step moves revenue
// ---------------------------------------------------------------------------

test('BA8.3 draft \u2192 submitted \u2192 accepted, and the basis follows only the accept', () => {
  resetRegister();

  const rec = acc.record({
    projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-A3', percentage_progress: '40', document_date: '2026-03-05' },
  });
  const id = rec.certificate.id;
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 0, 'draft: basis 0%');

  // SUBMIT — the paper has gone to the client. Still not revenue.
  const submitted = acc.submit({ projectId: PROJECT, id, actorId: actor() });
  assert.strictEqual(submitted.status, 'submitted', 'now submitted');
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 0,
    'a SUBMITTED certificate is still not acceptance \u2014 basis stays 0%');

  // ACCEPT — the client signed. Now it counts.
  // The acceptance date is EXPLICIT and in the past, because `bastPct` is an AS-AT-MONTH figure: it
  // counts certificates accepted by the end of the month asked about. Accepting today and then
  // asking about March correctly gives 0% — the basis as at March did not include it. Passing a
  // March acceptance date makes the month placement visible instead of hiding it behind "now".
  const accepted = acc.accept({ projectId: PROJECT, id, actorId: pm(), acceptedDate: '2026-03-20' });
  assert.strictEqual(accepted.status, 'accepted', 'now accepted');
  assert.strictEqual(accepted.accepted_date, '2026-03-20',
    'the accepted_date is the one recorded against the acceptance');
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 40,
    'and now the basis is the certificate\u2019s 40%');

  // And the AS-AT-MONTH behaviour is pinned: a month BEFORE the acceptance does not include it.
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-02').pct, 0,
    'February\u2019s basis does not include a March acceptance \u2014 the figure is as at the month');

  // The register summary agrees with the revenue basis — one source, no drift.
  const s = acc.summary(PROJECT);
  assert.strictEqual(s.acceptedPct, 40, 'the register states 40%');
  assert.strictEqual(s.counts.accepted, 1, 'one accepted certificate');

  // Audited at each step, with the before and after.
  //
  // NOTE the `.slice(-3)`: `resetRegister()` DELETEs the certificates between tests, and SQLite
  // REUSES the freed rowids — so audits written by earlier tests share this `entity_id`. Taking the
  // last three rows is the deterministic reading, because create → submitted → accepted are the
  // most recent three writes for the id regardless of what a previous test left behind. Asserting
  // the whole list would pass or fail depending on test order.
  const audits = fx.db.prepare(`SELECT * FROM audit_log WHERE entity_type = 'acceptance_register'
      AND entity_id = ? ORDER BY id`).all(id);
  const actions = audits.slice(-3).map((a) => a.action);
  assert.deepStrictEqual(actions, ['create', 'submitted', 'accepted'],
    'all three steps are on the record, in order');
  assert.ok(JSON.parse(audits[audits.length - 1].after_json).accepted_date,
    'and the acceptance audit carries the stamped date');
});

// ---------------------------------------------------------------------------
// BA8.4 — the acceptance date is explicit when given, and the register orders itself
// ---------------------------------------------------------------------------

test('BA8.4 an explicit acceptance date is honoured, and sequence auto-increments', () => {
  resetRegister();

  const a = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-B1', percentage_progress: '10' } });
  const b = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-B2', percentage_progress: '15' } });
  assert.strictEqual(a.certificate.sequence, 1, 'first certificate is sequence 1');
  assert.strictEqual(b.certificate.sequence, 2, 'second is sequence 2 \u2014 auto-incremented per project');

  acc.submit({ projectId: PROJECT, id: a.certificate.id, actorId: actor() });
  // A client may have signed last week and the record only be entered now, so an explicit date is
  // allowed — and it must be the date given, not today.
  const accepted = acc.accept({ projectId: PROJECT, id: a.certificate.id, actorId: pm(),
    acceptedDate: '2026-03-20' });
  assert.strictEqual(accepted.accepted_date, '2026-03-20',
    'the supplied acceptance date is honoured, not overwritten with today');

  // The list is ordered by sequence, so the register reads in issue order even when rows were
  // inserted in a different order.
  const listed = acc.list(PROJECT);
  assert.deepStrictEqual(listed.map((r) => r.sequence), [1, 2], 'listed in sequence order');

  // An impossible acceptance date is refused rather than stored.
  assert.throws(
    () => acc.accept({ projectId: PROJECT, id: b.certificate.id, actorId: pm(), acceptedDate: '2026-02-31' }),
    (e) => e instanceof acc.AcceptanceError,
    '2026-02-31 is not a real date and is refused');
  acc.submit({ projectId: PROJECT, id: b.certificate.id, actorId: actor() });
  assert.throws(
    () => acc.accept({ projectId: PROJECT, id: b.certificate.id, actorId: pm(), acceptedDate: '20/03/2026' }),
    (e) => e instanceof acc.AcceptanceError,
    'a non-ISO date is refused rather than silently mis-parsed');
});

// ---------------------------------------------------------------------------
// BA8.5 — only a Project Manager accepts, and the refusal touches nothing
// ---------------------------------------------------------------------------

test('BA8.5 only the Project Manager may accept \u2014 and a refusal changes nothing', async () => {
  resetRegister();

  const rec = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-C1', percentage_progress: '50' } });
  const id = rec.certificate.id;
  acc.submit({ projectId: PROJECT, id, actorId: actor() });

  // Read the state ONCE, then prove the refused attempts did not change it.
  const before = fx.db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(id);

  // A cost_controller has NO acceptance capability at all, so they are refused the RECORDING form
  // too — the recording family is project_controller / project_manager / project_admin, following
  // WBS ownership. Asserted here so the capability boundary is pinned, not assumed.
  const costClient = fx.clients.get('cost_controller');
  const ccForm = await costClient.get('/acceptance/new');
  assert.strictEqual(ccForm.status, 403, 'a cost_controller may not open the recording form');
  await costClient.get('/acceptance');
  const asCC = await costClient.post(`/acceptance/${id}/accept`, '');
  assert.strictEqual(asCC.status, 403, 'nor accept a certificate (403)');

  // And a Project CONTROLLER — who genuinely may record and submit — still may NOT accept. That is
  // the real segregation this part adds: the person who files the paper is not the person who
  // approves it.
  const pcClient = fx.clients.get('project_controller');
  await pcClient.get('/acceptance');
  const asPC = await pcClient.post(`/acceptance/${id}/accept`, '');
  assert.strictEqual(asPC.status, 403,
    'a project_controller records and submits, but may not accept \u2014 that is the control');

  // A viewer is refused too — and is refused the READ-ONLY page not at all, which is the split:
  // reading the register is unrestricted, writing it is not.
  const { asRole } = require('./helpers/authz');
  const viewer = await asRole(require('better-sqlite3'), fx.dbPath, fx.ORIGIN, 'viewer',
    { email: 'ba85-viewer@example.test' });
  const viewerPage = await viewer.client.get('/acceptance');
  assert.strictEqual(viewerPage.status, 200, 'a viewer MAY read the register');
  const viewerHtml = await viewerPage.text();
  assert.ok(!/action="\/acceptance\/\d+\/accept"/.test(viewerHtml),
    'and the accept control is not offered to them');
  await viewer.client.get('/acceptance');
  const asViewer = await viewer.client.post(`/acceptance/${id}/accept`, '');
  assert.strictEqual(asViewer.status, 403, 'a viewer is refused the accept action (403)');

  // THE ASSERTION THAT MATTERS: the database is unchanged, not merely that the response was 403.
  const after = fx.db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(id);
  assert.strictEqual(after.status, before.status, 'status unchanged by the refused attempts');
  assert.strictEqual(after.accepted_date, before.accepted_date, 'accepted_date unchanged');
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 0, 'and no revenue was recognised');

  // The PM CAN accept it. An explicit March date so the basis question is asked about the month the
  // acceptance belongs to (`bastPct` is as-at-month).
  const pmClient = fx.clients.get('project_manager');
  await pmClient.get('/acceptance');
  const asPM = await pmClient.post(`/acceptance/${id}/accept`, 'accepted_date=2026-03-18');
  assert.strictEqual(asPM.status, 302, 'the Project Manager accepts it');
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-03').pct, 50, 'and the basis moves to 50%');
});

// ---------------------------------------------------------------------------
// BA8.6 — a rejected certificate is terminal and counts for nothing
// ---------------------------------------------------------------------------

test('BA8.6 a rejected certificate never counts and cannot be revived', () => {
  resetRegister();

  const rec = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-D1', percentage_progress: '60' } });
  const id = rec.certificate.id;
  acc.submit({ projectId: PROJECT, id, actorId: actor() });
  const rejected = acc.reject({ projectId: PROJECT, id, actorId: pm() });
  assert.strictEqual(rejected.status, 'rejected', 'submitted \u2192 rejected is allowed');

  assert.strictEqual(revenue.bastPct(PROJECT, '2026-06').pct, 0, 'a rejected certificate counts 0%');
  const s = acc.summary(PROJECT);
  assert.strictEqual(s.counts.rejected, 1, 'and is counted as rejected in the register');
  assert.strictEqual(s.acceptedPct, 0, 'the accepted total is untouched');

  // TERMINAL: it cannot be accepted afterwards. The reason must say what to do instead.
  assert.throws(
    () => acc.accept({ projectId: PROJECT, id, actorId: pm() }),
    (e) => e instanceof acc.AcceptanceError && /record a NEW certificate/i.test(e.message),
    'a rejected certificate cannot be revived, and the refusal says to supersede it');
  assert.throws(
    () => acc.submit({ projectId: PROJECT, id, actorId: actor() }),
    (e) => e instanceof acc.AcceptanceError,
    'and it cannot be re-submitted either');

  const row = fx.db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(id);
  assert.strictEqual(row.status, 'rejected', 'the refused moves left it rejected');
  assert.strictEqual(row.percentage_progress, 60, 'and its percentage is preserved as the record');
});

// ---------------------------------------------------------------------------
// BA8.7 — an accepted certificate is frozen
// ---------------------------------------------------------------------------

test('BA8.7 an accepted certificate cannot be re-opened, and its percentage cannot move', () => {
  resetRegister();

  const rec = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-E1', percentage_progress: '35' } });
  const id = rec.certificate.id;
  acc.submit({ projectId: PROJECT, id, actorId: actor() });
  // An explicit March date, because the basis is asked about a month (see BA8.3).
  acc.accept({ projectId: PROJECT, id, actorId: pm(), acceptedDate: '2026-03-11' });

  // Every move out of `accepted` is refused. Asserted individually so a future change that opens
  // one of them fails here rather than silently weakening the control.
  for (const to of ['draft', 'submitted', 'rejected']) {
    assert.throws(
      () => acc.transition({ projectId: PROJECT, id, to, actorId: pm() }),
      (e) => e instanceof acc.AcceptanceError && e.status === 409,
      `accepted \u2192 ${to} is refused`);
  }

  // The basis is exactly what the accepted certificate says, after all the refusals.
  assert.strictEqual(revenue.bastPct(PROJECT, '2026-06').pct, 35,
    'the basis is still the accepted 35%');

  // A DIRECT db UPDATE of the percentage is refused BY THE DATABASE, not just by the service. This
  // is the floor: if a future route bypasses the service, the trigger still holds. (There is no such
  // trigger today, so this asserts the behaviour that exists and documents the gap.)
  const row = fx.db.prepare('SELECT * FROM acceptance_register WHERE id = ?').get(id);
  assert.strictEqual(row.status, 'accepted', 'still accepted');
  assert.strictEqual(row.percentage_progress, 35, 'still 35%');
});

// ---------------------------------------------------------------------------
// BA8.8 — validation: the percentage is the basis, so it is checked hard
// ---------------------------------------------------------------------------

test('BA8.8 the accepted percentage is required, positive and at most 100', () => {
  resetRegister();

  const bad = [
    ['', 'missing'],
    ['0', 'zero'],
    ['-5', 'negative'],
    ['101', 'above 100'],
    ['abc', 'not a number'],
  ];
  for (const [value, label] of bad) {
    assert.throws(
      () => acc.record({ projectId: PROJECT, actorId: actor(),
        input: { certificate_no: 'X', percentage_progress: value } }),
      (e) => e instanceof acc.AcceptanceError,
      `a ${label} percentage (${value || 'blank'}) is refused`);
  }

  // Nothing was written by any of the refusals.
  assert.strictEqual(fx.db.prepare('SELECT COUNT(*) n FROM acceptance_register WHERE project_id = ?')
    .get(PROJECT).n, 0, 'no refused certificate was written');

  // 100 IS allowed — a final certificate covering the whole contract is legitimate.
  const full = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-F1', percentage_progress: '100' } });
  assert.strictEqual(full.certificate.percentage_progress, 100, '100% is a valid certificate');

  // A decimal is allowed too, because part-completions are not always whole numbers.
  const dec = acc.record({ projectId: PROJECT, actorId: actor(),
    input: { certificate_no: 'BAST-F2', percentage_progress: '12.5' } });
  assert.strictEqual(dec.certificate.percentage_progress, 12.5, '12.5% is accepted');
});

// ---------------------------------------------------------------------------
// BA8.9 — THE END-TO-END CLAIM: the register feeds the revenue screen
// ---------------------------------------------------------------------------

test('BA8.9 record \u2192 submit \u2192 accept, then the REVENUE PAGE shows it', async () => {
  resetRegister();
  // Set the method to POC first, so the screen has something to recognise with.
  fx.db.prepare("UPDATE projects SET revenue_method = 'poc' WHERE id = ?").run(PROJECT);

  // The RECORDER is a project_controller: they hold `canManageAcceptance` but NOT the accepting
  // capability, which is exactly the segregation this part adds. (Using the cost_controller here
  // was the first draft's mistake — they hold neither, so the 403 came from the wrong rule.)
  const client = fx.clients.get('project_controller');

  // BEFORE: the revenue screen reports no basis, because nothing is accepted.
  //
  // The READER is a separate client the recognition screen is open to — reading the revenue report
  // is unrestricted (`canViewForecast`), unlike writing it (module 8 part 8.8).
  const reader = fx.clients.get('cost_controller');
  const before = await reader.get('/reports/revenue?month=2026-03');
  const beforeHtml = await before.text();
  assert.match(beforeHtml, /0 accepted certificate/,
    'before any acceptance, the revenue screen says there is nothing to work from');

  // The register is empty on its own page too.
  const regBefore = await client.get('/acceptance');
  assert.match(await regBefore.text(), /No certificates recorded yet/,
    'the register says it is empty');

  // RECORD through the real HTTP form. 25% of a 10,000,000 contract.
  await client.get('/acceptance/new');
  const recorded = await client.post('/acceptance',
    'certificate_no=BAST-E2E&percentage_progress=25&document_date=2026-03-05');
  assert.strictEqual(recorded.status, 302, 'recording redirects to the register (PRG)');
  const id = fx.db.prepare("SELECT id FROM acceptance_register WHERE certificate_no = 'BAST-E2E'").get().id;

  // The register now shows it as a DRAFT, and says it is not yet revenue.
  const regDraft = await client.get('/acceptance');
  const draftHtml = await regDraft.text();
  assert.match(draftHtml, /BAST-E2E/, 'the certificate is on the register');
  assert.match(draftHtml, /DRAFT/, 'and shows as a draft');

  const afterRecord = await reader.get('/reports/revenue?month=2026-03');
  assert.match(await afterRecord.text(), /0 accepted certificate/,
    'a DRAFT is still not revenue on the recognition screen');

  // SUBMIT (the recorder's capability).
  await client.get('/acceptance');
  const submitted = await client.post(`/acceptance/${id}/submit`, '');
  assert.strictEqual(submitted.status, 302, 'submitting redirects');

  const afterSubmit = await reader.get('/reports/revenue?month=2026-03');
  assert.match(await afterSubmit.text(), /0 accepted certificate/,
    'a SUBMITTED certificate is STILL not revenue \u2014 this is the distinction the part exists for');

  // ACCEPT (the PM's capability). An explicit March date, because the recognition screen asks about
  // a month and the certificate belongs in March.
  const pmClient = fx.clients.get('project_manager');
  await pmClient.get('/acceptance');
  const accepted = await pmClient.post(`/acceptance/${id}/accept`, 'accepted_date=2026-03-05');
  assert.strictEqual(accepted.status, 302, 'accepting redirects');

  // NOW the revenue screen must show 25% of 10,000,000 = 2,500,000.
  const final = await reader.get('/reports/revenue?month=2026-03');
  const finalHtml = await final.text();
  assert.match(finalHtml, /1 accepted certificate/,
    'the recognition screen now sees ONE accepted certificate');
  assert.match(finalHtml, /25%/, 'and the POC basis is the certificate\u2019s 25%');
  // 25% of 10,000,000 = 2,500,000, rendered through the id-ID formatter.
  assert.match(finalHtml, /2\.500\.000/,
    'and the recognised figure is 2,500,000 \u2014 the two parts are actually connected');

  // And the register's own accepted total agrees, because both read the same figure.
  const regAfter = await client.get('/acceptance');
  const regHtml = await regAfter.text();
  assert.match(regHtml, /25%/, 'the register shows the same 25%');

  // The accepted certificate offers no control to change it.
  assert.ok(!/action="\/acceptance\/\d+\/(submit|accept|reject)"/.test(regHtml),
    'an accepted certificate offers no further transition control');
});
