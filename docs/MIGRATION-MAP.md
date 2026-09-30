# PRACTIS — Legacy → New Migration Map

**Sourced from:** `practis.graphml` (yEd ERD) — re-shared 2026-09-23, archived at `/opt/data/practis/legacy/practis.graphml`
**Parsed artifact:** `/opt/data/practis/legacy/erd-parsed.json` (35 tables, 40 FKs, extracted programmatically)
**Target:** `db/schema.sql` (PRACTIS v1.3)
**Status:** v2.0 · 2026-09-23

## 0. Source of truth

The ERD is now in hand and verified: **35 tables, 40 foreign keys, four naming layers.**

| Layer | Prefix | Count | Role |
|---|---|---|---|
| Reference / master | `a_` | 13 | Calendars, categories, registers of clients/suppliers/employees/teams, WBS/RBS/CBS masters |
| Project | `b_` | 3 | Project register, acceptance (BAST), procurement |
| Cost control (live) | `c_` | 7 | **The ledger**, dropping (cash advance), LPB, receivable, payable, execution budget, cost adjustment |
| Working / staging | `x_`,`y_`,`z_` | 12 | PowerQuery/PowerPivot staging → **become views, not tables** |

Correction to an earlier note: a Visio file (`/opt/data/tmp/practis-legacy/practis.vsdx`, 18 tables)
was briefly mistaken for the authoritative ERD. It is an **older, smaller iteration** and is
superseded by this graphml. The graphml is the source for everything below.

## 1. Legacy inventory — all 35 tables

### a_ — reference layer (13)

| Table | Columns | Notes |
|---|---|---|
| `a_calendars` | date, period, year, month, day, day_of_week, week_of_month, week_of_year, quarter | Date dimension |
| `a_month_names` | month, month_no, name_long, name_short | Presentation lookup |
| `a_team_register` | team_code, name, description | Company/team master |
| `a_client_register` | id, industry_id, name, address, correspondence_person, email, phone, description | Client master |
| `a_industry_type` | id, name, description | Client industry lookup |
| `a_project_type` | id, name, description | Project type lookup |
| `a_employee_register` | id, team_code, name, position, email, phone, start_date, end_date, description | HR-lite source |
| `a_supplier_register` | id, type, name, address, correspondence_person, email, phone, description | Supplier master |
| `a_wbs_table` | wbs_code, name, description | WBS master (flat list) |
| `a_rbs_table` | rbs_code, name, description | RBS master |
| `a_transaction_accounts` | sub_rbs_code, wbs_code, rbs_code, name, hidden, description | **The CBS** — cost account |
| `a_chart_of_accounts` | account_code, name, category, subcategory, debit_credit, hidden, description | Accounting COA |
| `a_cashflow_categories` | account_code, name, category, inflow_outflow, hidden, description | Cashflow categories |

### b_ — project layer (3)

| Table | Columns |
|---|---|
| `b_project_register` | project_code, project_type_id, contract_no, name, client_id, amount, team_code, payment_terms, start_date, end_date, description |
| `b_project_acceptance_register` | acceptance_no, project_code, sequence, percentage_progress, document_date, submission_date, approved_date, description |
| `b_procurement_register` | document_no, type, project_code, sub_rbs_code, supplier_id, item, purchase_date, delivery_date, amount, payment_terms, description |

### c_ — cost control layer (7) — **the live data**

| Table | Columns |
|---|---|
| `c_accounting_ledger` | id, transaction_id, date, account_code, debit, credit, amount, project_code, description, cashflow_code, type, reference_no, sub_rbs_code, **date_adjustment** |
| `c_receivable_register` | invoice_no, acceptance_no, description, amount, reimburse_amount, vat, total_amount, invoice_date, submission_date, due_date, payment_date |
| `c_payable_register` | invoice_no, document_no, sequence, description, amount, reimburse_amount, vat, total_amount, invoice_date, submission_date, due_date, payment_date |
| `c_dropping_register` | memo_no, project_code, sequence, amount, submission_date, approved_date, description |
| `c_lpb_ledger` | id, project_code, lpb_no, date, description, sub_rbs_code, debit, credit, amount |
| `c_project_execution_budget` | id, project_code, sub_rbs_code, date, amount |
| `c_project_cost_adjustment` | id, project_code, sub_rbs_code, date, amount |

### x/y/z — staging layer (12) → **become views**

