const express = require('express');
const router = express.Router();
const db = require('../db/db');
const q = require('../db/queries');
const { requirePage } = require('../middleware/auth');

const IDR = new Intl.NumberFormat('id-ID');
const fmt = (n) => IDR.format(n || 0);

// Resolve the current project context: ?project=N else first project.
function projectContext(req, res, next) {
  const all = q.projects();
  const sel = all.find(p => p.id === Number(req.query.project)) || all[0] || null;
  res.locals.project = sel;
  next();
}

function page(res, title, subtitle, crumb, bodyView, opts = {}) {
  res.render(bodyView, {
    layout: 'layout-app',
    title, subtitle, crumb,
    active: opts.active || '',
    actions: opts.actions || '',
    projectName: res.locals.project?.name || 'No project',
    ...opts.locals,
  });
}

router.use(requirePage, projectContext);

router.get('/', (req, res) => {
  const projects = q.projects();
  let contractValue = 0, costToDate = 0, untaggedCount = 0;
  for (const p of projects) {
    contractValue += p.contract_amount || 0;
    if (res.locals.project) {
      costToDate += q.costToDate(p.id).n;
      untaggedCount += q.untaggedCount(p.id).n;
    }
  }
  page(res, 'Dashboard', 'Portfolio overview · live', 'Portfolio / Dashboard', 'dashboard', {
    active: 'Dashboard',
    locals: {
      projects, contractValue, costToDate, untaggedCount,
      fmt,
    },
  });
});

router.get('/ledger', (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  const totals = q.totalsForProject(proj.id);
  const untagged = q.untaggedCount(proj.id).n;
  const lines = q.ledgerForProject(proj.id);
  page(res, 'Ledger', `${proj.name} · immutable entries · FY 2026`, `${proj.name} / Ledger`, 'ledger', {
    active: 'Ledger',
    actions: '<a class="btn" href="/import"><svg><use href="#i-in"/></svg>Import CSV</a><a class="btn pri" href="/ledger/entry"><svg><use href="#i-plus"/></svg>New entry</a>',
    locals: {
      lines, untaggedCount: untagged,
      saved: typeof req.query.saved !== 'undefined' ? Number(req.query.saved) : null,
      reversed: typeof req.query.reversed !== 'undefined' ? Number(req.query.reversed) : null,
      debitTotal: totals.debit_total, creditTotal: totals.credit_total,
      checkedCount: totals.checked_count, totalCount: totals.total_count,
      fmt,
    },
  });
});

const TYPES = require('../lib/ledger-builder').TYPES;

router.get('/ledger/entry',
  // Page visibility, not action permission: a Viewer may read the ledger but must
  // not be shown a form it cannot submit. (The POST is separately guarded.)
  requireCapability('canWriteLedger', 'Entering a ledger line is a Finance task.'),
  (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  res.render('entry', {
    layout: 'layout-app', title: 'New ledger entry',
    subtitle: `${proj.name} · posts a new line to the immutable ledger`,
    crumb: `${proj.name} / Ledger / New entry`, active: 'Ledger',
    actions: '', projectName: proj.name,
    defaultDate: new Date().toISOString().slice(0, 10),
    types: Object.keys(TYPES), fmt,
    flash: typeof req.query.saved !== 'undefined' || typeof req.query.dup !== 'undefined',
    dupId: typeof req.query.dup !== 'undefined' ? Number(req.query.dup) : null,
    untaggedCount: q.untaggedCount(proj.id).n,
  });
});

