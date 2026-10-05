const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const layouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3003;

// migrate before serving (idempotent, fast when current)
require('./db/migrate');
require('./db/seed');

// Request ID FIRST (TECH-SPEC §4.4). Everything below — including the access log and the 404/500
// handlers — reads `req.id`, so it must exist before any of them can run. It also becomes the
// `X-Request-Id` response header on every response, so a user can quote it for support.
app.use(require('./middleware/request-id').requestId());

// Structured access log (§4.4). Mounted before the routers so its 'finish' listener sees the
// route template Express resolved; static assets and the container probe are excluded there.
app.use(require('./lib/logger').accessLog());

// Behind nginx / Tailscale, req.ip is the proxy's address unless the hop count is
// declared — which would make every user share one rate-limit bucket. See
// src/lib/rate-limit.js for the reasoning; defaults to loopback (same-host proxy).
const { trustProxySetting, loginLimiter, writeLimiter, globalLimiter } = require('./lib/rate-limit');
app.set('trust proxy', trustProxySetting());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(layouts);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ORDER MATTERS (TECH-SPEC §3.10), and getting it wrong is subtle:
// security headers + rate limiters must sit BEFORE the CSRF middleware, not after.
// A limiter only counts what flows through it; with CSRF first, a token-less POST
// is rejected with 403 before the limiter ever sees it, so an attacker could spray
// unlimited requests by simply omitting the token. Similarly, a 403 rendered by
// CSRF would ship without the security headers.
app.use(require('./lib/security-headers').securityHeaders());
app.use(globalLimiter);
app.use('/login', loginLimiter);
app.use('/api/imports', writeLimiter);

// must sit after cookies + body parsing, before routes
app.use(require('./lib/csrf').csrf);

app.use(express.static(path.join(__dirname, '..', 'assets')));

// Resolve the signed-in user + sidebar locals (user name, role, initials, admin
// flag) on every request, so every page — including 403/404 — renders correctly.
app.use(require('./middleware/auth').attachUser);

// Health endpoints (module 9 part 9.2, TECH-SPEC §4.3). Mounted BEFORE the page routers on
// purpose: /health/live and /health/ready must answer a Docker HEALTHCHECK with no session, and
// everything mounted after this point is behind a page guard. /system/health inside this router
// applies its own requirePage+requireAdmin.
app.use(require('./routes/health'));

app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/api'));
app.use(require('./routes/projects'));
app.use(require('./routes/master'));
// WBS tree (module 7 part 7.1) and the resource plan (part 7.3) — both
// project-scoped, so they mount with the other project screens rather than with the
// org-wide admin routes.
app.use(require('./routes/wbs'));
app.use(require('./routes/rbs'));
app.use(require('./routes/cbs'));
// Baseline freeze + the BCR change-control workflow (part 7.6).
app.use(require('./routes/bcr'));
// Receivable / aging reports (module 8 part 8.3). Project-scoped like the WBS/CBS
// screens, and it is where the sidebar's restored "Reports" link lands.
app.use(require('./routes/reporting'));
app.use(require('./routes/app'));

// 404 + error handlers live in lib/error-handler.js so tests can reach them (they
// were inline here, which is exactly why the JSON-vs-HTML defect went unnoticed).
const { notFoundHandler, errorHandler } = require('./lib/error-handler');
app.use(notFoundHandler);
app.use(errorHandler);

// Exported so tests can inspect the route table WITHOUT binding a port
// (TEST_PLAN §12f asserts every page route is guarded — a structural check that
// a hand-maintained list of "public paths" cannot perform). `server.boot` is the
// real entry point; requiring this module no longer starts a listener.
module.exports = app;

// The job runner (module 9 part 9.1, TECH-SPEC §4.5). Started inside boot() rather than at require
// time, deliberately: requiring this module is what every test does, and a timer that starts on
// require would leave a scheduler running in tests that never wanted one.
//
// `recoverStale()` runs BEFORE the first tick and before traffic is accepted, so a job interrupted
// by the previous process is returned to the queue rather than sitting in `running` forever (§4.5's
// crash-recovery rule). It is the one piece of job state that must be repaired at boot.
module.exports.boot = () => {
  const jobs = require('./lib/jobs');
  const recovered = jobs.recoverStale();
  if (recovered) console.log(`jobs: recovered ${recovered} job(s) interrupted by the last shutdown`);

  // The hourly database backup (module 9 part 9.4, TECH-SPEC §4.2/§12.6, TS-13/TS-14). Registered
  // BEFORE the ticker starts so the first tick can already see the job type; registering after
  // would make the opening ticks complain about an unmounted type.
  //
  // The first enqueue is DELIBERATE and it is the point of the feature: TS-14 locks an RPO of one
  // hour, and a pipeline that waits an hour before its first snapshot leaves exactly the window it
  // promised to protect completely unprotected — which is always the window that matters, because
  // it is the one starting the moment the app goes live. `enqueueHourlyBackup` is a no-op if a
  // backup is already recent, so a restart loop does not produce a burst of snapshots.
  const backup = require('./lib/backup-service');
  backup.registerBackupJob(jobs);
  const first = backup.enqueueHourlyBackup(jobs);
  console.log(first.enqueued
    ? 'backup: first snapshot queued'
    : `backup: skipped startup snapshot (${first.reason})`);

  jobs.start({
    intervalMs: 60_000,
    // Each tick asks whether an hourly snapshot is due. The check is cheap and reads the backup
    // directory, not the database.
    onTick: () => { try { backup.enqueueHourlyBackup(jobs); } catch (e) { console.error('[backup] tick:', e.message); } },
  });

  return app.listen(PORT, () => {
    console.log(`PRACTIS on http://localhost:${PORT}`);

    // Drain ONCE, immediately, rather than waiting up to a full 60s tick. Without this the
    // snapshot is only QUEUED at boot and the first recovery copy of a newly-started deployment
    // is delayed by a whole tick — during exactly the window TS-14's one-hour RPO is supposed to
    // cover. Deferred with `setImmediate` so it runs AFTER the listener is accepting connections:
    // a slow snapshot must never delay startup, and the runner already logs a failed job.
    setImmediate(() => {
      jobs.drain().catch((e) => console.error('[backup] startup drain:', (e && e.message) || e));
    });
  });
};

// Only listen when run directly (`node src/server.js`), not when required.
if (require.main === module) module.exports.boot();
