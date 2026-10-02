// Baseline freeze + BCR screens (module 7, plan part 7.6).
//
// Two screens, one register:
//   GET  /bcr          the register, the freeze state, and the moves each request allows
//   GET  /bcr/new      raise a change request
//   POST /bcr          raise it
//   POST /bcr/:id/verify|approve|reject|withdraw
//   POST /projects/:id/baseline/freeze
//
// Same shape as routes/cbs.js and routes/rbs.js: a local `requireCapability`, the
// redirect-with-message refusal idiom, and one `fail()` per router. A ROLE refusal
// renders the 403 page; a FORM-rule refusal (bad month, wrong state) redirects with
// ?err= and the database is unchanged either way.
'use strict';

const express = require('express');
const router = express.Router();

const svc = require('../lib/bcr-service');
const cbs = require('../lib/cbs-service');
const rbs = require('../lib/rbs-service');
const q = require('../db/queries');
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

router.use(['/bcr'], requirePage);
router.use(['/bcr'], projectContext);

function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'Change requests',
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
    active: 'Change requests',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    ...locals,
  });
}

const msg = (s) => encodeURIComponent(String(s).slice(0, 220));
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function projectOf(res) {
  const p = res.locals.project;
  if (!p) throw new svc.BcrError('No project is in scope for your account.', 403);
  return p;
}

function fail(res, err, back = '/bcr') {
  const userFacing = typeof err.status === 'number' && err.status >= 400 && err.status < 500;
  if (!userFacing) {
    console.error('[bcr]', err);
    return res.status(500).redirect(`${back}?err=${msg('Something went wrong; nothing was changed.')}`);
  }
  return res.redirect(`${back}?err=${msg(err.message)}`);
}

// Raising a request is the Project/Cost Controller's job; the PM is included because
// they are the one who approves it, and the SoD check is what stops them approving
// their own (PRD §4.4 step 1).
const canRaise = requireCapability('canInitiateBcr',
  'Raising a change request is a Project Controller, Cost Controller or Project Manager task.');

// The freeze itself is the PM's alone — and NOT an Administrator's (PRD §4.2 step 4).
const canFreeze = requireCapability('canApproveBaseline',
  'Approving a baseline is the Project Manager’s decision. An Administrator does not approve baselines.');

// The register. Reads `v_evm_period` so the freeze card can say what freezing will lock in.
router.get('/bcr', (req, res) => {
  const project = projectOf(res);
  const caps = capabilities(req.user);
  const rows = svc.listFor(project.id);
  const stale = svc.staleFor(project.id);
  const staleIds = new Set(stale.map((s) => s.id));

  return page(res, 'Change requests',
    `${project.name} · every change to the frozen baseline, and where each one stands`,
    `${project.name} / Change requests`, 'bcr', {
      rows: rows.map((r) => ({
        ...r,
        type_label: svc.TYPE_LABEL[r.change_type] || r.change_type,
        allowed: svc.ALLOWED[r.status] || [],
        stale: staleIds.has(r.id),
        impact: Number(r.impact_cost || 0),
        proposed: r.new_baseline_json ? JSON.parse(r.new_baseline_json).length : 0,
        resource_rows: r.rbs_rows_json ? JSON.parse(r.rbs_rows_json).length : 0,
      })),
      pending: svc.pendingFor(project.id),
      // Also handed to the sidebar badge, which is on every page in the app. Passed
      // explicitly rather than queried in the partial.
      pendingBcr: svc.pendingFor(project.id),
      project,
      can_freeze: !!caps.canApproveBaseline,
      can_raise: !!caps.canInitiateBcr,
      can_verify: !(caps.roles.length > 0
        && caps.roles.every((r) => ['viewer', 'human_capital'].includes(r))),
      // What freezing would lock in, so the card can name the figure rather than say
      // "the baseline" and leave the operator to guess which number that is.
      baseline_total: cbs.baselineTotal(project.id),
      month_count: cbs.byMonth(project.id).length,
      notice: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 220) : null,
      error: typeof req.query.err === 'string' ? req.query.err.slice(0, 220) : null,
    });
});

router.get('/bcr/new', canRaise, (req, res) => {
  const project = projectOf(res);
  return page(res, 'Raise a change request',
    `${project.name} · what is changing, why, and from which month`,
    `${project.name} / Change requests / New`, 'bcr-new', {
      project,
      types: svc.CHANGE_TYPES.map((t) => ({ code: t, label: svc.TYPE_LABEL[t] })),
      lines: q.wbsOptions(project.id),
      accounts: q.transactionAccounts(),
      resources: rbs.resourceList(),
      error: typeof req.query.err === 'string' ? req.query.err.slice(0, 220) : null,
    });
});

// Repeated-field parsing: the form pairs `month`/`account`/`node`/`amount` by index, and
// `r_rbs_code`/`r_rate`/`r_units`/`r_account`/`r_node` likewise. A blank line is skipped,
// so the operator fills in as many rows as the change needs rather than a fixed number.
function repeat(body, key) {
  return [].concat(body[key] === undefined ? [] : body[key]);
}

