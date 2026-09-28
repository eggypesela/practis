// Shared test helper: fetch a CSRF token + cookie pair from a running PRACTIS
// server, the way a browser would (GET the page, read the token, echo the cookie).
//
// Any POST in a test must carry the token now that the csrf middleware is wired
// in server.js, so tests use this instead of hand-rolling the dance.
const SID = 'practis_sid';
const CSRF = 'practis_csrf';

function tokenFromHtml(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/)
    || html.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

// Minimal per-client cookie jar (Node's fetch has none).
function jar() {
  return { c: {} };
}
function header(j) {
  return Object.entries(j.c).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(j, res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (v === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) delete j.c[k];
    else j.c[k] = v;
  }
  return res;
}

function client(origin) {
  const j = jar();
  return {
    j,
    cookieHeader: () => header(j),
    get: async (p) => absorb(j, await fetch(origin + p, { redirect: 'manual', headers: { cookie: header(j) } })),
    // POST automatically attaches the current token, like a rendered form would.
    post: async (p, body, extra = {}) => {
      const sep = body && body.length ? '&' : '';
      const full = `${body || ''}${sep}_csrf=${encodeURIComponent(j.c[CSRF] || '')}`;
      return absorb(j, await fetch(origin + p, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: header(j), ...extra },
        body: full,
      }));
    },
    // POST deliberately omitting the token (negative tests).
    postNoToken: async (p, body) => absorb(j, await fetch(origin + p, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: header(j) },
      body: body || '',
    })),
    token: () => j.c[CSRF] || null,
  };
}

// Log in a client and return it, ready for authed requests.
async function loggedIn(origin, email, password) {
  const c = client(origin);
  await c.get('/login');                       // sets csrf cookie
  const res = await c.post('/login', `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`);
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  // The session cookie changed at login, and the token is bound to the session,
  // so the pre-login token is now stale — fetch a page to mint a fresh one.
  await c.get('/');
  return c;
}

module.exports = { client, loggedIn, tokenFromHtml, SID, CSRF };
