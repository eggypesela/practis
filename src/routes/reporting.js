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
const { capabilities } = require('../lib/permissions');
const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

// The same scoped-path discipline routes/app.js documents at its APP_PATHS: a bare
// `router.use(requirePage)` on a root-mounted router runs for EVERY request in the app and
// would answer unknown URLs with a redirect to /login instead of a 404. An ARRAY, and every
// path this router serves must appear in it.
const REPORT_PATHS = ['/reports', '/reports/aging'];
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
    active: 'Aging',
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

module.exports = router;