router.post('/ledger/entry',
  requireCapability('canWriteLedger', 'Entering a ledger line is a Finance task.'),
  (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  const { buildInsert } = require('../lib/ledger-builder');

  let row;
  try {
    row = buildInsert({
      projectId: proj.id,
      type: req.body.type || null,
      date: req.body.date,
      documentNo: req.body.document_no,
      description: req.body.description,
      side: req.body.side === 'credit' ? 'credit' : 'debit',
      amount: Number(req.body.amount),
      retainageAmount: req.body.retainage ? Number(req.body.retainage) : 0,
      paidAmount: req.body.paid ? Number(req.body.paid) : 0,
    });
  } catch (err) {
    return res.status(400).render('entry', {
      layout: 'layout-app', title: 'New ledger entry',
      subtitle: `${proj.name} · the entry was rejected`,
      crumb: `${proj.name} / Ledger / New entry`, active: 'Ledger',
      actions: '', projectName: proj.name,
      types: Object.keys(TYPES_r()), fmt,
      defaultDate: new Date().toISOString().slice(0, 10),
      error: err.message, form: req.body,
      untaggedCount: q.untaggedCount(proj.id).n,
    });
  }
  // keep a copy for audit BEFORE the insert (audit needs the pre-insert snapshot)
  const auditBefore = JSON.parse(JSON.stringify(row));
  let id;
  try {
    id = q.insertLedger(row).lastInsertRowid;
  } catch (err) {
    // schema-level integrity (money triggers, import dedupe) is the floor —
    // manual duplicates are legal (source='manual' bypasses the import dedupe
    // partial index by design); show the DB error rather than guess.
    return res.status(400).render('entry', {
      layout: 'layout-app', title: 'New ledger entry',
      subtitle: `${proj.name} · the entry was rejected`,
      crumb: `${proj.name} / Ledger / New entry`, active: 'Ledger',
      actions: '', projectName: proj.name,
      types: Object.keys(TYPES_r()), fmt,
      defaultDate: new Date().toISOString().slice(0, 10),
      error: err.message, form: req.body,
      untaggedCount: q.untaggedCount(proj.id).n,
    });
  }
  q.insertLedgerAudit(id, req.user.id, auditBefore);
  res.redirect(`/ledger?saved=${id}`);
});

function TYPES_r() { return require('../lib/ledger-builder').TYPES; }

router.get('/queue', (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  const lines = q.untaggedLines(proj.id);
  const checkedCount = q.totalsForProject(proj.id).checked_count;
  const totalCount = q.totalsForProject(proj.id).total_count;
  page(res, 'Tagging queue', `${proj.name} · every line needs a WBS + CBS tag before the cost report can freeze`,
    `${proj.name} / Tagging queue`, 'queue', {
      active: 'Tagging queue',
      locals: {
        lines, cbs: q.cbsOptions(), wbs: q.wbsOptions(proj.id),
        checkedCount, totalCount, untaggedCount: lines.length,
        fmt,
        flash: typeof req.query.tagged !== 'undefined' ? Number(req.query.tagged) : null,
      },
    });
});

// ---- correction path: a posted line is immutable; fix it by reversing it -----

// The correction screen for one line: shows the original, and either offers to
// reverse it or shows the reversal that already exists.
router.get('/ledger/:id/correct', (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  const id = Number(req.params.id);
  const found = require('../lib/ledger-correction').lineForCorrection(id);
  if (!found || found.line.project_id !== proj.id) return res.redirect('/ledger');

  res.render('correct', {
    layout: 'layout-app',
    title: 'Correct ledger line',
    subtitle: `${proj.name} · line #${id} stays on the books — a reversal cancels it`,
    crumb: `${proj.name} / Ledger / Correct #${id}`, active: 'Ledger',
    actions: '', projectName: proj.name,
    line: found.line, reversal: found.reversal, reverses: found.reverses,
    defaultDate: new Date().toISOString().slice(0, 10),
    fmt,
    untaggedCount: q.untaggedCount(proj.id).n,
  });
});

