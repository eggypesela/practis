// WBS tree screens (module 7, plan part 7.1; PRD §4.4, §5.1).
//
// Project-scoped: the tree belongs to the project the scope middleware resolved, so
// every query here is filtered by `res.locals.project.id`. A WBS code is only
// unique WITHIN a project, so reading one without the project filter would mix two
// projects' trees.
//
// Refusals a user should be told about use the redirect-with-message idiom
// (`?err=…`), matching the master-data screens; a genuinely invalid request is a
// 400/403/404. Errors carry their own status from the service so a refusal can
// never be silently reported as success.
'use strict';

const express = require('express');
const router = express.Router();

const svc = require('../lib/wbs-service');
const svc2 = require('../lib/progress-service');
const q = require('../db/queries');
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

// An array (not '/wbs/{*path}') because Express 5's wildcard form silently drops
// the guard on the bare prefix — same reasoning as routes/projects.js.
router.use(['/wbs'], requirePage);
router.use(['/wbs'], projectContext);

function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'WBS',
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
    active: 'WBS',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    ...locals,
  });
}

const msg = (s) => encodeURIComponent(String(s).slice(0, 200));
const str = (v) => (typeof v === 'string' ? v : '');

function projectOf(res) {
  const p = res.locals.project;
  if (!p) {
    const e = new svc.WbsError('No project is in scope for your account.', 403);
    throw e;
  }
  return p;
}

// GET /wbs — the tree, its change history, and the master codes a new line may use
router.get('/wbs', (req, res) => {
  const project = projectOf(res);
  const caps = capabilities(req.user);
  const { lines, versions, counts } = svc.tree(project.id);

  // Loaded per line rather than in one flat query so the view does not have to
  // group — a mistake there would show one line's milestones under another line.
  for (const l of lines) l.milestones = svc.milestones(l.id);

  return page(res, 'WBS tree', `${project.name} · work breakdown, versions and milestones`,
    `${project.name} / WBS`, 'wbs', {
      lines, versions, counts,
      masterCodes: q.wbsMasterCodes(),
      history: svc.changeHistory(project.id),
      notice: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
      error: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : null,
      canManage: !!caps.canManageWbs,
    });
});

// A single place that turns a service error into the right response, so no route
// can accidentally report a refusal as success.
//
// Deliberately keys on the error's own 4xx `status` rather than an `instanceof`
// check: this route already calls two services (wbs-service, progress-service) and
// an instanceof list silently turns the second one's refusals into "Something went
// wrong" 500s — which is exactly what happened on the first run. Any service that
// carries a 4xx status is a REFUSAL and its message is meant for the user; anything
// else is a bug, and its message is NOT leaked.
function fail(res, err, back = '/wbs') {
  const userFacing = typeof err.status === 'number' && err.status >= 400 && err.status < 500;
  if (!userFacing) {
    console.error('[wbs]', err);
    return res.status(500).redirect(`${back}?err=${msg('Something went wrong; nothing was changed.')}`);
  }
  return res.redirect(`${back}?err=${msg(err.message)}`);
}

const guard = requireCapability('canManageWbs', 'Maintaining the WBS is the Project Controller’s job.');

router.post('/wbs/lines', guard, (req, res) => {
  const project = projectOf(res);
  try {
    svc.addLine({
      projectId: project.id, actorId: req.user.id,
      wbs_code: str(req.body.wbs_code), name: str(req.body.name),
      parentId: str(req.body.parent_id) === '' ? null : str(req.body.parent_id),
      delta: str(req.body.contract_value_delta), reason: str(req.body.reason),
    });
    return res.redirect('/wbs?msg=' + msg(`${str(req.body.wbs_code)} ${str(req.body.name)} added.`));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/lines/:id/rename', guard, (req, res) => {
  const project = projectOf(res);
  try {
    svc.renameLine({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id),
      patch: { name: str(req.body.name) },
      reason: str(req.body.reason), delta: str(req.body.contract_value_delta),
    });
    return res.redirect('/wbs?msg=' + msg('Line renamed; the previous version is kept in history.'));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/lines/:id/reparent', guard, (req, res) => {
  const project = projectOf(res);
  try {
    svc.reparentLine({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id),
      patch: { parent_id: str(req.body.parent_id) },
      reason: str(req.body.reason), delta: str(req.body.contract_value_delta),
    });
    return res.redirect('/wbs?msg=' + msg('Line moved; the previous version is kept in history.'));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/lines/:id/split', guard, (req, res) => {
  const project = projectOf(res);
  try {
    svc.splitLine({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id),
      newCode: str(req.body.new_code), newName: str(req.body.new_name),
      endDate: str(req.body.end_date) || null,
      reason: str(req.body.reason), delta: str(req.body.contract_value_delta),
    });
    return res.redirect('/wbs?msg=' + msg('Line split; both halves are in the tree.'));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/lines/:id/status', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const node = svc.setStatus({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id),
      status: str(req.body.status), reason: str(req.body.reason),
    });
    return res.redirect('/wbs?msg=' + msg(`${node.wbs_code} is now ${str(req.body.status)}.`));
  } catch (err) { return fail(res, err); }
});

// ---------------------------------------------------------------------------
// progress (part 7.2) — ticking milestones is how a line reports as progressed.
//
// Every one of these re-derives the PERIOD's figure from the milestone set rather
// than accepting a percentage from the form. The browser must not be able to state
// progress directly, or the number feeding `ev` would be whatever was posted.
// ---------------------------------------------------------------------------

router.post('/wbs/milestones/:id/tick', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc2.setMilestoneTick({
      projectId: project.id, actorId: req.user.id, milestoneId: Number(req.params.id),
      ticked: true, period: str(req.body.period), note: str(req.body.note),
    });
    return res.redirect('/wbs?msg=' + msg(
      `Progress reported for ${str(req.body.period)}: ${out.pct_complete}% earned in the period.`));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/milestones/:id/untick', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc2.setMilestoneTick({
      projectId: project.id, actorId: req.user.id, milestoneId: Number(req.params.id),
      ticked: false, period: str(req.body.period), note: str(req.body.note),
    });
    return res.redirect('/wbs?msg=' + msg(
      `Milestone unticked; ${str(req.body.period)} now reports ${out.pct_complete}% for the period.`));
  } catch (err) { return fail(res, err); }
});

// An explicit "report this line for this period" action, so a line with NOTHING
// ticked can still be reported as zero — "nobody has reported" and "reported as
// nothing done" are different facts and `ev` should be able to tell them apart.
router.post('/wbs/lines/:id/progress', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc2.writePeriod({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id),
      period: str(req.body.period),
    });
    return res.redirect('/wbs?msg=' + msg(
      `${str(req.body.period)} recorded: ${out.pct_complete}% for the period.`));
  } catch (err) { return fail(res, err); }
});

router.post('/wbs/lines/:id/weights', guard, (req, res) => {
  const project = projectOf(res);
  try {
    const weights = str(req.body.weights).split(',').map((w) => w.trim()).filter((w) => w !== '');
    svc2.setMilestoneWeights({
      projectId: project.id, actorId: req.user.id, nodeId: Number(req.params.id), weights,
    });
    return res.redirect('/wbs?msg=' + msg('Milestone weights updated.'));
  } catch (err) { return fail(res, err); }
});

module.exports = router;
