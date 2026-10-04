// Receivable / aging report screens (module 8 part 8.3; PRD §5.2, §5.4).
//
// PRD §5.2: "Aging report view (30/60/90/120+ day buckets), sortable by amount — Finance's
// collection priority list. Due date = ledger date + payment terms (from project register)."
// PRD §5.4: "Aging report (receivables): 30/60/90/120+ buckets." Screen map (TECH-SPEC §10):
// `Reports | Aging | receivable priorities`.
//
// Same structure as routes/cbs.js: `page()`, the local `requireCapability`, and the
// refuse-with-a-reason idiom. Every statement lives in `db/queries.js` — the house rule for
// this repo, and the reason the sort whitelist is enforced in the query layer rather than here.
//
// WHAT THIS SCREEN IS CAREFUL ABOUT — three things Module 8's recon MEASURED as defects
//
//  1. The register it renders was, before migration 020, showing the one document that is NOT
//     a receivable and hiding every real claim. Part 8.1 fixed the view; this screen is the
//     first thing in the product to render it, which is why 8.1 had to land first.
//  2. An undatable claim must NOT be reported as "120+ days overdue" (migration 020 removed
//     those rows from aging entirely). They are a data-quality TO-DO list, so they are shown as
//     their own labelled group — visible and actionable, never mixed into the chase list.
//  3. Retainage is held SEPARATELY and "never buried in regular AR" (PRD §5.2), so it is its
//     own tile and its own column, read from the register rather than from the aging list (a
//     settled-but-still-retained claim keeps its retainage).
//
// The sort is a WHITELIST. `?sort=` selects one of three prepared statements inside
// `queries.js`; the parameter itself never reaches SQL as text.
'use strict';

const express = require('express');
const router = express.Router();

const q = require('../db/queries');
const revenue = require('../lib/revenue-service');
const reportSvc = require('../lib/report-service');
const periods = require('../lib/periods');
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

// The recognition month defaults to the CURRENT month, not to the latest closed one: a user
// opening the screen wants to recognise this month's revenue.
const currentMonth = () => new Date().toISOString().slice(0, 7);
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));

// PRG: every write redirects, so a refresh cannot re-post and the URL always describes what is
// on screen. `res.redirect` with a relative path is what the rest of the app uses.
const redirectTo = (res, url) => res.redirect(url);

// The same scoped-path discipline routes/app.js documents at its APP_PATHS: a bare
// `router.use(requirePage)` on a root-mounted router runs for EVERY request in the app and
// would answer unknown URLs with a redirect to /login instead of a 404. An ARRAY, and every
// path this router serves must appear in it.
// Cripples every guarded path on this router, and the plan/lesson is explicit that the ARRAY
// form is required: Express 5's `/x/{*path}` silently drops the guard on the bare prefix, so a
// non-array mount here would leak this router's pages past `requirePage`. Array it is.
const REPORT_PATHS = ['/reports', '/reports/aging', '/reports/project', '/reports/revenue',
  '/reports/update'];
router.use(REPORT_PATHS, requirePage, projectContext);

// Refuse a page the signed-in user has no role for — a rendered 403 with the reason, never a
// silently shorter list. This is the AUTHORIZATION half; `canViewReceivable` is the rule.
function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'Aging',
        projectName: res.locals.project?.name || 'No project',
      });
    }
    req.caps = caps;
    next();
  };
}

const IDR = new Intl.NumberFormat('id-ID');
const fmt = (n) => IDR.format(n || 0);

function page(res, title, subtitle, crumb, bodyView, locals = {}) {
  res.render(bodyView, {
    layout: 'layout-app',
    title, subtitle, crumb,
    // The sidebar entry to highlight. Defaults to Aging (this router's first screen), and a page
    // that belongs to a different entry overrides it through `locals.active` — otherwise the
    // Revenue screen would light up the aging report's link.
    active: locals.active || 'Aging',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    // Every screen in this repo renders money through the `fmt` local it was handed.
    fmt,
    ...locals,
  });
}

