// Team register — business rules (module 6, plan task 6.4, PRD §4.1 "Team register").
//
// WHAT A TEAM IS HERE
// A team is an internal grouping of people. Membership IS `users.team_id` — the
// schema has no junction table (db/schema.sql line 546), so "add a member" is an
// assignment on the account, not an insert into a link table.
//
// A team grants NO access. Access comes from roles (`user_roles`). Conflating the
// two is how a "team" quietly becomes a permission set; the PRD keeps them
// separate (Admin creates the team and its roles; the ROLE does the granting).
//
// WHY THERE IS NO APPROVAL CHAIN
// `approvals-service.js` covers project / client / supplier — registers of PARTIES
// you contract with, where an approval is a control. A team is not a party; PRD
// §4.1 gives it no verify/approve steps. Adding one would be inventing a control.
//
// Deleting is not offered: an inactive team keeps the roster readable, and a
// member's history is theirs, not the team's.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const invites = require('./invites');

function str(v, max = 200) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : null;
}

function validate(input, { isUpdate = false } = {}) {
  const out = {};

  // Set once at creation. The edit view renders it read-only AND disabled, so a
  // browser does not submit it; requiring it on update would break every edit.
  if (!isUpdate) {
    const code = str(input.code, 40);
    if (!code) return { ok: false, field: 'code', message: 'A team code is required.' };
    out.code = code;
  }

  const name = str(input.name, 200);
  if (!name) return { ok: false, field: 'name', message: 'A team name is required.' };
  out.name = name;

  if (isUpdate) {
    const active = input.active;
    out.active = (active === '0' || active === 0 || active === false) ? 0 : 1;
  }

  return { ok: true, row: out };
}

function codeTaken(code, exceptId = null) {
  const target = String(code).toLowerCase();
  return q.teams().some(
    (t) => t.code.toLowerCase() === target && (exceptId == null || t.id !== exceptId));
}

function createTeam(input, actorId) {
  const v = validate(input);
  if (!v.ok) return v;
  if (codeTaken(v.row.code)) {
    return { ok: false, field: 'code', status: 409, message: `Team code ${v.row.code} is already in use.` };
  }

  const run = db.transaction(() => {
    const info = q.insertTeam(v.row);
    const id = info.lastInsertRowid;
    const created = q.teamById(id);
    q.audit('team', id, 'create', actorId, null, created);
    return created;
  });

  return { ok: true, team: run() };
}

function updateTeam(id, input, actorId) {
  const before = q.teamById(id);
  if (!before) return { ok: false, status: 404, field: 'id', message: 'That team does not exist.' };

  const v = validate(input, { isUpdate: true });
  if (!v.ok) return v;

  const run = db.transaction(() => {
    q.updateTeam({ ...v.row, id });
    const after = q.teamById(id);
    q.audit('team', id, 'update', actorId, before, after);
    return after;
  });

  return { ok: true, team: run() };
}

// Put an EXISTING account into the team. Moving someone from another team is
// allowed and is recorded with both ends, so "who was where when" stays readable.
function assignMember(teamId, userId, actorId) {
  const team = q.teamById(teamId);
  if (!team) return { ok: false, status: 404, message: 'That team does not exist.' };

  const user = q.userById(userId);
  if (!user) return { ok: false, status: 400, field: 'user_id', message: 'Choose an account to add.' };

  if (user.team_id === teamId) {
    return { ok: false, status: 409, field: 'user_id', message: `${user.full_name} is already in this team.` };
  }

  const run = db.transaction(() => {
    const from = user.team_id == null ? null : (q.teamById(user.team_id) || {}).code || user.team_id;
    q.setUserTeam(userId, teamId);
    q.audit('team', teamId, 'member_added', actorId,
      { user_id: userId, team: from }, { user_id: userId, team: team.code });
    return user.full_name;
  });

  return { ok: true, name: run() };
}

// Remove someone from the team. Their account, roles and history are untouched —
// only the team assignment is cleared.
function removeMember(teamId, userId, actorId) {
  const team = q.teamById(teamId);
  if (!team) return { ok: false, status: 404, message: 'That team does not exist.' };

  const user = q.userById(userId);
  if (!user || user.team_id !== teamId) {
    return { ok: false, status: 400, message: 'That account is not in this team.' };
  }

  const run = db.transaction(() => {
    q.setUserTeam(userId, null);
    q.audit('team', teamId, 'member_removed', actorId,
      { user_id: userId, team: team.code }, { user_id: userId, team: null });
    return user.full_name;
  });

  return { ok: true, name: run() };
}

// Invite a NEW person straight into the team (PRD §4.1 step 3: "Team receives
// email invitation, creates account"). This REUSES the existing invitation
// machinery — the plan is explicit that a second invite path must not be written,
// because two paths means two places for the token/expiry rules to drift.
function inviteIntoTeam(teamId, { email, fullName, roleCode }, actorId) {
  const team = q.teamById(teamId);
  if (!team) return { ok: false, status: 404, message: 'That team does not exist.' };

  const result = invites.sendInvite({ email, fullName, roleCode, actorId });
  if (result.status !== 'ok') return { ok: false, status: 400, message: result.error };

  // The invite may have CREATED a disabled account or targeted an existing one;
  // either way it now has an id, and the team assignment is a separate act.
  const user = q.userByEmail(String(email || '').trim());
  if (user && user.team_id !== teamId) {
    db.transaction(() => {
      q.setUserTeam(user.id, teamId);
      q.audit('team', teamId, 'member_invited', actorId,
        { user_id: user.id, team: null }, { user_id: user.id, team: team.code });
    })();
  }

  return { ok: true, link: result.link, email: result.email, team };
}

module.exports = {
  validate, codeTaken,
  createTeam, updateTeam, assignMember, removeMember, inviteIntoTeam,
};
