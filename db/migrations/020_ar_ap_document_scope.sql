-- 020_ar_ap_document_scope.sql — the receivable register admits claims, not cash movements.
--
-- WHY
--
-- PRD §5.2, verbatim: "Receivable/payable are computed views over the ledger (filtered by
-- type + document no) — not separately keyed." The two views are written differently, and
-- only one of them follows that sentence:
--
--   v_payable    WHERE (line_role = 'payable' OR type = 'Payable' OR line_role = 'funding')
--                -> filters on TYPE. It works.
--   v_receivable JOIN cost_categories cc ON cc.id = r.cost_category_id AND cc.is_receivable = 1
--                -> filters on a COST CATEGORY. It does not.
--
-- That asymmetry is the whole defect, and it is measurable. `src/lib/ledger-builder.js` is the
-- manual entry path and it hard-codes `cost_category_id: null` (line 39) — Finance fills a cost
-- category only later, on the tagging screen, and the ledger-entry form has no such field at
-- all. So a claim typed into the app can never be seen by a view that requires one.
--
-- MEASURED on the seeded dev database (2026-10-03), every row of v_receivable as shipped:
--
--   document_no    | billed     | paid       | outstanding | what it really is
--   ---------------+------------+------------+-------------+---------------------------------
--   CASHOUT-0208   |          0 | 30,000,000 | -30,000,000 | a Dropping / funding line. NOT a claim.
--
-- One row. It is the one document that is NOT a receivable, reported at MINUS thirty million.
-- The real claims are absent, every one of them:
--
--   INV-0224       | 400,000,000 billed, 300,000,000 paid, 40,000,000 retainage  -> hidden
--   RET-0044       |  40,000,000 retainage claim                                  -> hidden
--   CASHIN-0114    | 300,000,000 received against INV-0224's doc no               -> hidden
--
-- Finance's collection priority list therefore led with "one item, minus thirty million" while
-- every sum owed to the company was invisible. This is the same class of defect migration 018
-- removed from the EVM view: a missing value presented as a confident — and here, inverted —
-- figure. It is a REPORTING defect, which is why Module 8 owns it and fixes it first: parts
-- 8.3 (aging), 8.5 (variance) and 8.7 (portfolio) all render this register, and rendering a
-- known-false register would have shipped the lie to the screen.
--
-- WHY THE SECOND CONDITION IS THE RIGHT FIX, NOT A WIDER ONE
--
-- "Filtered by type + document no" is a two-part rule and the second part is load-bearing.
-- A funding line (a payment) belongs in a customer's account only when the SAME document_no
-- already carries a claim line. That is precisely what the validator already asserts from the
-- other direction — `db/validate.py` line ~117: "Same-doc lines must net; a payment for a
-- DIFFERENT doc must not reduce this invoice's outstanding" — and it is what makes a
-- funding-ONLY document a cash movement rather than a receivable. Measured: CASHOUT-0208 is
-- the only funding-only document in the database (1 funding line, 0 other lines), and it is
-- exactly the one row the old view showed.
--
-- WHAT CHANGES — the register
--
--   v_receivable  admits a line when it is a claim (type IN ('Income','Receivable') OR
--                 line_role = 'receivable', i.e. the PRD rule), and admits a funding line
--                 only when the same document already carries a claim. The ten output columns
--                 and every arithmetic expression are UNCHANGED, byte for byte.
--   v_payable     already correct; only the same funding gate is added, so that a payable
--                 register cannot show a payment on a document that owes nothing. Its WHERE
--                 clause is otherwise untouched — this view works today and must not regress.
--   v_aging       reads v_receivable, so it is dropped and recreated in dependency order.
--
-- WHAT MUST NOT MOVE (the acceptance condition)
--
-- `db/validate.py` pins four figures, and they must be identical after this migration:
--
--   INV-0224 outstanding 60,000,000  |  paid 300,000,000  |  retainage 40,000,000
--   PO-9001 (after the validator's payment line) billed 90,000,000, paid 30,000,000,
--           outstanding 60,000,000
--
-- On the old v_receivable, INV-0224 never appeared, so `fetchone()` returned None and the
-- validator would have failed — the reading is only possible on a corrected view. That is
-- further evidence the old filter was wrong, not a preference.
--
-- ORDER MATTERS: v_aging SELECTs FROM v_receivable, so both are dropped before either is
-- recreated. Creating v_aging first would fail against the dropped view. This is the same
-- dependency discipline migration 003 documents at its head.

DROP VIEW IF EXISTS v_aging;       -- depends on v_receivable — must go first
DROP VIEW IF EXISTS v_receivable;
DROP VIEW IF EXISTS v_payable;

-- Receivable register: one row per (project, document). A claim line is identified by type,
-- per PRD §5.2. A funding (payment) line joins the document only when the document carries a
-- claim of its own — which is what "same-doc lines net" means, and what keeps a bare cash
-- movement out of the receivables list.
CREATE VIEW v_receivable AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  MIN(r.date)                                AS first_date,
  MIN(r.period_month)                        AS period_month,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE ABS(r.amount) END)        AS billed_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE 0 END)        AS paid_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE r.retainage_amount END)   AS retainage_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 AS net_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 - SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE r.retainage_amount END) AS outstanding_amount,
  MIN(CASE WHEN r.line_role = 'funding' THEN NULL ELSE NULLIF(r.date, '') END) AS invoice_date,
  MAX(r.date)                                AS last_activity_date,
  COUNT(*)                                   AS line_count
