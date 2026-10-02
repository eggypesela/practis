-- 016_rbs_rows_for_change_order.sql — the resource plan may be written inside a
-- baseline change, under the same forward-only rule as the budget.
--
-- WHY
--
-- The invariant is Σ budget buckets = the account's resource plan. A change order that
-- moves money (a scope reduction, a new scope item) therefore has to move BOTH, and
-- `applyBaselineChange` writes the resource plan and the buckets in one transaction —
-- otherwise they could be seen mid-move, one applied and the other not, and the project
-- would report a budget that its own plan does not support.
--
-- Nothing forbade that before, so this migration adds nothing restrictive. It exists to
-- state two things at the level where they cannot be bypassed:
--
--   1. `rbs_load` is versioned, and `uq_rbs_load_bucket` already says which row is
--      current. Stated here so the versionless readers added later have the rule in
--      front of them: SUM over rbs_load without a version filter double-counts, exactly
--      the way `v_evm_period` double-counted the baseline before migration 014.
--   2. The current row must be the HIGHEST version for its bucket. A change order that
--      wrote version 1 beside an existing version 3 would make "the current plan"
--      ambiguous, and the two readers that sum it would disagree.
--
-- The rule holds today by construction (every writer takes MAX(version)+1). This makes
-- it true whatever the writer.

CREATE TRIGGER IF NOT EXISTS trg_rbs_load_version_is_current_insert
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

-- The same rule on an update that moves a row into a bucket, or renumbers it.
CREATE TRIGGER IF NOT EXISTS trg_rbs_load_version_is_current_update
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

-- A zero-value resource row is meaningful: it retires a resource from a line while
-- keeping the history readable (nothing is ever deleted). Negative is not meaningful —
-- a plan cannot consume less than nothing.
CREATE TRIGGER IF NOT EXISTS trg_rbs_load_no_negative
BEFORE INSERT ON rbs_load
WHEN NEW.total_amount < 0 OR NEW.rate < 0 OR NEW.units < 0
BEGIN
  SELECT RAISE(ABORT, 'A resource-load figure cannot be negative.');
END;
