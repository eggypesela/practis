// Master data screens (module 6, plan task 6.5; PRD §5.5).
//
// One router drives NINE datasets. The dataset is a URL segment (`/master/wbs`)
// resolved against the registry in `master-service.js`; an unknown key is a 404,
// never a guess. That is deliberate: adding a tenth list is a registry entry, not
// a tenth set of routes to keep in step.
//
// THE ADMIN GATE (PRD §8 "Ask first")
// WBS and RBS carry `structure: true`, and their writes need `canManageStructure`
// (Administrator). Everything else needs `canManageMaster` (Finance, Cost
// Controller, Project Admin). The gate is applied per dataset, so the same screen
// does not silently become admin-only for cost buckets.
//
// NOTHING IS EVER DELETED. Deactivating is a soft flag, and the response says how
// many ledger/plan rows reference the row, so the cost report cannot be re-bucketed
// by accident and nobody has to find out from a report that a bucket disappeared.
'use strict';

const express = require('express');
const router = express.Router();

const q = require('../db/queries');
const svc = require('../lib/master-service');
const { capabilities } = require('../lib/permissions');

const { requirePage } = require('../middleware/auth');
const { projectContext } = require('../middleware/scope');

// Same reasoning as routes/projects.js: an array (or anchored regex), because
// Express 5's '/master/{*path}' form silently drops the guard on the bare prefix.
router.use(['/master'], requirePage);
router.use(['/master'], projectContext);

function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: 'Master data',
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
    active: 'Master data',
    actions: '',
    projectName: res.locals.project?.name || 'No project',
    ...locals,
  });
}

// Resolve `:key` or answer 404. A shared helper so every route agrees on what an
// unknown dataset means.
function datasetOr404(req, res) {
  const ds = svc.get(req.params.key);
  if (!ds) {
    res.status(404).render('404', {
      layout: 'layout-app', title: 'Not found', subtitle: '',
      projectName: res.locals.project?.name || 'No project',
    });
    return null;
  }
  return ds;
}

// The capability a dataset's WRITES need.
const writeFlag = (ds) => (svc.isStructure(ds) ? 'canManageStructure' : 'canManageMaster');
const writeReason = (ds) => (svc.isStructure(ds)
  // PRD §8 "Ask first": the shape of WBS/RBS is an administrator decision.
  ? `${ds.label} defines the shape of the ${ds.short} menu, so changing it is an Administrator task (PRD §8 "Ask first").`
  : `Editing ${ds.label} is a Finance, Cost Controller or Project Admin task.`);

function formLocals(res, ds, extra = {}) {
  // The select choices for any `lookup` field, resolved once here so the view
  // does not have to know how a lookup is stored.
  const lookups = {};
  for (const f of svc.formFields(ds, { isUpdate: !!extra.isUpdate })) {
    if (f.kind === 'lookup') lookups[f.name] = svc.lookupOptions(f);
  }
  return {
    ds, lookups,
    projectName: res.locals.project?.name || 'No project',
    ...extra,
  };
}

// ---- the index: what is in here, and how big each list is ----
router.get('/master', (req, res) => {
  const counts = svc.counts();
  page(res, 'Master data',
    'PRD §5.5 · the reference lists every other screen reads',
    'Setup / Master data', 'master/index', {
      lists: svc.keys().map((k) => svc.get(k)),
      counts,
      caps: capabilities(req.user),
    });
});

// ---- one list ----
router.get('/master/:key', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;

  const caps = capabilities(req.user);
  const canWrite = caps[writeFlag(ds)];

  page(res, ds.label, ds.purpose, `Setup / Master data / ${ds.short}`, 'master/list', {
    ds,
    rows: svc.rowsFor(ds),
    cols: svc.listColumns(ds),
    caps, canWrite,
    canWriteReason: writeReason(ds),
    // A row cannot be deactivated-and-in-use without the screen saying so, so the
    // reference counts are computed up front rather than discovered in a report.
    activeCount: svc.hasActive(ds) ? svc.rowsFor(ds).filter((r) => r.active === 1).length : null,
    notice: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
    error: null,
  });
});

