'use strict';
//
// Health endpoints — TECH-SPEC §4.3 and the route table at §6.2/6.3.
//
//   GET /health/live   public, minimal  → is the process up? touches NOTHING.
//   GET /health/ready  public, minimal  → DB, FK, schema, disk, job runner. Docker HEALTHCHECK.
//   GET /health        public, legacy   → minimal status (§4.3 mentions a bare `/health` probe).
//   GET /system/health Administrator    → the full operator detail page.
//
// ============================================================================================
// WHY THESE ARE PUBLIC ROUTES AND WHY THAT IS SAFE
// ============================================================================================
// The machine checks (/health/*) must be reachable by a container HEALTHCHECK and by a probe that
// has no session, so they cannot require auth. That is only safe because their BODIES are
// minimal: `{status:"ok"}` or `{status:"error",failed:["disk"]}`. The failing check NAMES are
// included (an operator needs to know what broke) but never a reason string, a path, a version or
// a secret — those live only on the authenticated /system/health page. This is exactly the split
// §4.3 draws, and the test file asserts the public bodies do not leak.
//
// `/system/health` reuses `requirePage` + `requireAdmin` so it behaves like the other admin
// screens: a signed-out browser is redirected to /login (not shown a 403), and a signed-in
// non-admin gets the 403 page.

const express = require('express');
const router = express.Router();
const health = require('../lib/health-service');
const { requirePage, requireAdmin } = require('../middleware/auth');

// --- public, minimal -----------------------------------------------------------------------

router.get('/health/live', (req, res) => {
  res.json(health.live());
});

router.get('/health/ready', (req, res) => {
  const body = health.ready();
  // 503 is what makes a HEALTHCHECK and a load balancer act. A 200 with `{status:'error'}` would
  // be reported healthy by anything that only looks at the status code — which is most probes.
  res.status(body.status === 'ok' ? 200 : 503).json(body);
});

// A bare /health probe (§4.3/TS-23) — same shape as readiness, so an existing monitor keeps
// working. Kept as an alias rather than a fourth opinion about health.
router.get('/health', (req, res) => {
  const body = health.ready();
  res.status(body.status === 'ok' ? 200 : 503).json(body);
});

// --- Administrator detail ------------------------------------------------------------------

router.get('/system/health', requirePage, requireAdmin, (req, res) => {
  const d = health.detail();
  // The page is the operator's window; it renders every check with its reason, the queue depth,
  // the backup age (null until part 9.4 measures one) and how long this process has been up.
  res.render('system-health', {
    layout: 'layout-app',
    title: 'System health',
    subtitle: 'Checks a browser can see, at the moment it asked.',
    crumb: 'Administration / Health',
    active: 'system',
    d,
    fmtBytes: (n) => (n === null || n === undefined ? '—' : `${Math.round(n / 1048576)} MB`),
    fmtAge: (s) => {
      if (s === null || s === undefined) return 'never measured';
      if (s < 90) return `${s}s ago`;
      if (s < 5400) return `${Math.round(s / 60)} min ago`;
      return `${Math.round(s / 3600)} h ago`;
    },
    fmtUptime: (s) => {
      if (s < 60) return `${s}s`;
      if (s < 5400) return `${Math.round(s / 60)} min`;
      return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
    },
  });
});

module.exports = router;
