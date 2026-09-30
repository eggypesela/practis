-- 007_lpb_reconciliation_status.sql — give the reconciliation view a complete
-- status, including the case it silently dropped.
--
-- v_lpb_reconciliation (001) matches Finance's bulk settlement against Project
-- Admin's detail lines. Its status CASE covers three of the four real outcomes:
--
--   balanced        settlement exists, detail agrees
--   difference      settlement exists, detail disagrees
--   missing_detail  settlement exists, NO detail at all
--   <missing>       detail exists, NO settlement  <-- fell through to NULL
--
-- A CASE with no ELSE yields NULL, so a pot that has been reported but not yet
-- settled by Finance came back with status = NULL. Any consumer rendering that
-- as "missing detail" would state the exact opposite of the truth (the detail is
-- the part that exists). Name the fourth state explicitly instead.
--
-- Only the CASE and the difference arithmetic change; the joins, the source of
-- each amount and the three existing statuses are untouched.

DROP VIEW v_lpb_reconciliation;

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
