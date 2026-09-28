// User administration (TS-01 §3.1 / TS-17). Administrator-only, enforced by
// requireAdmin in the route layer. Every mutation is audited.
//
//   GET  /admin/users            list + invite form + pending invitations
//   POST /admin/users            create/invite a user (issues a setup token)
//   POST /admin/users/:id/active enable/disable
//   POST /admin/users/:id/role   change global role (revokes their sessions)
//   POST /admin/users/:id/reset  issue a temporary password, revoke sessions
//   POST /admin/invitations/:id/resend   new token for a pending invitation
//   POST /admin/invitations/:id/revoke   cancel a pending invitation
//
// Public (unauthenticated) invitation acceptance:
//   GET  /invite/:token          set-password form
//   POST /invite/:token          set password → account activated
const express = require('express');
const router = express.Router();
const q = require('../db/queries');
const policy = require('../lib/policy');
const invites = require('../lib/invites');
const { requirePage, requireAdmin } = require('../middleware/auth');

const ID_RE = /^\d+$/;
const idOf = (raw) => (ID_RE.test(String(raw)) ? Number(raw) : null);
const actorOf = (req) => req.user?.id ?? null;

// Same project switcher contract as routes/app.js, so the sidebar renders
// identically on the administration screen.
function projectContext(req, res, next) {
  const all = q.projects();
  res.locals.project = all.find((p) => p.id === Number(req.query.project)) || all[0] || null;
  next();
}

// Every render of the users screen shares these locals. One function keeps the
// success and error paths from drifting apart.
function userLocals(res, extra = {}) {
  const users = q.allUsers();
  return {
    layout: 'layout-app',
    title: 'Users & roles',
    crumb: 'Administration / Users & roles',
    active: 'Users',
    projectName: res.locals.project?.name || 'No project',
    roles: q.roles(),
    users,
    invitesPending: q.pendingInvites(),
    activeCount: users.filter((u) => u.is_active === 1).length,
    pendingCount: users.filter((u) => u.is_active === 0).length,
    adminCount: q.adminCount(),
    ...extra,
  };
}

const guard = [requirePage, projectContext, requireAdmin];

router.get('/admin/users', guard, (req, res) => {
  const raw = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
  res.render('admin-users', userLocals(res, {
    subtitle: 'Accounts, roles and invitations · Administrator only',
    flash: typeof req.query.saved !== 'undefined',
    savedMsg: raw(req.query.msg),
    // The raw token exists for exactly one render, immediately after issuing.
    issuedLink: raw(req.query.token) ? `/invite/${raw(req.query.token)}` : null,
    invitedEmail: raw(req.query.email),
  }));
});

router.post('/admin/users', guard, (req, res) => {
  const result = invites.sendInvite({
    email: req.body.email,
    fullName: req.body.full_name,
    roleCode: req.body.role,
    actorId: actorOf(req),
  });

  if (result.status !== 'ok') {
    return res.status(400).render('admin-users', userLocals(res, {
      subtitle: 'The invitation could not be created',
      error: result.error,
      form: {
        email: req.body.email || '',
        full_name: req.body.full_name || '',
        role: req.body.role || '',
      },
    }));
  }

  // The one-time token rides the redirect rather than a re-render, so a browser
  // refresh can't silently mint a second invitation.
  const token = String(result.link || '').split('/invite/')[1] || '';
  const msg = result.created
    ? 'Account created (disabled) and invitation issued'
    : 'Invitation issued for the existing account';
  return res.redirect(
    `/admin/users?saved=1&email=${encodeURIComponent(result.email)}`
    + `&msg=${encodeURIComponent(msg)}&token=${encodeURIComponent(token)}`);
});

router.post('/admin/users/:id/active', guard, (req, res) => {
  const id = idOf(req.params.id);
  const target = id ? q.userById(id) : null;
  if (!target) return res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' });

  const enable = req.body.action === 'enable';
  const changed = q.setUserActive(enable, id).changes;

  if (changed) {
    q.audit('users', id, enable ? 'user_enabled' : 'user_disabled', actorOf(req),
      { is_active: enable ? 0 : 1 }, { is_active: enable ? 1 : 0 });
    if (!enable) {
      // TS-02: disabling revokes access immediately, not at next expiry.
      q.revokeUserSessions(id);
      q.audit('users', id, 'sessions_revoked', actorOf(req), null, { reason: 'user_disabled' });
    }
  }

  const msg = changed
    ? `${target.email} ${enable ? 'enabled' : 'disabled — all sessions revoked'}`
    : 'No change — an Administrator account cannot be disabled';
  return res.redirect(`/admin/users?saved=1&msg=${encodeURIComponent(msg)}`);
});

