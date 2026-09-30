// Queries shared by routes. Each export is a plain function wrapping the
// prepared statement — never export the raw bound method (`.get`/`.all` called
// detached from its statement throws "Illegal invocation").
const db = require('./db');

const _projects = db.prepare(`SELECT * FROM projects ORDER BY name`);
const _projectById = db.prepare(`SELECT * FROM projects WHERE id = ?`);

const _ledgerForProject = db.prepare(`
  SELECT v.*, r.id AS reversal_id, r.date AS reversal_date
  FROM v_ledger_period v
  LEFT JOIN accounting_ledger r ON r.reverses_ledger_id = v.id
  WHERE v.project_id = ?
  ORDER BY v.date DESC, v.id DESC
  LIMIT 20`);

const _totalsForProject = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS debit_total,
         COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS credit_total,
         COUNT(*) AS total_count,
         COALESCE(SUM(cost_checked), 0) AS checked_count
  FROM v_ledger_period WHERE project_id = ?`);

const _untaggedCount = db.prepare(`
  SELECT COUNT(*) AS n FROM v_untagged_queue WHERE project_id = ?`);

const _costToDate = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS n
  FROM v_ledger_period
  WHERE project_id = ? AND in_cost_basis = 1 AND line_role IN ('expense','payable','tax')`);

const _userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const _userById = db.prepare('SELECT * FROM users WHERE id = ?');

const _loginFail = db.prepare(`
  UPDATE users SET failed_login_count = failed_login_count + 1, locked_until =
    CASE WHEN failed_login_count + 1 >= 5 THEN datetime('now', '+15 minutes') ELSE locked_until END
  WHERE id = ?`);
