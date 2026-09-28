// Account/token policy (TS-01 §3.1). Kept apart from routes so the *numbers*
// live in one place and can be asserted directly by tests.
const crypto = require('crypto');
const argon2 = require('argon2');

// "Password minimum: 12 characters. No composition rules." — deliberately no
// character-class rules; length is the only requirement the spec sets.
const PASSWORD_MIN = 12;

// Password setup/reset tokens: random, single-use, short-lived (72 h per TS-01).
const TOKEN_BYTES = 32;              // 256 bits of CSPRNG entropy
const TOKEN_TTL_HOURS = 72;

// Invitation token as given to the admin. The raw value is shown once; only the
// SHA-256 is stored, so a leaked DB cannot be used to accept an invitation.
function makeToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Admin-issued temporary password (TS-17: admin-only reset, out-of-band delivery).
// Shape: 4 groups of 4 from an unambiguous alphabet. 64 bits of entropy, exactly
// 19 chars, so it satisfies the 12-char minimum without composition rules.
// Ambiguous glyphs (0/O, 1/l/I) are excluded because a human retypes this.
const SAFE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeTempPassword(groups = 4, size = 4) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let chunk = '';
    for (let i = 0; i < size; i++) {
      // rejection-free: alphabet length divides evenly enough for this purpose
      chunk += SAFE_ALPHABET[crypto.randomInt(SAFE_ALPHABET.length)];
    }
    out.push(chunk);
  }
  return out.join('-');
}

function hashPassword(raw) {
  return argon2.hash(raw);
}

// Returns null when the password satisfies policy, else a human-readable reason.
// One function so the same rule guards invite-accept, admin reset and any future
// change-password route.
function validatePassword(raw, confirm) {
  const pw = String(raw ?? '');
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (confirm !== undefined && pw !== String(confirm ?? '')) return 'The two passwords do not match.';
  return null;
}

module.exports = {
  PASSWORD_MIN, TOKEN_TTL_HOURS,
  makeToken, hashToken, makeTempPassword, hashPassword, validatePassword,
};
