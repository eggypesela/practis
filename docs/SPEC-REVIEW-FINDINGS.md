# PRACTIS — Adversarial review: flaws and bugs

**Date:** 2026-09-24
**Scope:** `db/schema.sql` (38 tables, 9 views, 2 triggers), `db/seed-smoke.sql`, `db/validate.py`, and consistency against `TECH-SPEC.md` (TS-01…TS-26) and `PRD-PRACTIS.md` v1.3.
**Method:** executed DDL + seed in an in-memory SQLite database, then attempted the tamper/edge operations a hostile or careless actor would attempt. Every finding below is backed by an actual observed result, not inspection alone.

**Headline:** the schema is structurally strong (FKs, enums, dedupe index, immutability on one table) but the immutability control was applied to **one money table out of three**, and does not cover the columns that actually move money. `ALL CHECKS PASS` does not detect any of this because the validator only exercises happy paths.

---

## A. Real defects — existing schema

### A-1 (HIGH) Ledger immutability trigger misses every column that moves money

`trg_ledger_no_amount_update` guards only `amount, date, type, document_no`.

Verified ALLOWED (each silently breaks a reported figure):

| Operation | Consequence |
|---|---|
| `UPDATE accounting_ledger SET debit = debit + 999999999` | Produced a row with `amount = -400000000`, `debit = 999999999`, `credit = 400000000` → **violates `amount = debit − credit`** |
| `UPDATE ... SET in_cost_basis = 0` | Removes a real cost from the cost basis with no trace; probe flipped 1 row and total cost basis changed |
| `UPDATE ... SET cost_checked = 1` | Marks a line approved without the Cost Controller ever seeing it; removes it from the untagged queue |
| `UPDATE ... SET line_role = 'funding'` | Changes how the line is classified in cost-basis views |
| `UPDATE ... SET wbs_node_id = ...` | Re-attributes cost to a different work line |
| `UPDATE ... SET project_id = 2` (valid target) | **Moves cost from one project to another**; both projects' totals change |
| `UPDATE ... SET source = 'import'` | Bypasses `idx_ledger_import_dedupe` (which is `WHERE source='import'`), enabling duplicate imports |

Protection is inconsistent: `amount/date/type/document_no` are immutable while `debit/credit` — the columns the invariant is *defined on* — are freely editable.

**Fix:** extend the trigger to every money-affecting column (`debit`, `credit`, `in_cost_basis`, `cost_checked`, `line_role`, `wbs_node_id`, `project_id`, `source`, `cost_category_id`, `chart_of_account_id`, `cashflow_category_id`, `transaction_account_id`, `cash_advance_id`, `import_batch_id`), with the correction path being a post-and-reverse flow, not an UPDATE. Add a `BEFORE UPDATE` guard that rejects any `amount <> debit - credit` on the resulting row.

### A-2 (HIGH) `lpb_statements` — the second money path has no immutability at all

Verified ALLOWED:

- `UPDATE lpb_statements SET amount = 1 WHERE id = 1`
- `DELETE FROM lpb_statements WHERE id = 3`
- `UPDATE lpb_statements SET status = 'checked' WHERE id = 3` (no `checked_by`, no `checked_at`)
- `INSERT ... (status='checked')` with `checked_by` NULL

Only `status='checked'` rows feed actual cost (`v_cbs_actual`). So a checked amount can be edited after the fact, a checked line can be deleted, and a line can self-declare as checked with no checker identity. This is the same defect class as A-1 in the table that carries Project Admin detail — the control was written for one table and never propagated.

**Fix:** `BEFORE UPDATE`/`BEFORE DELETE` triggers that reject changes to `amount`, `debit`, `credit`, `status`, `checked_by`, `checked_at` once `status='checked'`; require `checked_by IS NOT NULL AND checked_at IS NOT NULL` when `status='checked'`; require a non-null checker before the row can be considered checked.

### A-3 (HIGH) `audit_log` is editable and deletable by the application

Verified ALLOWED:

- `UPDATE audit_log SET action = 'forged' WHERE id = 1`
- `DELETE FROM audit_log WHERE id = 1`

Spec §3.9 states business audit rows cannot be updated or deleted through application accounts, and TS-21 commits to 10-year statutory retention. The spec notes SQLite has no per-table ACL — correct — but SQLite's available enforcement mechanism is a trigger, and none exists. As it stands the audit trail is forgeable, and a retention commitment on deletable rows is not a control.

**Fix:** `BEFORE UPDATE`/`BEFORE DELETE` triggers raising `ABORT` on `audit_log`. Retention/archival moves rows out-of-band (export + archive), never via application-issued DELETE.

### A-4 (MEDIUM-HIGH) `cash_advance` amount editable, rows deletable

`UPDATE cash_advance SET amount = 1 WHERE id = 1` and `DELETE FROM cash_advance WHERE id = 1` both succeed. The advance amount is the anchor for Expense Report reconciliation. Also `vat`, `reimburse_amount`, `total_amount` are unconstrained (no derivation check).

