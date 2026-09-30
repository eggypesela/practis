-- 006_ledger_reversals.sql — the correction path for an immutable ledger.
--
-- A posted ledger line can never be edited or deleted (trg_ledger_* already
-- abort that). The documented correction is therefore a REVERSING entry: a new
-- line that negates the original, optionally followed by a corrected line.
--
-- This migration makes the reversal link explicit and enforceable instead of
-- leaving it to convention:
--
--   reverses_ledger_id  set on the reversing line, pointing at the original.
--                       NULL for every ordinary line.
--
-- One column, one direction: "has this line been reversed?" is a query, not a
-- second pointer that has to be kept in sync (and that a bug could desync).
--
-- The partial UNIQUE index is the real guard: a line can be reversed EXACTLY
-- ONCE. Without it, two operators clicking "reverse" would double-count the
-- correction and silently overstate the reversal.
-------------------------------------------------------------------------------

ALTER TABLE accounting_ledger ADD COLUMN reverses_ledger_id INTEGER
  REFERENCES accounting_ledger(id);

CREATE UNIQUE INDEX idx_ledger_one_reversal
  ON accounting_ledger(reverses_ledger_id)
  WHERE reverses_ledger_id IS NOT NULL;

CREATE INDEX idx_ledger_reverses ON accounting_ledger(reverses_ledger_id);

-- The link is set at insert and must never move afterwards. Rather than rebuild
-- the existing immutability trigger (which enumerates every money column), add a
-- narrow guard for this one column.
CREATE TRIGGER trg_ledger_reversal_link_immutable
BEFORE UPDATE OF reverses_ledger_id ON accounting_ledger
WHEN OLD.reverses_ledger_id IS NOT NEW.reverses_ledger_id
BEGIN
  SELECT RAISE(ABORT,
    'accounting_ledger: a reversal link cannot be changed or removed; post a correcting line instead');
END;

-- A reversal must point at a real line in the same project and must actually
-- negate it. The service checks this too; the trigger is what makes it true even
-- if some other code path (a future import, a script) writes the row.
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
