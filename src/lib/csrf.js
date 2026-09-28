// CSRF protection — signed double-submit token bound to the session (TS-01/TECH-SPEC §3.1).
//
// Why signed, not plain double-submit: a bare "cookie must equal form field" check is
// defeatable by an attacker who can set a cookie on the victim's browser. Here the
// token is nonce.HMAC(secret, nonce|sessionId), so a forged cookie cannot carry a
// signature valid for the victim's session.
const crypto = require('crypto');
const db = require('../db/db');
const { SESSION_COOKIE } = require('../middleware/auth');

const COOKIE = 'practis_csrf';
const FIELD = '_csrf';
const HEADER = 'x-csrf-token';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Secret lives in app_settings so tokens survive a restart (and stay consistent
// if the app is ever run behind more than one process).
function secret() {
  let row = db.prepare(`SELECT value FROM app_settings WHERE key = 'csrf_secret'`).get();
  if (row) return row.value;
  const v = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('csrf_secret', ?)`).run(v);
  row = db.prepare(`SELECT value FROM app_settings WHERE key = 'csrf_secret'`).get();
  return row.value;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

// Session binding: derived from the session cookie, so a token minted for one
// session is not accepted for another. Anonymous requests bind to ''.
//
// Known, accepted limitation: before a session exists, two anonymous clients
// share the empty binding, so a plain double-submit token is transferable.
// That is inherent to pre-auth double-submit, and the impact is bounded —
// an attacker who can plant a cookie could at worst forge a LOGIN submission
// (login CSRF), not any state-changing action: every authenticated POST binds
// to the session cookie, which is HttpOnly and unreadable from script.
function bind(req) {
  const sid = req.cookies?.[SESSION_COOKIE];
  return sid ? crypto.createHash('sha256').update(String(sid)).digest('hex') : '';
}

function issue(req) {
  const nonce = crypto.randomBytes(32).toString('hex');
  return `${nonce}.${sign(`${nonce}|${bind(req)}`)}`;
}

function verify(token, req) {
  if (typeof token !== 'string' || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const nonce = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expect = sign(`${nonce}|${bind(req)}`);
  if (given.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect));
}

// Middleware: exposes res.locals.csrfToken for forms, and rejects unsafe methods
// whose token is missing/forged. Rejection is 403 with the standard page.
function csrf(req, res, next) {
  let token = req.cookies?.[COOKIE];
  if (!verify(token, req)) {
    token = issue(req);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: MAX_AGE_MS,
      secure: process.env.PRACTIS_SECURE_COOKIES === '1',
    });
  }
  res.locals.csrfToken = token;

  if (SAFE_METHODS.has(req.method)) return next();

  // Body field first (plain form posts), header second (fetch/XHR callers).
  const sent = (req.body && req.body[FIELD]) || req.get(HEADER);
  if (!verify(sent, req)) {
    return res.status(403).render('403', { layout: 'layout-app', title: 'Request blocked', subtitle: '' });
  }
  next();
}

module.exports = { csrf, issue, verify, COOKIE, FIELD, HEADER };