function monthRows(body) {
  const months = repeat(body, 'month');
  const accounts = repeat(body, 'account');
  const nodes = repeat(body, 'node');
  const amounts = repeat(body, 'amount');
  const out = [];
  for (let i = 0; i < months.length; i += 1) {
    const m = str(months[i]); const a = str(accounts[i]);
    const n = str(nodes[i]); const amt = str(amounts[i]);
    if (m === '' && a === '' && n === '' && amt === '') continue;
    out.push({ period_month: m, transaction_account_id: a, wbs_node_id: n, amount: amt });
  }
  return out;
}

function resourceRows(body) {
  const codes = repeat(body, 'r_rbs_code');
  const rates = repeat(body, 'r_rate');
  const units = repeat(body, 'r_units');
  const accounts = repeat(body, 'r_account');
  const nodes = repeat(body, 'r_node');
  const labels = repeat(body, 'r_unit_label');
  const out = [];
  for (let i = 0; i < codes.length; i += 1) {
    const code = str(codes[i]);
    if (code === '') continue;
    out.push({
      rbs_code: code,
      rate: str(rates[i]) === '' ? 0 : str(rates[i]),
      units: str(units[i]) === '' ? 0 : str(units[i]),
      transaction_account_id: str(accounts[i]),
      wbs_node_id: str(nodes[i]),
      unit_label: str(labels[i]),
    });
  }
  return out;
}

router.post('/bcr', canRaise, (req, res) => {
  const project = projectOf(res);
  try {
    const out = svc.initiateBcr({
      projectId: project.id,
      actorId: req.user.id,
      caps: req.caps,
      changeType: str(req.body.change_type),
      wbsNodeId: str(req.body.wbs_node_id) || null,
      title: str(req.body.title),
      description: str(req.body.description) || null,
      reason: str(req.body.reason) || null,
      impactCost: str(req.body.impact_cost) || 0,
      impactScheduleDays: str(req.body.impact_schedule_days) || null,
      effectivePeriod: str(req.body.effective_period),
      proposedRows: monthRows(req.body),
      rbsRows: resourceRows(req.body),
    });
    return res.redirect('/bcr?msg=' + msg(
      `${out.bcr_no} recorded. It is a draft — Finance verifies it, then the Project Manager `
      + 'approves it. The baseline does not move until then.'));
  } catch (err) { return fail(res, err, '/bcr/new'); }
});

// --- the moves ---------------------------------------------------------------

const MOVE_VERBS = {
  verify: { flag: null, run: (a) => svc.verifyBcr(a), back: '/bcr' },
  approve: { flag: 'canApproveBaseline', run: (a) => svc.approveBcr(a), back: '/bcr' },
  reject: { flag: null, run: (a) => svc.rejectBcr(a), back: '/bcr' },
  withdraw: { flag: null, run: (a) => svc.withdrawBcr(a), back: '/bcr' },
};

for (const [verb, spec] of Object.entries(MOVE_VERBS)) {
  const guards = spec.flag
    ? [requireCapability(spec.flag, 'Approving a baseline change is the Project Manager’s decision. '
        + 'An Administrator does not approve baselines.')]
    : [];
  router.post(`/bcr/:id/${verb}`, ...guards, (req, res) => {
    const project = projectOf(res);
    try {
      const out = spec.run({
        projectId: project.id,
        bcrId: Number(req.params.id),
        actorId: req.user.id,
        caps: req.caps || capabilities(req.user),
        note: str(req.body.note) || null,
      });
      const say = {
        verify: `${out.bcr_no} verified. The Project Manager can now approve it.`,
        approve: `${out.bcr_no} approved. The baseline now runs from `
          + `${out.effective_period} forward; earlier months were not touched.`,
        reject: `${out.bcr_no} rejected. Nothing was changed — the baseline is exactly as it was.`,
        withdraw: `${out.bcr_no} withdrawn.`,
      }[verb];
      return res.redirect('/bcr?msg=' + msg(say));
    } catch (err) { return fail(res, err, spec.back); }
  });
}

// The freeze. Deliberately NOT routed through the BCR service's project scope: the
// project id is in the path (it is the one thing in the app that is not "the current
// project"), and the switcher's project may be a different one.
router.post('/projects/:id/baseline/freeze', canFreeze, (req, res) => {
  const id = Number(req.params.id);
  try {
    const out = svc.freezeBaseline({ projectId: id, actorId: req.user.id, caps: req.caps });
    return res.redirect(`/bcr?project=${id}&msg=` + msg(
      `${out.code} baseline frozen. It can now only change through an approved change request.`));
  } catch (err) {
    // A role refusal still renders the 403 page (requireCapability already did that);
    // everything else is a form-rule refusal, which redirects with the reason.
    return fail(res, err, `/bcr?project=${id}`);
  }
});

module.exports = router;
