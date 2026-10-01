// Portfolio register (plan task 6.1, TECH-SPEC §10 step 3).
//
// WHY THIS FILE EXISTS
// `views/partials/sidebar.ejs` links `/projects` on EVERY page, and no route
// served it — every user, on every screen, had a nav link that 404'd.
//
// The register is also where the scope rule becomes visible. It lists
// `projectsFor(user)` (the authorised set), NOT `q.projects()` (the whole
// portfolio). Those two are different, and using the wrong one is exactly the
// leak found on the dashboard in the BOLA audit: a project-scoped user was
// shown a list of projects they are not on.
'use strict';

const express = require('express');
const router = express.Router();
const q = require('../db/queries');
const { projectsFor } = require('../lib/permissions');
const requirePage = require('../middleware/auth').requirePage;

const IDR = new Intl.NumberFormat('id-ID');
const fmt = (n) => IDR.format(n || 0);

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

router.use(requirePage);

// The register carries a cost-to-date figure per project, so it needs the same
// project context the rest of the app uses (for the switcher + the "current"
// highlight). Import the shared middleware rather than re-deriving scope here.
const { projectContext } = require('../middleware/scope');
router.use(projectContext);

router.get('/projects', (req, res) => {
  // The AUTHORISED set. Never q.projects() — see the file header.
  const projects = projectsFor(req.user);

  // Per-project figures. Cost-to-date is only meaningful for a project the user
  // may open, and it comes from the same view the dashboard uses so the two
  // screens cannot disagree.
  const rows = projects.map((p) => ({
    ...p,
    cost_to_date: q.costToDate(p.id).n,
    // EVM cannot work without a baseline (cbs_plan is empty), so surface the
    // state that blocks it rather than a blank cell (PRD §4.1 step 6).
    baselined: p.baseline_locked === 1,
  }));

  const total = rows.reduce((a, r) => a + (r.contract_amount || 0), 0);
  const baselined = rows.filter((r) => r.baselined).length;

  page(res, 'Projects', 'Portfolio register · every project you may open',
    'Portfolio / Projects', 'projects', {
      active: 'Projects',
      locals: {
        rows, fmt, total,
        baselined,
        notBaselined: rows.length - baselined,
      },
    });
});

module.exports = router;
