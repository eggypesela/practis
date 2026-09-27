-- PRACTIS — SQLite schema v1.3
-- Derived from PRD-PRACTIS.md v1.3 §3, §5, §7 and the user's MariaDB ERD (practis.graphml)
-- Engine: SQLite 3.39+ (WAL mode assumed at runtime: PRAGMA journal_mode=WAL)
--   * NOTE: v_evm_period uses FULL OUTER JOIN → requires SQLite 3.39+. Node's better-sqlite3
--     and modern sqlite3 CLI both exceed this. If the target engine is older, rewrite
--     v_evm_period with the classic LEFT JOIN + UNION pattern.
-- Conventions:
--   * money stored as INTEGER minor units?  -> NO. Stored as REAL is unsafe for money.
--     We store NUMERIC amounts as INTEGER * 100?  -> Chosen: store as INTEGER in RUPIAH (IDR has no
--     practical subunit in this domain) — all amounts are whole rupiah. If subunits are ever needed,
--     migrate to INTEGER minor units. This keeps SUM() exact (no float drift) per accounting rule.
--   * Income = credit = NEGATIVE amount ; Expense/debit = POSITIVE amount   (R2-7, stored signs)
--   * Dates: TEXT ISO-8601 'YYYY-MM-DD'; timestamps TEXT 'YYYY-MM-DD HH:MM:SS' UTC
--   * Period: derived, never stored as user input on the ledger.
--     period_month = substr(COALESCE(effective_date, date),1,7)   (R2-11)
--   * Currency: single IDR for v1; `currency` column reserved everywhere money lives (R2-9)

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. SYSTEM / REFERENCE
-- ============================================================================

CREATE TABLE app_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- seeded: ('base_currency','IDR'), ('fx_enabled','0')

CREATE TABLE teams (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
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
);

-- Role vocabulary, then per-project assignment (Q11b). role_code drives access;
-- the RACI responsibility (initiator/verifier/contributor/approver/informed) is per-workflow-step
-- and lives in `approvals` + the workflow engine, NOT here.
CREATE TABLE roles (
  code          TEXT PRIMARY KEY,       -- administrator|project_manager|project_controller|cost_controller|
                                        -- procurement|human_capital|finance|project_admin|viewer
  name          TEXT NOT NULL,
  domain        TEXT                    -- system|project|schedule|cost|supply|people|money|entry|readonly
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
CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_project ON user_roles(project_id);

CREATE TABLE industry_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT
);

CREATE TABLE project_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT
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
);

-- HR-lite slice (Sketch-5): project-relevant employee data only. Payroll/leave live elsewhere.
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

-- ---------------------------------------------------------------- cost accounts
-- a_cost_categories / a_cashflow_categories / a_chart_of_accounts equivalent.
-- Semantic flags let the receivable/payable/aging VIEWS be computed from the ledger (PRD §3.2).
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

