-- 021_receivable_due_date.sql — the due date the PRD promises, and the terms behind it.
--
-- WHY
--
-- PRD §5.2: "Due date = ledger date + payment terms (from project register)" and R2-6: "due date =
-- ledger date + payment terms (project register, editable for odd contracts)". Neither exists in the
-- product today: the aging report buckets on FIXED 30/60/90/120 offsets from `invoice_date` and the
-- stored terms columns are read by nothing. `src/lib/clients-service.js` says so in its own header —
-- "the column is a stored business term that nothing consumes YET ... Wiring the real due-date
-- column belongs to Module 8". This migration is that wiring.
--
-- DECISION D3 (owner, 2026-10-03) — WHERE THE TERMS COME FROM
--
--   project `payment_terms_days`  ->  else the client's  ->  else the system default in
--   `app_settings.default_payment_terms_days` (30 days, inserted below).
--
-- The chain is EXPOSED, not hidden: the view returns `terms_source` ('project' | 'client' |
-- 'default') so the screen can say "Due 31 Mar (client terms)". A "30 days" that is really "nobody
-- set this" is a different fact from "30 days, our terms", and Finance is entitled to know which.
--
-- MEASURED, and why the default lives in a table rather than in the view
--
-- `app_settings` is empty of business settings after `seed-master.js` — measured: the only rows on a
-- seeded database are the argon2 tuning keys and `csrf_secret`. So a view reading
-- `app_settings.default_payment_terms_days` would return NULL on every real installation, and no
-- screen could show the value or change it. The row is therefore INSERTED here, before the view that
-- reads it, and `INSERT OR IGNORE` is deliberate: an installation that has already set its own terms
-- keeps them, and a re-run cannot overwrite a business decision. Migrations 002, 003, 008, 009 and
-- 010 already carry data statements, so this is the house pattern, not a new one.
--
-- WHY AGING DOES **NOT** MOVE TO `due_date` — the trap this migration deliberately does not spring
--
-- The plan for this part originally said aging should "age from `due_date`". That is WRONG, and it
-- was caught before it shipped:
--
--   * TECH-SPEC §13 pins the ageing contract for this very phase: "aging buckets" belong beside
--     "billed != received". The PRD defines the buckets as offsets from the INVOICE date
--     ("Aging report view (30/60/90/120+ day buckets)", §5.2) and `v_aging` implements exactly that.
--   * `db/validate.py` and `test/reporting.test.js` (RG8.6, committed as 2fe33f8) pin the five real
--     boundaries against invoice date. Re-pointing the buckets at `due_date` would silently move
--     every aged figure — 30/60/90/120 would start meaning "days past due" — and RG8.6 would fail,
--     correctly.
--
-- So the buckets stay on the invoice date, and `due_date` / `overdue_days` are ADDED. Both facts are
-- what Finance asked for and they answer different questions: `days_aged` is "how long has this been
-- outstanding", `overdue_days` is "how long past its terms is it". A collection call needs the first
-- to prioritise and the second to justify. Neither is derived from the other.
--
-- `overdue_days` is CLAMPED AT 0. An invoice inside its terms is not "-12 days overdue"; it is not
-- overdue at all. A negative here would sort ahead of genuinely overdue rows and invent a priority.
--
-- DEPENDENCY ORDER: `v_aging` already reads `v_receivable`; it is dropped first and recreated from
-- the new `v_receivable_due`, which itself reads `v_receivable`. Creating in any other order fails
-- against a dropped view (the discipline migration 003 documents at its head).

-- The system default, once, and never over an owner's own value.
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('default_payment_terms_days', '30');

DROP VIEW IF EXISTS v_aging;         -- depends on v_receivable_due — must go first
DROP VIEW IF EXISTS v_receivable_due;

