const express = require('express');
const router = express.Router();
const { SESSION_COOKIE, createSession, destroySession } = require('../middleware/auth');
const q = require('../db/queries');

router.get('/login', (req, res) => {
  if (req.cookies?.[SESSION_COOKIE]) return res.redirect('/');
  res.render('login', { layout: 'layout-auth', title: 'Sign in' });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? q.userByEmail(String(email).trim()) : null;

  // PBKDF2 scaffold verify — Argon2id replaces this (TS-01).
  const ok = user && user.is_active !== 0 && verify(user.password_hash, password || '');
  if (!ok) {
    return res.status(401).render('login', {
      layout: 'layout-auth', title: 'Sign in', error: 'Invalid email or password', email,
    });
  }
  const token = createSession(user.id, req);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  dbTouch(user.id);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.render('logout', { layout: 'layout-auth', title: 'Signed out' });
});

function dbTouch(userId) {
  try {
    require('../db/db').prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(userId);
  } catch { /* non-fatal */ }
}

function verify(stored, provided) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'pbkdf2') return false;
  const [, iter, salt, hash] = parts;
  const h = require('crypto').pbkdf2Sync(provided, salt, Number(iter), 32, 'sha256').toString('hex');
  return h === hash;
}

module.exports = router;