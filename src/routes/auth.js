const express = require('express');
const router = express.Router();
const { SESSION_COOKIE, createSession, destroySession } = require('../middleware/auth');
const q = require('../db/queries');
const pwd = require('../lib/password');

const MAX_FAILS = 5;
const LOCK_MIN = 15;

router.get('/login', (req, res) => {
  if (req.cookies?.[SESSION_COOKIE]) return res.redirect('/');
  res.render('login', { layout: 'layout-auth', title: 'Sign in' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? q.userByEmail(String(email).trim()) : null;

  // Lockout check FIRST (never reveal lock state for unknown accounts — same generic error).
  const now = new Date();
  const lockedUntil = user?.locked_until ? new Date(user.locked_until + 'Z') : null;
  if (user && lockedUntil && lockedUntil > now) {
    await pwd.burn(); // timing equalizer
    return res.status(429).render('login', {
      layout: 'layout-auth', title: 'Sign in',
      error: 'Too many sign-in attempts. Try again in a few minutes.', email,
    });
  }

  const result = await pwd.verifySafe(user?.password_hash, password || '', !!user);
  // NEEDS_REHASH means the password WAS correct but stored with the legacy scheme —
  // upgrade it in place and treat the login as valid.
  const valid = result === true || result === pwd.NEEDS_REHASH;
  if (result === pwd.NEEDS_REHASH) {
    const fresh = await pwd.hash(password || '');
    q.setPasswordHash(user.id, fresh); // legacy pbkdf2 → argon2id, in-place
    q.audit('users', user.id, 'password_auto_rehash', user.id, null, { scheme: 'argon2id' });
  }

  if (!valid || (user && user.is_active !== 1)) {
    if (user) {
      q.loginFail(user.id);
      q.audit('users', user.id, 'login_failed', user.id, null, { ip: req.ip });
    }
    return res.status(401).render('login', {
      layout: 'layout-auth', title: 'Sign in', error: 'Invalid email or password', email,
    });
  }

  q.loginOk(user.id); // clears failed counter + lockout
  q.audit('users', user.id, 'login_success', user.id, null, { ip: req.ip });
  const token = createSession(user.id, req);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  try {
    require('../db/db').prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  } catch { /* non-fatal */ }
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  res.render('logout', { layout: 'layout-auth', title: 'Signed out' });
});

module.exports = router;