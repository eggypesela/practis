// Queries shared by routes. Each export is a plain function wrapping the
// prepared statement — never export the raw bound method (`.get`/`.all` called
// detached from its statement throws "Illegal invocation").
const db = require('./db');

const _projects = db.prepare(`SELECT * FROM projects ORDER BY name`);
const _projectById = db.prepare(`SELECT * FROM projects WHERE id = ?`);

// ---- project register (module 6 task 6.2) ---------------------------------
// `created_by` is NOT NULL: the approval rule (decision: self-approval needs a
// typed reason) is meaningless without a recorded creator.
const _insertProject = db.prepare(`
  INSERT INTO projects
    (code, name, client_id, industry_type, contract_amount, revenue_method,
     payment_terms_days, start_date, end_date, created_by)
  VALUES (@code, @name, @client_id, @industry_type, @contract_amount, @revenue_method,
          @payment_terms_days, @start_date, @end_date, @created_by)`);

const _updateProject = db.prepare(`
  UPDATE projects SET
    name = @name,
    client_id = @client_id,
    industry_type = @industry_type,
    contract_amount = @contract_amount,
    revenue_method = @revenue_method,
    payment_terms_days = @payment_terms_days,
    start_date = @start_date,
    end_date = @end_date,
    status = @status
  WHERE id = @id`);

// Approval chain for one entity. `approvals` is generic (entity_type/entity_id)
// so the register reads it by entity, never by joining a project column.
const _approvalsFor = db.prepare(`
  SELECT a.*, u.email AS actor_email, u.full_name AS actor_name
  FROM approvals a LEFT JOIN users u ON u.id = a.actor_id
  WHERE a.entity_type = ? AND a.entity_id = ?
  ORDER BY a.id`);

const _insertApproval = db.prepare(`
  INSERT INTO approvals (entity_type, entity_id, step, required_role, status, actor_id, acted_at, comment)
  VALUES (@entity_type, @entity_id, @step, @required_role, @status, @actor_id,
          CASE WHEN @status = 'pending' THEN NULL ELSE datetime('now') END, @comment)`);

const _setApprovalStatus = db.prepare(`
  UPDATE approvals SET status = ?, actor_id = ?, acted_at = datetime('now'), comment = ?
  WHERE entity_type = ? AND entity_id = ? AND step = ?`);

const _insertNotification = db.prepare(`
  INSERT INTO notification_inbox (user_id, project_id, alert_type, severity, title, body, entity_type, entity_id)
  VALUES (@user_id, @project_id, @alert_type, @severity, @title, @body, @entity_type, @entity_id)`);

const _notificationsFor = db.prepare(`
  SELECT * FROM notification_inbox WHERE user_id = ? ORDER BY id DESC LIMIT 50`);

// Reference data for the project registration form. Both tables are seeded by an
// Administrator (PRD §4.1 step 1) and are EMPTY on a fresh install, so the form
// renders them as optional selects rather than failing.
const _clients = db.prepare(`
  SELECT c.*, i.name AS industry_name FROM clients c
  LEFT JOIN industry_types i ON i.id = c.industry_id
  ORDER BY c.name`);

const _industryTypes = db.prepare(`SELECT * FROM industry_types ORDER BY name`);

const _insertClient = db.prepare(`
  INSERT INTO clients (code, name, industry_id, address, correspondence_person, email, phone, payment_terms_days, description, created_by, active)
  VALUES (@code, @name, @industry_id, @address, @correspondence_person, @email, @phone, @payment_terms_days, @description, @created_by, 1)`);

const _updateClient = db.prepare(`
  UPDATE clients SET
    name = @name,
    industry_id = @industry_id,
    address = @address,
    correspondence_person = @correspondence_person,
    email = @email,
    phone = @phone,
    payment_terms_days = @payment_terms_days,
    description = @description,
    active = @active
  WHERE id = @id`);

// ---- supplier register (module 6 task 6.4) --------------------------------
// `active` is selected explicitly so a reader can filter without a second query;
// there is no lookup table for `supplier_type` (it is legacy free text), so no
// LEFT JOIN is needed — unlike clients/industry_types.
const _suppliers = db.prepare(`SELECT * FROM suppliers ORDER BY name`);

