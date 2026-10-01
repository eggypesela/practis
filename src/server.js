const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const layouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3003;

// migrate before serving (idempotent, fast when current)
require('./db/migrate');
require('./db/seed');

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

app.use(require('./routes/auth'));
app.use(require('./routes/admin'));
app.use(require('./routes/api'));
app.use(require('./routes/projects'));
app.use(require('./routes/app'));

// 404 + error handler
app.use((req, res) => res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => console.log(`PRACTIS on http://localhost:${PORT}`));
