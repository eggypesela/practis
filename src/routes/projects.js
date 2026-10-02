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
const { projectsFor, capabilities } = require('../lib/permissions');
const requirePage = require('../middleware/auth').requirePage;
const svc = require('../lib/projects-service');
const clientsSvc = require('../lib/clients-service');

const IDR = new Intl.NumberFormat('id-ID');
const fmt = (n) => IDR.format(n || 0);

// Refuse a page or action the signed-in user has no role for — 403 WITH the
// reason, never a silently hidden link (hidden buttons are usability, never
// security). Local copy of the pattern used by routes/app.js; kept here rather
// than imported because app.js does not export it.
function requireCapability(flag, message) {
  return (req, res, next) => {
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).render('403', {
        layout: 'layout-app', title: 'Not allowed', subtitle: message,
        crumb: `${res.locals.project?.name || ''} · blocked`, active: '',
        projectName: res.locals.project?.name || 'No project',
      });
    }
    req.caps = caps;
    next();
  };
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

// Scoped so the guard only runs for THIS router's paths.
//
// A bare `router.use(requirePage)` looks harmless but is a real defect: this
// router is mounted at the root, so an unscoped middleware runs for EVERY
// request in the app — including URLs that belong to no route at all. An
// anonymous request to an unknown path was therefore redirected to /login by
// this guard before Express could reach the 404 handler, so the app answered
// "sign in" to a URL that does not exist and would still not exist afterwards.
// (A signed-in user correctly got 404, because requirePage passes them through.)
//
// The path list must be an ARRAY (or an anchored regex). Express 5's
// '/projects/{*path}' and '/projects/*splat' forms were tested and SILENTLY DROP
// the guard on the bare prefix '/projects' itself — see TEST_PLAN §12f.
const PAGE_PATHS = ['/projects', '/clients'];
router.use(PAGE_PATHS, requirePage);

// The register carries a cost-to-date figure per project, so it needs the same
// project context the rest of the app uses (for the switcher + the "current"
// highlight). Import the shared middleware rather than re-deriving scope here.
const { projectContext } = require('../middleware/scope');
router.use(PAGE_PATHS, projectContext);

router.get('/projects', (req, res) => {
  // The AUTHORISED set. Never q.projects() — see the file header.
  const projects = projectsFor(req.user);

  // Per-project figures. Cost-to-date is only meaningful for a project the user
  // may open, and it comes from the same view the dashboard uses so the two
  // screens cannot disagree.
  const rows = projects.map((p) => {
    // Approval state comes from the `approvals` table, never a boolean column —
    // so the register reads the same chain the approval route writes.
    const state = svc.approvalState('project', p.id);
    return {
      ...p,
      client_name: svc.clientNameFor(p.client_id),
      cost_to_date: q.costToDate(p.id).n,
      // EVM cannot work without a baseline (cbs_plan is empty), so surface the
      // state that blocks it rather than a blank cell (PRD §4.1 step 6).
      baselined: p.baseline_locked === 1,
      approved: state.isApproved,
      approval: state.rows,
    };
  });

  const total = rows.reduce((a, r) => a + (r.contract_amount || 0), 0);
  const baselined = rows.filter((r) => r.baselined).length;
  const awaiting = rows.filter((r) => !r.approved).length;

  page(res, 'Projects', 'Portfolio register · every project you may open',
    'Portfolio / Projects', 'projects', {
      active: 'Projects',
      actions: req.caps?.canManageProjects
        ? '<a class="btn pri" href="/projects/new"><svg><use href="#i-plus"/></svg>Register project</a>'
        : '',
      locals: {
        rows, fmt, total,
        baselined,
        notBaselined: rows.length - baselined,
        awaiting,
        caps: req.caps || capabilities(req.user),
        saved: req.query.saved ? Number(req.query.saved) : null,
        code: req.query.code || null,
        updated: req.query.updated ? Number(req.query.updated) : null,
        approved: req.query.approved ? Number(req.query.approved) : null,
        error: null, errorProject: null, needsReason: false,
      },
    });
});

// ---- module 6 task 6.2: register + approval ---------------------------------

router.get('/projects/new',
  requireCapability('canManageProjects', 'Registering a project is a Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    page(res, 'Register project', 'PRD §4.1 · a new project starts with no numbers and no baseline',
      'Portfolio / Projects / New', 'project-new', {
        active: 'Projects',
        locals: {
          form: {}, error: null, field: null,
          revenueMethods: svc.REVENUE_METHODS,
          clients: q.clientsActive ? q.clientsActive() : [],
          industryTypes: q.industryTypes ? q.industryTypes() : [],
          termsByClient: q.clientsActive ? q.clientsActive().reduce((m, c) => {
            if (c.payment_terms_days != null) m[c.id] = c.payment_terms_days;
            return m;
          }, {}) : {},
        },
      });
  });