const _insertSupplier = db.prepare(`
  INSERT INTO suppliers (code, name, supplier_type, address, correspondence_person, email, phone, description, created_by, active)
  VALUES (@code, @name, @supplier_type, @address, @correspondence_person, @email, @phone, @description, @created_by, 1)`);

const _updateSupplier = db.prepare(`
  UPDATE suppliers SET
    name = @name,
    supplier_type = @supplier_type,
    address = @address,
    correspondence_person = @correspondence_person,
    email = @email,
    phone = @phone,
    description = @description,
    active = @active
  WHERE id = @id`);

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
// Record the sign-in time. Non-fatal bookkeeping, but it belongs with the other
// user statements rather than inline in the route (task 0.6).
const _touchLastLogin = db.prepare(
  `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`);
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

// The cost category a CBS account defaults to. Used when tagging an untagged
// ledger line (task 0.6 — was inline SQL in src/routes/app.js).
const _costCategoryOfAccount = db.prepare(
  'SELECT cost_category_id AS c FROM transaction_accounts WHERE id = ?');

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

// ---- team register (module 6 task 6.4) --------------------------------------
// Membership IS `users.team_id` (schema line 546) — there is no junction table,
// so a member count and the roster both read from `users`.
const _teams = db.prepare(`
  SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS member_count
  FROM teams t
  ORDER BY t.name`);

const _teamById = db.prepare(`
  SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS member_count
  FROM teams t WHERE t.id = ?`);

// Member roster, with the member's GLOBAL role (project_id IS NULL) — the same
// grant the admin-users screen shows.
const _teamMembers = db.prepare(`
  SELECT u.id, u.email, u.full_name, u.is_active,
         COALESCE(r.code, '') AS role_code, COALESCE(r.name, '—') AS role_name
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.project_id IS NULL
  LEFT JOIN roles r ON r.code = ur.role_code
  WHERE u.team_id = ?
  ORDER BY u.full_name`);

const _insertTeam = db.prepare(`INSERT INTO teams (code, name, active) VALUES (@code, @name, 1)`);

const _updateTeam = db.prepare(`UPDATE teams SET name = @name, active = @active WHERE id = @id`);

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

// ---- frozen periods (plan task 0.10, TECH-SPEC §8.4) -------------------------
const _freezePeriod = db.prepare(`
  INSERT INTO frozen_periods (project_id, period_month, frozen_at, frozen_by)
  VALUES (@project_id, @period_month, datetime('now'), @actor_id)
  ON CONFLICT(project_id, period_month) DO NOTHING`);

const _unfreezePeriod = db.prepare(
  `DELETE FROM frozen_periods WHERE project_id = ? AND period_month = ?`);

// ---- per-project scoping (audit BOLA, plan task 0.9) --------------------------
// `user_roles.project_id` is the junction the PRD 2.3 describes ("users are
// assigned a role PER PROJECT"). It existed from migration 001 and was NULL in
// every row and read by zero code until now.
//
// Scoped grants are written per (user, project): replacing the grant for one
// project must not disturb the user's other projects or their global grant.
const _projectIdsForUser = db.prepare(`
  SELECT DISTINCT project_id FROM user_roles
  WHERE user_id = ? AND project_id IS NOT NULL`);
const _dropScopedUserRole = db.prepare(`
  DELETE FROM user_roles WHERE user_id = ? AND project_id = ?`);
// Clears EVERY scoped grant for a user while leaving their global grant alone —
// the distinction the whole scoping model rests on.
const _clearScopedRolesForUser = db.prepare(`
  DELETE FROM user_roles WHERE user_id = ? AND project_id IS NOT NULL`);
const _insertScopedUserRole = db.prepare(`
  INSERT INTO user_roles (user_id, role_code, project_id, granted_by)
  VALUES (@user_id, @role_code, @project_id, @actor_id)`);
const _scopedGrantsForUser = db.prepare(`
  SELECT ur.role_code, ur.project_id, p.code AS project_code, p.name AS project_name,
         r.name AS role_name
  FROM user_roles ur
  JOIN projects p ON p.id = ur.project_id
  LEFT JOIN roles r ON r.code = ur.role_code
  WHERE ur.user_id = ?
  ORDER BY p.name`);