// Post the reversal. The original row is never touched.
router.post('/ledger/:id/reverse',
  requireCapability('canCorrectLedger', 'Reversing a ledger line is a Finance or Cost Controller task.'),
  (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  const id = Number(req.params.id);
  const corr = require('../lib/ledger-correction');

  const found = corr.lineForCorrection(id);
  if (!found || found.line.project_id !== proj.id) return res.redirect('/ledger');

  const renderError = (status, message) => res.status(status).render('correct', {
    layout: 'layout-app', title: 'Correct ledger line',
    subtitle: `${proj.name} · the reversal was rejected`,
    crumb: `${proj.name} / Ledger / Correct #${id}`, active: 'Ledger',
    actions: '', projectName: proj.name,
    line: found.line, reversal: found.reversal, reverses: found.reverses,
    defaultDate: new Date().toISOString().slice(0, 10),
    fmt, error: message,
    untaggedCount: q.untaggedCount(proj.id).n,
  });

  // A line may be reversed only once — this is also enforced by
  // idx_ledger_one_reversal, but checking here gives the operator a sentence
  // instead of a raw constraint error.
  if (found.reversal) {
    return renderError(409, `Line #${id} was already reversed by line #${found.reversal.id}.`);
  }

  let row;
  try {
    row = corr.buildReversal(found.line, {
      date: req.body.date || null,
      description: req.body.description || null,
      actorId: req.user.id,
    });
  } catch (err) {
    return renderError(400, err.message);
  }

  const apply = db.transaction(() => {
    const newId = q.insertLedger(row).lastInsertRowid;
    q.insertLedgerAudit(newId, req.user.id, row);
    q.audit('accounting_ledger', id, 'reverse', req.user.id,
      { reversed_by: found.line.id, amount: found.line.amount },
      { reversal_id: newId, amount: row.amount });
    return newId;
  });

  let reversalId;
  try {
    reversalId = apply();
  } catch (err) {
    // the DB guards (negation, one-reversal, money integrity) are the floor
    return renderError(409, err.message);
  }
  res.redirect(`/ledger?reversed=${reversalId}`);
});

router.get('/import',
  // Page visibility: the upload form is Finance's job. A Viewer may read the
  // ledger but must not be shown an upload widget it cannot use.
  requireCapability('canImportLedger', 'Importing the ledger is a Finance task.'),
  (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');
  page(res, 'Import ledger', `${proj.name} · fixed-template CSV from the legacy workbook — staged first, never written straight to the ledger`,
    `${proj.name} / Ledger / Import`, 'import', {
      active: 'Import',
      locals: {
        batches: q.importBatches(),
        fmt,
      },
    });
});

// Tag/check a batch of ledger lines. Only the fields the controller set are
// written; the DB triggers enforce the one-way transitions and abort tampering.
router.post('/queue/tag',
  // Marking cost as checked is what promotes a line into v_cbs_actual, i.e. into
  // the cost report. That is the Cost Controller's job and nobody else's.
  requireCapability('canTagCost', 'Checking cost lines is a Cost Controller task.'),
  (req, res) => {
  const proj = res.locals.project;
  if (!proj) return res.redirect('/');

  const ids = [].concat(req.body.line || []).map(Number).filter(Boolean);
  const cbsId = req.body.cbs ? Number(req.body.cbs) : null;
  const wbsId = req.body.wbs ? Number(req.body.wbs) : null;
  const check = req.body.check === '1';

  let tagged = 0;
  const apply = db.transaction(() => {
    for (const id of ids) {
      const before = q.untaggedLineById(id);
      // refuse lines that are not in this project or already checked
      if (!before || before.project_id !== proj.id || before.cost_checked === 1) continue;
      // need at least one real action
      if (!cbsId && !wbsId && !check) continue;

      // cost category follows the CBS account (its own default), per the master data
      const catId = cbsId ? (q.costCategoryOfAccount(cbsId)?.c ?? null) : null;

      q.tagLine(id, { cbsId, wbsId, costCategoryId: catId, check, actorId: req.user.id });
      q.insertAudit(id, req.user.id, before,
        { transaction_account_id: cbsId, wbs_node_id: wbsId, cost_category_id: catId, cost_checked: check ? 1 : before.cost_checked });
      tagged++;
    }
  });
  try {
    apply();
  } catch (err) {
    return res.status(409).render('queue', {
      layout: 'layout-app', title: 'Tagging queue',
      subtitle: `${proj.name} · the database rejected that change`,
      crumb: `${proj.name} / Tagging queue`, active: 'Tagging queue', actions: '',
      projectName: proj.name,
      lines: q.untaggedLines(proj.id), cbs: q.cbsOptions(), wbs: q.wbsOptions(proj.id),
      checkedCount: q.totalsForProject(proj.id).checked_count,
      totalCount: q.totalsForProject(proj.id).total_count,
      untaggedCount: q.untaggedLines(proj.id).length,
      fmt, flash: null, tagError: err.message,
    });
  }
  res.redirect(`/queue?tagged=${tagged}`);
});

