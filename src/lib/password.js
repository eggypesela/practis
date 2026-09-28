// Argon2id password hashing (TS-01). OWASP memory guidance: m=64 MiB, t=3, p=4.
const argon2 = require('argon2');
const crypto = require('crypto');

function hash(raw) {
  return argon2.hash(raw);
}

async function verify(stored, raw) {
  stored = String(stored || '');
  if (stored.startsWith('$argon2id$')) {
    return argon2.verify(stored, raw || '');
  }
  // legacy scaffold pbkdf2$ prefix — login rehashes on success (see auth.js)
  const parts = stored.split('$');
  if (parts[0] !== 'pbkdf2') return false;
  const [, iter, salt, h] = parts;
  const candidate = crypto.pbkdf2Sync(raw || '', salt, Number(iter), 32, 'sha256').toString('hex');
  return candidate === h;
}

const NEEDS_REHASH = Symbol('needs rehash');

// Timing equalizer (TS-01 3.1): when the account doesn't exist, burn one real
// Argon2id hash+verify so response time doesn't leak account existence.
async function burn() {
  await argon2.hash(crypto.randomUUID());
}

async function verifySafe(stored, raw, userExists) {
  if (!userExists) {
    await burn();
    return false;
  }
  const ok = await verify(stored, raw);
  if (!ok) return false;
  if (String(stored).startsWith('pbkdf2$')) return NEEDS_REHASH;
  return true;
}

module.exports = { hash, verify, verifySafe, NEEDS_REHASH, burn };