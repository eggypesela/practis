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
function fail(res, err, back = '/wbs') {
  const status = err instanceof svc.WbsError ? err.status : 500;
  if (status >= 500) {
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

module.exports = router;