// ---- module 5: Cash Advance + Expense Report + reconciliation -----------------
//
// The spec's rule (R2-1..R2-3): a Project Admin ENTERS the month's cash-advance
// usage lines; a Cost Controller CHECKS them (assigns/confirms CBS + WBS) and
// that check is FINAL — no Finance approval step. Only CHECKED lines feed actual
// cost (v_cbs_actual), and Finance's bulk settlement stays out of the cost basis
// so nothing is counted twice (R2-18).

const { capabilities, checkSoD } = require('../lib/permissions');

// Refuse a page the signed-in user has no role for. Renders 403 with the reason
// rather than silently hiding the link.
function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: '',
        projectName: res.locals.project?.name || 'No project',
        untaggedCount: res.locals.project ? q.untaggedCount(res.locals.project.id).n : 0,
      });
    }
    req.caps = caps;
    next();
  };
}

router.get('/advances', requireCapability('canViewExpense', 'Cash advances are visible to the Project Admin, the Cost Controller and Finance.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const advances = q.advancesForProject(proj.id);
    const openAmount = advances
      .filter((a) => a.status === 'open' || a.status === 'settling')
      .reduce((s, a) => s + (a.unreported_amount || 0), 0);
    page(res, 'Cash advances', `${proj.name} · money handed out for project expenses · one pot per project`,
      `${proj.name} / Cash advances`, 'advances', {
        active: 'Cash advances',
        actions: req.caps.canOpenAdvance
          ? '<a class="btn pri" href="/advances/new"><svg><use href="#i-plus"/></svg>New cash advance</a>' : '',
        locals: {
          advances, openAmount, summary: q.lpbSummary(proj.id),
          caps: req.caps, fmt,
          saved: typeof req.query.saved !== 'undefined' ? Number(req.query.saved) : null,
        },
      });
  });

router.get('/advances/new', requireCapability('canOpenAdvance', 'Only a Project Admin, PM or Finance can open a cash advance.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    page(res, 'New cash advance', `${proj.name} · opens a pot that Expense Report lines are reported against`,
      `${proj.name} / Cash advances / New`, 'advance-new', {
        active: 'Cash advances',
        locals: { defaultDate: new Date().toISOString().slice(0, 10), fmt },
      });
  });

router.post('/advances', requireCapability('canOpenAdvance', 'Only a Project Admin, PM or Finance can open a cash advance.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const amount = Number(req.body.amount);
    const renderErr = (msg, status = 400) => res.status(status).render('advance-new', {
      layout: 'layout-app', title: 'New cash advance',
      subtitle: `${proj.name} · the cash advance was rejected`,
      crumb: `${proj.name} / Cash advances / New`, active: 'Cash advances', actions: '',
      projectName: proj.name, defaultDate: new Date().toISOString().slice(0, 10),
      fmt, error: msg, form: req.body,
      untaggedCount: q.untaggedCount(proj.id).n,
    });

    if (!Number.isInteger(amount) || amount === 0) {
      return renderErr('Amount must be a non-zero whole rupiah figure.');
    }
    const recipientType = ['employee', 'project_admin', 'supplier'].includes(req.body.recipient_type)
      ? req.body.recipient_type : null;

    let id;
    try {
      id = q.insertAdvance({
        project_id: proj.id,
        advance_no: req.body.advance_no || null,
        recipient_type: recipientType,
        amount,
        submission_date: req.body.submission_date || null,
        approved_date: req.body.approved_date || null,
        issued_date: req.body.issued_date || req.body.approved_date || null,
        description: req.body.description || null,
        currency: 'IDR',
        status: 'open',
      }).lastInsertRowid;
    } catch (err) {
      // the money-integrity trigger is the floor
      return renderErr(err.message, 409);
    }
    q.audit('cash_advance', id, 'create', req.user.id, null,
      { project_id: proj.id, amount, advance_no: req.body.advance_no || null });
    res.redirect(`/advances/${id}?saved=1`);
  });

