-- 009_lpb_blocked_and_cbs_guard.sql — a Blocked state, the guard that stops cost
-- being checked in with nothing to attribute it to, and a closed resubmit loop.
--
-- The Auditor's question this answers: should the checker REJECT an invalid line
-- or only CHECK it (with a warning)? Research (GAO's definition of segregation of
-- duties; Stanford's Expense Requests System; SAP/OpenText invoice blocking) says
-- reject — and that one state is not enough. There are three genuinely different
-- outcomes, and PRACTIS could express only two:
--
--   CHECK    I have a CBS + WBS; this is real cost          -> status 'checked'
--   RETURN   the ENTERER made a mistake (amount, date, text) -> status 'rejected'
--   BLOCK    the line is fine, the PROJECT cannot book it yet -> status 'blocked'
--            (no CBS/WBS code exists for the phase/package)
--
-- Blocked is not cosmetic. Without it the only ways out of an unbookable line are
-- to check it — inserting cost nothing can attribute, demonstrated below — or to
-- reject it, which blames the Project Admin for a setup gap that is not theirs.
-- Blocked also has to stay VISIBLE: a line parked in a state nobody looks at is
-- how unreported spend accumulates, so it surfaces on /expenses and the pot.
--
-- Why the CBS guard matters (the hole this closes, measured before the fix): a
-- checked line with transaction_account_id NULL was ACCEPTED, and v_cbs_actual —
-- which groups by that column — put 500,000 of unattributable cost in the report
-- under a NULL account. The check is final, so the mistake was permanent. The
-- route already refuses to check without a CBS account; these triggers make that
-- the floor rather than the only line of defence, the same belt-and-braces as
-- trg_lpb_checked_requires_checker.
--
-- WBS is deliberately NOT required to check: the ledger feed (the real cost
-- source) carries no WBS column at all, so requiring it would make imported cost
-- uncheckable. CBS is required, because that is the column the report groups by.
--
-- superseded_by closes the loop that a rejection opens. A rejection is final, so
-- the corrected figures arrive as a NEW line; without a link the returned line
-- sits forever looking unresolved and the pair cannot be read as one story. The
-- corrected line points back at the one it replaces.
--
-- Only the status CHECK and two new columns change; every existing value and
-- timestamp is carried across. Table, index, trigger and view SQL is copied
-- VERBATIM from sqlite_master, rebuilt in the create-new -> copy -> drop -> rename
-- order (see 008 for why the rename-aside order corrupts foreign keys).
--
-- SQLite validates views when a table is dropped, so the two views reading this
-- table are dropped first and recreated after.


DROP VIEW v_cbs_actual;

DROP VIEW IF EXISTS v_lpb_reconciliation;


-- ---- rebuild lpb_statements: widened status, block_reason, superseded_by ----


CREATE TABLE lpb_statements_new (
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


INSERT INTO lpb_statements_new (id, cash_advance_id, project_id, lpb_no, period_month, entry_date, description, debit, credit, amount, currency, transaction_account_id, wbs_node_id, status, checked_by, checked_at, reject_reason, block_reason, superseded_by, ledger_id, created_at, created_by)
  SELECT id, cash_advance_id, project_id, lpb_no, period_month, entry_date, description, debit, credit, amount, currency, transaction_account_id, wbs_node_id, status, checked_by, checked_at, reject_reason, NULL, NULL, ledger_id, created_at, created_by FROM lpb_statements;


DROP TABLE lpb_statements;
ALTER TABLE lpb_statements_new RENAME TO lpb_statements;


-- ---- indexes and inherited triggers, verbatim -----------------------------


CREATE INDEX idx_lpb_project ON lpb_statements(project_id, period_month);

CREATE INDEX idx_lpb_status  ON lpb_statements(status);



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


-- ---- the guards the missing-code hole needed --------------------------------

CREATE TRIGGER trg_lpb_checked_requires_cbs_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'checked' AND NEW.transaction_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line must carry a CBS account — without one its cost cannot be attributed to anything');
END;

CREATE TRIGGER trg_lpb_checked_requires_cbs
BEFORE UPDATE OF status, transaction_account_id ON lpb_statements
WHEN NEW.status = 'checked' AND NEW.transaction_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a checked line must carry a CBS account — without one its cost cannot be attributed to anything');
END;

-- A block is not a home for junk: it needs a reason, like a rejection.
-- Blocked lines are NOT final — clearing one returns the line to draft.
CREATE TRIGGER trg_lpb_blocked_needs_reason_insert
BEFORE INSERT ON lpb_statements
WHEN NEW.status = 'blocked' AND (NEW.block_reason IS NULL OR trim(NEW.block_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'lpb_statements: status=blocked requires block_reason (why it cannot be booked yet)');
END;

CREATE TRIGGER trg_lpb_blocked_needs_reason
BEFORE UPDATE OF status, block_reason ON lpb_statements
WHEN NEW.status = 'blocked' AND (NEW.block_reason IS NULL OR trim(NEW.block_reason) = '')
BEGIN
  SELECT RAISE(ABORT, 'lpb_statements: status=blocked requires block_reason (why it cannot be booked yet)');
END;

-- A rejected or blocked line has no business being checked later: the only way
-- forward is a corrected line, or clearing the block.
CREATE TRIGGER trg_lpb_no_check_from_blocked
BEFORE UPDATE OF status ON lpb_statements
WHEN NEW.status = 'checked' AND OLD.status IN ('blocked','rejected')
BEGIN
  SELECT RAISE(ABORT,
    'lpb_statements: a blocked or rejected line cannot be checked — clear the block or enter a corrected line');
END;


-- ---- recon view back, verbatim (007's version) ----------------------------


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


-- ---- the CBS report must not carry unattributable cost ----------------------
--
-- v_cbs_actual is the report this module exists to feed. It groups by
-- transaction_account_id, and NULL is a real group there — not something the
-- caller can detect or filter meaningfully. Exclude it, so the view can only
-- contain attributable cost. The guard above should mean there is never one to
-- skip; this is the second belt for a database that already holds such rows.

DROP VIEW IF EXISTS v_cbs_actual;

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