CREATE TABLE resource_categories (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- ------------------------------------------------------- WBS / RBS / CBS masters
-- Company-standard menus, reused across projects (Q18). WBS = work scope, RBS = resource type,
-- transaction_accounts = the CBS cost account the Cost Controller tags on ledger lines.
CREATE TABLE wbs_code (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  parent_code   TEXT REFERENCES wbs_code(code),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE rbs_code (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  resource_category_id INTEGER REFERENCES resource_categories(id),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

-- a_transaction_accounts: the CBS / cost-account code (kept from the ERD).
-- Legacy carries wbs_code + rbs_code as a composite; the new model keeps them as *suggested*
-- default tags (the live tag comes from the transaction, R2-10) and adds the semantic links
-- that let receivable/payable/aging be computed as views over the ledger.
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

-- ============================================================================
-- 2. PROJECT
-- ============================================================================

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
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_status ON projects(status);

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
CREATE INDEX idx_proc_reg_project ON procurement_register(project_id);

-- BAST: milestone handover certificate → the EXTERNAL progress used for billing/POC revenue.
-- Deliberately separate from internal WBS tick % (PRD §5.1) — never conflated.
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
CREATE INDEX idx_acceptance_project ON acceptance_register(project_id);

-- Per-project WBS tree (lines come from the company-standard menu; hierarchy + dates only, Q14a).
-- Lines are NEVER deleted — status carries retirement (R2-13/R2-15).
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
CREATE INDEX idx_wbs_nodes_project ON wbs_nodes(project_id);
CREATE INDEX idx_wbs_nodes_parent ON wbs_nodes(parent_id);

-- ============================================================================
-- 3. PLAN (the CBS money book) + RBS loading
-- ============================================================================

-- Single versioned plan table (replaces the sketch's c_*_baseline/_actual/_forecast split, PRD §7).
-- Money lives ONLY here (+ the ledger for actuals). WBS/RBS carry no money of their own.
-- Monthly buckets: one row per (project, cost account, plan_type, period_month, version).
-- INVARIANT (enforced in app logic):  SUM(amount) per (account, version, plan_type='baseline')
--            = the account total = the RBS-derived total for that account.
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
-- One bucket per (project, cost account, WBS LINE, plan type, month, version).
-- The WBS line must be part of the key: the same cost account is legitimately planned
-- against several work lines in the same month (e.g. MAT-01 on both Foundation and Steel).
-- COALESCE is used because NULL wbs_node_id = an unallocated project-level bucket, and bare
-- NULLs in a UNIQUE index are treated as distinct (which would allow silent duplicates).
CREATE UNIQUE INDEX uq_cbs_plan_bucket ON cbs_plan(
  project_id, transaction_account_id, COALESCE(wbs_node_id, 0), plan_type, period_month, version);
CREATE INDEX idx_cbs_plan_lookup ON cbs_plan(project_id, period_month, plan_type, version);
CREATE INDEX idx_cbs_plan_wbs ON cbs_plan(wbs_node_id);

-- RBS resource loading: rates × units at TOTAL level (derivation source for the account total).
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
CREATE INDEX idx_rbs_load_project ON rbs_load(project_id);

-- Milestone ticks → internal EVM progress (Q21b). Weighted milestones = pct_weight per step.
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
CREATE INDEX idx_milestones_node ON progress_milestones(wbs_node_id);

-- Period-dated progress snapshots → progress-over-time charts + frozen-period history.
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
CREATE INDEX idx_wbs_progress_period ON wbs_progress(period_month);

-- Hybrid period freeze (v1.2/v1.3): a period locks when its Project Update Report is generated.
CREATE TABLE frozen_periods (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,
  frozen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  frozen_by     INTEGER REFERENCES users(id),
  report_id     INTEGER,                       -- FK added after project_reports
  UNIQUE (project_id, period_month)
);

-- ============================================================================
-- 4. LEDGER — single book of truth (R2-4, R2-5, R2-11)
-- ============================================================================
-- Every transaction, income AND cost, invoice AND payment. Registers/aging are VIEWS over this.
-- Immutability: rows are never updated (amount/date) or deleted — corrections add new lines
-- (the user's own double-entry pattern: same document_no, inverse sign, zero sum).
-- Ledger field-provenance note (from the real ERD, 2026-09-23):
--   legacy c_accounting_ledger = (id, transaction_id, date, account_code, debit, credit, amount,
--     project_code, description, cashflow_code, type, reference_no, sub_rbs_code, date_adjustment)
--   * `date_adjustment` maps 1:1 to effective_date — the Cost Controller's correction column.
--   * `sub_rbs_code` maps to transaction_account_id (CBS).
--   * `cashflow_code` → cashflow_category_id.
--   * `account_code` is confirmed chart-of-accounts (user, 2026-09-23). Preserve the raw text,
--     resolve it to chart_of_accounts, and quarantine unknown codes.
--   * `debit` AND `credit` AND `amount` all exist on one row. Real fixture confirms
--     `amount = debit - credit`; migration still requires trial-balance verification.
CREATE TABLE accounting_ledger (
  id                INTEGER PRIMARY KEY,
  transaction_id    TEXT,                      -- legacy human/reporting transaction id (kept for traceability)
  project_id        INTEGER REFERENCES projects(id),
  document_no       TEXT,                      -- invoice / PO / payment reference. Links payment→invoice.
  reference_no      TEXT,                      -- legacy reference_no
  account_code      TEXT,                      -- legacy account_code, PRESERVED RAW (see note below)
  partner_type      TEXT CHECK (partner_type IN ('client','supplier','employee','other')),
  partner_id        INTEGER,                   -- clients.id | suppliers.id | employees.id (per partner_type)
  -- dates
  date              TEXT NOT NULL,             -- Finance's posted date — IMMUTABLE audit anchor
  effective_date    TEXT,                      -- Cost Controller's correction (NULL unless adjusted)
  -- classification
  -- `type` = optional movement filter, kept in legacy vocabulary (Payable/Expense/Dropping/LPB/…).
  --   Dropping = cash advance issued; it is not detailed cost.
  --   LPB = Finance bulk Expense Report settlement; it is not detailed cost.
  -- Checked Project Admin detail lives in lpb_statements and contributes actual cost.
  -- `line_role` = what kind of line this is (drives which views include it). The two are NOT the
  -- same: in the real data a "Payable" line is an expense-side line whose counterparty sits in
  -- trade payable — its `line_role` is 'expense', but it is ALSO visible in the payable register.
  -- TYPES + ROLES (user-confirmed enum, 2026-09-23: Income|Expense|Receivable|Payable|LPB|Dropping):
  --   Income     → line_role='receivable', in_cost_basis=0   (client money in)
  --   Expense    → line_role='expense',    in_cost_basis=1   (cost consumed)
  --   Receivable → line_role='receivable', in_cost_basis=0   (billed to client, not yet paid)
  --   Payable    → line_role='expense',    in_cost_basis=1   (supplier invoice; also feeds payable register)
  --   LPB        → line_role='expense',    in_cost_basis=0   (finance's BULK settlement; real cost
  --                                                            = checked lpb_statements DETAIL lines)
  --   Dropping   → line_role='dropping',   in_cost_basis=0   (cash advance issued)
  --   BLANK/NULL → ALLOWED & intentional (user: "we only take some line for each transaction to
  --                classify as expense/income/receivable/payable"). The balancing offset lines are
  --                deliberately untagged. Double-entry integrity lives in debit/credit + account,
  --                NOT in this filter. Blank-type lines get line_role='other', in_cost_basis=0
  --                (conservative: never inflate cost), and surface in the review queue.
  type              TEXT CHECK (type IS NULL OR type IN
                      ('Income','Expense','Receivable','Payable','LPB','Dropping')),
                                                 -- user's filter vocabulary (enum above); OPTIONAL
                                                 -- (NULL is intentional, see BLANK/NULL note above)
  line_role         TEXT NOT NULL DEFAULT 'other'
                      CHECK (line_role IN ('expense','payable','receivable','dropping','funding','tax','payment','other')),
  -- Cost-basis rule (VERIFIED on real data): only genuine cost consumption counts as project cost.
  -- Cash movements (Dropping/cash advance, funding, receivables) do NOT — otherwise the advance
  -- would be double-counted when its LPB detail lines are later expensed.
  in_cost_basis     INTEGER NOT NULL DEFAULT 1 CHECK (in_cost_basis IN (0,1)),
  cost_category_id  INTEGER REFERENCES cost_categories(id),
  chart_of_account_id INTEGER REFERENCES chart_of_accounts(id),
  cashflow_category_id INTEGER REFERENCES cashflow_categories(id),
  -- the two tags the Cost Controller sets in one screen (R2-10)
  transaction_account_id INTEGER REFERENCES transaction_accounts(id),   -- CBS: what kind of money
  wbs_node_id       INTEGER REFERENCES wbs_nodes(id),                    -- WBS: which work line
  -- money.  User fills debit OR credit (never both, never amount). amount is COMPUTED
  -- automatically: amount = debit - credit (verified: 26/26 real rows, user's own workflow).
  --   debit > 0  → money out (cost, expense, cash advance)
  --   credit > 0 → money in (income, cash received)
  -- Stored signs (R2-7): income/credit = NEGATIVE, cost/debit = POSITIVE.
  -- UX guard (planned, app layer, see PRD §5.2): input shows ONE amount + a Debit/Credit toggle,
  -- never two number fields. amount stays derived, never user-typed.
  amount            INTEGER NOT NULL,           -- = debit - credit, computed by app/import
  debit             INTEGER NOT NULL DEFAULT 0, -- legacy + new entry: fill ONE side
  credit            INTEGER NOT NULL DEFAULT 0, -- the other side stays 0
  retainage_amount  INTEGER NOT NULL DEFAULT 0,
  paid_amount       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'IDR',   -- reserved (R2-9)
  description       TEXT,
  -- provenance / workflow
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','lpb','system')),
  import_batch_id   INTEGER REFERENCES import_batches(id),
  cash_advance_id   INTEGER REFERENCES cash_advance(id),
  cost_checked      INTEGER NOT NULL DEFAULT 0 CHECK (cost_checked IN (0,1)),  -- Cost Controller tagged?
  cost_checked_by   INTEGER REFERENCES users(id),
  cost_checked_at   TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        INTEGER REFERENCES users(id)
);
CREATE INDEX idx_ledger_project      ON accounting_ledger(project_id);
CREATE INDEX idx_ledger_period       ON accounting_ledger(project_id, date);
CREATE INDEX idx_ledger_effective    ON accounting_ledger(project_id, effective_date);
CREATE INDEX idx_ledger_doc          ON accounting_ledger(document_no);
CREATE INDEX idx_ledger_cbs          ON accounting_ledger(transaction_account_id);
CREATE INDEX idx_ledger_wbs          ON accounting_ledger(wbs_node_id);
CREATE INDEX idx_ledger_unchecked    ON accounting_ledger(cost_checked) WHERE cost_checked = 0;

-- Date/amount immutability guard + audit of any correction attempt.
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
-- The trigger above only covers 4 columns. Every OTHER column that can move money, change how a
-- line is classified in cost-basis views, or bypass the import dedupe index must be immutable too
-- (review 2026-09-24, findings A-1). Corrections are posted as reversing + correcting lines.
CREATE TRIGGER trg_ledger_immutable_financial_fields
BEFORE UPDATE OF debit, credit, project_id, in_cost_basis, cost_checked, cost_checked_by,
                 cost_checked_at, line_role, source, import_batch_id, cash_advance_id,
                 cost_category_id, chart_of_account_id, cashflow_category_id,
                 transaction_account_id, wbs_node_id, partner_type, partner_id,
                 currency, retainage_amount, paid_amount, account_code,
                 reference_no, transaction_id
ON accounting_ledger
WHEN (
     -- hard-blocked: any change to these columns is tampering, period
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
     -- Cost Controller tagging/approval fields: allowed ONLY as the exact one-way transitions
     -- below (R2-10, R2-23). Any other change to them is tampering.
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

-- A-1 fix introduced a real regression: the Cost Controller's OWN workflow (R2-10, R2-23) must be
-- able to assign WBS/CBS tags and mark a line checked — those fields are the ones he SET, not tamper.
-- The allowed legit transitions are encoded inside trg_ledger_immutable_financial_fields WHEN clause:
--   * wbs_node_id, transaction_account_id, cost_category_id: NULL -> value (controller tagging)
--   * cost_checked: 0 -> 1 together with cost_checked_by/cost_checked_at (controller approval)
--   * line_role / in_cost_basis: 'other' -> assigned (type-driven classification, import path)
-- Everything else on those columns still aborts. Clearing or rewriting any field is tampering.

-- Whole-rupiah + one-side-only + derived-amount invariants (review findings A-6..A-8).
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

-- ============================================================================
-- 5. CASH ADVANCE + LPB (R2-1..R2-3)
-- ============================================================================
-- One big pot per project (Q17a). Finance's ledger holds the BULK entry; the LPB screen holds
-- the detailed usage lines, which the Cost Controller checks (= final, no Finance approval).

CREATE TABLE cash_advance (
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
CREATE INDEX idx_cash_advance_project ON cash_advance(project_id);

-- The advance pot anchors Expense Report reconciliation, so its amount must be whole rupiah and the
-- pot itself must not be erasable once it carries detail or is being settled
-- (review 2026-09-24, finding A-4).
CREATE TRIGGER trg_cash_advance_money_integrity_insert
BEFORE INSERT ON cash_advance
WHEN typeof(NEW.amount) <> 'integer' OR NEW.amount = 0
BEGIN
  SELECT RAISE(ABORT, 'cash_advance: amount must be a non-zero whole-rupiah integer');
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

-- Never cascade away the detail behind an advance (audit evidence), and never delete a pot in use.
CREATE TRIGGER trg_cash_advance_no_delete_when_used
BEFORE DELETE ON cash_advance
WHEN OLD.status <> 'open'
  OR EXISTS (SELECT 1 FROM lpb_statements WHERE cash_advance_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT,
    'cash_advance: cannot delete a pot that is not open or that carries Expense Report detail');
END;

-- LPB usage lines: draft → checked. Checked lines roll into cost actuals automatically.
CREATE TABLE lpb_statements (
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
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','checked','rejected')),
  checked_by            INTEGER REFERENCES users(id),
  checked_at            TEXT,
  reject_reason         TEXT,
  ledger_id             INTEGER REFERENCES accounting_ledger(id),       -- set when rolled into actuals
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  created_by            INTEGER REFERENCES users(id)
);
CREATE INDEX idx_lpb_project ON lpb_statements(project_id, period_month);
CREATE INDEX idx_lpb_status  ON lpb_statements(status);

-- LPB detail lines are the SECOND money path: only status='checked' rows feed actual cost
-- (v_cbs_actual). They carried no immutability at all (review 2026-09-24, findings A-2/A-4/A-5/A-6).
-- Money integrity on insert: whole rupiah, one side only, amount is derived, never negative sides.
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

-- A line may only be marked checked WITH a checker identity, on insert or on update
-- (finding A-2: no self-declared checks). Historical migration rows must name the migration actor.
CREATE TRIGGER trg_lpb_checked_requires_checker_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'checked'
 AND (NEW.checked_by IS NULL OR NEW.checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: status=checked requires checked_by and checked_at (the Cost Controller who checked it)');
END;

CREATE TRIGGER trg_lpb_checked_requires_checker
BEFORE UPDATE OF status, checked_by, checked_at ON lpb_statements
WHEN NEW.status = 'checked'
 AND (NEW.checked_by IS NULL OR NEW.checked_at IS NULL)
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: status=checked requires checked_by and checked_at (the Cost Controller who checked it)');
END;

-- Once checked, the financial content and the check itself are frozen: a checked amount must not be
-- editable afterwards, and a checked line must not be silently un-checked.
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

-- Checked detail lines are audit evidence and must never be deleted.
CREATE TRIGGER trg_lpb_checked_no_delete
BEFORE DELETE ON lpb_statements
WHEN OLD.status = 'checked'
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line is never deleted; post a reversing line instead');
END;

-- ============================================================================
-- 6. REVENUE RECOGNITION (Q7 / IFRS15-PSAK72)
-- ============================================================================
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
CREATE INDEX idx_rev_recog_project ON revenue_recognized(project_id);

-- ============================================================================
-- 7. IMPORT (fixed template, R2-5) — never overwrites tagged lines
-- ============================================================================
CREATE TABLE import_profiles (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  source_type    TEXT NOT NULL CHECK (source_type IN ('ledger','lpb','procurement')),
  template_version TEXT NOT NULL DEFAULT 'v1',
  mapping_json   TEXT,                          -- column → field map (fixed template, stored for reference)
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
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
);

-- import dedupe key (R2-27): same (transaction_id, document_no, date, amount, project) = re-import → skip
CREATE UNIQUE INDEX idx_ledger_import_dedupe ON accounting_ledger(
  COALESCE(transaction_id,''), COALESCE(document_no,''), COALESCE(date,''), amount, COALESCE(project_id,0)
) WHERE source = 'import';

-- ============================================================================
-- 8. CHANGE CONTROL (BCR) + internal replanning log
-- ============================================================================
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
);
CREATE INDEX idx_bcr_project ON bcr_register(project_id, status);

-- Internal replanning (same contract value) — logged, no BCR needed (R2-12).
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
CREATE INDEX idx_change_log_project ON change_log(project_id);

-- ============================================================================
-- 9. WORKFLOW, AUDIT, NOTIFICATIONS
-- ============================================================================
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
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER,
  action        TEXT NOT NULL,                 -- create|update|approve|reject|freeze|import|check
  actor_id      INTEGER REFERENCES users(id),
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  before_json   TEXT,
  after_json    TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- Business audit rows are evidence, not mutable state: they back the 10-year statutory retention
-- commitment (TS-21) and spec 3.9's "not editable through application accounts". SQLite has no
-- per-table ACL, so the available in-database control is a trigger (review 2026-09-24, finding A-3).
-- Retention/archival must move rows out-of-band (export + archive), never by DELETE.
CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be updated');
END;

CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are append-only and cannot be deleted');
END;

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
CREATE INDEX idx_notif_user_unread ON notification_inbox(user_id, read_at);

-- One unread alert per condition per user. The 30-second alert poll (TS-03) evaluates the same
-- conditions repeatedly, so without this index the inbox fills with identical unread copies
-- (review 2026-09-24, finding A-9). A new alert for the same condition is allowed once the
-- previous one is read.
CREATE UNIQUE INDEX idx_notif_unread_unique
  ON notification_inbox(user_id, alert_type, COALESCE(project_id, 0), COALESCE(entity_type, ''), COALESCE(entity_id, 0))
  WHERE read_at IS NULL;

-- Project Update Report (monthly, scheduled; freezes the period when generated)
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

-- ============================================================================
-- 10. VIEWS — registers, aging, actuals, EVM
-- ============================================================================

-- Effective period for any ledger line (R2-11)
CREATE VIEW v_ledger_period AS
SELECT l.*,
       COALESCE(l.effective_date, l.date)                    AS effective_period_date,
       substr(COALESCE(l.effective_date, l.date), 1, 7)      AS period_month
FROM accounting_ledger l;

-- Receivable register: per-document netting. The invoice line carries the receivable cost
-- category (is_receivable=1, credit, negative amount). The payment line is the SAME document_no
-- with a debit/cash-in (positive amount, line_role='funding' in seed). Outstanding = the net of
-- all lines sharing that document_no (user-confirmed workflow 2026-09-25: Finance posts payment
-- lines, register nets by document number — no separate payments table; paid_amount stays frozen).
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
  MIN(CASE WHEN r.line_role = 'funding' THEN NULL ELSE r.date END)            AS invoice_date,
  MAX(r.date)                                AS last_activity_date,
  COUNT(*)                                   AS line_count
FROM v_ledger_period r
JOIN cost_categories cc ON cc.id = r.cost_category_id AND (cc.is_receivable = 1 OR r.line_role = 'funding')
WHERE r.project_id IS NOT NULL AND r.document_no IS NOT NULL
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;

-- Payable register: per-document netting, symmetric with v_receivable. A payable line is an
-- expense-side line (type='Payable' or line_role='payable', credit/negative in ledger for the
-- supplier-invoice side); payment posts a debit/cash-out line with the same document_no.
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
  AND (r.line_role = 'payable' OR r.type = 'Payable' OR r.line_role = 'funding')
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;

-- Aging buckets (30/60/90/120+), retainage excluded into its own row set
CREATE VIEW v_aging AS
SELECT r.project_id, r.document_no, r.partner_id, r.invoice_date, r.outstanding_amount,
       CASE WHEN r.retainage_amount > 0 THEN 1 ELSE 0 END AS has_retainage,
       julianday('now') - julianday(r.invoice_date) AS days_aged,
       CASE
         WHEN julianday('now') <= julianday(r.invoice_date) THEN 'current'
         WHEN julianday('now') - julianday(r.invoice_date) <= 30 THEN '1_30'
         WHEN julianday('now') - julianday(r.invoice_date) <= 60 THEN '31_60'
         WHEN julianday('now') - julianday(r.invoice_date) <= 90 THEN '61_90'
         WHEN julianday('now') - julianday(r.invoice_date) <= 120 THEN '91_120'
         ELSE '120_plus'
       END AS aging_bucket
FROM v_receivable r
WHERE r.outstanding_amount <> 0;

-- Cost ACTUALS per CBS account per period — computed, never a stored plan row.
-- TWO sources, combined (R2-18, user-clarified 2026-09-23):
--   (1) ledger lines with in_cost_basis=1 (genuine expense/payable/tax; income, funding,
--       and cash movements like the Dropping advance are excluded)
--   (2) CHECKED lpb_statements lines — the detailed cash-advance usage created by Project Admin.
--       Finance's bulk LPB line in the ledger stays in_cost_basis=0; the detail is what counts.
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
)
GROUP BY project_id, transaction_account_id, period_month;

-- LPB / EXPENSE-REPORT RECONCILIATION (user feature request 2026-09-23):
-- compare Finance's bulk settlement (ledger, document_no = lpb_no) vs Project Admin's
-- DETAIL lines (lpb_statements). Status: balanced | difference | missing_detail.
CREATE VIEW v_lpb_reconciliation AS
SELECT
  COALESCE(f.doc_no, d.lpb_no)                         AS lpb_no,
  COALESCE(f.project_id, d.project_id)                 AS project_id,
  f.period_month,
  f.bulk_amount  AS finance_amount,       -- what Finance booked in the ledger (bulk)
  d.detail_amount AS admin_detail_amount, -- what Project Admin recorded line-by-line
  f.bulk_amount - d.detail_amount        AS difference,
  CASE
    WHEN d.lpb_no IS NULL          THEN 'missing_detail'
    WHEN f.bulk_amount = d.detail_amount THEN 'balanced'
    WHEN f.bulk_amount <> d.detail_amount THEN 'difference'
  END                                AS status
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
  GROUP BY project_id, lpb_no, period_month
) d ON d.project_id = f.project_id AND d.lpb_no = f.doc_no AND d.period_month = f.period_month;

-- DUAL-TAG integrity: ledger lines missing either tag (Cost Controller's work queue)
CREATE VIEW v_untagged_queue AS
SELECT id, project_id, document_no, date, effective_date, amount, description, source
FROM accounting_ledger
WHERE cost_checked = 0
   OR transaction_account_id IS NULL
   OR (in_cost_basis = 1 AND line_role IN ('expense','payable','tax') AND wbs_node_id IS NULL)
ORDER BY date;

-- EVM per project per period: PV (baseline buckets) / EV (progress × budget) / AC (ledger)
CREATE VIEW v_evm_period AS
WITH pv AS (
  SELECT project_id, period_month, SUM(amount) AS pv
  FROM cbs_plan
  WHERE plan_type = 'baseline'
  GROUP BY project_id, period_month
),
ev AS (
  SELECT n.project_id, wp.period_month,
         SUM(COALESCE(b.ba, 0) * wp.pct_complete / 100.0) AS ev
  FROM wbs_progress wp
  JOIN wbs_nodes n ON n.id = wp.wbs_node_id
  LEFT JOIN (
    SELECT wbs_node_id, SUM(amount) AS ba
    FROM cbs_plan WHERE plan_type = 'baseline' AND wbs_node_id IS NOT NULL
    GROUP BY wbs_node_id
  ) b ON b.wbs_node_id = n.id
  GROUP BY n.project_id, wp.period_month
),
ac AS (
  SELECT project_id, period_month, SUM(actual_amount) AS ac
  FROM v_cbs_actual
  GROUP BY project_id, period_month
)
SELECT COALESCE(pv.project_id, ev.project_id, ac.project_id) AS project_id,
       COALESCE(pv.period_month, ev.period_month, ac.period_month) AS period_month,
       COALESCE(pv.pv, 0)  AS pv,
       COALESCE(ev.ev, 0)  AS ev,
       COALESCE(ac.ac, 0)  AS ac,
       CASE WHEN COALESCE(pv.pv,0) <> 0 THEN ROUND(COALESCE(ev.ev,0) / pv.pv, 4) END AS spi,
       CASE WHEN COALESCE(ac.ac,0) <> 0 THEN ROUND(COALESCE(ev.ev,0) / ac.ac, 4) END AS cpi,
       COALESCE(ac.ac,0) - COALESCE(ev.ev,0) AS cost_variance
FROM pv
FULL OUTER JOIN ev ON ev.project_id = pv.project_id AND ev.period_month = pv.period_month
FULL OUTER JOIN ac ON ac.project_id = COALESCE(pv.project_id, ev.project_id)
                  AND ac.period_month = COALESCE(pv.period_month, ev.period_month);

-- Budget in WBS/RBS guard: de-scoped lines keep their spent cost visible
CREATE VIEW v_descoped_lines AS
SELECT n.id, n.project_id, n.wbs_code, n.name, n.status, n.version, n.de_scope_period,
       (SELECT SUM(amount) FROM accounting_ledger l WHERE l.wbs_node_id = n.id) AS cost_incurred,
       (SELECT SUM(amount) FROM cbs_plan c
         WHERE c.wbs_node_id = n.id AND c.plan_type = 'baseline') AS budget_removed
FROM wbs_nodes n
WHERE n.status = 'de_scoped';