// One pot + its Expense Report detail. The entry form is shown to the roles that
// may enter; the check controls to the roles that may check.
router.get('/advances/:id', requireCapability('canViewExpense', 'Cash advances are visible to the Project Admin, the Cost Controller and Finance.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const adv = q.advanceById(Number(req.params.id));
    if (!adv || adv.project_id !== proj.id) return res.redirect('/advances');
    const lines = q.lpbLinesForAdvance(adv.id);
    page(res, `Cash advance ${adv.advance_no || '#' + adv.id}`,
      `${proj.name} · ${adv.description || 'advance pot'} · Expense Report detail`,
      `${proj.name} / Cash advances / ${adv.advance_no || '#' + adv.id}`, 'advance', {
        active: 'Cash advances',
        locals: {
          adv, lines, caps: req.caps, fim: fmt,
          cbs: q.cbsOptions(), wbs: q.wbsOptions(proj.id),
          defaultDate: new Date().toISOString().slice(0, 10),
          total: lines.reduce((s, l) => s + Math.abs(l.amount), 0),
          draftCount: lines.filter((l) => l.status === 'draft').length,
          // Lines waiting on a human: returned to the enterer, or blocked on a
          // missing code. Both need chasing, so both are surfaced.
          returned: lines.filter((l) => l.status === 'rejected' && !l.superseded_by),
          blockedCount: lines.filter((l) => l.status === 'blocked').length,
          saved: typeof req.query.saved !== 'undefined',
          error: typeof req.query.error !== 'undefined' ? req.query.error : null,
          flash: typeof req.query.checked !== 'undefined' ? Number(req.query.checked) : null,
          fmt,
        },
      });
  });

// ENTER a usage line (Project Admin side). Lines land as draft; they contribute
// nothing to actual cost until a Cost Controller checks them.
router.post('/advances/:id/lines', requireCapability('canEnterExpense', 'Only a Project Admin or PM can enter Expense Report lines.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const adv = q.advanceById(Number(req.params.id));
    if (!adv || adv.project_id !== proj.id) return res.redirect('/advances');

    const fail = (msg) => res.redirect(`/advances/${adv.id}?error=${encodeURIComponent(msg)}`);

    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount === 0) return fail('Amount must be a non-zero whole rupiah figure.');
    const side = req.body.side === 'credit' ? 'credit' : 'debit';
    const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);

    try {
      const id = q.insertLpbLine({
        cash_advance_id: adv.id,
        project_id: proj.id,
        lpb_no: req.body.lpb_no || adv.advance_no || null,
        period_month: entryDate.slice(0, 7),
        entry_date: entryDate,
        description: req.body.description || null,
        debit: side === 'debit' ? amount : 0,
        credit: side === 'credit' ? amount : 0,
        amount: side === 'debit' ? amount : -amount,
        currency: 'IDR',
        // The Cost Controller assigns the codes at check time; a Project Admin may
        // propose them but the check is what makes them count.
        transaction_account_id: req.body.cbs ? Number(req.body.cbs) : null,
        wbs_node_id: req.body.wbs ? Number(req.body.wbs) : null,
        status: 'draft',
        created_by: req.user.id,
      }).lastInsertRowid;
      q.audit('lpb', id, 'create', req.user.id, null,
        { advance_id: adv.id, amount, entry_date: entryDate, status: 'draft' });

      // If this line corrects a returned one, link the pair. A rejection is final,
      // so the fix always arrives as a new line; without this the returned line
      // sits forever looking unresolved.
      const replaces = Number(req.body.replaces || 0);
      if (replaces) {
        const old = q.lpbLineById(replaces);
        if (old && old.project_id === proj.id && q.supersedeLpbLine(old.id, id, proj.id).changes === 1) {
          q.audit('lpb', old.id, 'supersede', req.user.id,
            { status: old.status }, { superseded_by: id });
        }
      }
    } catch (err) {
      return fail(err.message);
    }
    res.redirect(`/advances/${adv.id}?saved=1`);
  });