const guard = requireCapability('canViewReceivable',
  'The receivables and aging registers are Finance and Cost Control screens.');

// The five real buckets in chase order, with the labels Finance expects to read on screen.
// `current` is its own group and is NOT an urgency — an invoice inside its terms is simply not
// yet due. `120_plus` is last among the aged groups because it is the oldest debt.
const BUCKETS = [
  { key: 'current', label: 'Not yet due', note: 'inside their payment terms' },
  { key: '1_30', label: '1–30 days', note: 'newest' },
  { key: '31_60', label: '31–60 days', note: '' },
  { key: '61_90', label: '61–90 days', note: '' },
  { key: '91_120', label: '91–120 days', note: '' },
  { key: '120_plus', label: '120+ days', note: 'oldest — chase first' },
];

const SORT_LABELS = { amount: 'Largest first', overdue: 'Most overdue', due: 'Due soonest' };
const isSort = (v) => Object.prototype.hasOwnProperty.call(SORT_LABELS, String(v));

// Roll the GROUP BY up into the six display groups, INCLUDING the empty ones, so the page's
// tiles and its table cannot disagree: both read exactly one `q.receivableAging` result.
function bucketTiles(rows) {
  const agg = new Map();
  for (const r of rows) {
    const b = agg.get(r.aging_bucket) || { n: 0, total: 0, overdue: 0 };
    b.n += 1;
    b.total += r.outstanding_amount || 0;
    b.overdue += r.overdue_days || 0;
    agg.set(r.aging_bucket, b);
  }
  return BUCKETS.map((b) => {
    const a = agg.get(b.key) || { n: 0, total: 0, overdue: 0 };
    return { ...b, n: a.n, total: a.total, overdue: a.overdue };
  });
}

// GET /reports — the report index. One entry today; the module's later parts add more, and the
// sidebar's Reports group points HERE rather than at a single report, so it never has to be
// re-pointed as the module grows.
router.get('/reports', guard, (req, res) => {
  const project = res.locals.project;
  if (!project) {
    return page(res, 'Reports', 'No project is in scope for your account',
      'Reports', 'reports-index', { project: null, tiles: [], total: 0 });
  }
  const rows = q.receivableAging(project.id, 'amount');
  return page(res, 'Reports',
    `${project.name} · what we are owed, and how late it is`,
    `${project.name} / Reports`, 'reports-index', {
      project, tiles: bucketTiles(rows), total: rows.length,
    });
});

// GET /reports/project — the Project Overview: the S-curves, the period bars and the headline
// figures for ONE project (PRD §5.4: "Project dashboard (PM/Controller): S-curves, EVM trend,
// cashflow actual vs forecast, WBS drill-down").
//
// NOT gated on a write capability. A dashboard is a read: PRD §5.2 asks for this report, and
// PRD §5.4 gives "EVM trend" to readers the write gates (entering the budget, entering the
// forecast) deliberately exclude. The boundary that matters — who may CHANGE these figures — is
// enforced on the screens that write them, where it belongs.
//
// STILL PROJECT-SCOPED. `projectContext` resolves `?project=N` and the BOLA rule applies: a
// scoped user asking for another project gets the same refusal as everywhere else, because the
// scoping middleware is mounted on this path above. DB8.7 asserts that with an unchanged row
// count, not just a status code.
router.get('/reports/project', (req, res) => {
  const project = res.locals.project;
  if (!project) {
    return page(res, 'Project overview', 'No project is in scope for your account',
      'Reports', 'project-dashboard', {
        project: null, curve: null, bars: null, eac: null, chartSrc: null,
      });
  }

  const chart = require('../lib/chart-config');
  const dash = chart.dashboard(project.id);

  // The chart script is served from `assets/`, which `express.static` mounts at the root. Emitted
  // here (not in layout-app.ejs) so that ONLY the pages with a chart carry the 204 KB download.
  // DB8.8 asserts this file exists on disk — a 404 here is a blank canvas and nothing else.
  const chartSrc = '/vendor/chart.js/chart.umd.min.js';

  return page(res, 'Project overview',
    `${project.name} · planned, earned and actual, month by month`,
    `${project.name} / Project overview`, 'project-dashboard', {
      active: 'Overview',
      project,
      curve: dash.curve,
      bars: dash.bars,
      eac: dash.eac,
      chartSrc,
    });
});