| Table | Columns | Verdict |
|---|---|---|
| `x_working_ledger` | id, transaction_id, date, account_code, account_name, amount, project_code, description, type, reference_no, sub_rbs_code, transaction_category, date_adjustment | View over ledger |
| `x_receivable_register` | 19 cols — joins project/client/acceptance/invoice + all BAST dates | View over ledger + acceptance |
| `y_lpb` | 14 cols (same shape as `c_lpb_ledger` + account_code) | View over LPB |
| `y_accounting_lpb_ledger` | 14 cols | View (ledger ∪ LPB) |
| `z_evm` | Project Code, Period, Revenue, Cummulative Revenue, Income, Cummulative Income, Expense, Cummulative Expense | **View over `v_evm_period`** |
| `z_income` | Project Code, Period, Ref No, Amount, Cummulative Amount | View |
| `z_expense` | Project Code, Period, Cost Code, Amount, Cummulative Amount | View |
| `z_revenue` | Project Code, Period, Amount, Cummulative Amount | View |
| `z_receivable` | project_code, reference_no, invoice_amount, invoice_date, payment_date | View |
| `z_payable` | project_code, reference_no, invoice_amount, invoice_date, payment_date | View |
| `z_dropping` | Project Code, Ref No, Description, Amount, Date | View over cash_advance |
| `z_lpb_ledger` | project_code, reference_no, description, amount, date_adjustment | View over LB |

**Confirmed:** the `x/y/z` layer is derived reporting, not source data. **It disappears as tables and reappears as SQL views** — exactly as PRD Q9 predicted. Nothing is lost because nothing there is origin data.

## 2. Key confirmations from the real ERD

