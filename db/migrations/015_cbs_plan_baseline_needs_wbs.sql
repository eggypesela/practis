-- 015_cbs_plan_baseline_needs_wbs.sql — a baseline bucket must name a work line.
--
-- THE HOLE THIS CLOSES
--
-- `v_evm_period` computes PV and EV from the same table two different ways:
--
--   pv: SUM(amount) over ALL baseline rows                 -> includes account totals
--   ev: ... WHERE wbs_node_id IS NOT NULL                  -> excludes them
--
-- So a row with no work line is counted in the planned value and can never be earned
-- against. Put an account-total row beside the per-WBS rows for the same month and the
-- same money is counted twice:
--
--   per-WBS rows totalling 3,000,000 + one account-total row of 3,000,000
--                                        -> PV = 6,000,000, and EV can never reach it
--
-- Measured on a migrated, seeded database before this migration. Migration 014 stops a
-- SUPERSEDED version from being added in; this stops the OTHER kind of extra row, and
-- in the place that cannot be bypassed.
--
-- The PRD settles the intent (§6): "Σ monthly buckets = account total = RBS total" —
-- the account total is a CHECK, so it is CALCULATED and never stored. A stored
-- account-total row is therefore not a second way of saying the same thing; it is a
-- double statement of it.
--
-- WHY A TRIGGER AND NOT ONLY A SERVICE CHECK
--
-- Part 7.4's service refuses an untagged bucket, which is where the user sees a
-- readable message. But the failure mode is a SILENTLY wrong PV — no error, no
-- unexplained figure, just an SPI that is too low forever. Migration 011's lesson is
-- that such a rule must not live in one code path: `db/seed-smoke.sql` writes baseline
-- rows directly, and Module 8's forecast work will write more. The trigger is what
-- makes the rule true whatever the caller. (The aggregation rule itself —
-- Σ buckets = RBS total — stays in the service: it spans two tables and needs a
-- readable message, which is what the PRD asks the app to enforce.)
--
-- The existing writers already comply: every baseline row in `db/seed-smoke.sql`
-- carries a `wbs_node_id`, so this changes no existing figure. Verified by re-running
-- the smoke seed after applying.
--
-- Enforcement is on INSERT and on UPDATE OF wbs_node_id, so a tagged row cannot be
-- blanked afterwards. Only plan_type='baseline' is guarded — it is the only type
-- `v_evm_period` reads, so a forecast or bcr row is unaffected.

CREATE TRIGGER IF NOT EXISTS trg_cbs_plan_baseline_needs_wbs_insert
BEFORE INSERT ON cbs_plan
FOR EACH ROW WHEN NEW.plan_type = 'baseline' AND NEW.wbs_node_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'a baseline bucket must name a work line (plan_type=baseline, wbs_node_id IS NULL)');
END;

CREATE TRIGGER IF NOT EXISTS trg_cbs_plan_baseline_needs_wbs_update
BEFORE UPDATE OF wbs_node_id ON cbs_plan
FOR EACH ROW WHEN NEW.plan_type = 'baseline' AND NEW.wbs_node_id IS NULL
BEGIN
  SELECT RAISE(ABORT,
    'a baseline bucket must name a work line (plan_type=baseline, wbs_node_id IS NULL)');
END;
