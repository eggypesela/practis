// Project context + per-project scope enforcement (PRD §2.3, plan task 0.9).
//
// This replaces the copy of `projectContext` that lived in BOTH routes/app.js and
// routes/admin.js. The old one was four lines and read:
//
//     const sel = all.find(p => p.id === Number(req.query.project)) || all[0];
//
// — a raw query parameter with no authorization check, so any signed-in user
// could read and write any project by changing one number (see
// docs/AUDIT-2026-09-30.md). Both copies are now this one function, which
// resolves the project from the user's AUTHORISED set instead.
//
// Two separate concerns, deliberately kept apart:
//   * which project OPENS  — always the first authorised project, or the
//     explicitly requested one when the user is entitled to it. A user is never
//     dropped into a project they cannot see.
//   * refusing an unauthorised ?project=N — only when SCOPE_ENFORCE=1.
//     Decision 4A (the owner): backfill every account's real project FIRST, then
//     enforce, because enforcing against a table of NULLs would lock every
//     existing account out. With the gate off the request silently falls back
//     instead of 403-ing, so a shared or bookmarked link keeps working.

'use strict';

const { projectsFor, canAccessProject, scopeReason } = require('../lib/permissions');

const enforce = () => process.env.SCOPE_ENFORCE === '1';

// Tolerant of a missing/invalid user: the routes that mount this all run after
// requirePage, but admin.js also renders for an Administrator who may have been
// removed mid-session. Never throw here — a scope failure must not 500 a page.
function projectContext(req, res, next) {
  let allowed = [];
  try {
    allowed = projectsFor(req.user);
  } catch (err) {
    console.error('[scope] could not resolve project scope:', err.message);
    allowed = [];
  }

  const raw = req.query.project;
  const requested = (raw === undefined || raw === null || raw === '') ? null : Number(raw);
  let sel = allowed[0] || null;

  if (requested != null && Number.isFinite(requested)) {
    if (canAccessProject(req.user, requested)) {
      sel = allowed.find((p) => p.id === requested) || sel;
    } else if (enforce()) {
      // Fail closed with an explanation, not a silent redirect: a user who
      // follows a link to a project they are not on should be told why.
      return res.status(403).render('403', {
        layout: 'layout-app',
        title: 'Not allowed',
        subtitle: scopeReason(req.user),
        crumb: 'Project / Not assigned',
        active: '',
        projectName: allowed[0]?.name || 'No project',
      });
    }
  }

  res.locals.project = sel;
  // The switcher renders from THIS list, never from every project — a user must
  // not be offered a project the server would refuse.
  res.locals.projects = allowed;
  res.locals.scopeEnforced = enforce();
  next();
}

module.exports = { projectContext, enforce };