router.post('/projects',
  requireCapability('canManageProjects', 'Registering a project is a Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const out = svc.createProject(req.body, req.user.id);
    if (!out.ok) {
      return res.status(out.status || 400).render('project-new', {
        layout: 'layout-app', title: 'Register project',
        subtitle: 'PRD §4.1 · the project was not registered',
        crumb: 'Portfolio / Projects / New', active: 'Projects', actions: '',
        projectName: res.locals.project?.name || 'No project',
        form: req.body, error: out.message, field: out.field,
        revenueMethods: svc.REVENUE_METHODS,
        clients: q.clients ? q.clients() : [],
        industryTypes: q.industryTypes ? q.industryTypes() : [],
      });
    }
    // The new project is NOT yet visible to the person who created it unless
    // they are org-wide: `projectsFor` grants only assigned projects to a scoped
    // PM. Send them back to the register with a confirmation instead of into a
    // project that may 403.
    return res.redirect(`/projects?saved=${out.project.id}&code=${encodeURIComponent(out.project.code)}`);
  });

router.get('/projects/:id/edit',
  requireCapability('canManageProjects', 'Editing a project is a Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const project = q.projectById(Number(req.params.id));
    if (!project) return res.status(404).render('404', {
      layout: 'layout-app', title: 'Not found', subtitle: '', projectName: 'No project',
    });
    page(res, `Edit ${project.code}`, `${project.name} · registration details`,
      `Portfolio / Projects / ${project.code}`, 'project-edit', {
        active: 'Projects',
        locals: {
          project, form: project, error: null, field: null,
          revenueMethods: svc.REVENUE_METHODS,
          clients: q.clients ? q.clients() : [],
          industryTypes: q.industryTypes ? q.industryTypes() : [],
          state: svc.approvalState('project', project.id),
        },
      });
  });

router.post('/projects/:id',
  requireCapability('canManageProjects', 'Editing a project is a Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const id = Number(req.params.id);
    const out = svc.updateProject(id, req.body, req.user.id);
    if (!out.ok) {
      const project = q.projectById(id);
      return res.status(out.status || 400).render('project-edit', {
        layout: 'layout-app', title: project ? `Edit ${project.code}` : 'Edit project',
        subtitle: 'the change was not saved', crumb: 'Portfolio / Projects',
        active: 'Projects', actions: '',
        projectName: res.locals.project?.name || 'No project',
        project: project || {}, form: req.body, error: out.message, field: out.field,
        revenueMethods: svc.REVENUE_METHODS,
        clients: q.clients ? q.clients() : [],
        industryTypes: q.industryTypes ? q.industryTypes() : [],
        state: svc.approvalState('project', id),
      });
    }
    return res.redirect(`/projects?updated=${id}`);
  });

// Approve. Gated on canApproveProjects, which is NOT the same flag as
// canManageProjects — the Project Admin may register but not approve (PRD §4.1
// gives approval to the PM; decision 8A keeps that).
router.post('/projects/:id/approve',
  requireCapability('canApproveProjects', 'Approving a project is a Project Manager task.'),
  (req, res) => {
    const id = Number(req.params.id);
    const out = svc.approveProject(id, req.user.id, req.body.reason);
    if (!out.ok) {
      // The self-approval refusal is the interesting one: it renders the register
      // WITH the reason box open so the operator can satisfy it in one step,
      // rather than bouncing them to an error page with no way forward.
      const project = q.projectById(id);
      if (!project) return res.redirect('/projects');
      const projects = projectsFor(req.user);
      return res.status(out.status || 400).render('projects', {
        layout: 'layout-app', title: 'Projects',
        subtitle: 'the approval was refused', crumb: 'Portfolio / Projects',
        active: 'Projects', actions: '',
        projectName: res.locals.project?.name || 'No project',
        rows: projects.map((p) => {
          const st = svc.approvalState('project', p.id);
          return { ...p, client_name: svc.clientNameFor(p.client_id),
                   cost_to_date: q.costToDate(p.id).n, baselined: p.baseline_locked === 1,
                   approved: st.isApproved, approval: st.rows };
        }),
        fmt, total: 0, baselined: 0, notBaselined: 0, awaiting: 0,
        caps: req.caps || capabilities(req.user),
        error: out.message, errorProject: id, needsReason: out.field === 'reason',
      });
    }
    return res.redirect(`/projects?approved=${id}`);
  });

// ---- module 6 task 6.3: client register -------------------------------------
//
// Clients are NOT project-scoped: the same client serves many projects, so the
// register is org-wide and this middleware ordering (requirePage only) is
// deliberate — the client list must not be filtered by the current project.