// GET /reports/aging — Finance's collection priority list.
router.get('/reports/aging', guard, (req, res) => {
  const project = res.locals.project;
  if (!project) {
    return page(res, 'Receivables aging', 'No project is in scope for your account',
      'Reports / Aging', 'aging', {
        project: null, rows: [], tiles: [], overdueTotal: 0, noDate: [],
        retainage: 0, sort: 'amount', sortLabels: SORT_LABELS,
      });
  }

  const sort = isSort(req.query.sort) ? String(req.query.sort) : 'amount';
  const rows = q.receivableAging(project.id, sort);

  return page(res, 'Receivables aging',
    `${project.name} · Finance's collection priority list, grouped and totalled`,
    `${project.name} / Reports / Aging`, 'aging', {
      project,
      rows,
      tiles: bucketTiles(rows),
      // Everything past its terms. `overdue_days` is clamped at 0 by migration 021, so a
      // not-yet-due invoice cannot subtract from this figure.
      overdueTotal: rows.reduce((a, r) => a + (r.overdue_days || 0), 0),
      // The data-quality to-do list: claims that cannot be dated, so they cannot be aged.
      // They are invisible in `v_aging` by design, so this can only read the register.
      noDate: q.receivablesWithoutDate(project.id),
      retainage: q.retainageHeld(project.id),
      sort,
      sortLabels: SORT_LABELS,
    });
});

// GET /reports/revenue — revenue recognition (module 8 part 8.8; PRD §5.3).
//
// FOUR METHODS, ONE CONFIGURED. The screen shows all four side by side so the reader can see why
// the configured one is in force, and — for `poc` — how far the client-accepted (BAST) percentage
// sits from our own internal tick percentage. The PRD is emphatic that `poc` follows BAST, so the
// gap is the interesting thing, not a detail.
//
// MOTHER OF THE SCREEN'S STATES: `revenue_method` is NULL on the live project (MEASURED), so
// "not set" is the first thing a real user meets. It is rendered as a stated empty state with the
// four options, never as a project that has recognized nothing.
//
// The POST writes; the GET does not. Which is why the two capability checks differ: reading a
// revenue figure follows the same rule as the forecast (PRD §5.4 hands the figure to PM and
// Controller, and `canViewForecast` is deliberately unrestricted), while CHANGING it is a
// deliberate act gated on `canManageForecast` — the same pair the forecast screen uses, so
// revenue and forecast cannot drift into different rules for the same column family.
router.get('/reports/revenue', (req, res) => {
  const project = res.locals.project;
  if (!project) {
    return page(res, 'Revenue recognition', 'No project is in scope for your account',
      'Reports / Revenue', 'revenue', {
        project: null, reg: null, preview: null, methods: revenue.METHODS,
        methodLabels: revenue.METHOD_LABELS, month: null,
        canManage: false, errors: [], notice: null,
        recognizeAction: '/reports/revenue/recognize', methodAction: '/reports/revenue/method',
      });
  }

  // READING this page is not gated — PRD §5.3 hands the revenue figure to the PM and the
  // Controller, and `canViewForecast` is deliberately unrestricted. So the caps are computed here
  // rather than by a guard middleware (there is none on this route), and they are used ONLY to
  // decide whether to offer the write forms. `canManageForecast` on the two POSTs is the real
  // boundary; this is the same flag, asked without the redirect.
  const caps = capabilities(req.user);
  const month = isValidMonth(req.query.month)
    ? String(req.query.month) : (req.query.month ? null : currentMonth());
  const view = revenue.preview(project.id, month);
  const reg = revenue.register(project.id);

  return page(res, 'Revenue recognition',
    `${project.name} · what can be recognised, and on what basis`,
    `${project.name} / Reports / Revenue`, 'revenue', {
      project, reg, preview: view, month,
      methods: revenue.METHODS, methodLabels: revenue.METHOD_LABELS,
      // Highlights the Revenue link in the sidebar rather than the default Aging one.
      active: 'Revenue',
      // The write capability, so the form is only offered to someone who can submit it — the same
      // rule `views/forecast.ejs` follows. A form a reader cannot submit is worse than no form.
      canManage: !!caps.canManageForecast,
      errors: (req.query.err ? [String(req.query.err)] : []),
      notice: req.query.ok ? String(req.query.ok) : null,
      recognizeAction: '/reports/revenue/recognize',
      methodAction: '/reports/revenue/method',
    });
});

