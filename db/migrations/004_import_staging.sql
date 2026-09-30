-- 004_import_staging.sql — TS-04/TS-24: persist staged import rows + audit file path
-- so a staged batch survives across the stage → preview → confirm lifecycle, and
-- the confirmed batch keeps its original file for the 90-day audit window.
--
-- staging_json: validated rows (post mapper, pre-commit) awaiting confirm.
--               NULL until the batch is staged; written by POST /api/imports.
-- file_path:    random server-side name under data/imports/; never the client's.
-------------------------------------------------------------------------------

ALTER TABLE import_batches ADD COLUMN staging_json TEXT;
ALTER TABLE import_batches ADD COLUMN file_path TEXT;