-- Due dates for every receivable the register admits. Column-for-column a superset of
-- `v_receivable`: everything that view returns is still returned, plus the terms and the due date.
--
-- `terms_days` cascades project -> client -> system default. `terms_source` names which link
-- supplied it, so the number on screen can always be explained. Note the deliberate asymmetry with
-- an absent setting: if `app_settings.default_payment_terms_days` is missing, `terms_days` is NULL
-- and `due_date` stays NULL rather than inventing 30 days. That is the same rule migration 018
-- applied to SPI/CPI — an unknown is reported as unknown, never as a confident figure.
CREATE VIEW v_receivable_due AS
SELECT
  r.project_id,
  r.document_no,
  r.partner_type,
  r.partner_id,
  r.first_date,
  r.period_month,
  r.billed_amount,
  r.paid_amount,
  r.retainage_amount,
  r.net_amount,
  r.outstanding_amount,
  r.invoice_date,
  r.last_activity_date,
  r.line_count,
  -- How long the money has been outstanding, and the priority bucket the PRD defines on it.
  -- UNCHANGED from v_aging: 30/60/90/120 offsets from the INVOICE date.
  julianday('now') - julianday(r.invoice_date) AS days_aged,
  CASE
    WHEN julianday('now') <= julianday(r.invoice_date) THEN 'current'
    WHEN julianday('now') - julianday(r.invoice_date) <= 30 THEN '1_30'
    WHEN julianday('now') - julianday(r.invoice_date) <= 60 THEN '31_60'
    WHEN julianday('now') - julianday(r.invoice_date) <= 90 THEN '61_90'
    WHEN julianday('now') - julianday(r.invoice_date) <= 120 THEN '91_120'
    ELSE '120_plus'
  END AS aging_bucket,
  -- The terms actually applied, and where they came from (decision D3).
  COALESCE(
    p.payment_terms_days,
    cl.payment_terms_days,
    (SELECT CAST(s.value AS INTEGER) FROM app_settings s
      WHERE s.key = 'default_payment_terms_days')
  ) AS terms_days,
  CASE
    WHEN p.payment_terms_days IS NOT NULL THEN 'project'
    WHEN cl.payment_terms_days IS NOT NULL THEN 'client'
    ELSE 'default'
  END AS terms_source,
  -- The due date itself: ledger date + the terms above. SQLite's own date arithmetic — no new
  -- dependency, deterministic given the row. NULL when either half is unknown.
  CASE
    WHEN NULLIF(r.invoice_date, '') IS NOT NULL
     AND COALESCE(
           p.payment_terms_days,
           cl.payment_terms_days,
           (SELECT CAST(s.value AS INTEGER) FROM app_settings s
             WHERE s.key = 'default_payment_terms_days')
         ) IS NOT NULL
    THEN date(
           r.invoice_date,
           '+' || COALESCE(
                    p.payment_terms_days,
                    cl.payment_terms_days,
                    (SELECT CAST(s.value AS INTEGER) FROM app_settings s
                      WHERE s.key = 'default_payment_terms_days')
                  ) || ' days')
  END AS due_date
FROM v_receivable r
LEFT JOIN projects p  ON p.id  = r.project_id
LEFT JOIN clients  cl ON cl.id = p.client_id;

-- Finance's collection priority list. Unchanged contract from migration 020: datable, still-
-- outstanding claims only, bucketed on the invoice date. The new columns come along because
-- `SELECT ... FROM v_aging` is not written anywhere yet, so nothing can break, and part 8.3 needs
-- them on the same row.
--
-- The `no_date` guard is NOT repeated in the CASE here. Migration 020 removed undatable rows from
-- this view entirely (they are a data-quality to-do list, served by querying `v_receivable_due` for
-- `invoice_date IS NULL OR invoice_date = ''`), so an undated row cannot reach this CASE at all.
CREATE VIEW v_aging AS
SELECT
  r.project_id, r.document_no, r.partner_id, r.invoice_date, r.outstanding_amount,
  CASE WHEN r.retainage_amount > 0 THEN 1 ELSE 0 END AS has_retainage,
  r.days_aged,
  r.aging_bucket,
  r.terms_days,
  r.terms_source,
  r.due_date,
  -- Days PAST DUE, clamped at 0: not-yet-due is 0 overdue, never negative. NaN cannot occur here —
  -- `due_date` is only non-NULL when the invoice date and the terms are both known.
  CASE
    WHEN r.due_date IS NULL THEN NULL
    ELSE MAX(0, CAST(julianday('now') - julianday(r.due_date) AS INTEGER))
  END AS overdue_days
FROM v_receivable_due r
WHERE r.outstanding_amount <> 0
  AND r.invoice_date IS NOT NULL AND r.invoice_date <> '';