// Whole-roster version of the above, for the admin screen's one-shot read.
const _projectIdsGrouped = db.prepare(`
  SELECT user_id, project_id FROM user_roles
  WHERE project_id IS NOT NULL ORDER BY user_id, project_id`);


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

// ---- cash advance + Expense Report (R2-1..R2-3, R2-18, R2-19) ----------------

// The advance pots of a project with what has been reported against each, so the
// screen can show "how much of this pot is still unreported" without a second
// query per row.
const _advancesForProject = db.prepare(`
  SELECT a.*,
         COALESCE(d.detail_total, 0)  AS reported_amount,
         COALESCE(d.checked_total, 0) AS checked_amount,
         COALESCE(d.line_count, 0)    AS line_count,
         a.amount - COALESCE(d.checked_total, 0) AS unreported_amount
  FROM cash_advance a
  LEFT JOIN (
    SELECT cash_advance_id,
           SUM(ABS(amount)) AS detail_total,
           SUM(CASE WHEN status = 'checked' THEN ABS(amount) ELSE 0 END) AS checked_total,
           COUNT(*) AS line_count
    FROM lpb_statements GROUP BY cash_advance_id
  ) d ON d.cash_advance_id = a.id
  WHERE a.project_id = ?
  ORDER BY a.id DESC`);

const _advanceById = db.prepare(`
  SELECT a.*, p.name AS project_name, p.code AS project_code
  FROM cash_advance a JOIN projects p ON p.id = a.project_id
  WHERE a.id = ?`);

// The Expense Report detail of one pot, oldest first, with the tag names and who
// entered / checked each line.
const _lpbLinesForAdvance = db.prepare(`
  SELECT s.*,
         ta.code AS cbs_code, ta.name AS cbs_name,
         w.wbs_code, w.name AS wbs_name,
         cu.full_name AS created_by_name, cu.email AS created_by_email,
         ku.full_name AS checked_by_name, ku.email AS checked_by_email
  FROM lpb_statements s
  LEFT JOIN transaction_accounts ta ON ta.id = s.transaction_account_id
  LEFT JOIN wbs_nodes w ON w.id = s.wbs_node_id
  LEFT JOIN users cu ON cu.id = s.created_by
  LEFT JOIN users ku ON ku.id = s.checked_by
  WHERE s.cash_advance_id = ?
  ORDER BY s.entry_date, s.id`);

const _lpbLinesForProject = db.prepare(`
  SELECT s.*, a.advance_no, a.status AS advance_status,
         ta.code AS cbs_code, w.wbs_code,
         cu.full_name AS created_by_name, ku.full_name AS checked_by_name
  FROM lpb_statements s
  LEFT JOIN cash_advance a ON a.id = s.cash_advance_id
  LEFT JOIN transaction_accounts ta ON ta.id = s.transaction_account_id
  LEFT JOIN wbs_nodes w ON w.id = s.wbs_node_id
  LEFT JOIN users cu ON cu.id = s.created_by
  LEFT JOIN users ku ON ku.id = s.checked_by
  WHERE s.project_id = ?
  ORDER BY s.entry_date DESC, s.id DESC
  LIMIT 100`);

const _lpbLineById = db.prepare(`SELECT * FROM lpb_statements WHERE id = ?`);

const _insertLpbLine = db.prepare(`
  INSERT INTO lpb_statements
    (cash_advance_id, project_id, lpb_no, period_month, entry_date, description,
     debit, credit, amount, currency, transaction_account_id, wbs_node_id,
     status, created_by)
  VALUES
    (@cash_advance_id, @project_id, @lpb_no, @period_month, @entry_date, @description,
     @debit, @credit, @amount, @currency, @transaction_account_id, @wbs_node_id,
     @status, @created_by)`);

const _insertAdvance = db.prepare(`
  INSERT INTO cash_advance
    (project_id, advance_no, recipient_type, amount, submission_date, approved_date,
     issued_date, description, currency, status)
  VALUES
    (@project_id, @advance_no, @recipient_type, @amount, @submission_date, @approved_date,
     @issued_date, @description, @currency, @status)`);

