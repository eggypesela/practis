// Auth: session cookie (random token, hash stored in sessions table per TS-02),
// page guard redirects, API guard returns JSON. Argon2id + lockout + invites
// land with the auth feature (TS-01) — this is the session skeleton only.
const db = require('../db/db');
const crypto = require('crypto');

const SESSION_COOKIE = 'practis_sid';
const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 12 * 60 * 60 * 1000;

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
  if (!token) return;
  db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
    .run(sha256(token));
}

function loadUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const s = db.prepare(`
    SELECT s.user_id, s.expires_at, s.last_seen_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.revoked_at IS NULL`).get(sha256(token));
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { destroySession(token); return null; }
  if (Date.now() - new Date(s.last_seen_at).getTime() > IDLE_MS) {
    destroySession(token);
    return null;
  }
  // sliding window: bump last_seen (cheap, throttled to once/min by app usage)
  db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(sha256(token));
  return s;
}

function requirePage(req, res, next) {
  req.user = loadUser(req);
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAuth(req, res, next) {
  req.user = loadUser(req);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

module.exports = { SESSION_COOKIE, createSession, destroySession, loadUser, requirePage, requireAuth };