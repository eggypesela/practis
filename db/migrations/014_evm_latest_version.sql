-- 014_evm_latest_version.sql — the EVM and de-scope views now read the CURRENT
-- baseline version only, instead of adding every version together.
--
-- THE DEFECT THIS CLOSES
--
-- `cbs_plan` is versioned: uq_cbs_plan_bucket keys on (project_id,
-- transaction_account_id, COALESCE(wbs_node_id,0), plan_type, period_month,
-- version), so a revision of a bucket is a NEW row at version+1 — deliberately, so the
-- previous figure stays readable. That is how `wbs_nodes` and `rbs_load` work too.
--
-- But `v_evm_period` sums baseline rows with NO version filter:
--
--   pv AS (SELECT project_id, period_month, SUM(amount) AS pv
--          FROM cbs_plan WHERE plan_type='baseline' GROUP BY project_id, period_month)
--
-- so every version of a bucket is counted. Measured on a freshly migrated database:
--
--   one row, 3,000,000 in 2026-03        -> PV 2026-03 = 3,000,000   (correct)
--   after a baseline CHANGE (v2, same
--   bucket, same amount)                 -> PV 2026-03 = 6,000,000   (DOUBLED)
--
-- This is not a latent risk that "will be a bug someday". Parts 7.5, 7.6 and 7.7 ARE
-- the machinery that writes those rows: an approved BCR or a de-scope produces exactly
-- the version-2 row above. On the old view, every approved change order would silently
-- double the planned value for the affected months, and every SPI computed from it
-- would be wrong by a factor nobody could trace.
--
-- The second axis is worse because it is silent. The view's `pv` sums ALL baseline rows
-- while its `ev` branch uses only WBS-tagged ones. So an account-total row
-- (wbs_node_id IS NULL) sitting beside per-WBS rows for the same month is counted in PV
-- and counted AGAIN in the per-WBS rows:
--
--   per-WBS rows totalling 3,000,000 + one account-total row of 3,000,000
--                                        -> PV 2026-03 = 6,000,000   (DOUBLED)
--
-- Part 7.4 closes that axis at the service (a baseline row must carry a WBS tag). This
-- migration closes the version axis in the view, which is where it belongs: the
-- number is wrong regardless of who wrote the row, so the rule cannot live in one
-- service. Migration 011's lesson again — a rule that lives only in the service dies at
-- the first direct write, and here the direct write is a trigger-free INSERT.
--
-- WHY NOT JUST DELETE THE OLD ROWS INSTEAD OF VERSIONING
--
-- Because the module's whole premise is that nothing is ever deleted (PRD §4.4), and a
-- Cost Controller genuinely needs to ask "what did the baseline originally say for
-- August?" after two change orders. The archive in `bcr_register.old_baseline_json`
-- answers it for the baseline as a whole; keeping the old bucket readable answers it per
-- line. So the view learns which version is current; the rows stay.
--
-- `v_descoped_lines.budget_removed` had the identical hole and is fixed the same way.
--
-- THE DEFINITION OF "CURRENT"
--
-- For each bucket — (project_id, transaction_account_id, COALESCE(wbs_node_id, 0),
-- plan_type, period_month) — the row with the highest `version`. COALESCE matches
-- uq_cbs_plan_bucket, so a NULL account or a NULL wbs_node_id compares as one value
-- instead of an unbounded set of distinct NULLs.
--
-- Verified before and after on a seeded database: with no bucket holding more than one
-- version, every figure is unchanged (a view rewrite that moved a number would be a
-- silent regression of its own). test/cbs.test.js BL7.11 asserts both cases — one
-- version, and two.

-- Both views read cbs_plan, so both are dropped and rebuilt. No table references
-- cbs_plan by foreign key (checked: 0), and it carries no triggers, so this is a pure
-- view swap with nothing else to keep in step.
DROP VIEW IF EXISTS v_evm_period;
DROP VIEW IF EXISTS v_descoped_lines;

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