**Fix:** same trigger pattern; add a CHECK that `total_amount = amount + vat - reimburse_amount` (or whatever the agreed derivation is — confirm).

### A-5 (MEDIUM) `lpb_statements.debit`/`credit` are nullable

`INSERT INTO lpb_statements(..., debit, credit, amount, ...) VALUES (..., NULL, NULL, 5000000, ...)` succeeded. `accounting_ledger` correctly has `NOT NULL DEFAULT 0`, so the same invariant is enforced in one table and not the other. NULL sides make `amount = debit − credit` evaluate to NULL rather than failing.

**Fix:** `NOT NULL DEFAULT 0` on both columns, matching `accounting_ledger`.

### A-6 (MEDIUM) "one side only" is a spec rule with no DDL enforcement

Spec §8.4 requires one side only on user entry. Nothing in DDL enforces it on either money table — a line can carry both `debit` and `credit`.

**Fix:** `CHECK (NOT (debit <> 0 AND credit <> 0))` plus `CHECK (amount = debit - credit)` as a generated/validated constraint where SQLite allows (use triggers for cross-column CHECK on UPDATE, since SQLite CHECK cannot reference other rows but can reference same-row columns — same-row is fine here).

### A-7 (MEDIUM) INTEGER columns accept fractional money

`INSERT INTO accounting_ledger(..., amount) VALUES (..., 1.5)` succeeded. SQLite type affinity does not coerce `1.5` to integer, so fractional rupiah can enter sums. The PRD requires whole-rupiah integers.

**Fix:** either `STRICT` tables or `CHECK (typeof(amount) = 'integer')` on every money column (`amount`, `debit`, `credit`, `retainage_amount`, `paid_amount`, and the money columns on `lpb_statements`, `cash_advance`, `cbs_plan`, `rbs_load`, `revenue_recognized`).

### A-8 (MEDIUM) Zero-amount ledger lines allowed

`INSERT ... amount = 0` succeeded. A zero-amount line is meaningless in a double-entry ledger and pollutes the untagged queue and reconciliation.

**Fix:** `CHECK (amount <> 0)` on `accounting_ledger` and `lpb_statements` (confirm no legitimate zero case exists in the legacy data first — the fixture should be re-checked before enforcing).

### A-9 (MEDIUM) `notification_inbox` has no dedupe key

Two identical rows inserted for the same user/alert/entity. Alert rules are evaluated on a 30-second polling cycle (TS-03), so the same condition re-inserts the same alert on every evaluation unless the service dedupes. Nothing in DDL supports the intended "one unread alert per condition".

**Fix:** partial unique index on `(user_id, alert_type, entity_type, entity_id) WHERE read_at IS NULL`.

---

## B. Expected gaps — planned tables (not defects, but confirm sequencing)

These are decided in the tech spec and simply do not exist yet. Listed so the gap is explicit rather than discovered at implementation time.

| Missing | Required by | Note |
|---|---|---|
| `sessions` | TS-02 | Session rows in SQLite; rotation + revocation on disable/reset/role change |
| `jobs` | TS-05 | Full DDL already drafted in spec §4.5; not yet in schema |
| `attachments` | TS-20 | 10 MB/file, 50 MB/project, per-project accounting |
| import staging | TS-04 / TS-24 | Stage → preview → confirm; 90-day retention |
| `user_invitations`, `password_resets` | TS-01 / TS-17 | Single-use, hashed, short-lived tokens |

## C. Decision-vs-schema mismatches (migrations required)

| Gap | Required by | Detail |
|---|---|---|
| `users.failed_login_count`, `users.locked_until` | TS-01 | No storage for the 5-failure / 15-minute lockout |
| `users.locale` | TS-08 | Language stored on user profile |
| `users.timezone` | TS-09 | Entry default GMT+7 per user |
| `audit_log.request_id`, `outcome`, `session_hash` | §3.9 | Spec promises request/session correlation and outcome; columns absent |
| `app_settings` key/value only | §3.1 | Argon2id parameter versioning promised "in app settings" — workable, but no typed columns for anything else |

## D. Process findings

- **D-1** `validate.py` reports `ALL CHECKS PASS` while every defect in section A is present. The suite has no negative/tamper tests. Recommended addition: a tamper pass that asserts each forbidden operation **fails** (update amount, update debit, delete ledger row, delete checked LPB line, update audit row, fractional amount, NULL sides).
- **D-2** Triggers exist for one table only. Inconsistent control placement is itself a risk indicator: the second and third money tables were assumed to be covered.
- **D-3** `amount` immutability is enforced but `debit`/`credit` are not, which means the stated invariant (`amount = debit − credit`) is not actually protected by the schema — only by service code that does not exist yet.
- **D-4** Spec §3.9 correctly acknowledges SQLite's lack of per-table ACL but then relies on "filesystem backup + restricted DB access" as the control. For an in-app actor with a DB connection, that is insufficient; triggers are the available in-DB control and are missing (see A-3).

---

## Recommended order of work