// CHECK a line (Cost Controller side) — the final act that rolls it into cost.
// Separation of duties: the enterer cannot be the checker.
router.post('/expenses/:lineId/check', requireCapability('canCheckExpense', 'Only a Cost Controller can check an Expense Report line.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const line = q.lpbLineById(Number(req.params.lineId));
    if (!line || line.project_id !== proj.id) return res.redirect('/advances');

    const back = `/advances/${line.cash_advance_id}`;
    const fail = (msg) => res.redirect(`${back}?error=${encodeURIComponent(msg)}`);

    // SoD is checked here AND the DB refuses an uncheckered/double check.
    const sod = checkSoD({ line, actorId: req.user.id, caps: req.caps });
    if (sod) return fail(sod);
    if (line.status !== 'draft') return fail(`Line #${line.id} is already ${line.status}.`);

    // The Cost Controller confirms the codes as part of the check.
    const cbsId = req.body.cbs ? Number(req.body.cbs) : line.transaction_account_id;
    const wbsId = req.body.wbs ? Number(req.body.wbs) : line.wbs_node_id;
    if (!cbsId) return fail('A Cost Controller must assign a CBS account before the line can be checked.');

    try {
      const apply = db.transaction(() => {
        if (cbsId !== line.transaction_account_id || wbsId !== line.wbs_node_id) {
          q.setLpbCodes(cbsId, wbsId ?? null, line.id);
        }
        const r = q.checkLpbLine(line.id, req.user.id);
        if (r.changes !== 1) throw new Error('the line was already checked by someone else');
        q.audit('lpb', line.id, 'check', req.user.id,
          { status: line.status, transaction_account_id: line.transaction_account_id, wbs_node_id: line.wbs_node_id },
          { status: 'checked', transaction_account_id: cbsId, wbs_node_id: wbsId ?? null });
      });
      apply();
    } catch (err) {
      return fail(err.message);
    }
    res.redirect(`${back}?checked=1`);
  });