const revGuard = requireCapability('canManageForecast',
  'Only the Cost Controller or the Project Manager may change revenue recognition.');

router.post('/reports/revenue/method', revGuard, (req, res) => {
  const project = res.locals.project;
  if (!project) return redirectTo(res, '/reports/revenue?err=' + encodeURIComponent('No project in scope.'));
  try {
    const out = revenue.setMethod({
      projectId: project.id, method: String(req.body.method || ''), actorId: req.user.id,
    });
    const msg = out.changed
      ? `Revenue method set to ${revenue.METHOD_LABELS[out.method].name}.`
      : `Revenue method was already ${revenue.METHOD_LABELS[out.method].name}.`;
    return redirectTo(res, '/reports/revenue?ok=' + encodeURIComponent(msg));
  } catch (e) {
    if (e instanceof revenue.RevenueError) {
      return redirectTo(res, '/reports/revenue?err=' + encodeURIComponent(e.message));
    }
    throw e;
  }
});

router.post('/reports/revenue/recognize', revGuard, (req, res) => {
  const project = res.locals.project;
  if (!project) return redirectTo(res, '/reports/revenue?err=' + encodeURIComponent('No project in scope.'));
  const month = String(req.body.period_month || '');
  try {
    const out = revenue.recognize({ projectId: project.id, month, actorId: req.user.id });
    const msg = `${out.month}: ${fmt(out.amount)} recognised (${out.basisPct}% of contract).`;
    return redirectTo(res, '/reports/revenue?month=' + encodeURIComponent(month)
      + '&ok=' + encodeURIComponent(msg));
  } catch (e) {
    if (e instanceof revenue.RevenueError) {
      return redirectTo(res, '/reports/revenue?month=' + encodeURIComponent(month)
        + '&err=' + encodeURIComponent(e.message));
    }
    throw e;
  }
});

// ---- Project Update Report + period freeze (module 8 part 8.10; PRD §4.4, §5.4) ---------------
//
// The monthly report, and the act that closes the period. Read `src/lib/report-service.js` for the
// decision (A: freezes on APPROVAL) and for why the service compiles rather than computes.
//
// THE FREEZE IS NOT REIMPLEMENTED HERE. `report.approve()` calls the same `q.freezePeriod` the
// Administrator's /periods button calls, so the two doors close the month the same way and
// `/periods` shows what a PM's approval did.

// The report month defaults to the CURRENT month: a Controller opening the screen is compiling this
// month's report. A month given on the query string is only accepted if it looks like one — a typo
// must not silently become "no month".
const reportMonth = (raw) => (isValidMonth(raw) ? String(raw)
  : (raw ? null : new Date().toISOString().slice(0, 7)));

function reportLocals(req, res, extra = {}) {
  const project = res.locals.project;
  const month = reportMonth(req.query.month);
  const stored = (project && month) ? reportSvc.forMonth(project.id, month) : null;
  // The compiled body is always shown, even when a stored report exists, because it is what the
  // report WOULD say right now — the difference between the two is exactly what regeneration would
  // change, and hiding it would make a stale stored report invisible.
  const live = (project && month) ? reportSvc.compile(project.id, month) : null;
  return {
    project, month,
    stored,
    live,
    // A stored report whose figures differ from the live compile is STALE. Said plainly, because a
    // frozen report legitimately differs (the period cannot move) while a draft one should be
    // regenerated.
    stale: !!(stored && live && (stored.spi !== live.spi || stored.cpi !== live.cpi
      || stored.receivable_amount !== live.receivable_amount
      || stored.revenue_recognized !== live.revenue_recognized)),
    caps: capabilities(req.user),
    // The `periods` MODULE, so the view can ask whether the month is frozen without the route
    // pre-deciding which of the two statuses to print. (A boolean here would make the view unable
    // to distinguish "this report is frozen" from "the period is frozen".)
    periods,
    ...extra,
  };
}