1. **Lock the money paths first** (A-1, A-2, A-3, A-4) — add tamper triggers + negative tests in `validate.py`. No application code should be written while the ledger, LPB detail, advance, and audit tables can be mutated freely.
2. **Tighten column constraints** (A-5, A-6, A-7, A-8) — cheap, high value, catches bad imports at the boundary.
3. **Alert dedupe** (A-9) — before alert rules are implemented.
4. **Migrations for decided tables/columns** (§B, §C) — bundle into `002_auth_and_jobs.sql` and `003_constraints.sql` rather than retrofitting later.
5. Re-run `validate.py` after each step; keep it green.

---

## E. Resolution status (2026-09-24, user approved option A)

All section-A defects are **fixed in `db/schema.sql`** and each fix has a **negative test in `db/validate.py`** that fails without it (TDD order was observed: tests written red, then controls added, then green).

**Schema changes (13 triggers → 14, +3 unique/partial indexes):**

| Finding | Fix committed |
|---|---|
| A-1 | `trg_ledger_immutable_financial_fields` — BEFORE UPDATE on every money/classification/dedupe column (`debit`, `credit`, `project_id`, `in_cost_basis`, `cost_checked*`, `line_role`, `source`, `import_batch_id`, `cash_advance_id`, `cost_category_id`, `chart_of_account_id`, `cashflow_category_id`, `transaction_account_id`, `wbs_node_id`, `partner_*`, `currency`, `retainage_amount`, `paid_amount`, `account_code`, `reference_no`, `transaction_id`) |
| A-2 | LPB insert + update triggers enforce whole-rupiah/one-side/derived-amount/nonzero; `checked` requires `checked_by` + `checked_at` on INSERT and UPDATE; checked lines are final (no amount/status/attribute edits, no deletes); project reassignment blocked once checked |
| A-3 | `trg_audit_log_no_update` + `trg_audit_log_no_delete` — audit rows append-only |
| A-4 | `trg_cash_advance_immutable_when_committed` freezes amount, project, totals, ledger link, currency once status ≠ 'open'; `trg_cash_advance_no_delete_when_used` blocks delete of non-open pots or pots with LPB detail |
| A-5 | LPB `debit`/`credit` now `NOT NULL DEFAULT 0`; trigger rejects NULL/negative sides |
| A-6 | Both ledger and LPB triggers reject `(debit <> 0 AND credit <> 0)` |
| A-7 | `typeof(...) = 'integer'` guards on ledger, LPB, cash advance money columns |
| A-8 | `amount = 0` rejected on ledger and LPB |
| A-9 | `idx_notif_unread_unique` — partial unique index on `(user_id, alert_type, COALESCE(project_id,0), COALESCE(entity_type,''), COALESCE(entity_id,0)) WHERE read_at IS NULL` |

**Test evidence:** `validate.py` now runs **61 + N tamper/negative assertions, 0 failures, exit 0**. New coverage: 14 immutable ledger fields blocked, 6 ledger money-integrity rejections, 7 LPB controls, 5 cash-advance controls, 2 audit append-only checks, 1 notification dedupe check. Draft-stage edits (LPB draft amount, open cash advance) verified still allowed — finality applies only after the state transition that makes a line effective.

**Not changed (intentionally):** section B planned tables and section C column additions remain for the schema evolution step (migration `002_auth_and_jobs`, `003_*`). They are additive and do not block the money-path hardening. Section-A fixes are in place and enforced by tests **now**.

**Counts after hardening:** 38 tables, 9 views, 14 triggers, 33 indexes, `foreign_key_check` clean, `integrity_check` ok, `ALL CHECKS PASS`.

## F. Payment-path resolution (2026-09-25, user workflow confirmed)

**Finding:** the ledger immutability fix froze `paid_amount`/`retainage_amount`, but no payment mechanism existed — invoices could never clear. Receivable/payable registers would show every invoice unpaid forever.

**User's workflow (confirmed):** Finance records the payment **in the ledger** — one line, same `document_no` as the invoice, `line_role='funding'` (cash movement). Cost control does not create a second entry; the payment line is `in_cost_basis=0`, so it contributes nothing to project cost. The invoice line carries the cost.

**Schema change:** `v_receivable` and `v_payable` rewritten to **net per `document_no`** — billed lines (receivable/payable role) minus funding lines (same doc). `paid_amount`/`retainage_amount` columns stay frozen; they are informational only, fed by the same-doc netting. No `payments` table needed.

**Proof (validate.py 72 PASS):**
| Case | Expected | Got |
|---|---|---|
| INV-0224: billed 400M, retainage 40M, paid 300M | outstanding 60M | 60M ✓ |
| PO-9001: billed 90M, paid 30M | outstanding 60M | 60M ✓ |
| payment line `in_cost_basis=0` | excluded from cost basis | ✓ |
| tamper probes (14) | all still blocked | ✓ |

**Doc sync:** `MIGRATION-MAP.md` §4.1 updated — migrated rows load `paid_amount = 0`; legacy payment lines migrate as their own rows; `paid_amount` is never back-filled.
