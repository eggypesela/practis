// Security headers (TECH-SPEC §3.6, §3.10).
//
// CSP uses a per-response NONCE rather than 'unsafe-inline'. The app has real
// inline <script> blocks (views/queue.ejs, entry.ejs, import.ejs, layout-app.ejs)
// plus inline style="" attributes, so a bare `default-src 'self'` would break the
// import screen. Nonces keep the strictness that matters — an injected <script>
// cannot guess the nonce — while the scripts we actually ship still run.
//
// style-src keeps 'unsafe-inline' deliberately. Every view uses style="..." on
// layout divs; moving those to classes is a refactor worth doing later, and
// style injection is a far lower risk than script injection. This is a conscious
// trade-off, recorded in the audit, not an oversight.
//
// Placement (TECH-SPEC §3.10): after cookies/body parsing, before routes. The
// nonce must exist before any render, so this sits above the routers.

'use strict';

const crypto = require('crypto');

// Per-response nonce: 16 random bytes, base64 (matches the CSP grammar).
function makeNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function buildCsp(nonce, opts) {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // frame-ancestors is the modern equivalent of X-Frame-Options: DENY; both are
    // sent so old browsers that ignore CSP still refuse framing.
    "frame-ancestors 'none'",
  ];

  // Only upgrade to HTTPS when we are actually serving HTTPS — sending HSTS on a
  // plain-HTTP local dev box would pin the browser to a scheme that is not there.
  if (opts.https) directives.push('upgrade-insecure-requests');

  return directives.join('; ');
}

function securityHeaders(opts = {}) {
  // `https: true` forces HTTPS-only headers on; `false` forces them off; leaving
  // it undefined auto-detects per request (behind a proxy, trust proxy + XFP).
  const https = opts.https;

  return (req, res, next) => {
    const nonce = makeNonce();
    res.locals.cspNonce = nonce;

    const isHttps = https === undefined ? req.secure === true : https === true;

    res.setHeader('Content-Security-Policy', buildCsp(nonce, { https: isHttps }));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Cross-origin isolation for the app's own resources; the app embeds nothing.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    if (isHttps) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}

module.exports = { securityHeaders, buildCsp, makeNonce };
