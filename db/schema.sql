-- PRACTIS schema (GENERATED — do not hand-edit)
--
-- This file is a build artefact of db/migrations/*.sql, produced by:
--     node db/dump-schema.js
--
-- It exists so db/validate.py can assert invariants against the schema the app
-- ACTUALLY runs. Before this was generated, the two had drifted (14 triggers here
-- vs 21 in the migrations) and the validator passed against a schema missing the
-- reversal and CBS guards.
--
-- Objects are emitted in dependency order: tables, indexes, triggers, then views.
-- DDL is copied verbatim out of sqlite_master. To change it, write a migration and
-- re-run the generator — never edit this file directly.
--
-- Composition: 43 tables, 45 indexes, 30 triggers, 10 views.

-- TABLES (43)
CREATE TABLE acceptance_register (
  id                  INTEGER PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id         INTEGER REFERENCES wbs_nodes(id),
  certificate_no      TEXT,                     -- legacy acceptance_no
  sequence            INTEGER,                  -- legacy sequence (order of BAST certificates)
  description         TEXT,
  percentage_progress REAL CHECK (percentage_progress BETWEEN 0 AND 100),
  document_date       TEXT,                     -- legacy document_date
  handover_date       TEXT,                     -- legacy submission_date
  accepted_date       TEXT,                     -- legacy approved_date
  invoice_date        TEXT,
  status              TEXT CHECK (status IN ('draft','submitted','accepted','rejected')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          INTEGER REFERENCES users(id)
);
CREATE TABLE "accounting_ledger" (
  id                INTEGER PRIMARY KEY,
  transaction_id    TEXT,
  project_id        INTEGER REFERENCES projects(id),
  document_no       TEXT,
  reference_no      TEXT,
  account_code      TEXT,
  partner_type      TEXT CHECK (partner_type IN ('client','supplier','employee','other')),
  partner_id        INTEGER,
  date              TEXT NOT NULL,
  effective_date    TEXT,
  type              TEXT CHECK (type IS NULL OR type IN
                      ('Income','Expense','Receivable','Payable','LPB','Dropping','Revenue')),
  line_role         TEXT NOT NULL DEFAULT 'other'
                      CHECK (line_role IN ('expense','payable','receivable','dropping','funding','tax','payment','other')),
  in_cost_basis     INTEGER NOT NULL DEFAULT 1 CHECK (in_cost_basis IN (0,1)),
  cost_category_id  INTEGER REFERENCES cost_categories(id),
  chart_of_account_id INTEGER REFERENCES chart_of_accounts(id),
  cashflow_category_id INTEGER REFERENCES cashflow_categories(id),
  transaction_account_id INTEGER REFERENCES transaction_accounts(id),
  wbs_node_id       INTEGER REFERENCES wbs_nodes(id),
  amount            INTEGER NOT NULL,
  debit             INTEGER NOT NULL DEFAULT 0,
  credit            INTEGER NOT NULL DEFAULT 0,
  retainage_amount  INTEGER NOT NULL DEFAULT 0,
  paid_amount       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'IDR',
  description       TEXT,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','lpb','system')),
  import_batch_id   INTEGER REFERENCES import_batches(id),
  cash_advance_id   INTEGER REFERENCES cash_advance(id),
  cost_checked      INTEGER NOT NULL DEFAULT 0 CHECK (cost_checked IN (0,1)),
  cost_checked_by   INTEGER REFERENCES users(id),
  cost_checked_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        INTEGER REFERENCES users(id)
, reverses_ledger_id INTEGER
  REFERENCES accounting_ledger(id));
CREATE TABLE app_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL,                 -- project|client|supplier|baseline|bcr|lpb|report
  entity_id     INTEGER NOT NULL,
  step          TEXT NOT NULL,                 -- initiator|verifier|approver
  required_role TEXT REFERENCES roles(code),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','skipped')),
  actor_id      INTEGER REFERENCES users(id),
  acted_at      TEXT,
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id, step, required_role)
);
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,                -- lpb_statement|expense_report|receipt|document
  entity_id     INTEGER,
  filename      TEXT NOT NULL,
  stored_path   TEXT NOT NULL UNIQUE,         -- relative path under attachments volume
  mime_type     TEXT,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),  -- 10 MB cap
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT                          -- soft delete; hard delete only with explicit approval
);
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER,
  action        TEXT NOT NULL,                 -- create|update|approve|reject|freeze|import|check
  actor_id      INTEGER REFERENCES users(id),
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  before_json   TEXT,
  after_json    TEXT
, request_id TEXT, outcome TEXT, session_hash TEXT);
CREATE TABLE bcr_register (
  id                 INTEGER PRIMARY KEY,
  bcr_no             TEXT UNIQUE,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_type        TEXT NOT NULL CHECK (change_type IN ('add_scope','de_scope','modify','budget_only')),
  wbs_node_id        INTEGER REFERENCES wbs_nodes(id),
  title              TEXT NOT NULL,
  description        TEXT,
  reason             TEXT,
  impact_cost        INTEGER NOT NULL DEFAULT 0,
  impact_schedule_days INTEGER,
  effective_period   TEXT,                     -- prospective: applies from this period forward
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','verified','approved','rejected','withdrawn')),
  initiated_by       INTEGER REFERENCES users(id),
  verified_by        INTEGER REFERENCES users(id),
  approved_by        INTEGER REFERENCES users(id),
  initiated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at         TEXT,
  decision_note      TEXT,
  old_baseline_json  TEXT,                     -- archived prior values (audit)
  new_baseline_json  TEXT
, rbs_rows_json TEXT);
CREATE TABLE "cash_advance" (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  advance_no     TEXT,                          -- legacy memo_no
  sequence       INTEGER,                       -- legacy sequence
  recipient_type TEXT CHECK (recipient_type IN ('employee','project_admin','supplier')),
  recipient_id   INTEGER,
  amount         INTEGER NOT NULL,
  submission_date TEXT,                         -- legacy submission_date
  approved_date  TEXT,                          -- legacy approved_date
  issued_date    TEXT,                          -- taken = approved_date when absent
  reimburse_amount INTEGER,                     -- legacy reimburse_amount
  vat            INTEGER,                       -- legacy vat
  total_amount   INTEGER,                       -- legacy total_amount
  description    TEXT,
  currency       TEXT NOT NULL DEFAULT 'IDR',
  ledger_id      INTEGER REFERENCES accounting_ledger(id),   -- the bulk ledger line
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settling','settled','closed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE cashflow_categories (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,          -- legacy account_code
  name          TEXT NOT NULL,
  category      TEXT,                          -- legacy category
  inflow_outflow TEXT CHECK (inflow_outflow IN ('in','out')),   -- legacy column
  direction     TEXT CHECK (direction IN ('in','out')),
  hidden        INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE cbs_plan (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  transaction_account_id INTEGER NOT NULL REFERENCES transaction_accounts(id),
  wbs_node_id           INTEGER REFERENCES wbs_nodes(id),
  -- plan_type: baseline = approved PM (R2-4); forecast = "cost adjustment" (R2-24):
  --   user starts it as a DUPLICATE of the execution plan, then EDITS it period by period
  --   against actuals to produce the forecast (ETC/EAC). bcr = re-baseline; cost_adjustment reserved.
  plan_type             TEXT NOT NULL CHECK (plan_type IN ('baseline','forecast','bcr','cost_adjustment')),
  version               INTEGER NOT NULL DEFAULT 1,
  period_month          TEXT NOT NULL,          -- 'YYYY-MM'
  amount                INTEGER NOT NULL DEFAULT 0,
  is_manual_override    INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_override IN (0,1)),
  note                  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  created_by            INTEGER REFERENCES users(id)
);
CREATE TABLE change_log (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id   INTEGER REFERENCES wbs_nodes(id),
  action        TEXT NOT NULL CHECK (action IN ('add_line','split_line','rename_line','reparent','restructure')),
  reason        TEXT,
  contract_value_delta INTEGER NOT NULL DEFAULT 0,   -- must be 0 for internal replanning
  actor_id      INTEGER REFERENCES users(id),
  at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chart_of_accounts (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,          -- legacy account_code
  name          TEXT NOT NULL,
  category      TEXT,                          -- legacy category
  subcategory   TEXT,                          -- legacy subcategory
  account_type  TEXT CHECK (account_type IN ('asset','liability','equity','income','expense')),
  normal_side   TEXT CHECK (normal_side IN ('debit','credit')),
  hidden        INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE clients (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  industry_id         INTEGER REFERENCES industry_types(id),
  address             TEXT,
  correspondence_person TEXT,
  email               TEXT,
  phone               TEXT,
  payment_terms_days  INTEGER,                  -- default due-date offset (R2-6)
  description         TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
, created_by INTEGER REFERENCES users(id));
CREATE TABLE cost_categories (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  category       TEXT,                          -- legacy category
  is_receivable  INTEGER NOT NULL DEFAULT 0 CHECK (is_receivable IN (0,1)),
  is_payable     INTEGER NOT NULL DEFAULT 0 CHECK (is_payable IN (0,1)),
  is_cash_in     INTEGER NOT NULL DEFAULT 0 CHECK (is_cash_in IN (0,1)),
  is_cash_out    INTEGER NOT NULL DEFAULT 0 CHECK (is_cash_out IN (0,1)),
  is_retainage   INTEGER NOT NULL DEFAULT 0 CHECK (is_retainage IN (0,1)),
  hidden         INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  description    TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE employees (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  full_name          TEXT NOT NULL,
  user_id            INTEGER REFERENCES users(id),
  team_code          TEXT REFERENCES teams(code),
  position           TEXT,
  email              TEXT,
  phone              TEXT,
  default_rate       INTEGER,                   -- IDR per hour/unit
  rate_unit          TEXT,                      -- hour|day|month
  contract_start     TEXT,
  contract_end       TEXT,
  contract_status    TEXT CHECK (contract_status IN ('active','expired','terminated','suspended')),
  description        TEXT,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE frozen_periods (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,
  frozen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  frozen_by     INTEGER REFERENCES users(id),
  report_id     INTEGER,                       -- FK added after project_reports
  UNIQUE (project_id, period_month)
);
CREATE TABLE import_batches (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER REFERENCES import_profiles(id),
  project_id     INTEGER REFERENCES projects(id),
  filename       TEXT,
  row_count      INTEGER,
  inserted_count INTEGER DEFAULT 0,
  skipped_count  INTEGER DEFAULT 0,             -- duplicates / already-tagged (never overwritten)
  error_json     TEXT,
  imported_at    TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by    INTEGER REFERENCES users(id)
, status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('staged','previewed','confirmed','failed','expired')), original_name TEXT, uploaded_by INTEGER REFERENCES users(id), new_count INTEGER NOT NULL DEFAULT 0, confirmed_at TEXT, expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 days')), staging_json TEXT, file_path TEXT);
CREATE TABLE import_profiles (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  source_type    TEXT NOT NULL CHECK (source_type IN ('ledger','lpb','procurement')),
  template_version TEXT NOT NULL DEFAULT 'v1',
  mapping_json   TEXT,                          -- column → field map (fixed template, stored for reference)
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE industry_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT
);
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY,
  type           TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','running','failed','completed')),
  run_at         TEXT NOT NULL DEFAULT (datetime('now')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT,
  finished_at    TEXT
);
CREATE TABLE "lpb_statements" (
  id                    INTEGER PRIMARY KEY,
  cash_advance_id       INTEGER REFERENCES cash_advance(id) ON DELETE CASCADE,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lpb_no                TEXT,
  period_month          TEXT,                  -- 'YYYY-MM'
  entry_date            TEXT NOT NULL,
  description           TEXT,
  -- legacy c_lpb_ledger carries its own debit/credit/amount (it doubles as a ledger fragment);
  -- amount is the single signed value per R2-7, debit/credit kept for migration fidelity only.
  -- NOT NULL DEFAULT 0 to match accounting_ledger: NULL sides make `amount = debit - credit`
  -- evaluate to NULL instead of failing (review 2026-09-24, finding A-5).
  debit                 INTEGER NOT NULL DEFAULT 0,
  credit                INTEGER NOT NULL DEFAULT 0,
  amount                INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'IDR',
  transaction_account_id INTEGER REFERENCES transaction_accounts(id),   -- filled/confirmed by Cost Controller
  wbs_node_id           INTEGER REFERENCES wbs_nodes(id),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','checked','rejected','blocked')),
  checked_by            INTEGER REFERENCES users(id),
  checked_at            TEXT,
  reject_reason         TEXT,
  block_reason          TEXT,                          -- why it cannot be booked yet (missing CBS/WBS)
  superseded_by         INTEGER REFERENCES lpb_statements(id),  -- the corrected line that replaced this one
  ledger_id             INTEGER REFERENCES accounting_ledger(id),       -- set when rolled into actuals
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  created_by            INTEGER REFERENCES users(id)
);
CREATE TABLE notification_inbox (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    INTEGER REFERENCES projects(id),
  alert_type    TEXT NOT NULL,                 -- cpi_spi_breach|cost_overrun|progress_stale|invoice_overdue|
                                               -- bcr_pending|cash_advance_aged|period_frozen
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title         TEXT NOT NULL,
  body          TEXT,
  entity_type   TEXT,
  entity_id     INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  read_at       TEXT
);
CREATE TABLE password_resets (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  temp_password_hash TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,                          -- NULL = unused
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE procurement_register (
  id             INTEGER PRIMARY KEY,
  document_no    TEXT,                          -- legacy document_no (PO)
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id    INTEGER REFERENCES wbs_nodes(id),
  transaction_account_id INTEGER REFERENCES transaction_accounts(id),  -- legacy sub_rbs_code
  supplier_id    INTEGER REFERENCES suppliers(id),
  procurement_type TEXT,                        -- legacy type
  item           TEXT,                          -- legacy item
  description    TEXT,
  currency       TEXT NOT NULL DEFAULT 'IDR',
  amount         INTEGER,
  payment_terms  TEXT,                          -- legacy payment_terms
  status         TEXT CHECK (status IN ('planned','rfq','ordered','delivered','invoiced','closed','cancelled')),
  purchase_date  TEXT,                          -- legacy purchase_date
  delivery_date  TEXT,                          -- legacy delivery_date
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT
);
CREATE TABLE progress_milestones (
  id            INTEGER PRIMARY KEY,
  wbs_node_id   INTEGER NOT NULL REFERENCES wbs_nodes(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,                  -- mobilize / install / test / handover
  pct_weight    REAL NOT NULL DEFAULT 0 CHECK (pct_weight BETWEEN 0 AND 100),
  planned_date  TEXT,
  ticked        INTEGER NOT NULL DEFAULT 0 CHECK (ticked IN (0,1)),
  ticked_at     TEXT,
  ticked_by     INTEGER REFERENCES users(id),
  note          TEXT,
  UNIQUE (wbs_node_id, seq)
);
CREATE TABLE project_reports (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_month   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','approved','frozen')),
  spi            REAL,
  cpi            REAL,
  cost_variance_pct REAL,
  receivable_amount INTEGER,
  revenue_recognized INTEGER,
  payable_amount INTEGER,
  payload_json   TEXT,
  generated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TEXT,
  frozen_at      TEXT,
  UNIQUE (project_id, period_month)
);
CREATE TABLE project_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT
);
CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  client_id           INTEGER REFERENCES clients(id),
  industry_type       TEXT,
  contract_amount     INTEGER,                 -- total contract value (BAC envelope)
  currency            TEXT NOT NULL DEFAULT 'IDR',   -- reserved for multi-currency (R2-9)
  revenue_method      TEXT CHECK (revenue_method IN ('milestone','poc','time_based','on_billing')),
  payment_terms_days  INTEGER,                 -- overrides client default (R2-6)
  project_type_id     INTEGER REFERENCES project_types(id),   -- legacy project_type_id
  start_date          TEXT,
  end_date            TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','on_hold','closed')),
  -- 3-step close (Sketch-6 / PRD 4.5)
  close_operational_at TEXT,
  close_financial_at   TEXT,
  close_contractual_at TEXT,
  baseline_locked     INTEGER NOT NULL DEFAULT 0 CHECK (baseline_locked IN (0,1)),
  baseline_locked_at  TEXT,
  baseline_locked_by  INTEGER REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  created_by          INTEGER REFERENCES users(id)
);
CREATE TABLE rbs_code (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  resource_category_id INTEGER REFERENCES resource_categories(id),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE rbs_load (
  id                    INTEGER PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_node_id           INTEGER REFERENCES wbs_nodes(id),
  rbs_code              TEXT REFERENCES rbs_code(code),
  transaction_account_id INTEGER REFERENCES transaction_accounts(id),
  description           TEXT,
  rate                  INTEGER,               -- IDR per unit
  units                 REAL,                  -- hours / tonnes / days
  unit_label            TEXT,
  total_amount          INTEGER,               -- rate * units (materialised for the invariant check)
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, wbs_node_id, rbs_code, transaction_account_id, version)
);
CREATE TABLE resource_categories (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE revenue_recognized (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('milestone','poc','time_based','on_billing')),
  basis_pct     REAL,                          -- % used (BAST for POC; 1.0 for on-billing; etc.)
  amount        INTEGER NOT NULL,              -- revenue recognised this period
  cumulative    INTEGER,                       -- to-date recognised
  acceptance_id INTEGER REFERENCES acceptance_register(id),
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER REFERENCES users(id),
  UNIQUE (project_id, period_month)
);
CREATE TABLE roles (
  code          TEXT PRIMARY KEY,       -- administrator|project_manager|project_controller|cost_controller|
                                        -- procurement|human_capital|finance|project_admin|viewer
  name          TEXT NOT NULL,
  domain        TEXT                    -- system|project|schedule|cost|supply|people|money|entry|readonly
);
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,             -- random session id (cookie value, hashed at rest)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,                -- 30 min idle / 12 h absolute (TS-16), app computes
  ip_address    TEXT,
  user_agent    TEXT,
  revoked_at    TEXT                          -- NULL = active; set on logout/disable/reset/role change
);
CREATE TABLE suppliers (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  supplier_type TEXT,                           -- legacy a_supplier_register.type
  address       TEXT,
  correspondence_person TEXT,
  email         TEXT,
  phone         TEXT,
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT
, created_by INTEGER REFERENCES users(id));
CREATE TABLE teams (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE transaction_accounts (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,          -- legacy sub_rbs_code
  name           TEXT NOT NULL,
  default_wbs_code TEXT REFERENCES wbs_code(code),   -- legacy wbs_code (suggestion only)
  default_rbs_code TEXT REFERENCES rbs_code(code),   -- legacy rbs_code (suggestion only)
  cost_category_id    INTEGER REFERENCES cost_categories(id),
  cashflow_category_id INTEGER REFERENCES cashflow_categories(id),
  chart_of_account_id  INTEGER REFERENCES chart_of_accounts(id),
  hidden         INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  description    TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE user_invitations (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the emailed token (never store raw)
  invited_by    INTEGER NOT NULL REFERENCES users(id),
  role_id       TEXT REFERENCES roles(code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,          -- 72 h (spec 3.4: single-use, time-limited)
  used_at       TEXT,                   -- NULL = unused; set on consumption
  revoked_at    TEXT                    -- NULL = active; set on cancel
);
CREATE TABLE user_roles (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code     TEXT NOT NULL REFERENCES roles(code),
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global scope
  granted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by    INTEGER REFERENCES users(id),
  UNIQUE (user_id, role_code, project_id)
);
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,                 -- email+password auth (Q22a)
  team_id       INTEGER REFERENCES teams(id),
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_system_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_system_admin IN (0,1)),  -- Administrator (global)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
, failed_login_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','id')), timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta');
CREATE TABLE wbs_code (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  parent_code   TEXT REFERENCES wbs_code(code),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);
CREATE TABLE wbs_nodes (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  wbs_code       TEXT NOT NULL,                 -- code from wbs_code master
  name           TEXT NOT NULL,
  parent_id      INTEGER REFERENCES wbs_nodes(id),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT,
  end_date       TEXT,
  baseline_start TEXT,
  baseline_end   TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','completed','de_scoped')),
  is_control_account INTEGER NOT NULL DEFAULT 0 CHECK (is_control_account IN (0,1)),
  version        INTEGER NOT NULL DEFAULT 1,    -- renames/restructures version the line, never overwrite
  superseded_by  INTEGER REFERENCES wbs_nodes(id),
  de_scope_period TEXT,                        -- period the de-scope took effect (prospective)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, wbs_code, version)
);
CREATE TABLE wbs_progress (
  id            INTEGER PRIMARY KEY,
  wbs_node_id   INTEGER NOT NULL REFERENCES wbs_nodes(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,                  -- 'YYYY-MM'
  pct_complete  REAL NOT NULL CHECK (pct_complete BETWEEN 0 AND 100),
  source        TEXT NOT NULL DEFAULT 'milestones' CHECK (source IN ('milestones','manual')),
  reported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reported_by   INTEGER REFERENCES users(id),
  frozen        INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),
  UNIQUE (wbs_node_id, period_month)
);

-- INDEXS (45)
CREATE INDEX idx_acceptance_project ON acceptance_register(project_id);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';
CREATE INDEX idx_attachments_project ON attachments(project_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_bcr_project ON bcr_register(project_id, status);
CREATE INDEX idx_cash_advance_project ON cash_advance(project_id);
CREATE INDEX idx_cbs_plan_lookup ON cbs_plan(project_id, period_month, plan_type, version);
CREATE INDEX idx_cbs_plan_wbs ON cbs_plan(wbs_node_id);
CREATE INDEX idx_change_log_project ON change_log(project_id);
CREATE INDEX idx_imports_project_status ON import_batches(project_id, status);
CREATE INDEX idx_invites_pending ON user_invitations(email) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_jobs_due ON jobs(state, run_at);
CREATE INDEX idx_ledger_cbs          ON accounting_ledger(transaction_account_id);
CREATE INDEX idx_ledger_cost_checked ON accounting_ledger(cost_checked);
CREATE INDEX idx_ledger_doc          ON accounting_ledger(document_no);
CREATE INDEX idx_ledger_effective    ON accounting_ledger(project_id, effective_date);
CREATE UNIQUE INDEX idx_ledger_import_dedupe ON accounting_ledger(
  COALESCE(transaction_id,''), COALESCE(document_no,''), COALESCE(date,''),
  amount, COALESCE(project_id,0))
WHERE source = 'import';
CREATE UNIQUE INDEX idx_ledger_one_reversal
  ON accounting_ledger(reverses_ledger_id)
  WHERE reverses_ledger_id IS NOT NULL;
CREATE INDEX idx_ledger_period       ON accounting_ledger(project_id, date);
CREATE INDEX idx_ledger_project      ON accounting_ledger(project_id);
CREATE INDEX idx_ledger_reverses ON accounting_ledger(reverses_ledger_id);
CREATE INDEX idx_ledger_unchecked    ON accounting_ledger(cost_checked) WHERE cost_checked = 0;
CREATE INDEX idx_ledger_wbs          ON accounting_ledger(wbs_node_id);
CREATE INDEX idx_lpb_project ON lpb_statements(project_id, period_month);
CREATE INDEX idx_lpb_status  ON lpb_statements(status);
CREATE INDEX idx_milestones_node ON progress_milestones(wbs_node_id);
CREATE UNIQUE INDEX idx_notif_unread_unique
  ON notification_inbox(user_id, alert_type, COALESCE(project_id, 0), COALESCE(entity_type, ''), COALESCE(entity_id, 0))
  WHERE read_at IS NULL;
CREATE INDEX idx_notif_user_unread ON notification_inbox(user_id, read_at);
CREATE INDEX idx_proc_reg_project ON procurement_register(project_id);
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_pwreset_user ON password_resets(user_id);
CREATE INDEX idx_rbs_load_bucket_lookup ON rbs_load(
  project_id, wbs_node_id, rbs_code, version);
CREATE INDEX idx_rbs_load_project ON rbs_load(project_id);
CREATE INDEX idx_rev_recog_project ON revenue_recognized(project_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_roles_project ON user_roles(project_id);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_wbs_nodes_parent ON wbs_nodes(parent_id);
CREATE INDEX idx_wbs_nodes_project ON wbs_nodes(project_id);
CREATE INDEX idx_wbs_progress_period ON wbs_progress(period_month);
CREATE UNIQUE INDEX uq_cbs_plan_bucket ON cbs_plan(
  project_id, transaction_account_id, COALESCE(wbs_node_id, 0), plan_type, period_month, version);
CREATE UNIQUE INDEX uq_rbs_load_bucket ON rbs_load(
  project_id,
  wbs_node_id,
  rbs_code,
  COALESCE(transaction_account_id, 0),
  version
);

-- TRIGGERS (30)
CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be deleted');
END;
CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be updated');
END;
CREATE TRIGGER trg_cash_advance_immutable_when_committed
BEFORE UPDATE OF amount, project_id, advance_no, recipient_type, recipient_id,
                 vat, reimburse_amount, total_amount, ledger_id, currency
ON cash_advance
WHEN OLD.status <> 'open' AND (
     OLD.amount           IS NOT NEW.amount           OR
     OLD.project_id       IS NOT NEW.project_id       OR
     OLD.advance_no       IS NOT NEW.advance_no       OR
     OLD.recipient_type   IS NOT NEW.recipient_type   OR
     OLD.recipient_id     IS NOT NEW.recipient_id     OR
     OLD.vat              IS NOT NEW.vat              OR
     OLD.reimburse_amount IS NOT NEW.reimburse_amount OR
     OLD.total_amount     IS NOT NEW.total_amount     OR
     OLD.ledger_id        IS NOT NEW.ledger_id        OR
     OLD.currency         IS NOT NEW.currency
)
BEGIN
  SELECT RAISE(ABORT,
    'cash_advance: a pot that is settling/settled/closed is immutable; correct it through the ledger instead');
END;
CREATE TRIGGER trg_cash_advance_money_integrity_insert
BEFORE INSERT ON cash_advance
WHEN typeof(NEW.amount) <> 'integer' OR NEW.amount = 0
BEGIN
  SELECT RAISE(ABORT, 'cash_advance: amount must be a non-zero whole-rupiah integer');
END;
CREATE TRIGGER trg_cash_advance_no_delete_when_used
BEFORE DELETE ON cash_advance
WHEN OLD.status <> 'open'
  OR EXISTS (SELECT 1 FROM lpb_statements WHERE cash_advance_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT,
    'cash_advance: cannot delete a pot that is not open or that carries Expense Report detail');
END;
CREATE TRIGGER trg_cbs_plan_baseline_needs_wbs_insert
BEFORE INSERT ON cbs_plan
FOR EACH ROW WHEN NEW.plan_type = 'baseline' AND NEW.wbs_node_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'a baseline bucket must name a work line (plan_type=baseline, wbs_node_id IS NULL)');
END;
CREATE TRIGGER trg_cbs_plan_baseline_needs_wbs_update
BEFORE UPDATE OF wbs_node_id ON cbs_plan
FOR EACH ROW WHEN NEW.plan_type = 'baseline' AND NEW.wbs_node_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'a baseline bucket must name a work line (plan_type=baseline, wbs_node_id IS NULL)');
END;
CREATE TRIGGER trg_ledger_frozen_period_effective_date
BEFORE UPDATE OF effective_date, date ON accounting_ledger
WHEN NEW.reverses_ledger_id IS NULL
 AND (OLD.date IS NOT NEW.date OR OLD.effective_date IS NOT NEW.effective_date)
 AND EXISTS (
   SELECT 1 FROM frozen_periods fp
   WHERE fp.project_id = NEW.project_id
     AND fp.period_month = substr(COALESCE(NEW.effective_date, NEW.date), 1, 7)
 )
BEGIN
  SELECT RAISE(ABORT,
    'frozen period: this accounting period is frozen and rejects ordinary backdated writes. Correct an existing line instead (a reversal is admitted), or ask an Administrator to unfreeze the period.');
END;
CREATE TRIGGER trg_ledger_frozen_period_insert
BEFORE INSERT ON accounting_ledger
WHEN NEW.reverses_ledger_id IS NULL
 AND EXISTS (
   SELECT 1 FROM frozen_periods fp
   WHERE fp.project_id = NEW.project_id
     AND fp.period_month = substr(COALESCE(NEW.effective_date, NEW.date), 1, 7)
 )
BEGIN
  SELECT RAISE(ABORT,
    'frozen period: this accounting period is frozen and rejects ordinary backdated writes. Correct an existing line instead (a reversal is admitted), or ask an Administrator to unfreeze the period.');
END;
CREATE TRIGGER trg_ledger_immutable_financial_fields
BEFORE UPDATE OF debit, credit, project_id, in_cost_basis, cost_checked, cost_checked_by,
                 cost_checked_at, line_role, source, import_batch_id, cash_advance_id,
                 cost_category_id, chart_of_account_id, cashflow_category_id,
                 transaction_account_id, wbs_node_id, partner_type, partner_id,
                 currency, retainage_amount, paid_amount, account_code,
                 reference_no, transaction_id
ON accounting_ledger
WHEN (
     OLD.debit                IS NOT NEW.debit                OR
     OLD.credit               IS NOT NEW.credit               OR
     OLD.project_id           IS NOT NEW.project_id           OR
     OLD.source               IS NOT NEW.source               OR
     OLD.import_batch_id      IS NOT NEW.import_batch_id      OR
     OLD.cash_advance_id      IS NOT NEW.cash_advance_id      OR
     OLD.chart_of_account_id  IS NOT NEW.chart_of_account_id  OR
     OLD.cashflow_category_id IS NOT NEW.cashflow_category_id OR
     OLD.partner_type         IS NOT NEW.partner_type         OR
     OLD.partner_id           IS NOT NEW.partner_id           OR
     OLD.currency             IS NOT NEW.currency             OR
     OLD.retainage_amount     IS NOT NEW.retainage_amount     OR
     OLD.paid_amount          IS NOT NEW.paid_amount          OR
     OLD.account_code         IS NOT NEW.account_code         OR
     OLD.reference_no         IS NOT NEW.reference_no         OR
     OLD.transaction_id       IS NOT NEW.transaction_id
  OR (
     (OLD.wbs_node_id IS NOT NEW.wbs_node_id
        AND NOT (OLD.wbs_node_id IS NULL AND NEW.wbs_node_id IS NOT NULL))
     OR (OLD.transaction_account_id IS NOT NEW.transaction_account_id
        AND NOT (OLD.transaction_account_id IS NULL AND NEW.transaction_account_id IS NOT NULL))
     OR (OLD.cost_category_id IS NOT NEW.cost_category_id
        AND NOT (OLD.cost_category_id IS NULL AND NEW.cost_category_id IS NOT NULL))
     OR (OLD.cost_checked IS NOT NEW.cost_checked
        AND NOT (OLD.cost_checked = 0 AND NEW.cost_checked = 1
                 AND NEW.cost_checked_by IS NOT NULL AND NEW.cost_checked_at IS NOT NULL))
     OR (OLD.cost_checked_by IS NOT NEW.cost_checked_by
        AND NOT (OLD.cost_checked = 0 AND NEW.cost_checked = 1
                 AND NEW.cost_checked_by IS NOT NULL AND NEW.cost_checked_at IS NOT NULL))
     OR (OLD.cost_checked_at IS NOT NEW.cost_checked_at
        AND NOT (OLD.cost_checked = 0 AND NEW.cost_checked = 1
                 AND NEW.cost_checked_by IS NOT NULL AND NEW.cost_checked_at IS NOT NULL))
     OR (OLD.line_role IS NOT NEW.line_role
        AND NOT (OLD.in_cost_basis = 1 AND NEW.in_cost_basis = 1
                 AND OLD.line_role = 'other' AND NEW.line_role IN ('expense','payable')))
     OR (OLD.in_cost_basis IS NOT NEW.in_cost_basis
        AND NOT (OLD.in_cost_basis = 1 AND NEW.in_cost_basis = 1
                 AND OLD.line_role = 'other' AND NEW.line_role IN ('expense','payable')))
  )
)
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger financial/classification fields are immutable; post a reversing + correcting line instead');
END;
CREATE TRIGGER trg_ledger_money_integrity_insert
BEFORE INSERT ON accounting_ledger
WHEN typeof(NEW.amount) <> 'integer'
  OR typeof(NEW.debit)  <> 'integer'
  OR typeof(NEW.credit) <> 'integer'
  OR NEW.amount <> NEW.debit - NEW.credit
  OR NEW.amount = 0
  OR (NEW.debit <> 0 AND NEW.credit <> 0)
  OR NEW.debit < 0 OR NEW.credit < 0
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger: whole-rupiah integers only; amount must equal debit - credit; enter ONE side only and never a negative side');
END;
CREATE TRIGGER trg_ledger_no_amount_update
BEFORE UPDATE OF amount, date, type, document_no ON accounting_ledger
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger amount/date/type/document_no are immutable; post a correcting line instead');
END;
CREATE TRIGGER trg_ledger_no_delete
BEFORE DELETE ON accounting_ledger
BEGIN
  SELECT RAISE(ABORT, 'accounting_ledger rows are never deleted; post a reversing entry instead');
END;
CREATE TRIGGER trg_ledger_reversal_link_immutable
BEFORE UPDATE OF reverses_ledger_id ON accounting_ledger
WHEN OLD.reverses_ledger_id IS NOT NEW.reverses_ledger_id
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger: a reversal link cannot be changed or removed; post a correcting line instead');
END;
CREATE TRIGGER trg_ledger_reversal_must_negate
BEFORE INSERT ON accounting_ledger
WHEN NEW.reverses_ledger_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM accounting_ledger o
     WHERE o.id = NEW.reverses_ledger_id
       AND o.project_id IS NEW.project_id
       AND NEW.debit  = o.credit
       AND NEW.credit = o.debit
       AND NEW.amount = -o.amount
  )
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger: a reversing entry must negate the original line (same project, swapped debit/credit, negated amount)');
END;
CREATE TRIGGER trg_lpb_blocked_needs_reason
BEFORE UPDATE OF status, block_reason ON lpb_statements
WHEN NEW.status = 'blocked' AND (NEW.block_reason IS NULL OR trim(NEW.block_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'lpb_statements: status=blocked requires block_reason (why it cannot be booked yet)');
END;
CREATE TRIGGER trg_lpb_blocked_needs_reason_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'blocked' AND (NEW.block_reason IS NULL OR trim(NEW.block_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'lpb_statements: status=blocked requires block_reason (why it cannot be booked yet)');
END;
CREATE TRIGGER trg_lpb_checked_is_final
BEFORE UPDATE OF amount, debit, credit, status, checked_by, checked_at, cash_advance_id,
                 project_id, lpb_no, entry_date, transaction_account_id, wbs_node_id
ON lpb_statements
WHEN OLD.status = 'checked' AND (
     OLD.amount                IS NOT NEW.amount                OR
     OLD.debit                 IS NOT NEW.debit                 OR
     OLD.credit                IS NOT NEW.credit                OR
     OLD.status                IS NOT NEW.status                OR
     OLD.checked_by            IS NOT NEW.checked_by            OR
     OLD.checked_at            IS NOT NEW.checked_at            OR
     OLD.cash_advance_id       IS NOT NEW.cash_advance_id       OR
     OLD.project_id            IS NOT NEW.project_id            OR
     OLD.lpb_no                IS NOT NEW.lpb_no                OR
     OLD.entry_date            IS NOT NEW.entry_date            OR
     OLD.transaction_account_id IS NOT NEW.transaction_account_id OR
     OLD.wbs_node_id           IS NOT NEW.wbs_node_id
)
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line is final; reverse it with a new line instead of editing it');
END;
CREATE TRIGGER trg_lpb_checked_no_delete
BEFORE DELETE ON lpb_statements
WHEN OLD.status = 'checked'
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line is never deleted; post a reversing line instead');
END;
CREATE TRIGGER trg_lpb_checked_requires_cbs
BEFORE UPDATE OF status, transaction_account_id ON lpb_statements
WHEN NEW.status = 'checked' AND NEW.transaction_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line must carry a CBS account — without one its cost cannot be attributed to anything');
END;
CREATE TRIGGER trg_lpb_checked_requires_cbs_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'checked' AND NEW.transaction_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line must carry a CBS account — without one its cost cannot be attributed to anything');
END;
CREATE TRIGGER trg_lpb_checked_requires_checker
BEFORE UPDATE OF status, checked_by, checked_at ON lpb_statements
WHEN NEW.status = 'checked'
 AND (NEW.checked_by IS NULL OR NEW.checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: status=checked requires checked_by and checked_at (the Cost Controller who checked it)');
END;
CREATE TRIGGER trg_lpb_checked_requires_checker_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'checked'
 AND (NEW.checked_by IS NULL OR NEW.checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: status=checked requires checked_by and checked_at (the Cost Controller who checked it)');
END;
CREATE TRIGGER trg_lpb_frozen_period_check
BEFORE UPDATE OF status ON lpb_statements
WHEN NEW.status = 'checked'
 -- the door: a line that supersedes another is a correction, not a new entry
 AND NOT EXISTS (SELECT 1 FROM lpb_statements old WHERE old.superseded_by = NEW.id)
 AND EXISTS (
   SELECT 1 FROM frozen_periods fp
   WHERE fp.project_id = NEW.project_id
     AND fp.period_month = COALESCE(NEW.period_month, substr(NEW.entry_date, 1, 7))
 )
BEGIN
  SELECT RAISE(ABORT,
    'frozen period: this accounting period is frozen and rejects ordinary backdated writes. Post a line that supersedes the existing one instead, or ask an Administrator to unfreeze the period.');
END;
CREATE TRIGGER trg_lpb_frozen_period_check_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'checked'
 AND NOT EXISTS (SELECT 1 FROM lpb_statements old WHERE old.superseded_by = NEW.id)
 AND EXISTS (
   SELECT 1 FROM frozen_periods fp
   WHERE fp.project_id = NEW.project_id
     AND fp.period_month = COALESCE(NEW.period_month, substr(NEW.entry_date, 1, 7))
 )
BEGIN
  SELECT RAISE(ABORT,
    'frozen period: this accounting period is frozen and rejects ordinary backdated writes. Post a line that supersedes the existing one instead, or ask an Administrator to unfreeze the period.');
END;
CREATE TRIGGER trg_lpb_money_integrity_insert
BEFORE INSERT ON lpb_statements
WHEN typeof(NEW.amount) <> 'integer'
  OR typeof(NEW.debit)  <> 'integer'
  OR typeof(NEW.credit) <> 'integer'
  OR NEW.amount <> NEW.debit - NEW.credit
  OR NEW.amount = 0
  OR (NEW.debit <> 0 AND NEW.credit <> 0)
  OR NEW.debit < 0 OR NEW.credit < 0
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: whole-rupiah integers only; amount must equal debit - credit; enter ONE side only and never a negative side');
END;
CREATE TRIGGER trg_lpb_no_check_from_blocked
BEFORE UPDATE OF status ON lpb_statements
WHEN NEW.status = 'checked' AND OLD.status IN ('blocked','rejected')
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a blocked or rejected line cannot be checked — clear the block or enter a corrected line');
END;
CREATE TRIGGER trg_rbs_load_no_negative
BEFORE INSERT ON rbs_load
WHEN NEW.total_amount < 0 OR NEW.rate < 0 OR NEW.units < 0
BEGIN
  SELECT RAISE(ABORT, 'A resource-load figure cannot be negative.');
END;
CREATE TRIGGER trg_rbs_load_version_is_current_insert
BEFORE INSERT ON rbs_load
WHEN NEW.version <= (
  SELECT COALESCE(MAX(r.version), 0) FROM rbs_load r
  WHERE r.project_id = NEW.project_id
    AND r.wbs_node_id = NEW.wbs_node_id
    AND r.rbs_code = NEW.rbs_code
    AND COALESCE(r.transaction_account_id, 0) = COALESCE(NEW.transaction_account_id, 0)
)
BEGIN
  SELECT RAISE(ABORT, 'A resource-load row must be the newest version for its bucket.');
END;
CREATE TRIGGER trg_rbs_load_version_is_current_update
BEFORE UPDATE OF version, wbs_node_id, rbs_code, transaction_account_id ON rbs_load
WHEN NEW.version < (
  SELECT COALESCE(MAX(r.version), 0) FROM rbs_load r
  WHERE r.project_id = NEW.project_id
    AND r.wbs_node_id = NEW.wbs_node_id
    AND r.rbs_code = NEW.rbs_code
    AND COALESCE(r.transaction_account_id, 0) = COALESCE(NEW.transaction_account_id, 0)
    AND r.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'A resource-load row must not be given a version lower than the current one.');
END;

-- VIEWS (10)
CREATE VIEW v_aging AS
SELECT
  r.project_id, r.document_no, r.partner_id, r.invoice_date, r.outstanding_amount,
  CASE WHEN r.retainage_amount > 0 THEN 1 ELSE 0 END AS has_retainage,
  r.days_aged,
  r.aging_bucket,
  r.terms_days,
  r.terms_source,
  r.due_date,
  -- Days PAST DUE, clamped at 0: not-yet-due is 0 overdue, never negative. NaN cannot occur here —
  -- `due_date` is only non-NULL when the invoice date and the terms are both known.
  CASE
    WHEN r.due_date IS NULL THEN NULL
    ELSE MAX(0, CAST(julianday('now') - julianday(r.due_date) AS INTEGER))
  END AS overdue_days
FROM v_receivable_due r
WHERE r.outstanding_amount <> 0
  AND r.invoice_date IS NOT NULL AND r.invoice_date <> '';
CREATE VIEW v_cbs_actual AS
SELECT project_id, transaction_account_id, period_month, SUM(amount) AS actual_amount
FROM (
  SELECT lp.project_id, lp.transaction_account_id, lp.period_month, lp.amount
  FROM v_ledger_period lp
  WHERE lp.in_cost_basis = 1 AND lp.line_role IN ('expense','payable','tax')
  UNION ALL
  SELECT project_id, transaction_account_id, period_month, amount
  FROM lpb_statements
  WHERE status = 'checked'
    AND transaction_account_id IS NOT NULL   -- unattributable cost is not cost
)
GROUP BY project_id, transaction_account_id, period_month;
CREATE VIEW v_descoped_lines AS
SELECT n.id, n.project_id, n.wbs_code, n.name, n.status, n.version, n.de_scope_period,
       -- What was actually spent on the cancelled line. Reads the ledger directly: a
       -- de-scope never touches a booked cost, which is the point of the rule.
       (SELECT SUM(amount) FROM accounting_ledger l WHERE l.wbs_node_id = n.id) AS cost_incurred,
       -- The budget that left scope: the line's CURRENT baseline only. Summing every
       -- version would report a removed budget larger than the one that ever existed.
       (SELECT SUM(c.amount) FROM cbs_plan c
         WHERE c.wbs_node_id = n.id AND c.plan_type = 'baseline'
           AND c.version = (
             SELECT MAX(c2.version) FROM cbs_plan c2
             WHERE c2.project_id = c.project_id
               AND c2.transaction_account_id = c.transaction_account_id
               AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
               AND c2.plan_type = c.plan_type
               AND c2.period_month = c.period_month
           )) AS budget_removed
FROM wbs_nodes n
WHERE n.status = 'de_scoped';
CREATE VIEW v_evm_period AS
WITH cur AS (
  -- The current version of every baseline bucket. Every reader below goes through
  -- this, so no branch can accidentally sum two versions of the same figure.
  SELECT c.*
  FROM cbs_plan c
  WHERE c.plan_type = 'baseline'
    AND c.version = (
      SELECT MAX(c2.version) FROM cbs_plan c2
      WHERE c2.project_id = c.project_id
        AND c2.transaction_account_id = c.transaction_account_id
        AND COALESCE(c2.wbs_node_id, 0) = COALESCE(c.wbs_node_id, 0)
        AND c2.plan_type = c.plan_type
        AND c2.period_month = c.period_month
    )
),
pv AS (
  SELECT project_id, period_month, SUM(amount) AS pv
  FROM cur
  GROUP BY project_id, period_month
),
ev AS (
  SELECT n.project_id, wp.period_month,
         SUM(COALESCE(b.ba, 0) * wp.pct_complete / 100.0) AS ev
  FROM wbs_progress wp
  JOIN wbs_nodes n ON n.id = wp.wbs_node_id
  LEFT JOIN (
    -- The line's whole approved budget: every month of its current baseline, summed.
    -- `wbs_node_id IS NOT NULL` is kept because a budget with no work line cannot
    -- earn anything — there is no progress to attach it to.
    SELECT wbs_node_id, SUM(amount) AS ba
    FROM cur WHERE wbs_node_id IS NOT NULL
    GROUP BY wbs_node_id
  ) b ON b.wbs_node_id = n.id
  GROUP BY n.project_id, wp.period_month
),
ac AS (
  SELECT project_id, period_month, SUM(actual_amount) AS ac
  FROM v_cbs_actual
  GROUP BY project_id, period_month
),
-- The project's month grid: EVERY month that appears in any of the three sources, not just the
-- months that happen to have a row in one of them. This is what makes the running totals below
-- continuous — without it, a month that earned nothing has no cumulative row and the curve breaks.
months AS (
  SELECT project_id, period_month FROM pv
  UNION
  SELECT project_id, period_month FROM ev
  UNION
  SELECT project_id, period_month FROM ac
),
-- One row per project per month, with the three per-period figures filled in (0 where that source
-- has nothing for the month — the same COALESCE the previous view used).
tot AS (
  SELECT m.project_id, m.period_month,
         COALESCE(pv.pv, 0) AS pv,
         COALESCE(ev.ev, 0) AS ev,
         COALESCE(ac.ac, 0) AS ac
  FROM months m
  LEFT JOIN pv ON pv.project_id = m.project_id AND pv.period_month = m.period_month
  LEFT JOIN ev ON ev.project_id = m.project_id AND ev.period_month = m.period_month
  LEFT JOIN ac ON ac.project_id = m.project_id AND ac.period_month = m.period_month
),
-- The running totals. Every month in the grid has one, because every month is in `tot`.
cum AS (
  SELECT project_id, period_month, pv, ev, ac,
         SUM(pv) OVER w AS pv_cum,
         SUM(ev) OVER w AS ev_cum,
         SUM(ac) OVER w AS ac_cum
  FROM tot
  WINDOW w AS (PARTITION BY project_id ORDER BY period_month)
)
SELECT project_id, period_month, pv, ev, ac,
       -- NULL unless there is something to divide: an index needs a denominator AND a
       -- non-zero numerator. With no measured progress there is no earned value, so
       -- neither index exists — blank, never 0. (Migration 018's rule.)
       CASE WHEN ev <> 0 AND pv <> 0 THEN ROUND(ev / pv, 4) END AS spi,
       CASE WHEN ev <> 0 AND ac <> 0 THEN ROUND(ev / ac, 4) END AS cpi,
       -- Kept exactly as 018 wrote it, OPPOSITE sign to `cv` below. EV7.6 pins this
       -- expression and the ledger-side readers are built on it; changing it to match
       -- `cv` would silently flip a figure for every existing caller.
       ac - ev AS cost_variance,
       -- The running totals, and the indexes they support. Same rule at both scales.
       pv_cum, ev_cum, ac_cum,
       CASE WHEN ev_cum <> 0 AND pv_cum <> 0 THEN ROUND(ev_cum / pv_cum, 4) END AS spi_cum,
       CASE WHEN ev_cum <> 0 AND ac_cum <> 0 THEN ROUND(ev_cum / ac_cum, 4) END AS cpi_cum,
       -- Standard-EVM variances. Plain arithmetic: 0 is a real answer here ("plan and
       -- reality agree"), not a missing measurement, so there is no CASE. See the header.
       ev - pv     AS sv,
       ev - ac     AS cv,
       ev_cum - pv_cum AS sv_cum,
       ev_cum - ac_cum AS cv_cum
FROM cum;
CREATE VIEW v_ledger_period AS
SELECT l.*,
       COALESCE(l.effective_date, l.date)                    AS effective_period_date,
       substr(COALESCE(l.effective_date, l.date), 1, 7)      AS period_month
FROM accounting_ledger l;
CREATE VIEW v_lpb_reconciliation AS
SELECT
  COALESCE(f.doc_no, d.lpb_no)                         AS lpb_no,
  COALESCE(f.project_id, d.project_id)                 AS project_id,
  COALESCE(f.period_month, d.period_month)             AS period_month,
  f.bulk_amount  AS finance_amount,       -- what Finance booked in the ledger (bulk)
  d.detail_amount AS admin_detail_amount, -- what Project Admin recorded line-by-line
  COALESCE(f.bulk_amount, 0) - COALESCE(d.detail_amount, 0) AS difference,
  CASE
    WHEN f.doc_no IS NULL          THEN 'awaiting_settlement'  -- detail, no settlement yet
    WHEN d.lpb_no IS NULL          THEN 'missing_detail'       -- settlement, no detail
    WHEN f.bulk_amount = d.detail_amount THEN 'balanced'
    ELSE 'difference'
  END                                                  AS status
FROM (
  SELECT project_id, document_no AS doc_no,
         substr(COALESCE(effective_date, date),1,7) AS period_month,
         SUM(ABS(amount)) AS bulk_amount   -- finance posts bulk as credit (negative) → compare magnitude
  FROM accounting_ledger
  WHERE type = 'LPB'  -- Finance's bulk settlement lines
  GROUP BY project_id, document_no, substr(COALESCE(effective_date, date),1,7)
) f
FULL OUTER JOIN (
  SELECT project_id, lpb_no,
         period_month,
         SUM(CASE WHEN status = 'checked' THEN ABS(amount) ELSE 0 END) AS detail_amount
  FROM lpb_statements
  WHERE lpb_no IS NOT NULL      -- an unnumbered line cannot be reconciled to a settlement
  GROUP BY project_id, lpb_no, period_month
) d ON d.project_id = f.project_id AND d.lpb_no = f.doc_no AND d.period_month = f.period_month;
CREATE VIEW v_payable AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  MIN(r.date)                                AS first_date,
  MIN(r.period_month)                        AS period_month,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE ABS(r.amount) END) AS billed_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE 0 END) AS paid_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 AS outstanding_amount,
  MIN(r.date)                                AS invoice_date,
  MAX(r.date)                                AS last_activity_date,
  COUNT(*)                                   AS line_count
FROM v_ledger_period r
JOIN projects p ON p.id = r.project_id
WHERE r.project_id IS NOT NULL
  AND r.document_no IS NOT NULL
  AND (
    -- A payable: the purchase-side mirror of the claim test above. `line_role <> 'funding'` for
    -- the same reason — a payment must never be admitted as the thing being paid.
    (r.line_role <> 'funding'
       AND (r.line_role IN ('payable', 'expense') OR r.type = 'Payable'))
    OR
    -- A payment on a real payable, admitted only when the same document carries one.
    (r.line_role = 'funding' AND EXISTS (
        SELECT 1 FROM v_ledger_period c
        WHERE c.project_id = r.project_id
          AND c.document_no = r.document_no
          AND c.line_role <> 'funding'
          AND (c.line_role IN ('payable', 'expense') OR c.type = 'Payable')))
  )
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;
CREATE VIEW v_receivable AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  MIN(r.date)                                AS first_date,
  MIN(r.period_month)                        AS period_month,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE ABS(r.amount) END)        AS billed_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE 0 END)        AS paid_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE r.retainage_amount END)   AS retainage_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 AS net_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 - SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE r.retainage_amount END) AS outstanding_amount,
  MIN(CASE WHEN r.line_role = 'funding' THEN NULL ELSE NULLIF(r.date, '') END) AS invoice_date,
  MAX(r.date)                                AS last_activity_date,
  COUNT(*)                                   AS line_count
FROM v_ledger_period r
JOIN projects p ON p.id = r.project_id
WHERE r.project_id IS NOT NULL
  AND r.document_no IS NOT NULL
  AND (
    -- A claim: identified by type + line_role, per PRD §5.2, never by cost category.
    -- `line_role <> 'funding'` is NOT decoration. A payment line may itself carry a claim's
    -- type — `db/validate.py` inserts exactly that (`type='Payable', line_role='funding'`) to
    -- test netting, and the first draft of this migration admitted one as a claim because the
    -- type test was evaluated first. A payment is never a claim, whatever its type says.
    (r.line_role <> 'funding'
       AND (r.type IN ('Income', 'Receivable') OR r.line_role = 'receivable'))
    OR
    -- A payment, admitted only against a claim on the SAME document: "same-doc lines net".
    (r.line_role = 'funding' AND EXISTS (
        SELECT 1 FROM v_ledger_period c
        WHERE c.project_id = r.project_id
          AND c.document_no = r.document_no
          AND c.line_role <> 'funding'
          AND (c.type IN ('Income', 'Receivable') OR c.line_role = 'receivable')))
  )
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;
CREATE VIEW v_receivable_due AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  r.first_date,
  r.period_month,
  r.billed_amount,
  r.paid_amount,
  r.retainage_amount,
  r.net_amount,
  r.outstanding_amount,
  r.invoice_date,
  r.last_activity_date,
  r.line_count,
  -- How long the money has been outstanding, and the priority bucket the PRD defines on it.
  -- UNCHANGED from v_aging: 30/60/90/120 offsets from the INVOICE date.
  julianday('now') - julianday(r.invoice_date) AS days_aged,
  CASE
    WHEN julianday('now') <= julianday(r.invoice_date) THEN 'current'
    WHEN julianday('now') - julianday(r.invoice_date) <= 30 THEN '1_30'
    WHEN julianday('now') - julianday(r.invoice_date) <= 60 THEN '31_60'
    WHEN julianday('now') - julianday(r.invoice_date) <= 90 THEN '61_90'
    WHEN julianday('now') - julianday(r.invoice_date) <= 120 THEN '91_120'
    ELSE '120_plus'
  END AS aging_bucket,
  -- The terms actually applied, and where they came from (decision D3).
  COALESCE(
    p.payment_terms_days,
    cl.payment_terms_days,
    (SELECT CAST(s.value AS INTEGER) FROM app_settings s
      WHERE s.key = 'default_payment_terms_days')
  ) AS terms_days,
  CASE
    WHEN p.payment_terms_days IS NOT NULL THEN 'project'
    WHEN cl.payment_terms_days IS NOT NULL THEN 'client'
    ELSE 'default'
  END AS terms_source,
  -- The due date itself: ledger date + the terms above. SQLite's own date arithmetic — no new
  -- dependency, deterministic given the row. NULL when either half is unknown.
  CASE
    WHEN NULLIF(r.invoice_date, '') IS NOT NULL
     AND COALESCE(
           p.payment_terms_days,
           cl.payment_terms_days,
           (SELECT CAST(s.value AS INTEGER) FROM app_settings s
             WHERE s.key = 'default_payment_terms_days')
         ) IS NOT NULL
    THEN date(
           r.invoice_date,
           '+' || COALESCE(
                    p.payment_terms_days,
                    cl.payment_terms_days,
                    (SELECT CAST(s.value AS INTEGER) FROM app_settings s
                      WHERE s.key = 'default_payment_terms_days')
                  ) || ' days')
  END AS due_date
FROM v_receivable r
LEFT JOIN projects p  ON p.id  = r.project_id
LEFT JOIN clients  cl ON cl.id = p.client_id;
CREATE VIEW v_untagged_queue AS
SELECT id, project_id, document_no, date, effective_date, amount, description, source
FROM accounting_ledger
WHERE cost_checked = 0
   OR transaction_account_id IS NULL
   OR (in_cost_basis = 1 AND line_role IN ('expense','payable','tax') AND wbs_node_id IS NULL)
ORDER BY date;
