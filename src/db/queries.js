// Queries shared by routes. Each export is a plain function wrapping the
// prepared statement — never export the raw bound method (`.get`/`.all` called
// detached from its statement throws "Illegal invocation").
const db = require('./db');

const _projects = db.prepare(`SELECT * FROM projects ORDER BY name`);
const _projectById = db.prepare(`SELECT * FROM projects WHERE id = ?`);

const _ledgerForProject = db.prepare(`
  SELECT * FROM v_ledger_period
  WHERE project_id = ?
  ORDER BY date DESC, id DESC
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
     import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at)
  VALUES
    (@project_id, @transaction_id, @document_no, @reference_no, @account_code,
     @partner_type, @partner_id, @date, @effective_date, @type, @line_role, @in_cost_basis,
     @cost_category_id, @chart_of_account_id, @cashflow_category_id,
     @transaction_account_id, @wbs_node_id, @amount, @debit, @credit,
     @retainage_amount, @paid_amount, @currency, @description, @source,
     @import_batch_id, @cash_advance_id, @cost_checked, @cost_checked_by, @cost_checked_at)`);

const _insertLedgerAudit = db.prepare(`
  INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
  VALUES ('accounting_ledger', ?, 'create', ?, NULL, ?)`);

const _insertGenericAudit = db.prepare(`
  INSERT INTO audit_log (entity_type, entity_id, action, actor_id, before_json, after_json)
  VALUES (?, ?, ?, ?, ?, ?)`);

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
};