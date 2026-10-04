-- Module 8 part 8.7: the traffic-light breach threshold, as a SETTING rather than a constant.
--
-- PRD §4.4: "Alert threshold: SPI or CPI < 0.95 for two consecutive periods (threshold tunable)".
-- The plan's decision (7.9A) is that the portfolio tiles read the CUMULATIVE spi_cum/cpi_cum from
-- migration 019, NOT the per-period columns — the per-period figures read "5.0, blank, blank,
-- blank" down a year and are not a health indicator.
--
-- WHERE THE THRESHOLD LIVES. `app_settings` already exists for exactly this (argon2 parameters,
-- `default_payment_terms_days` from migration 021), and its convention is plain text values read
-- with CAST. This follows 021's precedent: INSERT OR IGNORE so an operator who has already tuned
-- the value keeps their value when this migration runs on an existing installation.
--
-- MEASURED BEFORE WRITING, on a copy of the development database with migrations 020-022 applied:
-- `app_settings` held only the argon2 trio, a csrf secret and `default_payment_terms_days` — no
-- threshold of any kind. So without this migration the tile would silently fall back to a
-- hard-coded 0.95 and PRD §4.4's "tunable" would be untrue. The service ALSO defaults to 0.95 when
-- the row is missing, so an installation that somehow lacks it still renders correctly rather than
-- throwing; the row makes it tunable.
--
-- NO SCHEMA CHANGE: `app_settings` is a table that already exists and `db/schema.sql` is generated
-- from table/index/trigger/view DDL, not from data. Adding rows here does not move it, so
-- `dump-schema.js --check` stays clean. Both keys are seeded because the OWNER's answer covers
-- both indices and the page states the threshold — one number for both is what it says.

INSERT OR IGNORE INTO app_settings (key, value) VALUES ('spi_breach_threshold', '0.95');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('cpi_breach_threshold', '0.95');