// ---- new ----
router.get('/master/:key/new', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;
  const caps = capabilities(req.user);
  if (!caps[writeFlag(ds)]) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed', subtitle: writeReason(ds),
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data',
      projectName: res.locals.project?.name || 'No project',
    });
  }
  page(res, `New ${ds.short.toLowerCase()}`, `${ds.label} · add a row`,
    `Setup / Master data / ${ds.short} / New`, 'master/form', formLocals(res, ds, {
      row: {}, isUpdate: false, error: null, field: null,
    }));
});

router.post('/master/:key', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;
  const caps = capabilities(req.user);
  if (!caps[writeFlag(ds)]) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed', subtitle: writeReason(ds),
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data',
      projectName: res.locals.project?.name || 'No project',
    });
  }

  const out = svc.createRow(ds.key, req.body, req.user.id);
  if (!out.ok) {
    return res.status(out.status || 400).render('master/form', {
      layout: 'layout-app',
      title: `New ${ds.short.toLowerCase()}`,
      subtitle: `${ds.label} · the row was not saved`,
      crumb: `Setup / Master data / ${ds.short} / New`, active: 'Master data', actions: '',
      ...formLocals(res, ds, { row: req.body, isUpdate: false, error: out.message, field: out.field }),
    });
  }
  return res.redirect(`/master/${ds.key}?msg=${encodeURIComponent(`${ds.keyLabel} ${out.row[ds.keyCol]} added`)}`);
});

// ---- edit ----
router.get('/master/:key/:id/edit', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;
  const row = svc.rowById(ds, Number(req.params.id));
  if (!row) {
    return res.status(404).render('404', {
      layout: 'layout-app', title: 'Not found', subtitle: '',
      projectName: res.locals.project?.name || 'No project',
    });
  }
  const caps = capabilities(req.user);
  if (!caps[writeFlag(ds)]) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed', subtitle: writeReason(ds),
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data',
      projectName: res.locals.project?.name || 'No project',
    });
  }
  page(res, `Edit ${row[ds.keyCol]}`, `${ds.label} · ${row.name || ''}`,
    `Setup / Master data / ${ds.short} / ${row[ds.keyCol]}`, 'master/form', formLocals(res, ds, {
      row, isUpdate: true, error: null, field: null,
      refs: svc.refsFor(ds, row),
    }));
});

router.post('/master/:key/:id', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;
  const id = Number(req.params.id);
  const caps = capabilities(req.user);
  if (!caps[writeFlag(ds)]) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed', subtitle: writeReason(ds),
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data',
      projectName: res.locals.project?.name || 'No project',
    });
  }

  const out = svc.updateRow(ds.key, id, req.body, req.user.id);
  if (!out.ok) {
    const row = svc.rowById(ds, id) || {};
    return res.status(out.status || 400).render('master/form', {
      layout: 'layout-app',
      title: `Edit ${row[ds.keyCol] || ds.short}`,
      subtitle: `${ds.label} · the change was not saved`,
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data', actions: '',
      ...formLocals(res, ds, {
        row: { ...row, ...req.body }, isUpdate: true, error: out.message, field: out.field,
      }),
    });
  }
  return res.redirect(`/master/${ds.key}?msg=${encodeURIComponent(`${out.row[ds.keyCol]} saved`)}`);
});

// ---- activate / deactivate (never delete) ----
router.post('/master/:key/:id/active', (req, res) => {
  const ds = datasetOr404(req, res);
  if (!ds) return;
  const caps = capabilities(req.user);
  if (!caps[writeFlag(ds)]) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed', subtitle: writeReason(ds),
      crumb: `Setup / Master data / ${ds.short}`, active: 'Master data',
      projectName: res.locals.project?.name || 'No project',
    });
  }

  const out = svc.setActive(ds.key, Number(req.params.id), req.body.action === 'activate', req.user.id);
  const msg = out.ok
    // Say what is still pointing at it — that is the whole reason this is a soft
    // flag rather than a delete.
    ? `${out.row[ds.keyCol]} ${out.row.active ? 'activated' : 'deactivated'}`
      + (out.refs.length
        ? ` — ${out.refs.reduce((a, b) => a + b.n, 0)} existing record(s) still reference it (${out.refs.map((r) => `${r.table}.${r.col}`).join(', ')})`
        : '')
    : out.message;

  return res.redirect(`/master/${ds.key}?msg=${encodeURIComponent(msg)}`);
});

module.exports = router;