// Reject a draft line with a reason, so the enterer knows why.
router.post('/expenses/:lineId/reject', requireCapability('canCheckExpense', 'Only a Cost Controller can reject an Expense Report line.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const line = q.lpbLineById(Number(req.params.lineId));
    if (!line || line.project_id !== proj.id) return res.redirect('/advances');
    const back = `/advances/${line.cash_advance_id}`;
    const reason = String(req.body.reason || '').trim();
    const sod = checkSoD({ line, actorId: req.user.id, caps: req.caps });
    if (sod) return res.redirect(`${back}?error=${encodeURIComponent(sod)}`);
    if (line.status !== 'draft') return res.redirect(`${back}?error=${encodeURIComponent(`Line #${line.id} is already ${line.status}.`)}`);
    if (!reason) return res.redirect(`${back}?error=${encodeURIComponent('A rejection needs a reason.')}`);

    q.rejectLpbLine(line.id, reason, req.user.id);
    q.audit('lpb', line.id, 'reject', req.user.id, { status: 'draft' }, { status: 'rejected', reason });
    res.redirect(`${back}?saved=1`);
  });

// BLOCK a draft the project cannot book yet. Not a rejection: the line is fine,
// the project is missing the code it needs. Stays visible and is reversible.
router.post('/expenses/:lineId/block', requireCapability('canCheckExpense', 'Only a Cost Controller can block an Expense Report line.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const line = q.lpbLineById(Number(req.params.lineId));
    if (!line || line.project_id !== proj.id) return res.redirect('/advances');
    const back = `/advances/${line.cash_advance_id}`;
    const fail = (msg) => res.redirect(`${back}?error=${encodeURIComponent(msg)}`);
    const reason = String(req.body.reason || '').trim();

    const sod = checkSoD({ line, actorId: req.user.id, caps: req.caps });
    if (sod) return fail(sod);
    if (line.status !== 'draft') return fail(`Line #${line.id} is already ${line.status}.`);
    if (!reason) return fail('A block needs a reason — say what the project is missing.');

    q.blockLpbLine(line.id, reason, req.user.id);
    q.audit('lpb', line.id, 'block', req.user.id, { status: 'draft' }, { status: 'blocked', reason });
    res.redirect(`${back}?saved=1`);
  });

// CLEAR a block: the missing code now exists, so the line goes back to draft and
// can be checked normally. This is what makes blocked different from rejected —
// one is final, the other is a pause.
router.post('/expenses/:lineId/unblock', requireCapability('canCheckExpense', 'Only a Cost Controller can clear a block.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const line = q.lpbLineById(Number(req.params.lineId));
    if (!line || line.project_id !== proj.id) return res.redirect('/advances');
    const back = `/advances/${line.cash_advance_id}`;
    if (line.status !== 'blocked') {
      return res.redirect(`${back}?error=${encodeURIComponent(`Line #${line.id} is ${line.status}, not blocked.`)}`);
    }
    const r = q.unblockLpbLine(line.id);
    if (r.changes !== 1) {
      return res.redirect(`${back}?error=${encodeURIComponent('the line could not be returned to draft')}`);
    }
    q.audit('lpb', line.id, 'unblock', req.user.id,
      { status: 'blocked', reason: line.block_reason }, { status: 'draft' });
    res.redirect(`${back}?saved=1`);
  });

// All Expense Report detail of the project, one list (the "Expense reports" nav).
router.get('/expenses', requireCapability('canViewExpense', 'Expense Report detail is visible to the Project Admin, the Cost Controller and Finance.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    page(res, 'Expense reports', `${proj.name} · cash-advance usage entered line by line · only CHECKED lines become actual cost`,
      `${proj.name} / Expense reports`, 'expenses', {
        active: 'Expense reports',
        locals: {
          lines: q.lpbLinesForProject(proj.id), summary: q.lpbSummary(proj.id),
          // Blocked + returned lines: real work waiting on a human, and neither
          // counts as cost. Listed here so a parked line cannot go unnoticed.
          stalled: q.lpbStalled(proj.id),
          caps: req.caps, fmt,
        },
      });
  });

// R2-19: Finance's bulk settlement vs the detail lines, and the alarm when there
// is no detail at all for a settlement Finance already booked.
router.get('/reconciliation', requireCapability('canReconcile', 'Reconciliation is visible to Finance and the Cost Controller.'),
  (req, res) => {
    const proj = res.locals.project;
    if (!proj) return res.redirect('/');
    const rows = q.reconciliation(proj.id);
    page(res, 'Reconciliation', `${proj.name} · Finance bulk settlement vs Project Admin detail, per Expense Report`,
      `${proj.name} / Reconciliation`, 'reconciliation', {
        active: 'Reconciliation',
        locals: {
          rows, fmt,
          balanced: rows.filter((r) => r.status === 'balanced').length,
          differing: rows.filter((r) => r.status === 'difference').length,
          missing: rows.filter((r) => r.status === 'missing_detail').length,
          awaiting: rows.filter((r) => r.status === 'awaiting_settlement').length,
        },
      });
  });

module.exports = router;