FROM v_ledger_period r
JOIN projects p ON p.id = r.project_id
WHERE r.project_id IS NOT NULL
  AND r.document_no IS NOT NULL
  AND (
    -- A claim: identified by type + line_role, per PRD §5.2, never by cost category.
    -- `line_role <> 'funding'` is NOT decoration. A payment line may itself carry a claim's
    -- type — `db/validate.py` inserts exactly that (`type='Payable', line_role='funding'`) to
    -- test netting, and the first draft of this migration admitted one as a claim because the
    -- type test was evaluated first. A payment is never a claim, whatever its type says.
    (r.line_role <> 'funding'
       AND (r.type IN ('Income', 'Receivable') OR r.line_role = 'receivable'))
    OR
    -- A payment, admitted only against a claim on the SAME document: "same-doc lines net".
    (r.line_role = 'funding' AND EXISTS (
        SELECT 1 FROM v_ledger_period c
        WHERE c.project_id = r.project_id
          AND c.document_no = r.document_no
          AND c.line_role <> 'funding'
          AND (c.type IN ('Income', 'Receivable') OR c.line_role = 'receivable')))
  )
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;

-- Payable register: unchanged arithmetic and unchanged WHERE, plus the same funding gate.
-- Today this view is correct because it filters on type; the gate only closes the
-- funding-only-document case that v_receivable was caught by, so the two registers answer the
-- same question the same way.
CREATE VIEW v_payable AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  MIN(r.date)                                AS first_date,
  MIN(r.period_month)                        AS period_month,
  SUM(CASE WHEN r.line_role = 'funding' THEN 0 ELSE ABS(r.amount) END) AS billed_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE 0 END) AS paid_amount,
  SUM(CASE WHEN r.line_role = 'funding' THEN ABS(r.amount) ELSE -ABS(r.amount) END) * -1 AS outstanding_amount,
  MIN(r.date)                                AS invoice_date,
  MAX(r.date)                                AS last_activity_date,
  COUNT(*)                                   AS line_count
