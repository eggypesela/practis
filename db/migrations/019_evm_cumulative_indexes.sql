-- 019_evm_cumulative_indexes.sql — the running-total SPI and CPI.
--
-- WHY
--
-- `v_evm_period.spi` / `.cpi` (migration 018) are PER PERIOD: `pv` is one month's bucket and `ev`
-- is the value earned IN that month. That answers "how did this month go?" — a real question, worth
-- keeping. It does NOT answer "is the project ahead or behind?", which is what the PRD promises
-- (success criterion 2: "SPI and CPI computed automatically each period"; §5.1 line 211: the KPI is
-- expressed on cumulative values) and what any portfolio dashboard shows.
--
-- Measured on a fixture — one line, 1,000,000 spread evenly over 10 months, 50% ticked in month 1
-- (EV = 500,000 from March onward), 200,000 of cost in March:
--
--   month | per-period spi (018)                  | running-total spi (this migration)
--   ------+---------------------------------------+----------------------------------
--   03    | 5.0                                   | 5.0
--   04    | NULL (blank — nothing earned in April) | 2.5
--   05    | NULL                                  | 1.667
--   06    | NULL                                  | 1.25
--
-- Read the left column downward: "5.0, blank, blank, blank" is a project whose health nobody can
-- read. The right column settles toward 1.0, which is the answer.
--
-- WHAT IS ADDED (additive only — no existing column changes)
--
--   pv_cum, ev_cum, ac_cum   the running totals through and including this month
--   spi_cum = ev_cum / pv_cum
--   cpi_cum = ev_cum / ac_cum
--
-- Same honesty rule as migration 018: a cumulative index is NULL when there is nothing to divide
-- (zero cumulative earned value, or a zero denominator). A project with no progress yet has no
-- cumulative index — reporting `0` would be the false claim 018 removed.
--
-- THE TRAP THIS MIGRATION EXISTS TO AVOID, AND IT BIT THE FIRST DRAFT
--
-- A window function emits a row ONLY for its input rows. Written the obvious way —
-- `SUM(ev) OVER (PARTITION BY project_id ORDER BY period_month)` straight over the `ev` CTE — the
-- running `ev` exists only in months that HAVE progress. Every other month gets no `ev_cum` row, the
-- join fills it with NULL, and the trend line reads:
--
--   Jan ev_cum NULL · Feb 180,000,000 · Mar NULL · Apr NULL · May NULL
--
-- which is not a running total at all — it is the per-period figure with the blanks moved. Measured
-- on the seeded database. The fix is the `months` grid below: the union of every month that appears
-- in ANY of the three sources, so every month has a cumulative row and a month that earned nothing
-- carries the previous total forward.
--
-- WHY NOT JUST SUM THE PER-PERIOD COLUMNS
--
-- `pv_cum` could be a window sum of `pv`. `ev_cum`/`ac_cum` must not be assumed to be, for a reason
-- specific to this app: `ac` per period comes from `v_cbs_actual`, which deliberately EXCLUDES cost
-- that cannot be attributed to a CBS account ("unattributable cost is not cost"). A later period can
-- attribute an earlier month's cost, and that changes the cumulative total without changing any
-- individual per-period column. So the cumulative columns are computed from the SAME base tables as
-- the per-period ones, each with its own window. Same source, one place, no drift. (Designed for;
-- not demonstrable on today's seed data, which has no such re-attribution. Stated as design intent.)
--
-- `period_month` is `'YYYY-MM'` text, so it sorts chronologically; SQLite's default window frame
-- (RANGE UNBOUNDED PRECEDING TO CURRENT ROW) is the standard running total.
--
-- No table is touched and no trigger added: a pure view swap, like 014 and 018. No other view
-- depends on `v_evm_period` (checked), so the DROP needs no CASCADE.
--
-- Verified before and after on the seeded database: the row count is unchanged and NOT ONE
-- per-period figure moved — only the new cumulative columns appear. test/evm.test.js EV7.8 asserts
-- that, and EV7.10 pins the carrying-forward this header describes.

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
),
-- The project's month grid: EVERY month that appears in any of the three sources, not just the
-- months that happen to have a row in one of them. This is what makes the running totals below
-- continuous — without it, a month that earned nothing has no cumulative row and the curve breaks.
months AS (
  SELECT project_id, period_month FROM pv
  UNION
  SELECT project_id, period_month FROM ev
  UNION
  SELECT project_id, period_month FROM ac
),
-- One row per project per month, with the three per-period figures filled in (0 where that source
-- has nothing for the month — the same COALESCE the previous view used).
tot AS (
  SELECT m.project_id, m.period_month,
         COALESCE(pv.pv, 0) AS pv,
         COALESCE(ev.ev, 0) AS ev,
         COALESCE(ac.ac, 0) AS ac
  FROM months m
  LEFT JOIN pv ON pv.project_id = m.project_id AND pv.period_month = m.period_month
  LEFT JOIN ev ON ev.project_id = m.project_id AND ev.period_month = m.period_month
  LEFT JOIN ac ON ac.project_id = m.project_id AND ac.period_month = m.period_month
),
-- The running totals. Every month in the grid has one, because every month is in `tot`.
cum AS (
  SELECT project_id, period_month, pv, ev, ac,
         SUM(pv) OVER w AS pv_cum,
         SUM(ev) OVER w AS ev_cum,
         SUM(ac) OVER w AS ac_cum
  FROM tot
  WINDOW w AS (PARTITION BY project_id ORDER BY period_month)
)
SELECT project_id, period_month, pv, ev, ac,
       -- NULL unless there is something to divide: an index needs a denominator AND a
       -- non-zero numerator. With no measured progress there is no earned value, so
       -- neither index exists — blank, never 0. (Migration 018's rule.)
       CASE WHEN ev <> 0 AND pv <> 0 THEN ROUND(ev / pv, 4) END AS spi,
       CASE WHEN ev <> 0 AND ac <> 0 THEN ROUND(ev / ac, 4) END AS cpi,
       ac - ev AS cost_variance,
       -- The running totals, and the indexes they support. Same rule at both scales.
       pv_cum, ev_cum, ac_cum,
       CASE WHEN ev_cum <> 0 AND pv_cum <> 0 THEN ROUND(ev_cum / pv_cum, 4) END AS spi_cum,
       CASE WHEN ev_cum <> 0 AND ac_cum <> 0 THEN ROUND(ev_cum / ac_cum, 4) END AS cpi_cum
FROM cum;
