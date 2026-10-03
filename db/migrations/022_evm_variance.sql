-- 022_evm_variance.sql — schedule and cost variance, per period and cumulative.
--
-- WHY
--
-- `v_evm_period` already carries `cost_variance = ac - ev` (from 018, deliberately pinned by
-- EV7.6 and NOT changed here) and the two indexes. What the PRD promises on top is the pair a
-- reader actually asks for, and the one it does not yet have:
--
--   PRD §5.1:   "EVM engine: PV from baseline, EV from ticks x CBS, AC from ledger actuals."
--   PRD §5.4:   "Project dashboard (PM/Controller): S-curves, EVM trend ..."
--   TECH-SPEC §10 step 7 names "variance".
--
-- Missing: Schedule variance (SV) and Cost variance in the EVM convention (CV). Without SV there
-- is no number answering "are we ahead or behind?" in money, and a dashboard can only show the
-- index.
--
-- THE SIGN TRAP — THIS IS WHY THE MIGRATION EXISTS AND NOT JUST A SCREEN
--
-- `cost_variance` is spelled `AC - EV` and therefore has the OPPOSITE sign to standard EVM:
--
--   AC - EV > 0   means spent more than earned   -> over budget
--   CV = EV - AC  < 0 in the same situation      -> over budget, NEGATIVE
--
-- Both are defensible in isolation and EV7.6 pins the existing one, so a screen that showed
-- `cost_variance` labelled "CV" would silently INVERT every verdict, and one that showed both
-- under one name would contradict itself on the page. So both live here, each named for its own
-- value, and the screen states the convention it renders.
--
-- The convention used for the new columns is the STANDARD one, so the numbers match the textbook
-- and any other tool the reader has:
--
--   SV = EV - PV    positive = ahead of schedule
--   CV = EV - AC    positive = under budget
--   VAC = BAC - EAC positive = expected to finish under budget (computed in the service, where
--                   BAC and EAC already live -- EAC needs CPI and a rounding decision)
--
-- WHAT THIS MEANS FOR EXISTING READERS
--
-- NOTHING. This migration is additive: every column that existed before is emitted with the same
-- name and the same expression. `cost_variance` in particular keeps the `AC - EV` sign EV7.6
-- pins. The one thing to be careful of is that the view is DROPPED and recreated, so anything
-- depending on it is dropped and recreated in the same file (see the dependency note below).
--
-- DEPENDENCY NOTE
--
-- `v_payable` and `v_receivable` do not read this view. Nothing else in SQLite does either, and
-- SQLite resolves view bodies lazily in any case, so a straight DROP/CREATE is safe — the same
-- pattern 003, 014 and 018 used for this exact view.
--
-- WHAT IS ADDED (additive only -- no existing column changes)
--
--   sv      = ev - pv          per period
--   cv      = ev - ac          per period
--   sv_cum  = ev_cum - pv_cum  running total
--   cv_cum  = ev_cum - ac_cum  running total
--
-- The blank rule holds (migrations 018/019): a variance is computed from the three measured
-- figures, all of which are 0 on a month nobody has touched. A variance of 0 is therefore a real
-- answer here -- "the plan and reality agree so far" -- unlike an index, where a 0 denominator
-- means there is no index at all. So these are plain arithmetic, NOT wrapped in a CASE. Note this
-- is a deliberate difference from `spi`/`cpi` two lines above, and it is stated here so nobody
-- later "fixes" the inconsistency in the wrong direction.

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
       -- Kept exactly as 018 wrote it, OPPOSITE sign to `cv` below. EV7.6 pins this
       -- expression and the ledger-side readers are built on it; changing it to match
       -- `cv` would silently flip a figure for every existing caller.
       ac - ev AS cost_variance,
       -- The running totals, and the indexes they support. Same rule at both scales.
       pv_cum, ev_cum, ac_cum,
       CASE WHEN ev_cum <> 0 AND pv_cum <> 0 THEN ROUND(ev_cum / pv_cum, 4) END AS spi_cum,
       CASE WHEN ev_cum <> 0 AND ac_cum <> 0 THEN ROUND(ev_cum / ac_cum, 4) END AS cpi_cum,
       -- Standard-EVM variances. Plain arithmetic: 0 is a real answer here ("plan and
       -- reality agree"), not a missing measurement, so there is no CASE. See the header.
       ev - pv     AS sv,
       ev - ac     AS cv,
       ev_cum - pv_cum AS sv_cum,
       ev_cum - ac_cum AS cv_cum
FROM cum;