FROM v_ledger_period r
JOIN projects p ON p.id = r.project_id
WHERE r.project_id IS NOT NULL
  AND r.document_no IS NOT NULL
  AND (
    -- A payable: the purchase-side mirror of the claim test above. `line_role <> 'funding'` for
    -- the same reason — a payment must never be admitted as the thing being paid.
    (r.line_role <> 'funding'
       AND (r.line_role IN ('payable', 'expense') OR r.type = 'Payable'))
    OR
    -- A payment on a real payable, admitted only when the same document carries one.
    (r.line_role = 'funding' AND EXISTS (
        SELECT 1 FROM v_ledger_period c
        WHERE c.project_id = r.project_id
          AND c.document_no = r.document_no
          AND c.line_role <> 'funding'
          AND (c.line_role IN ('payable', 'expense') OR c.type = 'Payable')))
  )
GROUP BY r.project_id, r.document_no, r.partner_type, r.partner_id;

-- Aging: same shape as before, with one new FIRST branch. A row with no usable invoice date
-- cannot be aged — it has no age — and the old CASE fell through every `<=` comparison to ELSE
-- and called it '120_plus'. Measured on the dev database before this migration, the register's
-- single row came back with days_aged NULL and aging_bucket '120_plus': an undated row leading
-- the collection list as the most overdue item. That is the same "missing value becomes an
-- alarming value" defect as above.
--
-- THE TRAP THE FIRST DRAFT WALKED INTO, AND IT IS MEASURED, NOT THEORISED
--
-- The obvious guard is `invoice_date IS NULL`, and it is not enough. `accounting_ledger.date` is
-- declared NOT NULL, which stops an ABSENT date but not a BLANK one: `date = ''` is accepted
-- (verified by direct insert), and `julianday('')` is NULL, so it sorts before every real date
-- and totals as though it had an age. A blank string is exactly what a partially filled import
-- produces. Worse, `MIN(date)` over a document whose lines mix a blank and a real date returns
-- the blank — one undated line drags the whole document's invoice_date to ''. Both are closed
-- here: `NULLIF(r.date, '')` in the register's MIN (so a blank line cannot blank the document)
-- and `IS NULL OR = ''` plus an explicit WHERE here.
--
-- The consequence, stated plainly, because it changes what this view is FOR: v_aging is the
-- register of datable, still-outstanding claims. A row it cannot date is not aged and does not
-- belong in it; the "no date" to-do list is served by querying v_receivable directly for
-- `invoice_date IS NULL OR invoice_date = ''` (part 8.3 renders it on the aging screen). The
-- guard and the WHERE are therefore both deliberate, and the five real bucket boundaries
-- (30/60/90/120) are untouched.
-- `days_aged` stays NULL where nothing can be derived: the age is genuinely unknown, and 0
-- would be a claim that the invoice is current.
CREATE VIEW v_aging AS
SELECT r.project_id, r.document_no, r.partner_id, r.invoice_date, r.outstanding_amount,
       CASE WHEN r.retainage_amount > 0 THEN 1 ELSE 0 END AS has_retainage,
       julianday('now') - julianday(r.invoice_date) AS days_aged,
       CASE
         WHEN r.invoice_date IS NULL OR r.invoice_date = '' THEN 'no_date'
         WHEN julianday('now') <= julianday(r.invoice_date) THEN 'current'
         WHEN julianday('now') - julianday(r.invoice_date) <= 30 THEN '1_30'
         WHEN julianday('now') - julianday(r.invoice_date) <= 60 THEN '31_60'
         WHEN julianday('now') - julianday(r.invoice_date) <= 90 THEN '61_90'
         WHEN julianday('now') - julianday(r.invoice_date) <= 120 THEN '91_120'
         ELSE '120_plus'
       END AS aging_bucket
FROM v_receivable r
WHERE r.outstanding_amount <> 0
  -- An undatable row is NOT an aged row: it has to be fixed, not chased. Filtering is also
  -- necessary for correctness, not just tidiness — see the note above; julianday('') is NULL,
  -- so a blank date would otherwise sort and total as if it had an age.
  AND r.invoice_date IS NOT NULL AND r.invoice_date <> '';