router.get('/clients', (req, res) => {
  const caps = capabilities(req.user);
  const rows = q.clientsAll().map((c) => {
    const state = clientsSvc.approvalState('client', c.id);
    return { ...c, approved: state.isApproved, approval: state.rows };
  });

  page(res, 'Clients', 'The client register · payment terms and points of contact',
    'Portfolio / Clients', 'clients', {
      active: 'Clients',
      actions: caps.canManageClients
        ? '<a class="btn pri" href="/clients/new"><svg><use href="#i-plus"/></svg>Register client</a>'
        : '',
      locals: {
        rows, caps,
        awaiting: rows.filter((r) => !r.approved).length,
        inactive: rows.filter((r) => r.active !== 1).length,
        saved: req.query.saved ? Number(req.query.saved) : null,
        code: req.query.code || null,
        error: null, errorClient: null, needsReason: false,
      },
    });
});

router.get('/clients/new',
  requireCapability('canManageClients', 'Registering a client is a Finance, Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    page(res, 'Register client', 'PRD §4.1 · the client register · payment terms feed project due dates',
      'Portfolio / Clients / New', 'client-new', {
        active: 'Clients',
        locals: {
          form: {}, error: null, field: null,
          industryTypes: q.industryTypes(),
        },
      });
  });

router.post('/clients',
  requireCapability('canManageClients', 'Registering a client is a Finance, Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const out = clientsSvc.createClient(req.body, req.user.id);
    if (!out.ok) {
      return res.status(out.status || 400).render('client-new', {
        layout: 'layout-app', title: 'Register client',
        subtitle: 'PRD §4.1 · the client was not registered',
        crumb: 'Portfolio / Clients / New', active: 'Clients', actions: '',
        projectName: res.locals.project?.name || 'No project',
        form: req.body, error: out.message, field: out.field,
        industryTypes: q.industryTypes(),
      });
    }
    return res.redirect(`/clients?saved=${out.client.id}&code=${encodeURIComponent(out.client.code)}`);
  });

router.get('/clients/:id/edit',
  requireCapability('canManageClients', 'Editing a client is a Finance, Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const client = q.clientById(Number(req.params.id));
    if (!client) {
      return res.status(404).render('404', {
        layout: 'layout-app', title: 'Not found', subtitle: '', projectName: 'No project',
      });
    }
    page(res, `Edit ${client.code}`, `${client.name} · registration details`,
      `Portfolio / Clients / ${client.code}`, 'client-edit', {
        active: 'Clients',
        locals: {
          client, form: client, error: null, field: null,
          industryTypes: q.industryTypes(),
          state: clientsSvc.approvalState('client', client.id),
        },
      });
  });

router.post('/clients/:id',
  requireCapability('canManageClients', 'Editing a client is a Finance, Project Manager, Project Controller or Project Admin task.'),
  (req, res) => {
    const id = Number(req.params.id);
    const out = clientsSvc.updateClient(id, req.body, req.user.id);
    if (!out.ok) {
      const client = q.clientById(id);
      return res.status(out.status || 400).render('client-edit', {
        layout: 'layout-app',
        title: client ? `Edit ${client.code}` : 'Edit client',
        subtitle: 'the change was not saved', crumb: 'Portfolio / Clients',
        active: 'Clients', actions: '',
        projectName: res.locals.project?.name || 'No project',
        client: client || {}, form: req.body, error: out.message, field: out.field,
        industryTypes: q.industryTypes(),
        state: clientsSvc.approvalState('client', id),
      });
    }
    return res.redirect(`/clients?updated=${id}`);
  });

router.post('/clients/:id/approve',
  requireCapability('canApproveClients', 'Approving a client is a Project Manager task.'),
  (req, res) => {
    const id = Number(req.params.id);
    const out = clientsSvc.approveClient(id, req.user.id, req.body.reason);
    if (!out.ok) {
      const client = q.clientById(id);
      if (!client) return res.redirect('/clients');
      const caps = capabilities(req.user);
      return res.status(out.status || 400).render('clients', {
        layout: 'layout-app', title: 'Clients',
        subtitle: 'the approval was refused', crumb: 'Portfolio / Clients',
        active: 'Clients', actions: '',
        projectName: res.locals.project?.name || 'No project',
        rows: q.clientsAll().map((c) => {
          const st = clientsSvc.approvalState('client', c.id);
          return { ...c, approved: st.isApproved, approval: st.rows };
        }),
        caps, awaiting: 0, inactive: 0,
        saved: null, code: null,
        error: out.message, errorClient: id, needsReason: out.field === 'reason',
      });
    }
    return res.redirect(`/clients?approved=${id}`);
  });

module.exports = router;