router.get('/reports/update', (req, res) => {
  const project = res.locals.project;
  // NOTE the locals are passed FLAT, not nested under a `locals:` key. `page()` spreads its last
  // argument into the render context, so `page(res, ..., { locals: { x } })` would define one
  // variable called `locals` and leave `x` undefined in the view.
  if (!project) {
    return page(res, 'Project update report', 'No project is in scope for your account',
      'Portfolio / Reports / Update', 'report-update',
      { active: 'Update report', project: null, month: null, stored: null, live: null,
        stale: false, caps: capabilities(req.user), periods, error: null, notice: null });
  }
  return page(res, 'Project update report',
    `${project.name} · the monthly report · approving it freezes the period`,
    `${project.name} / Reports / Update`, 'report-update',
    Object.assign({ active: 'Update report' }, reportLocals(req, res, {
      error: req.query.err ? String(req.query.err) : null,
      notice: req.query.ok ? String(req.query.ok) : null,
      saved: req.query.saved ? Number(req.query.saved) : null,
    })));
});

router.post('/reports/update/generate',
  requireCapability('canManageReport',
    'Compiling the Project Update Report is a Project Controller, Project Manager or Project Admin task.'),
  (req, res) => {
    const project = res.locals.project;
    const month = String(req.body.period_month || '');
    try {
      const out = reportSvc.generate({ projectId: project.id, month, actorId: req.user.id });
      return redirectTo(res, `/reports/update?month=${encodeURIComponent(month)}`
        + `&saved=${out.report.id}`
        + `&ok=${encodeURIComponent(out.regenerated ? 'Report regenerated from the current figures.' : 'Report compiled as a draft.')}`);
    } catch (e) {
      if (e instanceof reportSvc.ReportError) {
        return redirectTo(res, `/reports/update?month=${encodeURIComponent(month)}`
          + `&err=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
  });

router.post('/reports/update/:id/review',
  requireCapability('canManageReport',
    'Reviewing the Project Update Report is a Project Controller, Project Manager or Project Admin task.'),
  (req, res) => {
    const project = res.locals.project;
    try {
      const out = reportSvc.review({ projectId: project.id, id: Number(req.params.id),
        actorId: req.user.id });
      return redirectTo(res, `/reports/update?month=${encodeURIComponent(out.period_month)}`
        + `&ok=${encodeURIComponent('Report marked reviewed. It is ready for the Project Manager.')}`);
    } catch (e) {
      if (e instanceof reportSvc.ReportError) {
        return redirectTo(res, `/reports/update?err=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
  });

// APPROVE — and, under decision A, FREEZE THE PERIOD. The confirm text on the form says so; this
// route is what makes it true.
router.post('/reports/update/:id/approve',
  requireCapability('canApproveReport', 'Approving the report is a Project Manager task.'),
  (req, res) => {
    const project = res.locals.project;
    try {
      const out = reportSvc.approve({ projectId: project.id, id: Number(req.params.id),
        actorId: req.user.id });
      return redirectTo(res, `/reports/update?month=${encodeURIComponent(out.period)}`
        + `&ok=${encodeURIComponent(
          `Approved. The period ${out.period} is now frozen and backdated entries to it are refused.`)}`);
    } catch (e) {
      if (e instanceof reportSvc.ReportError) {
        return redirectTo(res, `/reports/update?err=${encodeURIComponent(e.message)}`);
      }
      throw e;
    }
  });

module.exports = router;
