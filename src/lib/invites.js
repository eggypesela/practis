// Invitation service (TS-01 §3.1): an Administrator creates a user; the account
// starts disabled until the invitation is completed.
//
// Two distinct flows, deliberately:
//
//   inviteNewUser()  — email not on file. Creates a DISABLED user with an
//                      unusable random hash plus a pending invitation. The
//                      invitation is what activates the account, so the token
//                      must be shown to the admin for out-of-band delivery.
//
//   reissueInvite()  — account exists (e.g. created before, or re-inviting).
//                      Only mints a fresh token; never re-enables an account.
//
// sendInvite() returns an explicit `status` instead of a loose boolean so the
// caller can distinguish "token issued" from "no delivery channel configured"
// from each refusal reason — the UI must never claim delivery that didn't happen.
const crypto = require('crypto');
const q = require('../db/queries');
const policy = require('./policy');

const REISSUABLE = ['no_pending_invite', 'invite_expired', 'invite_used'];

function sendInvite({ email, fullName, roleCode, actorId }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return { status: 'invalid_email', error: 'Enter a valid email address.' };
  }
  const role = roleCode ? String(roleCode) : null;
  if (role && !q.roles().some((r) => r.code === role)) {
    return { status: 'invalid_role', error: 'Choose a role from the list.' };
  }

  const user = q.userByEmail(addr);

  const token = policy.makeToken();
  const tokenHash = policy.hashToken(token);

  // TS-17: no SMTP dependency in v1. The raw token lives in memory only and is
  // rendered once to the admin, who delivers it out of band.
  const link = `/invite/${token}`;

  if (user) {
    if (user.is_active === 1) {
      return { status: 'already_active', error: `${addr} already has an active account. Use Reset to issue a temporary password instead.` };
    }
    // Re-inviting an existing disabled account resets its single invitation row.
    q.insertInvite(addr, tokenHash, actorId, role || user.role_code || null);
    q.audit('users', user.id, 'invite_reissued', actorId, null, { email: addr, role: role || user.role_code || null });
    return { status: 'ok', link, email: addr, reissued: true };
  }

  if (!fullName || !String(fullName).trim()) {
    return { status: 'invalid_name', error: 'Full name is required for a new user.' };
  }

  // Disabled account + unusable password: the hash is random and never
  // disclosed, so the account cannot be signed into until setup completes.
  const ghost = policy.hashToken(crypto.randomUUID());
  const info = q.insertUser(addr, String(fullName).trim(), `invite-pending$${ghost}`);
  const userId = Number(info.lastInsertRowid);
  if (role) q.setUserRole(userId, role, actorId);
  q.insertInvite(addr, tokenHash, actorId, role);
  q.audit('users', userId, 'invite_created', actorId, null, { email: addr, role: role || null });

  return { status: 'ok', link, email: addr, created: true, userId };
}

// Re-issue: resets the single invitation row for that email (see _upsertInvite),
// so the previous link stops working immediately.
function resendInvite({ inviteId, actorId }) {
  const inv = q.inviteById(inviteId);
  if (!inv) return { status: 'not_found', error: 'That invitation no longer exists.' };

  const raw = policy.makeToken();
  q.insertInvite(inv.email, policy.hashToken(raw), actorId, inv.role_id);
  // Audit against the USER the invitation belongs to (actor = the admin who
  // acted), so the trail is queryable per account.
  const user = q.userByEmail(inv.email);
  q.audit('users', user ? user.id : null, 'invite_reissued', actorId, null,
    { email: inv.email, replaced_invite_id: inv.id });
  return { status: 'ok', link: `/invite/${raw}`, email: inv.email };
}

// Consume an invitation: set the password, activate the account, clear pending
// invitations. Returns an explicit status for the same reason as sendInvite.
async function acceptInvite({ rawToken, password, confirm }) {
  const invalid = { status: 'invalid_token', error: 'This invitation link is not valid or has expired.' };
  if (!rawToken) return invalid;

  const inv = q.inviteForToken(policy.hashToken(rawToken));
  if (!inv) return invalid;

  const policyError = policy.validatePassword(password, confirm);
  if (policyError) return { status: 'weak_password', error: policyError, email: inv.email };

  const user = q.userByEmail(inv.email);
  if (!user) return invalid;

  q.setPasswordHash(user.id, await policy.hashPassword(password));
  q.loginOk(user.id);            // clear any stale lockout/counters
  q.setUserActive(true, user.id); // completion enables the account (TS-01)
  q.consumeInvite(inv.id);
  q.revokePendingInvitesForEmail(inv.email); // single-use: retire any siblings
  q.audit('users', user.id, 'invite_accepted', user.id, null, { email: inv.email });
  q.audit('users', user.id, 'user_enabled', user.id, { is_active: 0 }, { is_active: 1 });

  return { status: 'ok', email: inv.email };
}

module.exports = { sendInvite, resendInvite, acceptInvite };