router.post('/admin/users/:id/role', guard, (req, res) => {
  const id = idOf(req.params.id);
  const target = id ? q.userWithRole(id) : null;
  if (!target) return res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' });

  const role = String(req.body.role || '');
  const bounce = (m) => res.redirect(`/admin/users?saved=1&msg=${encodeURIComponent(m)}`);

  if (!q.roles().some((r) => r.code === role)) return bounce('Choose a role from the list');
  if (role === target.role_code) return bounce(`No change — ${target.email} already has that role`);
  // Losing the last Administrator would lock everyone out of user administration.
  if (target.is_system_admin === 1 && role !== 'administrator' && q.adminCount() <= 1) {
    return bounce('Refused — this is the only Administrator account');
  }

  const wasAdmin = target.is_system_admin === 1;
  q.clearUserRoles(id);
  q.setUserRole(id, role, actorOf(req));
  // Keep is_system_admin in step with the role, so the guard can't be bypassed
  // by a role change alone.
  if (wasAdmin && role !== 'administrator') q.demoteSystemAdmin(id);
  if (!wasAdmin && role === 'administrator') q.promoteSystemAdmin(id);
  // TS-01: *any* role change is a privilege change, so their sessions rotate and
  // the new role takes effect only after a fresh sign-in.
  q.revokeUserSessions(id);
  q.audit('users', id, 'sessions_revoked', actorOf(req), null, { reason: 'privilege_change' });
  q.audit('users', id, 'role_changed', actorOf(req),
    { role_code: target.role_code }, { role_code: role });

  return bounce(`${target.email} role → ${role} — sessions revoked, they sign in again`);
});

router.post('/admin/users/:id/reset', guard, async (req, res) => {
  const id = idOf(req.params.id);
  const target = id ? q.userById(id) : null;
  if (!target) return res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' });

  // TS-17: admin-only, temporary password delivered out of band, audited, and all
  // existing sessions revoked so a stolen cookie dies with the reset.
  const temp = policy.makeTempPassword();
  q.setPasswordHash(target.id, await policy.hashPassword(temp));
  q.loginOk(target.id);              // clear any lockout so it's usable immediately
  q.setUserActive(true, target.id);
  q.revokeUserSessions(target.id);
  q.audit('users', target.id, 'password_reset', actorOf(req), null,
    { method: 'temporary_password', sessions_revoked: true });

  res.render('admin-users', userLocals(res, {
    subtitle: 'Temporary password issued — deliver it out of band',
    resetEmail: target.email,
    tempPassword: temp,
  }));
});

router.post('/admin/invitations/:id/resend', guard, (req, res) => {
  const id = idOf(req.params.id);
  const result = id ? invites.resendInvite({ inviteId: id, actorId: actorOf(req) })
                    : { status: 'not_found', error: 'Invitation not found' };
  if (result.status !== 'ok') {
    return res.redirect(`/admin/users?saved=1&msg=${encodeURIComponent(result.error || 'Invitation not found')}`);
  }
  const token = String(result.link).split('/invite/')[1] || '';
  const msg = `New token issued for ${result.email} — the previous link no longer works`;
  return res.redirect(`/admin/users?saved=1&email=${encodeURIComponent(result.email)}`
    + `&msg=${encodeURIComponent(msg)}&token=${encodeURIComponent(token)}`);
});

router.post('/admin/invitations/:id/revoke', guard, (req, res) => {
  const id = idOf(req.params.id);
  const inv = id ? q.inviteById(id) : null;
  if (!inv) return res.status(404).render('404', { layout: 'layout-app', title: 'Not found', subtitle: '' });

  const changed = q.revokeInvite(id).changes;
  if (changed) {
    const user = q.userByEmail(inv.email);
    q.audit('users', user ? user.id : null, 'invite_revoked', actorOf(req), null,
      { email: inv.email, invite_id: id });
  }
  const msg = changed ? `Invitation for ${inv.email} revoked` : 'That invitation was already used or revoked';
  return res.redirect(`/admin/users?saved=1&msg=${encodeURIComponent(msg)}`);
});

// ---- public invitation acceptance (no session required) ----

router.get('/invite/:token', (req, res) => {
  const inv = q.inviteForToken(policy.hashToken(req.params.token || ''));
  const user = inv ? q.userByEmail(inv.email) : null;
  res.render('invite', {
    layout: 'layout-auth',
    title: 'Set your password',
    token: req.params.token,
    email: inv ? inv.email : null,
    fullName: user ? user.full_name : null,
    // One generic message for missing/used/revoked/expired: no enumeration.
    invalid: !inv,
  });
});

router.post('/invite/:token', async (req, res) => {
  const result = await invites.acceptInvite({
    rawToken: req.params.token,
    password: req.body.password,
    confirm: req.body.confirm,
  });

  if (result.status !== 'ok') {
    return res.status(result.status === 'weak_password' ? 400 : 410).render('invite', {
      layout: 'layout-auth',
      title: 'Set your password',
      token: req.params.token,
      email: result.email || null,
      fullName: null,
      invalid: result.status === 'invalid_token',
      error: result.error,
    });
  }
  return res.redirect('/login?setup=1');
});

module.exports = router;
