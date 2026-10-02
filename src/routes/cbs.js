// Cost baseline screens (module 7, plan part 7.4; PRD §5.1, §6).
//
// Project-scoped like the WBS tree and the resource plan. The baseline is the approved
// plan in money per month — it is what `v_evm_period.pv` reads, so it is the denominator
// of every SPI.
//
// Same structure as routes/rbs.js: `page()`, the local `requireCapability`, the
// redirect-with-message refusal idiom, and one `fail()` per router.
'use strict';

const express = require('express');
const router = express.Router();

const svc = require('../lib/cbs-service');
const q = require('../db/queries');
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

router.use(['/cbs'], requirePage);
router.use(['/cbs'], projectContext);

function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'Budget',
        projectName: res.locals.project?.name || 'No project',
      });
    }
    req.caps = caps;
    next();
  };
}

function page(res, title, subtitle, crumb, bodyView, locals = {}) {
  res.render(bodyView, {
    layout: 'layout-app',
    title, subtitle, crumb,
    active: 'Budget',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    ...locals,
  });
}

const msg = (s) => encodeURIComponent(String(s).slice(0, 220));
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function projectOf(res) {
  const p = res.locals.project;
  if (!p) throw new svc.CbsError('No project is in scope for your account.', 403);
  return p;
}

function fail(res, err, back = '/cbs') {
  const userFacing = typeof err.status === 'number' && err.status >= 400 && err.status < 500;
  if (!userFacing) {
    console.error('[cbs]', err);
    return res.status(500).redirect(`${back}?err=${msg('Something went wrong; nothing was changed.')}`);
  }
  return res.redirect(`${back}?err=${msg(err.message)}`);
}

// Setting the budget is the Cost Controller's job (PRD §4.4), and the PM may do it too.
const guard = requireCapability('canManageCbs', 'Setting the budget is the Cost Controller’s job.');

// GET /cbs — the baseline, and every account reconciled against its resource plan.
router.get('/cbs', (req, res) => {
  const project = projectOf(res);
  const caps = capabilities(req.user);
  const recon = svc.reconciliation(project.id);
  const unbalanced = recon.filter((r) => r.rbs_total !== r.budget);

  return page(res, 'Cost baseline',
    `${project.name} · the approved plan in money per month, and each account reconciled`,
    `${project.name} / Cost baseline`, 'cbs', {
      recon,
      unbalanced,
      buckets: svc.buckets(project.id),
      by_month: svc.byMonth(project.id),
      baseline_total: svc.baselineTotal(project.id),
      wbs_lines: q.wbsOptions(project.id),
      accounts: q.transactionAccounts(),
      canManage: !!caps.canManageCbs,
      notice: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 220) : null,
      error: typeof req.query.err === 'string' ? req.query.err.slice(0, 220) : null,
    });
});

// Enter the months by hand. `amount` arrives as a repeated field paired with `month`.
router.post('/cbs/spread', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const months = [].concat(req.body.period_month || []).map((m, i) => ({
      period_month: str(m),
      amount: str([].concat(req.body.amount || [])[i]),
    })).filter((m) => m.period_month !== '' || m.amount !== '');

    const out = svc.spreadBaseline({
      projectId: project.id,
      accountId: Number(req.body.transaction_account_id),
      wbsNodeId: Number(req.body.wbs_node_id),
      months,
      actorId: req.user.id,
      note: str(req.body.note) || null,
    });
    const fmt = (n) => Number(n).toLocaleString('en-US');
    return res.redirect('/cbs?msg=' + msg(
      `Spread ${fmt(out.rows.reduce((s, r) => s + r.amount, 0))} across `
      + `${out.rows.length} month${out.rows.length === 1 ? '' : 's'} on `
      + `${out.account.code} ${out.account.name}. It now agrees with the resource plan.`));
  } catch (err) { return fail(res, err); }
});

// Straight-line spread over the line's own dates. The service refuses a line with no
// dates, and refuses milestone-weighting by name rather than quietly straight-lining.
router.post('/cbs/auto', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const auto = svc.autoSpread({
      projectId: project.id,
      nodeId: Number(req.body.wbs_node_id),
      amount: str(req.body.amount),
      method: str(req.body.method) || 'straight',
    });
    const out = svc.spreadBaseline({
      projectId: project.id,
      accountId: Number(req.body.transaction_account_id),
      wbsNodeId: Number(req.body.wbs_node_id),
      months: auto.months,
      actorId: req.user.id,
      note: 'straight-line spread',
    });
    const fmt = (n) => Number(n).toLocaleString('en-US');
    return res.redirect('/cbs?msg=' + msg(
      `Spread ${fmt(auto.total)} straight-line across ${auto.count} months `
      + `(${auto.months[0].period_month} to ${auto.months[auto.months.length - 1].period_month}) `
      + `on ${out.account.code} ${out.account.name}.`));
  } catch (err) { return fail(res, err); }
});

module.exports = router;
