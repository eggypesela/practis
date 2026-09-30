-- 005_dedupe_index_fix.sql — restore the import-only predicate on the dedupe index.
--
-- 003_revenue_type.sql rebuilt accounting_ledger (to widen the type enum) and
-- recreated idx_ledger_import_dedupe WITHOUT its original `WHERE source='import'`
-- clause. As a result the dedupe key started applying to manual entries too, and
-- a legitimate second manual post of the same (transaction_id, document_no, date,
-- amount, project) was rejected — a behaviour change, not a tightening.
--
-- 001_initial.sql always intended this index to be import-only: manual duplicates
-- are legal by design (test L4.1), and only re-imported rows are skipped.
-- 003 is also corrected in place for fresh databases; this migration repairs the
-- databases that already ran the faulty version.

DROP INDEX IF EXISTS idx_ledger_import_dedupe;

CREATE UNIQUE INDEX idx_ledger_import_dedupe ON accounting_ledger(
  COALESCE(transaction_id,''), COALESCE(document_no,''), COALESCE(date,''),
  amount, COALESCE(project_id,0))
WHERE source = 'import';
