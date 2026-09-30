-- 003_revenue_type.sql
-- Add 'Revenue' to accounting_ledger.type (legacy enum includes it; TS-04 import).
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt via the
-- documented recipe: rename → create new → copy → drop old → recreate
-- indexes/triggers/views. PRAGMA foreign_keys=OFF is required so the rename
-- in the middle of an existing schema (other tables FK here, and views/triggers
-- reference this table) does not trip the FK checks while the table is absent.
--
-- The ledger is small (real deployments are ~57k rows), so the copy is cheap.
-- The rebuild preserves: data, indexes, the three ledger triggers, and every
-- view that reads accounting_ledger. If any step's dependent object changed,
-- the whole migration is atomic (migrate.js wraps each file in a transaction)
-- and fails closed.

PRAGMA foreign_keys = OFF;

-- 0. drop the views that read accounting_ledger. A table rename does NOT drop
--    them automatically; they keep pointing at the renamed table and would
--    fail recreation. Dependency order: v_evm_period → v_cbs_actual →
--    v_lpb_reconciliation → v_aging → v_receivable/v_payable →
--    v_ledger_period → v_untagged_queue → v_descoped_lines.
DROP VIEW IF EXISTS v_evm_period;
DROP VIEW IF EXISTS v_cbs_actual;
DROP VIEW IF EXISTS v_lpb_reconciliation;
DROP VIEW IF EXISTS v_aging;
DROP VIEW IF EXISTS v_receivable;
DROP VIEW IF EXISTS v_payable;
DROP VIEW IF EXISTS v_ledger_period;
DROP VIEW IF EXISTS v_untagged_queue;
DROP VIEW IF EXISTS v_descoped_lines;

-- 1. rename the live table aside
ALTER TABLE accounting_ledger RENAME TO accounting_ledger_old;

-- 2. recreate with the widened type enum ('Revenue' added)
CREATE TABLE accounting_ledger (
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
);

-- 3. copy data (column order must match the old table exactly)
INSERT INTO accounting_ledger
  (id, transaction_id, project_id, document_no, reference_no, account_code,
   partner_type, partner_id, date, effective_date, type, line_role, in_cost_basis,
   cost_category_id, chart_of_account_id, cashflow_category_id,
   transaction_account_id, wbs_node_id, amount, debit, credit,
   retainage_amount, paid_amount, currency, description, source,
   import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at,
   created_at, created_by)
SELECT id, transaction_id, project_id, document_no, reference_no, account_code,
       partner_type, partner_id, date, effective_date, type, line_role, in_cost_basis,
       cost_category_id, chart_of_account_id, cashflow_category_id,
       transaction_account_id, wbs_node_id, amount, debit, credit,
       retainage_amount, paid_amount, currency, description, source,
       import_batch_id, cash_advance_id, cost_checked, cost_checked_by, cost_checked_at,
       created_at, created_by
FROM accounting_ledger_old;

-- 4. drop the old table (its triggers/indexes go with it)
DROP TABLE accounting_ledger_old;

-- 5. recreate the indexes
CREATE INDEX idx_ledger_project      ON accounting_ledger(project_id);
CREATE INDEX idx_ledger_period       ON accounting_ledger(project_id, date);
CREATE INDEX idx_ledger_effective    ON accounting_ledger(project_id, effective_date);
CREATE INDEX idx_ledger_doc          ON accounting_ledger(document_no);
CREATE INDEX idx_ledger_cbs          ON accounting_ledger(transaction_account_id);
CREATE INDEX idx_ledger_wbs          ON accounting_ledger(wbs_node_id);
CREATE INDEX idx_ledger_unchecked    ON accounting_ledger(cost_checked) WHERE cost_checked = 0;
CREATE UNIQUE INDEX idx_ledger_import_dedupe ON accounting_ledger(
  COALESCE(transaction_id,''), COALESCE(document_no,''), COALESCE(date,''),
  amount, COALESCE(project_id,0))
WHERE source = 'import';
CREATE INDEX idx_ledger_cost_checked ON accounting_ledger(cost_checked);

-- 6. recreate the triggers (the ledger's immutability + integrity guards)
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

-- 7. recreate the views that read accounting_ledger (in dependency order).
--    When the table is RENAMEd, SQLite drops views that referenced it, so they
--    must be recreated here. Definitions copied verbatim from 001_initial.sql.
CREATE VIEW v_ledger_period AS
SELECT l.*,
       COALESCE(l.effective_date, l.date)                    AS effective_period_date,
       substr(COALESCE(l.effective_date, l.date), 1, 7)      AS period_month
FROM accounting_ledger l;

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

CREATE VIEW v_lpb_reconciliation AS
SELECT
  COALESCE(f.doc_no, d.lpb_no)                         AS lpb_no,
  COALESCE(f.project_id, d.project_id)                 AS project_id,
  f.period_month,
  f.bulk_amount  AS finance_amount,
  d.detail_amount AS admin_detail_amount,
  f.bulk_amount - d.detail_amount        AS difference,
  CASE
    WHEN d.lpb_no IS NULL          THEN 'missing_detail'
    WHEN f.bulk_amount = d.detail_amount THEN 'balanced'
    WHEN f.bulk_amount <> d.detail_amount THEN 'difference'
  END                                AS status
FROM (
  SELECT project_id, document_no AS doc_no,
         substr(COALESCE(effective_date, date),1,7) AS period_month,
         SUM(ABS(amount)) AS bulk_amount
  FROM accounting_ledger
  WHERE type = 'LPB'
  GROUP BY project_id, document_no, substr(COALESCE(effective_date, date),1,7)
) f
FULL OUTER JOIN (
  SELECT project_id, lpb_no,
         period_month,
         SUM(CASE WHEN status = 'checked' THEN ABS(amount) ELSE 0 END) AS detail_amount
  FROM lpb_statements
  GROUP BY project_id, lpb_no, period_month
) d ON d.project_id = f.project_id AND d.lpb_no = f.doc_no AND d.period_month = f.period_month;

CREATE VIEW v_untagged_queue AS
SELECT id, project_id, document_no, date, effective_date, amount, description, source
FROM accounting_ledger
WHERE cost_checked = 0
   OR transaction_account_id IS NULL
   OR (in_cost_basis = 1 AND line_role IN ('expense','payable','tax') AND wbs_node_id IS NULL)
ORDER BY date;

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

CREATE VIEW v_descoped_lines AS
SELECT n.id, n.project_id, n.wbs_code, n.name, n.status, n.version, n.de_scope_period,
       (SELECT SUM(amount) FROM accounting_ledger l WHERE l.wbs_node_id = n.id) AS cost_incurred,
       (SELECT SUM(amount) FROM cbs_plan c
         WHERE c.wbs_node_id = n.id AND c.plan_type = 'baseline') AS budget_removed
FROM wbs_nodes n
WHERE n.status = 'de_scoped';

PRAGMA foreign_keys = ON;