// The ONLY write the Expense Report check performs. The DB trigger permits
// exactly this one-way transition (draft → checked with a checker identity) and
// freezes the line afterwards.
const _checkLpbLine = db.prepare(`
  UPDATE lpb_statements
     SET status = 'checked', checked_by = ?, checked_at = datetime('now')
   WHERE id = ? AND status = 'draft'`);

// The Cost Controller may correct the codes as part of the check. Same idea as
// _tagLine: one statement, called inside the route's transaction, so the route
// never builds SQL. (Audit 2026-09-30, task 0.6 — this statement used to live
// inline in src/routes/app.js, which is the habit that produced blocker B2.)
const _setLpbCodes = db.prepare(`
  UPDATE lpb_statements
     SET transaction_account_id = ?, wbs_node_id = ?
   WHERE id = ?`);

const _rejectLpbLine = db.prepare(`
  UPDATE lpb_statements
     SET status = 'rejected', reject_reason = ?, checked_by = ?, checked_at = datetime('now')
   WHERE id = ? AND status = 'draft'`);

// PARK a draft the project cannot book yet (no CBS/WBS code exists for it).
//
// Blocked is not rejected: nothing is wrong with the line, so it is not blamed on
// the enterer, and — unlike a check or a rejection — it is NOT final. Clearing it
// returns the line to draft, ready to be checked once the code exists.
const _blockLpbLine = db.prepare(`
  UPDATE lpb_statements
     SET status = 'blocked', block_reason = ?, checked_by = ?, checked_at = datetime('now')
   WHERE id = ? AND status = 'draft'`);

// CLEAR a block: back to draft. Guarded so only a blocked line can come back.
const _unblockLpbLine = db.prepare(`
  UPDATE lpb_statements
     SET status = 'draft', block_reason = NULL, checked_by = NULL, checked_at = NULL
   WHERE id = ? AND status = 'blocked'`);

// Mark a returned line as replaced by its correction. Guarded so it can only be
// applied once, and only to a line that is actually waiting on a human.
const _supersedeLpbLine = db.prepare(`
  UPDATE lpb_statements
     SET superseded_by = ?
   WHERE id = ? AND project_id = ? AND status IN ('rejected','blocked')
     AND superseded_by IS NULL`);

const _lpbStalled = db.prepare(`
  SELECT s.*, a.advance_no,
         cu.full_name AS created_by_name, cu.email AS created_by_email,
         ku.full_name AS checked_by_name, ku.email AS checked_by_email,
         c.code AS cbs_code
  FROM lpb_statements s
  LEFT JOIN cash_advance a ON a.id = s.cash_advance_id
  LEFT JOIN users cu ON cu.id = s.created_by
  LEFT JOIN users ku ON ku.id = s.checked_by
  LEFT JOIN transaction_accounts c ON c.id = s.transaction_account_id
  WHERE s.project_id = ? AND s.status IN ('blocked','rejected')
    -- A returned line that has already been re-entered is resolved: the
    -- corrected line points back at it, so the pair reads as one story. Leaving
    -- it in "needs attention" would nag forever about work already done.
    AND s.superseded_by IS NULL
  ORDER BY s.status, s.entry_date DESC, s.id DESC`);

const _lpbSummary = db.prepare(`
  SELECT COUNT(*) AS total,
         COALESCE(SUM(status = 'draft'), 0)   AS draft,
         COALESCE(SUM(status = 'checked'), 0) AS checked,
         COALESCE(SUM(status = 'rejected'), 0) AS rejected,
         COALESCE(SUM(status = 'blocked'), 0) AS blocked,
         COALESCE(SUM(CASE WHEN status = 'checked' THEN ABS(amount) ELSE 0 END), 0) AS checked_amount
  FROM lpb_statements WHERE project_id = ?`);

// The reconciliation view, scoped to one project. This is the user-requested
// feature (R2-19): Finance's bulk settlement vs Project Admin's detail lines.
const _reconciliation = db.prepare(`
  SELECT * FROM v_lpb_reconciliation
  WHERE project_id = ?
  ORDER BY period_month DESC, lpb_no`);

