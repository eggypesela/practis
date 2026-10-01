// Rate limiting (TECH-SPEC §3.6). Decision 3A: express-rate-limit approved.
//
// WHY THIS EXISTS SEPARATELY FROM ACCOUNT LOCKOUT
// Account lockout (AU1.1 `locked_until`) only fires after 5 failures FOR ONE
// ACCOUNT. An attacker spraying 1,000 different emails never trips it. This
// limiter keys on the CLIENT IP, so credential stuffing from one host is capped
// regardless of how many accounts it tries.
//
// THE trust proxy TRAP
// nginx / Tailscale sits in front of this app. Without `trust proxy`, req.ip is
// the PROXY's address, so every user shares one bucket and the limiter throttles
// the whole world at once. With a wrong hop count, X-Forwarded-For is spoofable
// and the limiter is bypassable with a forged header. PRACTIS_TRUST_PROXY must be
// set to the real hop count by the operator; it defaults to loopback-only trust,
// which is correct for a proxy on the same host.
//
// 429 + Retry-After; windows are generous enough that a fat-fingered legitimate
// user cannot lock themselves out.

'use strict';

const { rateLimit } = require('express-rate-limit');

const MINUTE = 60 * 1000;

// Shared key: the client IP, as resolved by Express' trust-proxy setting.
// express-rate-limit v8 ships ipKeyGenerator for IPv6-safe normalisation — using
// a raw `req.ip` string lets one IPv6 host rotate through its /64 (and thus past
// the limit), so we let the library normalise it.
function keyGenerator(req) {
  return require('express-rate-limit').ipKeyGenerator(req.ip);
}

function makeLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',   // RateLimit-* headers
    legacyHeaders: false,
    keyGenerator,
    message: { error: { code: 'RATE_LIMITED', message } },
    // The handler decides the body shape: JSON for the API, plain for pages.
    // NOTE: for middleware mounted on a sub-path (`app.use('/api/imports', …)`)
    // Express strips the mount prefix from req.path, so a `req.path.startsWith
    // ('/api/')` check silently fails and a fetch() client gets plain text
    // ("Too many w…") that JSON.parse chokes on. req.originalUrl keeps the full
    // path, so that is what we test.
    handler: (req, res) => {
      res.status(429);
      const fullPath = req.originalUrl || req.url || '';
      if (fullPath.startsWith('/api/')) {
        return res.json({ error: { code: 'RATE_LIMITED', message } });
      }
      return res.type('text/plain').send(message);
    },
  });
}

// Limits are env-overridable so the test suite can run with generous values
// (many tests log in from 127.0.0.1, and a shared per-IP bucket would otherwise
// make unrelated tests flaky) while the DEDICATED rate-limit test spawns a
// server with deliberately tight values to prove limiting actually fires.
// Production defaults stay tight — the override exists for tests, not to weaken
// the deployed policy.
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Login: the credential-stuffing surface. 20 attempts / 15 min per IP is well
// above human error (the account locks at 5) but far below a useful spray rate.
const loginLimiter = makeLimiter({
  windowMs: envInt('PRACTIS_RL_LOGIN_WINDOW_MS', 15 * MINUTE),
  limit: envInt('PRACTIS_RL_LOGIN_MAX', 20),
  message: 'Too many sign-in attempts from this address. Wait 15 minutes and try again.',
});

// Import + correction endpoints are expensive (parse/insert whole files) and
// write the ledger, so they get a tighter, shorter window.
const writeLimiter = makeLimiter({
  windowMs: envInt('PRACTIS_RL_WRITE_WINDOW_MS', MINUTE),
  limit: envInt('PRACTIS_RL_WRITE_MAX', 30),
  message: 'Too many write requests. Slow down and try again in a minute.',
});

// Global backstop: generous, so normal browsing never notices it.
const globalLimiter = makeLimiter({
  windowMs: envInt('PRACTIS_RL_GLOBAL_WINDOW_MS', MINUTE),
  limit: envInt('PRACTIS_RL_GLOBAL_MAX', 300),
  message: 'Too many requests. Slow down and try again shortly.',
});

// Resolve the proxy hop count. `true`/`false`/number are all valid for Express.
function trustProxySetting(env = process.env) {
  const raw = env.PRACTIS_TRUST_PROXY;
  if (raw === undefined || raw === '') return 'loopback'; // same-host proxy
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 'loopback';
}

module.exports = { loginLimiter, writeLimiter, globalLimiter, trustProxySetting, makeLimiter };
