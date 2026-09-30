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

router.get('/ledger/entry', (req, res) => {
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

router.post('/ledger/entry', (req, res) => {
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
router.post('/ledger/:id/reverse', (req, res) => {
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

router.get('/import', (req, res) => {
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
router.post('/queue/tag', (req, res) => {
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
      const catId = cbsId ? (db.prepare('SELECT cost_category_id c FROM transaction_accounts WHERE id = ?').get(cbsId)?.c || null) : null;

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

module.exports = router;