const _reconciliationAll = db.prepare(`
  SELECT r.*, p.code AS project_code, p.name AS project_name
  FROM v_lpb_reconciliation r
  LEFT JOIN projects p ON p.id = r.project_id
  ORDER BY r.period_month DESC, r.lpb_no`);

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
  // audit 2026-09-30 task 0.6: these two were inline SQL in src/routes/app.js
  costCategoryOfAccount: (cbsId) => _costCategoryOfAccount.get(cbsId),
  setLpbCodes: (cbsId, wbsId, lineId) => _setLpbCodes.run(cbsId, wbsId ?? null, lineId),
  tagLine: (lineId, { cbsId, wbsId, costCategoryId, check, actorId }) => {
    const doCheck = check ? 1 : 0;
    return _tagLine.run(
      cbsId ?? null, wbsId ?? null, costCategoryId ?? null,
      doCheck, doCheck, actorId ?? null, doCheck, lineId,
    );
  },
  insertAudit: (entityId, actorId, before, after) =>
    _insertAudit.run(entityId, actorId, JSON.stringify(before), JSON.stringify(after)),

  // ---- project register (module 6 task 6.2) ----
  insertProject: (row) => _insertProject.run(row),
  updateProject: (row) => _updateProject.run(row),
  approvalsFor: (entityType, entityId) => _approvalsFor.all(entityType, entityId),
  insertApproval: (row) => _insertApproval.run(row),
  setApprovalStatus: (status, actorId, comment, entityType, entityId, step) =>
    _setApprovalStatus.run(status, actorId, comment, entityType, entityId, step),
  insertNotification: (row) => _insertNotification.run(row),
  notificationsFor: (userId) => _notificationsFor.all(userId),
  userIdsForRole: (roleCode) => db.prepare(
    `SELECT DISTINCT user_id FROM user_roles WHERE role_code = ? AND project_id IS NULL`)
    .all(roleCode).map((r) => r.user_id),
  adminUserIds: () => db.prepare(
    'SELECT id FROM users WHERE is_system_admin = 1 AND is_active = 1')
    .all().map((r) => r.id),
  notificationsPendingFor: (userId) => db.prepare(
    `SELECT COUNT(*) AS n FROM notification_inbox WHERE user_id = ? AND read_at IS NULL`)
    .get(userId).n,
  approvalByStep: (entityType, entityId, step) => db.prepare(
    `SELECT * FROM approvals WHERE entity_type = ? AND entity_id = ? AND step = ?`)
    .get(entityType, entityId, step),
  clients: () => _clients.all(),
  // Active clients only — the client pickers on the project form and the client
  // register both want the ones a user may actually choose.
  clientsActive: () => _clients.all().filter((c) => c.active === 1),
  clientsAll: () => _clients.all(),
  clientById: (id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id),
  insertClient: (row) => _insertClient.run(row),
  updateClient: (row) => _updateClient.run(row),
  industryTypes: () => _industryTypes.all(),
  // ---- supplier register (module 6 task 6.4) ----
  suppliers: () => _suppliers.all(),
  suppliersAll: () => _suppliers.all(),
  // Active only — the supplier pickers want the ones a user may actually choose.
  suppliersActive: () => _suppliers.all().filter((s) => s.active === 1),
  supplierById: (id) => db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id),
  insertSupplier: (row) => _insertSupplier.run(row),
  updateSupplier: (row) => _updateSupplier.run(row),
  insertLedger: (row) => _insertLedger.run(row),
  insertLedgerAudit: (entityId, actorId, after) =>
    _insertLedgerAudit.run(entityId, actorId, JSON.stringify(after)),
  loginFail: (userId) => _loginFail.run(userId),
  loginOk: (userId) => _loginOk.run(userId),
  setPasswordHash: (userId, hash) => _setPassword.run(hash, userId),
  touchLastLogin: (userId) => _touchLastLogin.run(userId),
  audit: (entityType, entityId, action, actorId, before, after) =>
    _insertGenericAudit.run(entityType, entityId, action, actorId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after)),

  // ---- user administration (TS-01 §3.1) ----
  // ---- team register (module 6 task 6.4) ----
  teams: () => _teams.all(),
  teamById: (id) => _teamById.get(id),
  teamMembers: (id) => _teamMembers.all(id),
  insertTeam: (row) => _insertTeam.run(row),
  updateTeam: (row) => _updateTeam.run(row),
  setUserTeam: (userId, teamId) =>
    db.prepare('UPDATE users SET team_id = ? WHERE id = ?').run(teamId, userId),
  // Every account, with its current team (by NAME) — the "assign a member"
  // picker shows who is already in another team rather than hiding them.
  usersWithTeam: () => db.prepare(`
    SELECT u.id, u.email, u.full_name, u.is_active, u.team_id, t.name AS team_name
    FROM users u LEFT JOIN teams t ON t.id = u.team_id
    ORDER BY u.full_name`).all(),
  allUsers: () => _allUsers.all(),
  roles: () => _roles.all(),
  userWithRole: (id) => _userWithRole.get(id),
  insertUser: (email, fullName, passwordHash) =>
    _insertUser.run({ email, full_name: fullName, password_hash: passwordHash }),
  setUserRole: (userId, roleCode, actorId) =>
    _setUserRole.run({ user_id: userId, role_code: roleCode, actor_id: actorId }),
  clearUserRoles: (userId) => _clearUserRoles.run(userId),

  // ---- frozen periods (plan task 0.10) ----
  freezePeriod: (projectId, periodMonth, actorId) =>
    _freezePeriod.run({ project_id: projectId, period_month: periodMonth, actor_id: actorId }),
  unfreezePeriod: (projectId, periodMonth) => _unfreezePeriod.run(projectId, periodMonth),

  // ---- per-project scoping (plan task 0.9 / BOLA) ----
  // Every user's scoped project ids, in ONE query for the whole roster, so the
  // admin screen does not issue a query per row.
  projectIdsByUser: () => {
    const m = new Map();
    for (const r of _projectIdsGrouped.all()) {
      if (!m.has(r.user_id)) m.set(r.user_id, []);
      m.get(r.user_id).push(r.project_id);
    }
    return m;
  },
  projectIdsForUser: (userId) => _projectIdsForUser.all(userId).map((r) => r.project_id),
  scopedGrantsForUser: (userId) => _scopedGrantsForUser.all(userId),
  setScopedUserRole: (userId, projectId, roleCode, actorId) =>
    _insertScopedUserRole.run({
      user_id: userId, role_code: roleCode, project_id: projectId, actor_id: actorId,
    }),
  clearScopedUserRole: (userId, projectId) => _dropScopedUserRole.run(userId, projectId),
  clearScopedRolesForUser: (userId) => _clearScopedRolesForUser.run(userId),
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

  // ---- cash advance + Expense Report (module 5) ----
  advancesForProject: (projectId) => _advancesForProject.all(projectId),
  advanceById: (id) => _advanceById.get(id),
  lpbLinesForAdvance: (advanceId) => _lpbLinesForAdvance.all(advanceId),
  lpbLinesForProject: (projectId) => _lpbLinesForProject.all(projectId),
  lpbLineById: (id) => _lpbLineById.get(id),
  insertLpbLine: (row) => _insertLpbLine.run(row),
  insertAdvance: (row) => _insertAdvance.run(row),
  checkLpbLine: (lineId, actorId) => _checkLpbLine.run(actorId, lineId),
  rejectLpbLine: (lineId, reason, actorId) => _rejectLpbLine.run(reason, actorId, lineId),
  blockLpbLine: (lineId, reason, actorId) => _blockLpbLine.run(reason, actorId, lineId),
  unblockLpbLine: (lineId) => _unblockLpbLine.run(lineId),
  supersedeLpbLine: (oldId, newId, projectId) => _supersedeLpbLine.run(newId, oldId, projectId),
  lpbSummary: (projectId) => _lpbSummary.get(projectId),
  // Blocked lines and rejected ones, project-wide: both are work waiting on a
  // human, and neither counts as cost. Surfaced so neither can be quietly parked.
  lpbStalled: (projectId) => _lpbStalled.all(projectId),
  reconciliation: (projectId) => _reconciliation.all(projectId),
  reconciliationAll: () => _reconciliationAll.all(),
};