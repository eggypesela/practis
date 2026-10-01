-- 011_frozen_period_enforcement.sql — frozen accounting periods actually
-- reject backdated writes, with an explicit correction door.
--
-- THE HOLE THIS CLOSES
-- TECH-SPEC §8.4: "Frozen period rejects ordinary backdated writes." The
-- `frozen_periods` table has existed since 001 and was READ BY NOTHING: no
-- trigger, no route, no reference anywhere in src/. The invariant lived in the
-- specification and nowhere in the system, so a reported month could be
-- backdated silently. Measured before this migration: an insert into a frozen
-- month succeeded and moved the period total.
--
-- WHERE THE RULE IS ENFORCED — and where it deliberately is not
--   accounting_ledger  INSERT guarded, and UPDATE OF effective_date, date
--                      guarded. This table IS the books; a row here moves the
--                      period total immediately, and either date column can put a
--                      row in a month.
--   lpb_statements     The CHECK transition guarded, not the draft insert. An
--                      lpb line is NOT cost until it is checked: v_cbs_actual and
--                      v_ledger_period count status='checked' only. So a draft
--                      dated in a frozen month is harmless and must stay legal —
--                      guarding the draft would block ordinary data entry for a
--                      month with no effect on the reported figures. The check is
--                      what books the cost, so the check is what freezes.
--
-- WHY THE PERIOD IS `COALESCE(effective_date, date)`
-- `effective_date` is the accounting date and is what v_ledger_period groups by.
-- Freezing has to follow the date the reports use, not the wall-clock entry date,
-- or a row could be posted today into a frozen month by backdating `date` alone.
-- Test FP1.6 exists for exactly that path.
--
-- THE DOOR (deliberate, and the reason this is not a plain block)
-- §8.4: "the flagged revision path remains explicit." A frozen period must still
-- admit a DELIBERATE, ATTRIBUTED correction — otherwise legitimate late
-- adjustments are impossible and the trigger gets disabled by whoever needs one.
--
-- The door is the EXISTING correction mechanism, not a new flag, so there stays
-- exactly ONE way to correct a posted line (owner decision, 2026-10-01):
--   ledger   a reversal carries `reverses_ledger_id` pointing at the line it
--            cancels. The link is already the only legal way to fix a posted
--            line (trg_ledger_reversal_link_immutable, trg_ledger_reversal_must_negate)
--            and its only writer is lib/ledger-correction.js.
--   lpb      an lpb line is corrected by a NEW line that supersedes it, and
--            `superseded_by` (added in 009) is set on the line being replaced.
--
-- KNOWN LIMIT on the lpb door, recorded rather than pretended away: the door
-- admits a line that a previously-checked line points at as its replacement. In
-- the current correction flow `superseded_by` is only written at check time, so
-- a row cannot normally be inserted already carrying it; in that flow an lpb
-- correction inside a frozen month is refused and an Administrator must unfreeze
-- the period. The ledger reversal door — the one the operator actually has a
-- button for — is unaffected. Widening this needs an lpb correction flow that
-- marks the replacement before it is checked.

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

-- Posting a line is blocked above, but `effective_date` is NOT covered by any
-- immutability trigger (it is the sanctioned accounting-date correction, and
-- db/validate.py asserts it stays editable). Because the period is derived from
-- it, an UPDATE could otherwise walk a row INTO a frozen month after the fact —
-- the same hole as the insert, reached one statement later.
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

-- An lpb line becomes cost at the moment it is CHECKED. Two ways in, both guarded:
-- a draft being checked, and a line inserted already checked.
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
