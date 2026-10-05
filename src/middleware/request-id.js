'use strict';
//
// Request IDs — TECH-SPEC §4.4 ("request ID returned on errors; user can quote it for support").
//
// Mounted FIRST, before the access log and before every route, so that:
//   * every log line for one request carries the same id, and
//   * an error rendered by the 404/500 handlers can name it.
//
// The id is echoed back on EVERY response as `X-Request-Id` (not only on errors): a proxy,
// a browser network tab, or the user can then quote it without having to trigger a failure
// first. That is the whole point of a support correlation id.
//
// Source: an inbound `X-Request-Id` is TRUSTED and reused when it is a sane token. This makes
// the id survive a reverse proxy (Tailscale Serve, nginx) that already assigned one — two
// different ids for the same request would defeat the correlation. The sanity check matters:
// the header is attacker-controlled, and echoing an arbitrary value back into a RESPONSE HEADER
// invites header/response splitting and log injection. Anything that is not
// [A-Za-z0-9._-] and 8..200 chars is discarded and a fresh id is minted.

const crypto = require('crypto');

const SAFE = /^[A-Za-z0-9._-]{8,200}$/;

function newRequestId() {
  // 128 bits from the CSPRNG. Not Math.random: an id that can be guessed can be used to spray
  // a log or to impersonate another user's support case.
  return crypto.randomBytes(16).toString('hex');
}

/** The id to use for this request: a sane inbound one, else a fresh id. Pure, so it is testable. */
function idFor(inbound) {
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  if (typeof value === 'string' && SAFE.test(value)) return value;
  return newRequestId();
}

function requestId() {
  return function requestIdMw(req, res, next) {
    req.id = idFor(req.headers && req.headers['x-request-id']);
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

module.exports = { requestId, idFor, newRequestId, SAFE };
