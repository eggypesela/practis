'use strict';
//
// The 404 and 500 handlers, extracted from server.js so they can be TESTED.
//
// Why this module exists: the error handlers were inline in server.js where no
// test could reach them, and the 500 handler answered
// `res.json({error:'internal error'})` for EVERY request. A signed-in user
// hitting a crashing page therefore saw the raw string {"error":"internal error"}
// in the browser — no page, no navigation, no explanation. Content negotiation is
// the fix: a browser gets an HTML page, a fetch()/XHR client still gets JSON.

/**
 * Unknown URL. 404 — never a redirect to /login.
 *
 * Deliberately NOT gated on a session: an anonymous visitor who mistypes a URL
 * must be told the page does not exist, on a real rendered page. (The old failure
 * mode was a 302 to /login, which made a typo look like an expired session.)
 */
function notFoundHandler(req, res) {
  res.status(404).render('404', {
    layout: 'layout-app',
    title: 'Not found',
    subtitle: '',
  });
}

/**
 * Unhandled error. Status 500 either way; the SHAPE depends on what asked.
 *
 * `Accept: text/html` (a browser navigation) → the 500 page.
 * anything else (fetch/XHR, `Accept: application/json`) → JSON, so the import UI
 * and other clients keep parsing a stable contract instead of HTML.
 */
function errorHandler(err, req, res, next) {
  // Log the whole error server-side; never leak the stack or message to the client
  // (it can name tables, paths and columns — an information disclosure).
  //
  // Logged as a STRUCTURED error line (§4.4) carrying the request id, so a crash can be tied to
  // the one request that caused it. The stack goes to the log, never to the response.
  const { error: logError } = require('./logger');
  logError('unhandled_error', err);

  // If the response already started, we cannot rewrite it — hand back to Express,
  // which destroys the socket. Without this the client hangs on a half-written body.
  if (res.headersSent) return next(err);

  const accept = String(req.headers?.accept || '');
  const url = String(req.originalUrl || req.url || '');

  // Two signals, because either alone gets a real client wrong:
  //   - the URL space: `/api/*` is consumed by fetch() and must always parse as
  //     JSON. Relying on Accept alone breaks the import UI when it sends `*/*`
  //     (fetch's default) and a route throws — JSON.parse chokes on "<!DOCTYPE".
  //   - Accept: a browser navigation outside /api/ expects a page, and that is the
  //     normal case. Only an EXPLICIT JSON preference (and no HTML preference)
  //     switches an /api/-less request to JSON.
  const isApi = url.startsWith('/api/');
  const prefersJson = accept.includes('application/json') && !accept.includes('text/html');

  // §4.4: "Request ID returned on errors; user can quote it for support." The id is already on
  // the X-Request-Id response header (middleware/request-id.js); it is repeated in the body
  // because a user reading a 500 page will quote what is ON the page, not a response header.
  //
  // Omitted entirely when the request has no id (the middleware always sets one in the real app,
  // but a direct unit call need not). `{requestId: undefined}` would still be a KEY, which changes
  // the response shape depending on how the handler was reached — a contract that differs by
  // caller is worse than one that omits an absent field.
  if (isApi || prefersJson) {
    const body = { error: 'internal error' };
    if (req.id) body.requestId = req.id;
    return res.status(500).json(body);
  }

  return res.status(500).render('500', {
    layout: 'layout-app',
    title: 'Something went wrong',
    subtitle: '',
    requestId: req.id,
  });
}

module.exports = { notFoundHandler, errorHandler };
