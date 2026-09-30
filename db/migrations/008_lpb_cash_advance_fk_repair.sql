-- 008_lpb_cash_advance_fk_repair.sql — repair the foreign keys that the 003
-- rebuild silently repointed at a dropped table.
--
-- 003 rebuilt accounting_ledger with the rename-aside order:
--
--     ALTER TABLE accounting_ledger RENAME TO accounting_ledger_old;
--     CREATE TABLE accounting_ledger (...);
--     INSERT INTO accounting_ledger SELECT ... FROM accounting_ledger_old;
--     DROP TABLE accounting_ledger_old;
--
-- With foreign keys enabled, that RENAME rewrites the FK clause of every OTHER
-- table referencing accounting_ledger to point at the new name. cash_advance and
-- lpb_statements both do, so both ended up as
--
--     ledger_id INTEGER REFERENCES "accounting_ledger_old"(id)
--
-- and the drop then left them referencing a table that no longer exists. Any
-- query that has to parse those tables fails with
-- "no such table: main.accounting_ledger_old" — which is why the app could not
-- boot at all once something touched them. 003 is fixed to use the
-- create-new -> copy -> drop -> rename order, but a migration that already ran
-- never re-runs, so existing databases need this forward repair.
--
-- The table definitions, indexes, triggers and views below are copied VERBATIM
-- from a migrated database with only the FK text corrected — retyping them by
-- hand is exactly how 003 lost an index predicate in the first place.
--
-- SQLite validates views when a table is dropped, so the two views reading these
-- tables are dropped first and recreated afterwards; the others still resolve
-- their own dependencies.
--
-- No data is touched: every column, value and timestamp is carried across.


DROP VIEW IF EXISTS v_cbs_actual;

DROP VIEW IF EXISTS v_lpb_reconciliation;



-- ---- cash_advance: rebuild with a correct foreign key -----

CREATE TABLE cash_advance_fkfix (
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


-- ---- lpb_statements: rebuild with a correct foreign key -----

CREATE TABLE lpb_statements_fkfix (
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


INSERT INTO cash_advance_fkfix (id, project_id, advance_no, sequence, recipient_type, recipient_id, amount, submission_date, approved_date, issued_date, reimburse_amount, vat, total_amount, description, currency, ledger_id, status, created_at)
  SELECT id, project_id, advance_no, sequence, recipient_type, recipient_id, amount, submission_date, approved_date, issued_date, reimburse_amount, vat, total_amount, description, currency, ledger_id, status, created_at FROM cash_advance;

DROP TABLE cash_advance;
ALTER TABLE cash_advance_fkfix RENAME TO cash_advance;


INSERT INTO lpb_statements_fkfix (id, cash_advance_id, project_id, lpb_no, period_month, entry_date, description, debit, credit, amount, currency, transaction_account_id, wbs_node_id, status, reject_reason, ledger_id, created_at, created_by)
  SELECT id, cash_advance_id, project_id, lpb_no, period_month, entry_date, description, debit, credit, amount, currency, transaction_account_id, wbs_node_id, status, reject_reason, ledger_id, created_at, created_by FROM lpb_statements;

DROP TABLE lpb_statements;
ALTER TABLE lpb_statements_fkfix RENAME TO lpb_statements;


CREATE INDEX idx_cash_advance_project ON cash_advance(project_id);

CREATE INDEX idx_lpb_project ON lpb_statements(project_id, period_month);

CREATE INDEX idx_lpb_status  ON lpb_statements(status);



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

CREATE TRIGGER trg_cash_advance_no_delete_when_used
BEFORE DELETE ON cash_advance
WHEN OLD.status <> 'open'
  OR EXISTS (SELECT 1 FROM lpb_statements WHERE cash_advance_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT,
    'cash_advance: cannot delete a pot that is not open or that carries Expense Report detail');
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

