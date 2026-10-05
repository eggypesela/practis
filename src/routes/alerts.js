'use strict';
//
// Alert endpoints — TECH-SPEC §6.2 (`GET /api/alerts`, `POST /api/alerts/:id/read`), TS-03.
//
// The browser polls `GET /api/alerts` every 30 seconds (TS-03). Both endpoints are JSON because
// their only caller is `fetch`, and both are READ-ONLY with respect to alerts: evaluation happens on
// the job runner, never here. A poll that wrote to the database would make every open browser tab a
// writer, which is exactly the kind of thing that looks fine until three people leave the app open.
//
// CSRF: `POST /api/alerts/:id/read` is a state-changing POST. It travels as a header-token request
// from `fetch` (the same path the import endpoints use), because the global CSRF middleware reads
// the `_csrf` body field or the `x-csrf-token` header — a JSON body would carry neither.

'use strict';

const express = require('express');

const svc = require('../lib/alert-service');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/alerts?project_id=&limit=   → unread alerts for the signed-in user
//
// TS-03 says "returns unread only" — the read set is not returned at all, so this is not a filtered
// view of everything but a different question. `unread` is included so the bell badge and the list
// cannot disagree about how many there are.
router.get('/api/alerts', requireAuth, (req, res) => {
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  res.json({
    alerts: svc.inboxFor(req.user, { projectId, limit: req.query.limit }),
    unread: svc.unreadCount(req.user),
    pollSeconds: 30,   // TS-03: the client is told the interval rather than hard-coding it
  });
});

// POST /api/alerts/:id/read   → mark one read
//
// Always answers 200 with `{ read: true|false }`, never 404 for a row that is not yours. The
// distinction between "does not exist", "someone else's" and "already read" is not information this
// endpoint owes the caller, and returning it would turn the id space into an existence oracle.
router.post('/api/alerts/:id/read', requireAuth, (req, res) => {
  const read = svc.markRead(req.user, req.params.id);
  res.json({ read, unread: svc.unreadCount(req.user) });
});

module.exports = router;
