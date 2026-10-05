'use strict';
//
// Structured logging — TECH-SPEC §4.4.
//
// ============================================================================================
// WHY THE LINE-BUILDING IS A SEPARATE PURE FUNCTION
// ============================================================================================
// §4.4 lists the fields a log line must carry (UTC time, request ID, method, route template,
// status, duration, user id when authenticated, error code) and then forbids a set of things
// (query string, request body, cookies, secrets). Both halves are rules about the SHAPE of a
// value. Keeping that shape in `accessLine()` — a pure function of a plain object — means the
// rules can be tested directly, without booting a server or capturing stdout, and that the
// middleware below cannot quietly widen what is logged.
//
// ============================================================================================
// WHAT IS DELIBERATELY NOT LOGGED
// ============================================================================================
//   * the QUERY STRING, and on an unmatched route the RAW PATH too. §4.4 forbids the query
//     string outright; the raw path of a 404 is attacker-controlled input, so echoing it into a
//     log is a log-injection vector (".../x\n{"level":"info","msg":"backup ok"}"). Unmatched
//     requests are recorded as the literal template `unmatched` instead. A support case can still
//     be tied to the request ID.
//   * the request body, cookies and headers, for the same reasons.
//
// The route is logged as the Express TEMPLATE (`/projects/:id`), never the filled path, so ids
// and other user data do not end up in an operational log.

const os = require('os');

/** UTC ISO-8601 to the second, e.g. 2026-10-05T02:14:33Z. Matches the SQLite datetime format. */
function stamp(at = new Date()) {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the log object for one finished request. Pure: same input → same output, no I/O.
 *
 * @param {object} r
 * @param {Date}   r.at          when the request finished
 * @param {string} r.requestId   §4.4's correlation id (always present)
 * @param {string} r.method      GET/POST/…
 * @param {string} r.route       Express route template, or the literal 'unmatched'
 * @param {number} r.status      response status code
 * @param {number} r.durationMs  wall time
 * @param {any}    [r.userId]    omitted entirely when anonymous
 * @param {string} [r.errorCode] stable code for a failed request
 */
function accessLine({ at, requestId, method, route, status, durationMs, userId, errorCode }) {
  const line = {
    time: stamp(at),
    level: 'info',
    msg: 'request',
    requestId,
    method,
    route,
    status,
    durationMs,
  };
  // Only add what exists: `userId: null` for an anonymous visitor is noise that makes a log
  // grep for a real user harder, and §4.4 says "user ID WHEN authenticated".
  if (userId !== undefined && userId !== null) line.userId = userId;
  if (errorCode) line.errorCode = errorCode;
  return line;
}

/**
 * A stable code for a failed request. §4.4 asks for an "error code" field; status alone cannot
 * distinguish "you are signed out" from "you are not allowed" from "you are rate limited" —
 * three different faults that all read as 401/403.
 */
function errorCodeFor(status) {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 429: return 'RATE_LIMITED';
    default: return status >= 500 ? 'INTERNAL' : undefined;
  }
}

// Static assets and the container probe are polled constantly; logging them would bury the
// business/security events §4.4 actually wants in the log. `/health/live` and `/health/ready`
// are hit by the Docker HEALTHCHECK every 30s (~2,880 lines/day for no signal); the operator
// page `/system/health` is NOT in this list and is always logged.
const QUIET = /^\/(assets|fonts|favicon\.ico|health\/live$|health\/ready$)/;

function shouldLogAccess(url) {
  return !QUIET.test(String(url || ''));
}

/** The route template for `req`, or 'unmatched'. Uses baseUrl + route.path so a router mounted
 *  at `/projects` reports `/projects/:id` rather than a bare `/:id`. */
function routeTemplate(req) {
  const path = req && req.route && req.route.path;
  if (!path) return 'unmatched';
  return (req.baseUrl || '') + path;
}

/**
 * Emit one line. JSON in production (§4.4 "JSON structured logs in production"), human-readable
 * when explicitly asked for locally. JSON is the default because the failure mode we cannot
 * afford is a production box emitting prose that nothing can parse.
 */
function emit(obj) {
  const json = process.env.PRACTIS_LOG_FORMAT !== 'text';
  if (json) {
    process.stdout.write(JSON.stringify(obj) + '\n');
    return;
  }
  // Text shape depends on which line this is. An ERROR line has no method/route/status (it is not
  // a request), and blindly joining those fields printed the literal "undefinedms" — harmless but
  // exactly the kind of noise that makes someone distrust the log.
  const bits = [obj.time, obj.level, obj.msg];
  if (obj.method) bits.push(obj.method);
  if (obj.route) bits.push(obj.route);
  if (obj.status !== undefined) bits.push(String(obj.status));
  if (typeof obj.durationMs === 'number') bits.push(`${obj.durationMs}ms`);
  if (obj.requestId) bits.push(obj.requestId);
  if (obj.userId) bits.push(`user=${obj.userId}`);
  if (obj.errorCode) bits.push(obj.errorCode);
  if (obj.err) bits.push(obj.err);
  process.stdout.write(bits.filter(Boolean).join(' ') + '\n');
}

/**
 * The access-log middleware. Mounted early, BEFORE the routers, so it sees
 * `req.route` once the response finishes — a 'finish' listener reads the route
 * Express resolved, which is only known after routing has happened.
 */
function accessLog() {
  return function accessLogMw(req, res, next) {
    if (!shouldLogAccess(req.originalUrl || req.url)) return next();
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      emit(accessLine({
        at: new Date(),
        requestId: req.id,
        method: req.method,
        route: routeTemplate(req),
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        userId: req.user && req.user.id,
        errorCode: errorCodeFor(res.statusCode),
      }));
    });
    next();
  };
}

/** Operational error line (a crash, a failed job). Not a request — no requestId required. */
function error(msg, err) {
  emit({
    time: stamp(),
    level: 'error',
    msg,
    err: err ? String((err && err.stack) || err.message || err).split(os.EOL)[0] : undefined,
  });
}

module.exports = { accessLog, accessLine, errorCodeFor, shouldLogAccess, routeTemplate, stamp, error };