const _loginOk = db.prepare(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`);
const _setPassword = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);
const _roleForUser = db.prepare(`
  SELECT r.code, r.name FROM user_roles ur JOIN roles r ON r.code = ur.role_code
  WHERE ur.user_id = ? AND ur.project_id IS NULL ORDER BY r.code LIMIT 1`);

// ---- tagging queue (v_untagged_queue + the master data the pickers need) ----

const _untaggedLines = db.prepare(`
  SELECT u.*, l.type, l.line_role, l.cost_checked, l.transaction_account_id,
         l.wbs_node_id,
         ta.code AS cbs_code, ta.name AS cbs_name,
         w.wbs_code, w.name AS wbs_name
  FROM v_untagged_queue u
  JOIN accounting_ledger l ON l.id = u.id
  LEFT JOIN transaction_accounts ta ON ta.id = l.transaction_account_id
  LEFT JOIN wbs_nodes w ON w.id = l.wbs_node_id
  WHERE u.project_id = ?
  ORDER BY u.date, u.id`);

const _cbsOptions = db.prepare(`
  SELECT id, code, name FROM transaction_accounts
  WHERE active = 1 AND hidden = 0 ORDER BY code`);

const _wbsOptions = db.prepare(`
  SELECT id, wbs_code, name, is_control_account FROM wbs_nodes
  WHERE project_id = ? AND status = 'active' ORDER BY sort_order, wbs_code`);

const _untaggedLineById = db.prepare(`
  SELECT l.id, l.project_id, l.wbs_node_id, l.transaction_account_id,
         l.cost_checked, l.line_role, l.in_cost_basis
  FROM accounting_ledger l WHERE l.id = ?`);

// The ONLY write the queue performs. The DB triggers allow exactly these one-way
// transitions (001_initial.sql trg_ledger_immutable_financial_fields); the app
// passes only the fields the controller actually set. Undefined/absent keys
// keep their old value (better-sqlite3 rejects `undefined` as a binding, so we
// build the SET list dynamically).
const _tagBase = `
  UPDATE accounting_ledger
     SET transaction_account_id = COALESCE(?, transaction_account_id),
         wbs_node_id           = COALESCE(?, wbs_node_id),
         cost_category_id      = COALESCE(
                                   ?, cost_category_id),
         cost_checked          = CASE WHEN ? = 1 THEN 1 ELSE cost_checked END,
         cost_checked_by       = CASE WHEN ? = 1 THEN ? ELSE cost_checked_by END,
         cost_checked_at       = CASE WHEN ? = 1 THEN datetime('now') ELSE cost_checked_at END
   WHERE id = ?`;

const _tagLine = db.prepare(_tagBase);

const _insertAudit = db.prepare(`
  INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
  VALUES ('accounting_ledger', ?, 'update', ?, ?, ?)`);

const _insertLedger = db.prepare(`
  INSERT INTO accounting_ledger
    (project_id, transaction_id, document_no, reference_no, account_code,
     partner_type, partner_id, date, effective_date, type, line_role, in_cost_basis,
     cost_category_id, chart_of_account_id, cashflow_category_id,
     transaction_account_id, wbs_node_id, amount, debit, credit,
     retainage_amount, paid_amount, currency, description, source,
     import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at,
     reverses_ledger_id)
  VALUES
    (@project_id, @transaction_id, @document_no, @reference_no, @account_code,
     @partner_type, @partner_id, @date, @effective_date, @type, @line_role, @in_cost_basis,
     @cost_category_id, @chart_of_account_id, @cashflow_category_id,
     @transaction_account_id, @wbs_node_id, @amount, @debit, @credit,
     @retainage_amount, @paid_amount, @currency, @description, @source,
     @import_batch_id, @cash_advance_id, @cost_checked, @cost_checked_by, @cost_checked_at,
     @reverses_ledger_id)`);

const _insertLedgerAudit = db.prepare(`
  INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
  VALUES ('accounting_ledger', ?, 'create', ?, NULL, ?)`);

const _insertGenericAudit = db.prepare(`
  INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
  VALUES (?, ?, ?, ?, ?, ?)`);

// ---- user administration (TS-01): list, create, enable/disable, invites ----

const _allUsers = db.prepare(`
  SELECT u.id, u.email, u.full_name, u.is_active, u.is_system_admin, u.created_at,
         u.last_login_at, u.failed_login_count, u.locked_until,
         COALESCE(ur.role_code, '') AS role_code,
         COALESCE(r.name, '—')     AS role_name,
         (SELECT COUNT(*) FROM sessions s
           WHERE s.user_id = u.id AND s.revoked_at IS NULL
             AND CAST(strftime('%s', s.expires_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER)
         ) AS active_sessions,
         (SELECT i.expires_at FROM user_invitations i
           WHERE i.email = u.email AND i.used_at IS NULL AND i.revoked_at IS NULL
             AND CAST(strftime('%s', i.expires_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER)
           ORDER BY i.id DESC LIMIT 1) AS pending_invite_expires
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.project_id IS NULL
  LEFT JOIN roles r ON r.code = ur.role_code
  ORDER BY u.is_active DESC, r.name, u.email`);

const _roles = db.prepare(`SELECT code, name, domain FROM roles ORDER BY domain, name`);

const _userWithRole = db.prepare(`
  SELECT u.*, COALESCE(r.code, '') AS role_code, COALESCE(r.name, '—') AS role_name,
         ur.id AS user_role_id
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.project_id IS NULL
  LEFT JOIN roles r ON r.code = ur.role_code
  WHERE u.id = ?`);

const _insertUser = db.prepare(`
  INSERT INTO users (email, full_name, password_hash, is_active, is_system_admin)
  VALUES (@email, @full_name, @password_hash, 0, 0)`);

const _setUserRole = db.prepare(`
  INSERT INTO user_roles (user_id, role_code, project_id, granted_by)
  VALUES (@user_id, @role_code, NULL, @actor_id)`);

const _clearUserRoles = db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND project_id IS NULL`);

const _setUserActive = db.prepare(`UPDATE users SET is_active = ? WHERE id = ? AND is_system_admin = 0`);

const _promoteOwnerSystemAdmin = db.prepare(`UPDATE users SET is_system_admin = 1 WHERE id = ?`);
const _demoteOwnerSystemAdmin = db.prepare(`UPDATE users SET is_system_admin = 0 WHERE id = ?`);

const _adminCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_system_admin = 1 AND is_active = 1`);

const _setUserIdentity = db.prepare(`UPDATE users SET full_name = ? WHERE id = ?`);

const _purgeUserSessions = db.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`);

const _inviteById = db.prepare(`SELECT * FROM user_invitations WHERE id = ?`);

const _pendingInviteForEmail = db.prepare(`
  SELECT * FROM user_invitations
  WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL
  ORDER BY id DESC LIMIT 1`);

// user_invitations.email is UNIQUE (migration 002), so there is exactly ONE row
// per email for all time. That row is the *current* invitation for that address;
// the history of issue/reissue/revoke/accept events lives in audit_log. Reissuing
// therefore resets the row in place (upsert) rather than inserting a second one.
const _upsertInvite = db.prepare(`
  INSERT INTO user_invitations (email, token_hash, invited_by, role_id, expires_at)
  VALUES (@email, @token_hash, @invited_by, @role_id, datetime('now', '+' || @ttl_hours || ' hours'))
  ON CONFLICT(email) DO UPDATE SET
    token_hash = excluded.token_hash,
    invited_by = excluded.invited_by,
    role_id    = COALESCE(excluded.role_id, user_invitations.role_id),
    expires_at = excluded.expires_at,
    used_at    = NULL,
    revoked_at = NULL,
    created_at = datetime('now')`);

const _consumeInvite = db.prepare(`UPDATE user_invitations SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL`);

const _revokeInvite = db.prepare(`UPDATE user_invitations SET revoked_at = datetime('now') WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`);

const _revokePendingInvitesForEmail = db.prepare(`
  UPDATE user_invitations SET revoked_at = datetime('now')
  WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`);

// Epoch-safe: an invitation is usable only while unused, unrevoked and unexpired.
const _inviteForToken = db.prepare(`
  SELECT * FROM user_invitations
  WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL
    AND CAST(strftime('%s', expires_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER)`);

const _pendingInvites = db.prepare(`
  SELECT i.id, i.email, i.created_at, i.expires_at, i.role_id,
         COALESCE(r.name, '—') AS role_name, u.email AS invited_by_email
  FROM user_invitations i
  LEFT JOIN roles r ON r.code = i.role_id
  LEFT JOIN users u ON u.id = i.invited_by
  WHERE i.used_at IS NULL AND i.revoked_at IS NULL
    AND CAST(strftime('%s', i.expires_at) AS INTEGER) > CAST(strftime('%s','now') AS INTEGER)
  ORDER BY i.id`);

const _auditLogFor = db.prepare(`
  SELECT al.*, u.email AS actor_email
  FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
  WHERE al.entity_type = ? AND al.entity_id = ?
  ORDER BY al.id DESC LIMIT 50`);

// ---- imports (TS-04/TS-24): the batch register shown on /import ---------------
const _importBatches = db.prepare(`
  SELECT b.id, b.original_name, b.filename, b.status, b.row_count,
         b.inserted_count, b.skipped_count, b.new_count, b.error_json,
         b.imported_at, b.confirmed_at, b.expires_at,
         p.code AS project_code, u.email AS uploaded_by_email,
         (b.staging_json IS NOT NULL) AS has_staging
  FROM import_batches b
  LEFT JOIN projects p ON p.id = b.project_id
  LEFT JOIN users u ON u.id = b.uploaded_by
  ORDER BY b.id DESC LIMIT 25`);

module.exports = {
  projects: () => _projects.all(),
  projectById: (id) => _projectById.get(id),
  ledgerForProject: (id) => _ledgerForProject.all(id),
  totalsForProject: (id) => _totalsForProject.get(id),
  untaggedCount: (id) => _untaggedCount.get(id),
  costToDate: (id) => _costToDate.get(id),
  userByEmail: (email) => _userByEmail.get(email),
  userById: (id) => _userById.get(id),
  roleForUser: (id) => _roleForUser.get(id),
  untaggedLines: (projectId) => _untaggedLines.all(projectId),
  cbsOptions: () => _cbsOptions.all(),
  wbsOptions: (projectId) => _wbsOptions.all(projectId),
  untaggedLineById: (id) => _untaggedLineById.get(id),
  tagLine: (lineId, { cbsId, wbsId, costCategoryId, check, actorId }) => {
    const doCheck = check ? 1 : 0;
    return _tagLine.run(
      cbsId ?? null, wbsId ?? null, costCategoryId ?? null,
      doCheck, doCheck, actorId ?? null, doCheck, lineId,
    );
  },
  insertAudit: (entityId, actorId, before, after) =>
    _insertAudit.run(entityId, actorId, JSON.stringify(before), JSON.stringify(after)),
  insertLedger: (row) => _insertLedger.run(row),
  insertLedgerAudit: (entityId, actorId, after) =>
    _insertLedgerAudit.run(entityId, actorId, JSON.stringify(after)),
  loginFail: (userId) => _loginFail.run(userId),
  loginOk: (userId) => _loginOk.run(userId),
  setPasswordHash: (userId, hash) => _setPassword.run(hash, userId),
  audit: (entityType, entityId, action, actorId, before, after) =>
    _insertGenericAudit.run(entityType, entityId, action, actorId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after)),

  // ---- user administration (TS-01 §3.1) ----
  allUsers: () => _allUsers.all(),
  roles: () => _roles.all(),
  userWithRole: (id) => _userWithRole.get(id),
  insertUser: (email, fullName, passwordHash) =>
    _insertUser.run({ email, full_name: fullName, password_hash: passwordHash }),
  setUserRole: (userId, roleCode, actorId) =>
    _setUserRole.run({ user_id: userId, role_code: roleCode, actor_id: actorId }),
  clearUserRoles: (userId) => _clearUserRoles.run(userId),
  setUserActive: (active, userId) => _setUserActive.run(active ? 1 : 0, userId),
  promoteSystemAdmin: (userId) => _promoteOwnerSystemAdmin.run(userId),
  demoteSystemAdmin: (userId) => _demoteOwnerSystemAdmin.run(userId),
  adminCount: () => _adminCount.get().n,
  setUserName: (fullName, userId) => _setUserIdentity.run(fullName, userId),
  revokeUserSessions: (userId) => _purgeUserSessions.run(userId),

  inviteById: (id) => _inviteById.get(id),
  pendingInviteForEmail: (email) => _pendingInviteForEmail.get(email),
  insertInvite: (email, tokenHash, invitedBy, roleCode) =>
    _upsertInvite.run({ email, token_hash: tokenHash, invited_by: invitedBy,
      role_id: roleCode || null, ttl_hours: require('../lib/policy').TOKEN_TTL_HOURS }),
  consumeInvite: (id) => _consumeInvite.run(id),
  revokeInvite: (id) => _revokeInvite.run(id),
  revokePendingInvitesForEmail: (email) => _revokePendingInvitesForEmail.run(email),
  inviteForToken: (tokenHash) => _inviteForToken.get(tokenHash),
  pendingInvites: () => _pendingInvites.all(),
  auditLogFor: (entityType, entityId) => _auditLogFor.all(entityType, entityId),

  importBatches: () => _importBatches.all(),
};