| ERD evidence | Confirms PRD decision |
|---|---|
| `c_accounting_ledger.date_adjustment` | The Cost Controller's correction column → `effective_date` (R2-11). **The name the user gave was literal.** |
| `a_transaction_accounts.sub_rbs_code` | "sub-RBS code" is the CBS cost account — the user's exact term |
| `a_transaction_accounts` has `wbs_code` **and** `rbs_code` | Legacy CBS = WBS×RBS composite. New schema decouples them and tags both per transaction (R2-10) |
| `c_dropping_register` | "Dropping" = Cash Advance — a real register, one pot |
| `c_lpb_ledger` (own debit/credit/amount) | LPB is a ledger-shaped detail table → `lpb_statements` with draft→checked workflow |
| `c_receivable_register` / `c_payable_register` as tables | Become **views** in the new model (R2-4/5) |
| `c_project_execution_budget` | The legacy cost-baseline source → `cbs_plan` (`plan_type='baseline'`) |
| `c_project_cost_adjustment` | User's own name for the FORECAST (R2-24): starts as a duplicate of the execution plan, edited period-by-period against actuals to produce the forecast → `cbs_plan` (`plan_type='forecast'`) |
| `b_project_acceptance_register.percentage_progress` + `sequence` | BAST % drives POC/billing; `sequence` = certificate order |
| `a_client_register.industry_id` → `a_industry_type` | Industry is a lookup table, not free text → `industry_types` added to the new schema |
| `a_project_type` | Project type is a lookup → `project_types` added |
| `a_*` `hidden` flags | Soft-hide on reference data → carried over |
| No users/roles/audit tables | Auth + per-project roles are **100% new** (PRD gap #3) |

## 3. Table-by-table mapping

Legend: **1:1** direct · **SPLIT** one → two · **MERGE** many → one · **VIEW** computed only · **NEW** no legacy source

| Legacy | → New | Kind | Rule |
|---|---|---|---|
| `a_team_register` | `teams` | 1:1 | `team_code`→`code`; name/description direct |
| `a_client_register` | `clients` | 1:1 | `industry_id`→ FK `industry_types.id`; `payment_terms` lives on project in legacy → move to `clients.payment_terms_days` as the default |
| `a_industry_type` | `industry_types` | 1:1 | New table added to schema for this |
| `a_project_type` | `project_types` | 1:1 | New table added; `b_project_register.project_type_id` preserved |
| `a_employee_register` | `employees` | 1:1 | `team_code` → `teams.code`; `start_date`/`end_date` → contract window; rate lives in RBS in legacy → `default_rate` optional |
| `a_supplier_register` | `suppliers` | 1:1 | `type` → `supplier_type` |
| `a_wbs_table` | `wbs_code` + `wbs_nodes` | **SPLIT** | Legacy is a flat company list. `wbs_nodes` (per-project tree with dates/status) is new; generate one node per (project × code) on load, parent/dates NULL for completion |
| `a_rbs_table` | `rbs_code` | 1:1 | Direct |
| `a_transaction_accounts` | `transaction_accounts` | 1:1 | `sub_rbs_code`→`code`; legacy `wbs_code`/`rbs_code` kept as `default_*` **suggestions** — the live tag is per transaction (R2-10) |
| `a_chart_of_accounts` | `chart_of_accounts` | 1:1 | `debit_credit` → `normal_side`; `category`/`subcategory` kept; `account_type` **derived** — verify per row with Finance |
| `a_cashflow_categories` | `cashflow_categories` | 1:1 | `inflow_outflow` → `direction` |
| `a_calendars` | — | **VIEW** | Delete. Period = `substr(COALESCE(effective_date,date),1,7)`. Keep a view only if Excel exports need a date dimension |
| `a_month_names` | — | **VIEW** | Presentation only |
| `b_project_register` | `projects` | 1:1 | `project_code`→`code`; `contract_no`→`contract_no`; `amount`→`contract_amount`; `project_type_id` FK preserved; `team_code`→`teams.code`. Add `revenue_method`, `status`, baseline lock, 3 close stamps |
| `b_project_acceptance_register` | `acceptance_register` | 1:1 | `acceptance_no`→`certificate_no`; `sequence`→`sequence`; `document_date`→`document_date`; `submission_date`→`handover_date`; `approved_date`→`accepted_date`; `%` direct. **Drives POC revenue — load before revenue back-fill** |
| `b_procurement_register` | `procurement_register` | 1:1 | `document_no`→`document_no`; `type`→`procurement_type`; `item`→`item`; `sub_rbs_code`→`transaction_account_id`; `purchase_date`/`delivery_date` direct |
| `c_accounting_ledger` | `accounting_ledger` | 1:1 | **The core move — §4** |
| `c_receivable_register` | — | **VIEW** | → `v_receivable` over the ledger. Legacy rows must reconcile into the ledger first (§4.4) |
| `c_payable_register` | — | **VIEW** | → `v_payable` |
| `c_dropping_register` | `cash_advance` | 1:1 | `memo_no`→`advance_no`; `sequence`→`sequence`; `submission_date`/`approved_date` direct; `issued_date` = `approved_date` |
| `c_lpb_ledger` | `lpb_statements` | 1:1 | `lpb_no`, `date`→`entry_date`, `amount`, `sub_rbs_code`→`transaction_account_id`. **All historical rows load as `status='checked'`** (already costed) |
| `c_project_execution_budget` | `cbs_plan` (`plan_type='baseline'`) | **MERGE** | `date` → `period_month`; `amount` per (project, sub_rbs_code, month) |
| `c_project_cost_adjustment` | `cbs_plan` (`plan_type='forecast'`) | **MERGE** | Same shape; distinguished by `plan_type`. User's own name for the forecast (R2-24) |
| `x_working_ledger` | — | **VIEW** | Rebuild from the ledger |
| `x_receivable_register` | — | **VIEW** | The wider BAST-aware receivable → rebuild from ledger + acceptance_register |
| `y_lpb`, `y_accounting_lpb_ledger` | — | **VIEW** | Rebuild |
| `z_*` (8 tables) | — | **VIEW** | Rebuild: `z_evm` ← `v_evm_period`; `z_income`/`z_expense`/`z_revenue` ← ledger grouped; `z_receivable`/`z_payable` ← `v_receivable`/`v_payable`; `z_dropping` ← `cash_advance`; `z_lpb_ledger` ← `lpb_statements` |
| — | `users`, `roles`, `user_roles` | **NEW** | Seed 9 roles, create accounts |
| — | `cbs_plan` (forecast/bcr types) | **NEW** | Forecast + change control |
| — | `wbs_nodes`, `progress_milestones`, `wbs_progress` | **NEW** | Tree growth, ticks, period-dated progress |
| — | `bcr_register`, `change_log` | **NEW** | |
| — | `approvals`, `audit_log`, `notification_inbox` | **NEW** | |
| — | `frozen_periods`, `project_reports` | **NEW** | |
| — | `import_profiles`, `import_batches` | **NEW** | |
| — | `revenue_recognized` | **NEW** (derivable) | Back-fill from BAST × contract value |

## 4. The core move: `c_accounting_ledger`

### 4.1 Column map (real columns)

| Legacy column | New column | Rule |
|---|---|---|
| `id` | `id` | Preserve |
| `transaction_id` | `transaction_id` | Keep verbatim (reporting reference) |
| `date` | `date` | Verbatim — immutable posted date |
| `date_adjustment` | `effective_date` | **Direct 1:1.** NULL stays NULL. Period = `COALESCE(effective_date, date)` |
| `sub_rbs_code` | `transaction_account_id` | CBS tag → `transaction_accounts.code` |
| `cashflow_code` | `cashflow_category_id` | → `cashflow_categories.code` |
| `account_code` | `account_code` **raw** + `chart_of_account_id` | **Resolved:** user confirmed it is chart of accounts. Preserve raw text and resolve to `chart_of_accounts`; validate every distinct code during dry-run. |
| `project_code` | `project_id` | → `projects.code` |
| `reference_no` | `reference_no` | Verbatim |
| `description` | `description` | Verbatim |
| `type` | `type` + `line_role` + `in_cost_basis` | Preserve raw optional filter values `Income|Expense|Receivable|Payable|LPB|Dropping`; app assigns controlled role/cost basis. NULL is valid. |
| `debit`, `credit`, `amount` | `amount` (single signed) | **⚠ §4.2 — the riskiest step** |
| — | `document_no` | **Derive** — see 4.4 |
| — | `partner_type`, `partner_id` | **Derive** from the linked receivable/payable row |
| — | `wbs_node_id` | **Legacy has none.** Load NULL; Cost Controller assigns it later (R2-23). |
| — | `retainage_amount` | From the linked register row (invoice line only) |
| — | `paid_amount` | **0 for all migrated rows.** Payment is a separate ledger line sharing `document_no` (user workflow 2026-09-25); registers net per document. Legacy payment lines migrate as their own rows. `paid_amount` column stays frozen — do not back-fill it. |
| — | `cost_checked` | **1** for all migrated rows |
| — | `currency` | `'IDR'` |
| — | `source` | `'import'` |

### 4.2 Debit/credit/amount reconciliation — resolved; trial-balance gate still required

Legacy carries **three** money columns on one row where the new schema stores **one signed amount**.
**Resolved:** real export + user confirmation prove `amount = debit - credit`; each user-entered line fills exactly one of debit/credit. This is the single biggest migration risk, so retain the gate:

1. Import/export representative rows across every `type`; at least 200 rows, including every full transaction group.
2. Assert `amount = debit - credit` on every row.
3. Build a **trial balance** per project, transaction group, and period; reject/quarantine any group that does not net to zero.
4. Only then apply the verified rule (income/credit negative, cost/debit positive — R2-7).

**If step 3 does not balance, stop and ask Finance.** Do not silently "fix" the data.

### 4.3 `account_code` — resolved as chart of accounts

The ERD contains a misleading/duplicate relationship edge: `c_accounting_ledger.account_code` also
appears linked to `a_transaction_accounts`. The user confirmed **the ledger `account_code` is chart of
accounts**, not CBS. CBS is `sub_rbs_code` → `transaction_accounts`. Migration preserves raw
`account_code` and resolves it to `chart_of_accounts`; unknown COA codes quarantine for Finance review.

### 4.4 Registers → views: the reconciliation gate

The registers become views, so their content must exist in the ledger. Legacy quirks to handle:

| Case | Action |
|---|---|
| Register row + matching ledger row | Load ledger; take retainage/paid from the register |
| Register row, **no** ledger row | Create a ledger line from the register row, `source='import'`, flag for Finance |
| Ledger row, no register row | Load ledger; no action |
| Both, disagreeing amounts | **Flag — never auto-resolve** |
| `c_payable_register.document_no` → `b_procurement_register.document_no` | Preserve the link; it is how a payable ties to a PO |
| `c_receivable_register.invoice_no` / `acceptance_no` | Preserve; `acceptance_no` ties the invoice to its BAST certificate |
| `reimburse_amount` + `vat` + `amount` vs `total_amount` | **Verify the arithmetic per row** (`amount + vat ± reimburse = total_amount`?) — if it does not hold, keep the raw columns too |

Deliverable: a per-project diff report (legacy register vs rebuilt view) with exceptions listed.

### 4.5 Cost-category semantic flags

`v_receivable` / `v_payable` / `v_aging` depend on `cost_categories.is_receivable` / `is_payable` /
`is_retainage`. Legacy has no such flags. Map the legacy `cashflow_code`/`type` values that mean
receivable / payable / retainage, set the flags, then **re-derive the legacy registers from the
ledger and diff them.** Matching = the flags are right. That diff is the acceptance test for the
entire migration.

## 5. Migration run order (FK-safe)

1. `app_settings`, `teams`, `roles`
2. `users`, `user_roles`
3. `industry_types`, `project_types`, `clients`, `suppliers`, `employees`
4. `cost_categories`, `cashflow_categories`, `chart_of_accounts`, `resource_categories`
5. `wbs_code`, `rbs_code`, `transaction_accounts`
6. `projects`
7. `wbs_nodes`, `progress_milestones`
8. `cbs_plan` ← `c_project_execution_budget` (baseline) + `c_project_cost_adjustment` (forecast, R2-24)
9. **`accounting_ledger`** ← `c_accounting_ledger` (only after §4.2 passes)
10. `acceptance_register` ← `b_project_acceptance_register`
11. `procurement_register` ← `b_procurement_register`
12. `cash_advance` ← `c_dropping_register`
13. `lpb_statements` ← `c_lpb_ledger`
14. `revenue_recognized` — back-fill from BAST × contract value
15. Create views: `v_*` then the `x/y/z` replacements
16. **Verify:** rebuild every legacy register/`z_*` report and diff against the originals

## 6. The baseline problem — RESOLVED (R2-21)

**User confirmed (2026-09-23):** the only baseline in legacy is the **cost baseline**
(`c_project_execution_budget`). WBS/RBS/CBS structuring is the user's **new** approach — legacy has
no EVM plan curve, no progress history, no SPI/CPI basis. Nothing to reconstruct faithfully.

**Decision:** old projects are **reference-only** — historical cost data imports (`accounting_ledger`,
`c_project_execution_budget`) so money totals and spend history stay reachable; **EVM starts fresh**
on the first real baseline built in PRACTIS. No fabricated plan curves, no fake SPI/CPI.

**Consequence:** current-period SPI/CPI exist only for projects baselined in PRACTIS (new projects,
and old projects the PM chooses to baseline going forward). Old history contributes cost totals,
not EVM indices.

## 7. Open questions

1. ~~**Ledger sample / sign rule**~~ — **RESOLVED:** real export received (26 rows); `amount = debit − credit`; complete sampled transaction groups balance. The deliberately partial `SAL-24-10-0038` extract is quarantined rather than “fixed.” Stored in `db/fixture-ledger-export.tsv` as a regression fixture.
2. ~~**Contract_value units**~~ — **RESOLVED:** whole rupiah; `1000000` = Rp 1,000,000. Dry-run must still compare one known project total.
3. ~~**§4.3 `account_code`**~~ — **RESOLVED:** user confirmed chart of accounts; CBS remains `sub_rbs_code`.
4. ~~**Legacy `type` values**~~ — **RESOLVED (R2-22):** `Income|Expense|Receivable|Payable|LPB|Dropping`, optional filter-only.
5. ~~**Historical WBS tagging**~~ — **RESOLVED (R2-23):** (b) leave NULL for the Cost Controller.
6. ~~**Baseline back-fill**~~ — **RESOLVED (R2-21):** old projects reference-only; EVM starts fresh. No reconstruction.
7. ~~**`c_project_cost_adjustment` semantics**~~ — **RESOLVED (R2-24):** it IS the forecast → `plan_type='forecast'`.
8. ~~**Closed projects**~~ — **RESOLVED (R2-25):** migrate everything; `status='closed'`; hidden from dashboards by default.
9. ~~**Counterparty**~~ — **RESOLVED (R2-26):** description-embedded vendor extraction (26/26 rows carry pattern) + review queue; partner list seeded from the user.

## 8. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Debit/credit sign misread | Every financial figure inverted | §4.2 trial-balance gate before load |
| COA reference mismatch | Wrong chart-of-accounts mapping | §4.3 raw-code preservation + unknown-code quarantine |
| Register↔ledger gaps | Aging/receivables disagree with old Excel | §4.4 diff report; flag, never auto-fix |
| Historical cost data mistaken for an EVM baseline | False EVM confidence | Legacy projects marked reference-only; EVM starts after PRACTIS baseline |
| `contract_value` unit/scale error | Contract totals and every ratio wrong | Whole-rupiah rule confirmed; dry-run must compare one known project total exactly |
| `reimburse_amount`/`vat`/`total_amount` mismatch | Revenue/payable totals wrong | Per-row arithmetic check (§4.4) |
