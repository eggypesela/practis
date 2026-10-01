// Auth: session cookie (random token, hash stored in sessions table per TS-02),
// page guard redirects, API guard returns JSON.
//
// Time handling: SQLite `datetime('now')` is UTC but has no timezone suffix, so
// `new Date('2026-09-28 01:30:00')` is parsed as *local* time by JS. That is a
// silent bug on any non-UTC host. All expiry/idle checks therefore compare
// `strftime('%s', col)` epoch integers inside SQLite, never JS Dates.
const db = require('../db/db');
const q = require('../db/queries');
const crypto = require('crypto');

const SESSION_COOKIE = 'practis_sid';
const IDLE_MS = 30 * 60 * 1000;   // 30 min idle (TS-16)
const ABS_MS = 12 * 60 * 60 * 1000; // 12 h absolute
const TOUCH_MS = 60 * 1000;       // throttle last_seen writes to once/min

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + ABS_MS).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, expires, req.ip || null, req.get('user-agent') || null);
  return token;
}

function destroySession(token) {
  if (!token) return false;
  const r = db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
    .run(sha256(token));
  return r.changes > 0;
}

// Session rotation (TS-01 3.1): revoke the presented session and mint a new one.
function rotateSession(oldToken, userId, req) {
  destroySession(oldToken);
  return createSession(userId, req);
}

// Revoke every active session for a user, optionally sparing one (the caller's
// fresh session). Used on password change / privilege change / disable.
function revokeUserSessions(userId, exceptToken) {
  const except = exceptToken ? sha256(exceptToken) : null;
  const r = db.prepare(`
    UPDATE sessions SET revoked_at = datetime('now')
    WHERE user_id = ? AND revoked_at IS NULL AND (? IS NULL OR id <> ?)`)
    .run(userId, except, except);
  return r.changes;
}

// Epoch-safe session lookup: expiry and idle windows are compared as integers
// derived by SQLite, so the result is identical on a UTC or a UTC+7 host.
function loadUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const s = db.prepare(`
    SELECT s.user_id, s.expires_at, s.last_seen_at, u.*,
           CAST(strftime('%s', s.expires_at) AS INTEGER)  AS exp_epoch,
           CAST(strftime('%s', s.last_seen_at) AS INTEGER) AS seen_epoch,
           CAST(strftime('%s','now') AS INTEGER)           AS now_epoch
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.revoked_at IS NULL`).get(id);
  if (!s) return null;

  const now = s.now_epoch;
  if (now > s.exp_epoch) { destroySession(token); return null; }              // absolute expiry
  if (now - s.seen_epoch > IDLE_MS / 1000) { destroySession(token); return null; } // idle timeout

  // sliding window, throttled so a busy request loop isn't a write per request
  if (now - s.seen_epoch > TOUCH_MS / 1000) {
    db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
  }
  return s;
}

// Resolves the signed-in user for every request that renders a page, and exposes
// the sidebar/topbar locals in one place. Without this, pages that render outside
// the app routes (403, 404, admin) would show an empty footer, and the sidebar
// could not tell an Administrator from a Viewer.
function attachUser(req, res, next) {
  req.user = loadUser(req);
  if (req.user) {
    const withRole = q.userWithRole(req.user.id);
    res.locals.isAdmin = req.user.is_system_admin === 1;
    res.locals.userName = req.user.full_name || req.user.email;
    res.locals.roleName = withRole?.role_name && withRole.role_name !== '—'
      ? withRole.role_name : (res.locals.isAdmin ? 'Administrator' : 'User');
    res.locals.initials = initialsOf(res.locals.userName);
  } else {
    res.locals.isAdmin = false;
  }
  next();
}

// "Ayu Kusuma" → "RC"; falls back to the first letter of an email.
function initialsOf(name) {
  const words = String(name || '').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function requirePage(req, res, next) {
  if (!req.user) req.user = loadUser(req);
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) req.user = loadUser(req);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Admin guard (TS-01 §3.4): the global system Administrator role is what gates
// user administration. Authorization is enforced here, in the route layer, not
// by hiding links in the UI — hidden buttons are usability only, never security.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.is_system_admin !== 1) {
    return res.status(403).render('403', {
      layout: 'layout-app', title: 'Not allowed',
      subtitle: 'Only an Administrator can manage users.',
      crumb: 'Administration / Users', active: '',
    });
  }
  next();
}

// Capability guard for JSON endpoints. The page guard in app.js renders a 403
// HTML page, which is correct for a browser navigation and wrong for fetch():
// the import UI parses JSON and would report "unexpected token <". Same rule,
// different representation. Audit blocker B4 — the import endpoints were
// `requireAuth` only, so any signed-in user could write ledger rows via CSV.
function requireApiCapability(flag, message) {
  const { capabilities } = require('../lib/permissions');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in first.' } });
    const caps = capabilities(req.user);
    if (!caps[flag]) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message } });
    }
    req.caps = caps;
    next();
  };
}

module.exports = {
  SESSION_COOKIE, IDLE_MS, ABS_MS,
  createSession, destroySession, rotateSession, revokeUserSessions,
  loadUser, attachUser, initialsOf, requirePage, requireAuth, requireAdmin,
  requireApiCapability,
};
