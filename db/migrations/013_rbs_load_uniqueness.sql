-- 013_rbs_load_uniqueness.sql — the resource plan can no longer be loaded twice.
--
-- THE HOLE THIS CLOSES
--
-- `rbs_load` carries an inline UNIQUE (project_id, wbs_node_id, rbs_code,
-- transaction_account_id, version). That looks like a guard and is not one, because
-- SQLite treats NULLs as DISTINCT in a UNIQUE constraint. `transaction_account_id`
-- is deliberately optional (decision 2A: the account is the Cost Controller's call
-- and often comes later), so in the ORDINARY case it is NULL — and the constraint
-- does not apply at all. Two identical rows then insert happily.
--
-- Measured before this migration, on a freshly migrated and seeded database:
--
--   1st insert (account NULL, v1): OK
--   2nd insert (account NULL, v1): ALSO OK      <-- the constraint did nothing
--   rows now: 2 | summed total_amount: 6,000,000  <-- 12 days of a carpenter, twice
--
-- The damage is not a duplicated screen row: part 7.4 checks the PRD's named
-- invariant (sum of the resource plan = the account total = the budget), and a
-- doubled resource plan breaks that reconciliation from the resource side. It is
-- also a plausible user action — a planner entering a line twice, or clicking Save
-- twice on a slow connection, and nothing tells them.
--
-- WHERE THE RULE IS ENFORCED — and why here rather than in the service
--
-- The same lesson as migration 011: a rule that lives only in the service dies at
-- the first direct write. This is an index, so the database itself refuses the
-- duplicate whatever path the write takes. The service still checks, to produce a
-- readable message; the index is what makes the check true.
--
-- `cbs_plan` already got this right and is deliberately left alone:
--
--   uq_cbs_plan_bucket ON cbs_plan(project_id, transaction_account_id,
--                                  COALESCE(wbs_node_id, 0), plan_type,
--                                  period_month, version)
--
-- COALESCE is exactly the fix applied here. (Note it permits an account-total row
-- and per-WBS rows to coexist for one bucket, which is why part 7.4 requires every
-- baseline row to carry a WBS tag — otherwise `v_evm_period` sums both and double
-- counts PV. That rule is enforced in the service and pinned by tests there.)
--
-- The old inline UNIQUE stays in place. It is weaker, so the stricter index
-- governs; dropping it would need a table rebuild for no gain.
--
-- THE KEY
--
-- COALESCE on BOTH nullable tag columns, so "no account" is a single comparable
-- value instead of an unbounded set of distinct NULLs. `wbs_node_id` and
-- `rbs_code` are NOT coalesced because the service requires both — a resource load
-- with no work line or no resource is meaningless, not merely untidy.

CREATE UNIQUE INDEX IF NOT EXISTS uq_rbs_load_bucket ON rbs_load(
  project_id,
  wbs_node_id,
  rbs_code,
  COALESCE(transaction_account_id, 0),
  version
);

-- The list screen reads the latest version of each bucket, so give that a path.
CREATE INDEX IF NOT EXISTS idx_rbs_load_bucket_lookup ON rbs_load(
  project_id, wbs_node_id, rbs_code, version);
