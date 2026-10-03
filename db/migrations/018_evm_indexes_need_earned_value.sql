-- 018_evm_indexes_need_earned_value.sql — SPI and CPI are only reported when EV exists.
--
-- THE DEFECT, MEASURED
--
-- `v_evm_period` gates each index on its DENOMINATOR only:
--
--   spi = CASE WHEN COALESCE(pv.pv,0) <> 0 THEN ROUND(COALESCE(ev.ev,0) / pv.pv, 4) END
--   cpi = CASE WHEN COALESCE(ac.ac,0) <> 0 THEN ROUND(COALESCE(ev.ev,0) / ac.ac, 4) END
--
-- EV is folded into a real 0 first by `COALESCE(ev.ev, 0)` in the SELECT, and the numerator
-- is then never checked. So a month with a plan and no progress, or with costs and no
-- progress, reports an INDEX OF ZERO — and 0 is not "we cannot tell", it is a claim:
--
--   March: pv 100,000, ev 0, ac 0        -> spi 0.0   reads as "totally behind schedule"
--   March: pv 0,       ev 0, ac 175,000  -> cpi 0.0   reads as "cost efficiency is zero"
--
-- Measured on the seeded dev database before this migration: the second row is exactly what
-- `PRJ-2026` returns for 2026-03 (pv 0, ev 0, ac 175,000,000 -> cpi 0).
--
-- Both sentences are false. The work simply has not been measured yet, and the PRD's own
-- definition (§4.4) is a division — EV/PV and EV/AC — with a zero numerator and no answer.
-- A project that has not reported progress has NOT been found to be behind; saying so would
-- be the app inventing a figure. The view already knows how to say "cannot be computed": its
-- `CASE WHEN pv <> 0` / `CASE WHEN ac <> 0` guards return NULL, and Part 7.8's own spec
-- states that a NULL here is the intent ("a 0 would read as 'totally behind schedule'").
-- The author's intent was right; the numerator was simply never covered by it.
--
-- WHY THIS IS THE VIEW'S JOB AND NOT A SERVICE'S
--
-- Migration 011's lesson, and again 014/015: a rule about a REPORTED NUMBER must live where
-- the number is produced. Every SPI in the product — dashboard, export, alert — will come
-- out of this one view. A guard in one service would be bypassed by the first direct read.
--
-- WHY NOT ALSO CHANGE `cost_variance`
--
-- `cost_variance` is computed as `ac - ev` (the view's own convention) and is left exactly
-- as it is: nothing reads it, and its sign convention is a separate question that this
-- migration should not decide silently. Flagged, not touched.
--
-- WHAT STAYS TRUE
--
-- Every figure in `pv`, `ev` and `ac` is unchanged; only an index that had no meaning is
-- now blank instead of 0. Verified before and after on the seeded database: both existing
-- March rows keep their values and only the impossible index moves 0 -> NULL.
-- test/evm.test.js EV7.1 asserts the blank and EV7.2 asserts that a real measurement is
-- untouched, so the change cannot be "fixed" by blanking everything.

-- No view depends on `v_evm_period` (checked: 0), so a plain drop is enough.
DROP VIEW IF EXISTS v_evm_period;

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
       -- NULL unless there is something to divide: an index needs a denominator AND a
       -- non-zero numerator. With no measured progress there is no earned value, so
       -- neither index exists — blank, never 0.
       CASE WHEN COALESCE(ev.ev,0) <> 0 AND COALESCE(pv.pv,0) <> 0
            THEN ROUND(COALESCE(ev.ev,0) / pv.pv, 4) END AS spi,
       CASE WHEN COALESCE(ev.ev,0) <> 0 AND COALESCE(ac.ac,0) <> 0
            THEN ROUND(COALESCE(ev.ev,0) / ac.ac, 4) END AS cpi,
       COALESCE(ac.ac,0) - COALESCE(ev.ev,0) AS cost_variance
FROM pv
FULL OUTER JOIN ev ON ev.project_id = pv.project_id AND ev.period_month = pv.period_month
FULL OUTER JOIN ac ON ac.project_id = COALESCE(pv.project_id, ev.project_id)
                  AND ac.period_month = COALESCE(pv.period_month, ev.period_month);
