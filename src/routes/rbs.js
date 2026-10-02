// Resource plan screens (module 7, plan part 7.3; PRD §5.1).
//
// Project-scoped, mounted like the WBS tree: the plan belongs to the project the
// scope middleware resolved, and every query is filtered by it. `rbs_load` rows
// carry a project_id, so reading without that filter would mix two projects' plans
// and make the total meaningless.
//
// The form posts RATE and QUANTITY only. The total is multiplied and stored by the
// service, so a posted total cannot become a second, unchecked source of truth for
// money.
//
// Same structure as routes/wbs.js — `page()`, the local `requireCapability`, the
// redirect-with-message refusal idiom, and one `fail()` per router.
'use strict';

const express = require('express');
const router = express.Router();

const svc = require('../lib/rbs-service');
const q = require('../db/queries');
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

// An array (not '/rbs/{*path}') because Express 5's wildcard form silently drops
// the guard on the bare prefix — same reasoning as routes/wbs.js.
router.use(['/rbs'], requirePage);
router.use(['/rbs'], projectContext);

function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'Resource plan',
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
    active: 'Resource plan',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    ...locals,
  });
}

const msg = (s) => encodeURIComponent(String(s).slice(0, 200));
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const numOrNull = (v) => (str(v) === '' ? null : Number(str(v)));

function projectOf(res) {
  const p = res.locals.project;
  if (!p) throw new svc.RbsError('No project is in scope for your account.', 403);
  return p;
}

// One error path, keyed on the service's own 4xx status. Deliberately NOT an
// `instanceof` list: this router calls one service today, but the wbs router's
// first version showed how quietly that breaks when a second one arrives — every
// refusal becomes a generic 500 while the rules work perfectly.
function fail(res, err, back = '/rbs') {
  const userFacing = typeof err.status === 'number' && err.status >= 400 && err.status < 500;
  if (!userFacing) {
    console.error('[rbs]', err);
    return res.status(500).redirect(`${back}?err=${msg('Something went wrong; nothing was changed.')}`);
  }
  return res.redirect(`${back}?err=${msg(err.message)}`);
}

// Writing the plan is the Project Controller's job (PRD §4.4: the plan is theirs to
// make). Reading it is not restricted — a plan is not confidential.
const guard = requireCapability('canManageWbs', 'Maintaining the resource plan is the Project Controller’s job.');

// GET /rbs — the plan and its total.
router.get('/rbs', (req, res) => {
  const project = projectOf(res);
  const caps = capabilities(req.user);
  const rows = svc.loadFor(project.id);

  return page(res, 'Resource plan', `${project.name} · what each line will consume, and its expected cost`,
    `${project.name} / Resource plan`, 'rbs', {
      rows,
      plan_total: svc.planTotal(project.id),
      resources: svc.resourceList(),
      accounts: q.transactionAccounts(),
      wbs_lines: q.wbsOptions(project.id),
      canManage: !!caps.canManageWbs,
      notice: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
      error: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : null,
    });
});

// Add or change a plan line. Choosing a line + resource + account that is already
// planned UPDATES it as a new version rather than adding a second row, so the plan
// total cannot silently double.
router.post('/rbs/load', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc.addLoad({
      projectId: project.id,
      actorId: req.user.id,
      wbsNodeId: Number(req.body.wbs_node_id),
      rbsCode: str(req.body.rbs_code),
      accountId: numOrNull(req.body.transaction_account_id),
      description: str(req.body.description) || null,
      rate: str(req.body.rate),
      units: str(req.body.units),
      unitLabel: str(req.body.unit_label) || null,
    });
    const amount = Number(out.total_amount).toLocaleString('en-US');
    return res.redirect('/rbs?msg=' + msg(out.created
      ? `Planned ${str(req.body.rbs_code)} on that line: ${amount} IDR.`
      : `Plan line updated to version ${out.version}: ${amount} IDR.`));
  } catch (err) { return fail(res, err); }
});

// Withdrawing a plan line writes a version with zero quantity rather than deleting
// the row: the total drops out, and the fact that it WAS planned and then withdrawn
// stays readable. Nothing is ever deleted (PRD §4.4).
router.post('/rbs/load/clear', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc.editLoad({
      projectId: project.id,
      actorId: req.user.id,
      wbsNodeId: Number(req.body.wbs_node_id),
      rbsCode: str(req.body.rbs_code),
      accountId: numOrNull(req.body.transaction_account_id),
      rate: 0, units: 0,
    });
    return res.redirect('/rbs?msg=' + msg(
      `Plan line withdrawn at version ${out.version}. The earlier figure is still readable.`));
  } catch (err) { return fail(res, err); }
});

module.exports = router;
