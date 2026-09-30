# PRACTIS — Project & Cost Control System
**Product Requirements Document v1.3**
Status: v1.3 · Draft-for-review · Created: 2026-09-18 · Updated: 2026-09-23 · Project folder: `/opt/data/practis/`
Previous docs: `PRACTIS_software_design.md` (user sketch, 2026-09-17), `practis.graphml` (ERD)

**Changelog:**
- **v1.1** (self-review pass, 2026-09-18): extracted ascenders (progress % vs acceptance %; billed/recognized/received timeline; POC reads BAST %); named Project Portfolio Report pack; clarified CPI+var% both reported (scope note); alert delivery detail.
- **v1.2** (flow/design review pass, 2026-09-22): hybrid period freeze (no fixed close date; period locks on report generation); PM approves baseline (Admin = system owner only); billed/received/retainage three-way + partial payments + aging report; report renamed Project Update Report (scheduled monthly); monthly schedule + freeze semantics; baseline comparison view.

---

## 1. Objective

**One-line:** PRACTIS integrates project control (schedule/progress) and cost control (cost/income/cashflow) for a project-based company, replacing the current Excel + PowerQuery/PowerPivot manual process with a multi-user web application.

**Company context:** One person currently enters all data manually. PRACTIS turns this into a multi-user web app, built inhouse to avoid perpetual vendor fees, industry-agnostic (PMBOK / IFRS 15 / PSAK 72 principles), portfolio-grade (any project size, any industry).

**Success criteria:**
1. Any role enters data through the app — work and money always current, no single-person bottleneck.
2. SPI and CPI computed automatically each period from progress + costs — no manual EVM math.
3. Portfolio dashboard answers "which projects are healthy" in one screen.
4. Historical data survives the migration (MariaDB + Excel) into the new model; x/y/z views die.
5. Inhouse, no SaaS fees, deployable on the company's own server (Docker).

---

## 2. Users & Roles

> **Glossary (R2-20).** UI language is universal English; legacy terms remain in internal storage and data imports for traceability:
>
> | UI term | Legacy/internal term | Meaning |
> |---|---|---|
> | **Cash Advance** | Dropping / `c_dropping_register` | money handed to a person for project expenses (one pot per project, v1) |
> | **Expense Report** | LPB / `lpb_statements` / Laporan Pengeluaran Bulanan | line-by-line report of how a cash advance was spent; Project Admin enters, Cost Controller checks |
> | **Settlement** | — | Finance booking the advance as spent (bulk, in the ledger) |
> | **Progress certificate** | BAST / berita acara serah terima | milestone handover certificate driving revenue recognition |

### 2.1 Responsibilities (workflow layer)

Any role can hold any responsibility, per workflow. This is RACI-style: role defines *access*, responsibility defines *step permission*.

| Responsibility | Meaning |
|---|---|
| **Initiator** | creates a record / starts a workflow |
| **Contributor** | adds data to an existing record |
| **Verifier** | checks correctness before approval |
| **Approver** | gives final sign-off |
| **Informed** | receives the record/report, read-only |

### 2.2 Roles

| Role | Domain | Default duties |
|---|---|---|
| **Administrator** | System | master data, teams, users, approvals of record registers |
| **Project Manager** | Project | owns registers (client, project), approves BCRs, overall project view |
| **Project Controller** | WBS + RBS | schedule, resources, progress, SPI |
| **Cost Controller** | CBS | cost baseline, cost updates, cost forecast, CPI — tags ledger transactions with CBS categories |
| **Procurement** | Supply | supplier register, procurement status |
| **Human Capital** | People | employee assignments, contract/rate data (HR-lite) |
| **Finance** | Money truth | actuals, receivable/payable, revenue recognition, verifies cost/register data; immutable ledger |
| **Project Admin** | Data entry | posts progress updates (wbs_actual), compiles updates — no analysis rights |
| **Viewer** | Read-only | dashboards, reports (executives, clients) |

### 2.3 Access model

- **Per-project assignments** (junction table): users are assigned a role *per project*. PM sees own projects; Finance sees all cost data; Viewer sees assigned dashboards.
- **Global reference data** (chart of accounts, WBS/RBS menu): Admin-managed, company-wide.
- Relationship: role = access scope, responsibility = step permission in workflow.

---

## 3. Domain Model

### 3.1 Key objects & relation to existing ERD

> **Source: `practis.graphml` (re-shared 2026-09-23, archived at `/opt/data/practis/legacy/`).**
> Parsed and verified: **35 tables, 40 FKs, 4 layers** (`a_` reference, `b_` project, `c_` cost
> control, `x/y/z` staging). The `x/y/z` layer is PowerQuery/PowerPivot staging → **becomes views,
> not tables** (Q9 confirmed). Full column-level mapping: `MIGRATION-MAP.md` §3.

| Object | Source ERD table(s) | Notes |
|---|---|---|
| Team | `a_team_register` | + roles per team |
| Client | `a_client_register` → `a_industry_type` | industry is a lookup table (`industry_types`), not free text |
| Project type | `a_project_type` | lookup table (`project_types`) |
| Supplier | `a_supplier_register` | `type` → `supplier_type` |
| Employee | `a_employee_register` | HR-lite slice |
| Project | `b_project_register` | + revenue method, BCRs, close state |
| WBS (work) | `a_wbs_table` | company-standard flat list; per-project tree is new (`wbs_nodes`) |
| RBS (resource) | `a_rbs_table` | company-standard list; loaded per project |
| Cost account (sub-RBS) | `a_transaction_accounts` | `sub_rbs_code`; carries legacy `wbs_code`+`rbs_code` as *suggestions* only |
| CBS (money) | `c_project_execution_budget` (+ `c_project_cost_adjustment`) → `cbs_plan` | **only money book**, monthly-bucketed, versioned by `plan_type` |
| Actuals | `c_accounting_ledger`, `c_payable_register`, `c_receivable_register` | all kept (Q8a); registers become **views** |
| Cash advance | `c_dropping_register` + `c_lpb_ledger` | one big pot (Q17a) |
| Procurement | `b_procurement_register` | per line status |
| Acceptance (BAST) | `b_project_acceptance_register` | milestone % certificate (+ `sequence`) |
| Forecast | (new) `cbs_plan.plan_type='forecast'` | auto EAC + manual override |
| Revenue recognition | (new) | per project method, billed vs recognized |
| BCR | (new) `bcr_register` | change control |
| Users/roles/assignments | (new) | auth + per-project assignment |
| Activity log / audit | (new) | immutable history (Finance/Audit) |

**ERD gaps the app must therefore ADD** (unchanged from the original analysis, now reconfirmed):
users + roles + per-project assignment; the EVM engine (legacy `z_evm` was output-only);
a distinct forecast store; BCR log; a recognized-revenue ledger; and progress-over-time
(legacy stores `percentage_progress` as a single untimed value).

### 3.2 Money model (critical decisions)

- **CBS = the only money book.** Budget/actual/forecast amounts live only on the CBS (cost account) level. WBS carries scope/schedule/progress (%); RBS carries resource loading info. WBS/RBS *dimensions* read from cost accounts; never hold their own money copy.
- **RBS → CBS derivation at total level, monthly buckets on CBS.** Planned cost per account = Σ (rate × hours/units) from resource plan. Monthly distribution = direct entry OR auto-spread (straight-line over WBS duration, or milestone-weighted). Invariant: Σ monthly buckets = account total = RBS total. App enforces.
- **The ledger is the single book of truth (v1.3).** All transactions — income and cost, including invoices and payments — live in one `accounting_ledger`. Receivable/payable registers and aging reports are **computed views** over ledger lines (filtered by type), never separately keyed data. Fixed-template Excel import carries the ledger wholesale.
- **Two date columns, one period rule (v1.3).** `date` = Finance's posted date (immutable audit anchor). `effective_date` = Cost Controller's corrected date (blank unless adjusted — this replaces the ERD's "new date"). **Period = COALESCE(effective_date, date)**, derived automatically; no manual period field. Finance posts for the wrong month → Cost Controller corrects the effective date; original stays visible.
- **Debit/credit signs (v1.3).** Income = credit = **negative**; expense = debit = **positive** (standard double-entry; matches the current Excel + the user's existing dashboard system). Ledger views show raw signs (accountant expects them). Project dashboards (CBS, cashflow, S-curves) render **natural signs**: income +, cost +, net = income − cost. View-layer rule only — stored values never change.
- **Dual tagging: WBS + CBS per transaction (v1.3).** Every cost line carries **two** tags, both chosen by the **Cost Controller** in one screen: `CBS` (what kind of money — the split kept from the ERD) and `WBS` (which work line — new, required for per-line EVM). No mapping-percentage guessing. The Project Controller owns the WBS list itself (work lines + progress) and never tags money; the Cost Controller never edits the WBS list.
- **Single currency (IDR) for v1 (v1.3).** No conversion logic. A `currency` column is reserved in the schema so multi-currency can be added later without migration.
- **Transactional storage, monthly views**: every ledger line stored (audit, drill-down); UI renders monthly cashflow table (the existing PowerPivot style).
- **Reporting anchor: calendar months.**
- **Billed vs recognized revenue tracked separately**; recognition method per project (milestone / POC / time-based / on-billing).

---

## 4. Product Workflow

Responsibilities apply per step (RACI-style). Workflows follow the project lifecycle: **Initialisation → Planning → Execution → Monitoring & Control → Closing** (PMBOK process groups).

### 4.1 Initialisation

**One-time set-up (Admin, auto-approved):**
1. Admin initiates `a_project_type`, `a_industry_type`.
2. Admin initiates `a_chart_of_accounts`, `a_cashflow_categories`.
3. Admin initiates `a_cost_categories`, `a_resource_categories`.
4. These reference datasets are automatically approved.

**Team register:**
1. Admin initiates `a_team_register`.
2. Admin sets up roles per team.
3. Team receives email invitation, creates account.

**Client register:**
1. PM initiates `a_client_register` (incl. `a_industry_type`).
2. Finance **verifies**.
3. Admin **approves**.

**Project register:**
1. PM / Project Controller / Project Admin initiate `b_project_register`.
2. Finance **verifies**.
3. PM **verifies**.
4. Admin **approves**.
5. PM picks **revenue recognition method** per project.
6. Project created with no numbers — portfolio card "not baselined".

**Supplier register:**
1. Procurement initiates `a_supplier_register`.
2. Finance **verifies**.
3. Admin **approves**. *(sketch typo fixed: approve supplier register, not project)*

### 4.2 Planning

**Project plan (the baselines):**
1. PM or Project Controller initiate `c_wbs_baseline`, `c_rbs_baseline`; Cost Controller initiates `c_cbs_baseline` (the money book).
2. Procurement verifies RBS (resource availability); Human Capital verifies RBS (labor availability/rates).
3. Finance **verifies** `c_cbs_baseline`.
4. PM **approves** all three as **Project Baseline Plan** — baseline frozen. (Large projects: PM + project sponsor. Admin does NOT approve baselines — Admin owns system/master data, not plan decisions.)

**After approval, baseline changes ONLY via BCR** (see 4.4).

### 4.3 Execution (monthly heartbeat)

| Step | Role | Action |
|---|---|---|
| Ledger entry | Finance | contribute `accounting_ledger` lines (date, document no, partner, type income/cost, amount, debit/credit sign) — typed in-app *or* fixed-template Excel import |
| Cost tagging | Cost Controller | tag each ledger line with **CBS** (kind of money) + **WBS** (work line); correct the **effective_date** where Finance posted the wrong month; block-tag for volume |
| Progress update | Project Admin or Project Controller | contribute WBS progress (milestone ticks → % complete) |
| Cash Advance / Expense Report | Project Admin or PM | enter the month's cash-advance usage lines in the **Expense Report screen**; Cost Controller **checks** (assigns/confirms CBS + WBS codes) = final, no Finance approval |
| Revenue recognition | Finance | recognize per project method; billed ≠ recognized |
| HR update | Human Capital | update employment contract status (assignment/rate/contract window) |
| Procurement update | Procurement | update procurement status |

**Import rule (v1.3):** import **never overwrites tagged lines** — it only adds new ones (flags duplicates by document no). Protects Cost Controller tags from re-imported Excel.
**Expense Report UI (v1.3):** Project Admin enters cash-advance usage lines (date, amount, description, codes optional); lines stay **draft** until Cost Controller checks → then they roll into cost actuals automatically. Finance's ledger keeps the bulk settlement; detail lives in the Expense Report. UI uses **Cash Advance** and **Expense Report**; legacy/internal names remain traceable.

### 4.4 Monitoring & Control

**Forecast & report:**
1. Project Controller updates `c_wbs_forecast`; Cost Controller updates `c_cbs_forecast` (auto EAC from CPI + manual override).
2. Project Controller compiles the **Project Update Report** for designated stakeholders: **SPI, CPI, Receivable vs Revenue, Payable status** — generated on a monthly schedule (per the month-end calendar below), reviewed by Controller, approved by PM, then frozen for the period.
3. Report includes a **prior-baseline vs current** comparison view (what changed this period, BCRs applied).

**Month-end calendar (hybrid freeze):**
1. **No fixed calendar close date** — team enters data whenever, tagging each entry to its period.
2. When a period's Project Update Report is **generated, that period freezes**: entries tagged to a frozen period are rejected by the system and must be tagged to the next period (or logged as a flagged revision).
3. This preserves EVM history: old reports stay truthful; variances can never be silently erased.

**BCR — Baseline Change Request (change control):** any change to a frozen baseline requires a BCR:
1. Project/Cost Controller **initiates** BCR (what, why, $/period impact, schedule impact).
2. Finance **verifies** (money/period logic).
3. PM **approves** (accepts scope/schedule consequence). Small projects: PM-only, Finance skipped.
4. On approval → baseline **re-baselines** (old numbers archived, new become PV). Full audit: who asked, who approved, what changed.
5. In-app alert if BCR pending > 3 days.

**Change classification (v1.3) — the test is the contract, not a size threshold:**
| Action | Test | Path |
|---|---|---|
| Add / split / rename a WBS line, **same total contract value** | Internal replanning | Project Controller adds directly; app writes a change-log entry (who/when/why). No BCR. |
| Add work **not in the contract** (client-requested scope) | External change | **Full BCR** (steps 1–5). |
| **De-scope**: remove a WBS line | External change (if contract value drops) | **Full BCR** + the rules below. |

**De-scope rule (v1.3) — prospective, never retroactive:**
- WBS lines are **never deleted**. Status: `active` / `completed` / `de-scoped`; de-scoped line stays in the list and in history forever.
- **Progress freezes** at its last value; **remaining budget drops out of the PV curve from the BCR month forward** — past months stay exactly as reported (EIA-748 G-30: cumulative values are never retroactively adjusted).
- **Spent cost stays tagged** to the de-scoped line (visible: "what did we spend on the cancelled part").
- **Revenue follows IFRS15 contract modification**: not yet billed → reduce contract value; already billed → credit note (immediate revenue hit only if the reduction is in substance a concession on already-delivered work).
- No management reserve in v1 (Q1b) — every contract-value-changing addition goes through a full BCR.

**Alerts (in-app only, v1):**

| Alert | Trigger |
|---|---|
| CPI/SPI breach | < 0.95 (threshold tunable) |
| Cost overrun ahead | EAC > BAC |
| Progress not updated | no progress entry 14 days |
| Overdue invoice | unpaid past due_date |
| Unapproved BCR waiting | > 3 days pending |
| Cash advance old | outstanding > 60 days |

### 4.5 Closing (3-step)

| Step | Who | Criteria | Portfolio status |
|---|---|---|---|
| **Operationally closed** | PM | work 100%, client acceptance recorded, no more updates | excluded from live schedule |
| **Financially closed** | Finance | receivables zero, invoices settled | excluded from live cashflow/forecast; shown in "settled" filter |
| **Contractually closed** | Finance/PM | retention released, warranties expired, final EAC-vs-BAC score archived | fully archived, still reportable |

Closed projects remain in portfolio history totals forever — feeds future bid estimates (lessons-learned / estimating memory).

---

## 5. Functional Requirements

### 5.1 Project Controls
- WBS tree per project from company-standard menu; 50–200 lines typical v1, scalable to any size.
- Each WBS line: start/end dates, milestone ticks (default: mobilize → install → test → handover). % complete derives from ticks (Q21b). No task-dependency/CPM engine v1 (Q14a).
- **WBS line status**: `active` / `completed` / `de-scoped` — lines are never deleted (see 4.4 de-scope rule). Renames/restructures version the line rather than overwriting.
- Progress reports per calendar period, dated; progress-over-time charts.
- EVM engine: PV from baseline, EV from ticks×CBS, AC from ledger actuals. SPI = EV/PV, CPI = EV/AC. Per-line + roll-up, auto. Per-line EVM relies on the WBS tag on each cost line (v1.3 dual tagging).
- Forecast: baseline + EAC (formula BAC/CPI) + manual override per line; both visible side-by-side, no forced reconciliation.
- **Progress % ≠ client acceptance %.** WBS milestone ticks drive *internal* EVM % (the report card). BAST acceptance certificates drive *external* billing/revenue (the invoice). POC revenue uses BAST%; EVM uses tick%. Both stored; never conflated.

### 5.2 Cost Control
- CBS monthly-bucketed baseline; RBS resource loading at total level.
- **General ledger UI** (PocketStash-style): Finance enters/imports transactions — fixed-template Excel import for bulk, in-app entry for exceptions. The app **is** the book of record; Excel is a bridge. Export back to Excel anytime for the accountant.
- **Two tags per cost line: CBS + WBS**, both set by the Cost Controller on one screen (dropdowns from the company-standard lists; recent choices surfaced; block-tag for volume).
- **Two dates per line**: `date` (Finance posted, immutable) + `effective_date` (Cost Controller's correction, blank by default). Period = COALESCE(effective_date, date). Date-adjusted rows flagged in the ledger view.
- **Signs**: ledger shows raw debit/credit (income credit = negative, cost debit = positive); dashboards render natural signs (income +, cost +, net = income − cost).
- **Single currency (IDR) v1**; `currency` column reserved for later multi-currency.
- Cash advance: one big pot per project; **dedicated LPB entry screen** — Project Admin/PM enter usage lines, Cost Controller checks codes (final); checked lines roll into cost actuals automatically. Finance's ledger keeps the bulk entry.
- **Receivable/payable are computed views over the ledger** (filtered by type + document no) — not separately keyed. **Billed / received / retainage tracked separately per invoice**: amount, paid_amount, retainage_amount; partial payments supported; retainage held separately (never buried in regular AR).
- **Aging report view** (30/60/90/120+ day buckets), sortable by amount — Finance's collection priority list. Due date = ledger date + payment terms (from project register).
- **Payment→invoice matching by document no**: payment lines carry the same document no as the invoice; app matches, marks paid (partial/full, retainage held). Unmatched payments → "to match" queue for Finance.
- **Income ≠ revenue.** Billed (receivable) vs recognized (per project method) vs received (payment) — three separate timelines (IFRS15/PSAK72).

### 5.3 Revenue Recognition
- Per-project method: milestone, POC (derives from same % ticks), time-based, on-billing.
- Billed vs recognized tracked separately (IFRS15 gap visible).
- POC method reads **BAST acceptance %** (external certificates), not internal tick % — see 5.1. Time-based straight-lines over contract window. On-billing recognizes exactly what's invoiced. Milestone recognizes on approved certificate.

### 5.4 Reporting / Dashboards
- **Portfolio dashboard** (exec/Viewer): all projects, CPI/SPI traffic-light cards, current-month cashflow, portfolio-wide forecast.
- **EVM S-curves** (project dashboard): PV from baseline (CBS monthly buckets), EV from ticks×CBS (internal, not BAST), AC from ledger actuals. Calendar-rendered.
- **Project dashboard** (PM/Controller): S-curves, EVM trend, cashflow actual vs forecast, WBS drill-down.
- **Project Update Report** — scheduled monthly: SPI, CPI, receivable vs revenue, payable status, exceptions, prior-baseline vs current comparison.
- **Aging report** (receivables): 30/60/90/120+ buckets.
- **Exports**: PDF + Excel report pack, light theme (dark app / light print — Q20c).
- **Migration view**: historical data intact post-migration.

### 5.5 Administration
- Users, teams, roles, per-project assignments.
- Master data: chart of accounts, cashflow categories, cost/resource categories, WBS/RBS menu (currency: IDR fixed v1).
- Register approvals (client / project / supplier — Admin approves the *record*), BCR management. Note: **baseline approval is PM's** (see 4.2), not Admin's.

---

## 6. Non-Functional Requirements

| Area | Requirement |
|---|---|
| **Stack** | Express 5 + SQLite (WAL) + EJS + Alpine CSP build, TDD, Docker on VPS. One process, single tenant v1. Full architecture: `TECH-SPEC.md` |
| **UI** | Desktop-first responsive; dark app theme, light print theme; **English + Indonesian** from day one; server-rendered pages with narrow JSON endpoints |
| **Auth & security** | Administrator-created username/email + password; Argon2id; server-side SQLite sessions; CSRF; per-project roles/SoD; output escaping, CSP without `unsafe-eval`; audit security events |
| **Notifications** | In-app only; browser polls every 30 seconds; thresholds tunable per project. Webhooks reserved for v2 server-to-server delivery (Telegram/n8n) |
| **Audit** | All Finance/actuals entries immutable + audit-logged (accounting rule: no silent history rewrite); BCR full history |
| **Currency** | Single currency (IDR) v1; `currency` column reserved on all money tables for later multi-currency without migration |
| **Time anchor** | Business dates stored as `YYYY-MM-DD`; audit timestamps UTC; Jakarta GMT+7 entry/display default; period derived from `COALESCE(effective_date, date)` — no manual period field |
| **Reliability** | SQLite WAL + `synchronous=FULL`, FK enforcement; versioned migrations; staged imports; backup/restore and recovery drill requirements; readiness health checks |
| **Backup & retention** | Hourly consistent full snapshots, gzip compression, 24h/7d/4w/12m retention, encrypted offsite copy, storage monitoring; no automatic deletion until explicit user approval |
| **Sign convention** | Stored: income = credit = negative, cost = debit = positive. Dashboards render natural signs (view layer only) |
| **Data integrity invariants** | Σ monthly CBS buckets = account total = RBS total (enforced); baseline frozen post-approval; billed≠recognized; progress ticks ≤ 100% per line |

---

## 7. Data Model (new system, ~tables)

- Reference: `teams`, `users`, `user_roles` (per-project), `clients` (payment terms), `suppliers`, `employees`, `chart_of_accounts`, `cashflow_categories`, `cost_categories`, `resource_categories`, `wbs_code`, `rbs_code`, `transaction_accounts` (CBS/split code — kept from the ERD)
- Project: `projects` (register + revenue method + payment terms + close state), `procurement_register`, `acceptance_register` (BAST %, 3 dates)
- Plan: `cbs_plan` (`plan_type ∈ {baseline, forecast, bcr, cost_adjustment}`; actual cost is computed from the ledger and checked Expense Reports, never a stored plan row), project, cost account, period month, amount — **single versioned plan table**; `rbs_load` (resource plan, rates × units); `progress_milestones` (WBS line tick states); `wbs_nodes` (line, parent, status active/completed/de-scoped, version)
- **Ledger (single book of truth):** `accounting_ledger` — `date` (Finance posted, immutable), `effective_date` (Cost Controller correction, nullable), `document_no` (invoice/PO/payment link), `partner`, optional filter `type` (`Income|Expense|Receivable|Payable|LPB|Dropping`), controlled `line_role` + `in_cost_basis`, computed `amount = debit - credit`, `retainage_amount`, `paid_amount`, CBS/WBS tags, `project`, `cash_advance_link`, `currency` (reserved; IDR v1). Receivable/payable registers + aging = **views over this table**.
- Supporting: `cash_advance` (pot per project), `lpb_statements` (usage lines, draft→checked), `revenue_recognized`, `import_profiles` (fixed template per source)
- Control: `bcr_register`, `change_log` (internal replanning entries), `approvals` (workflow state per record), `audit_log`, `notification_inbox`

---

## 8. Boundaries

**Always do:** base/actual/forecast per CBS monthly bucket; EVM auto-calc; BCR before baseline change; immutable actuals + audit; per-project role assignments; transaction-level storage; calendar-month views.

**Ask first:** change to company-standard WBS/RBS menus (Admin approval); new revenue method per project (PM decision); changing close state backwards (operational → reopened, needs PM note); adding a new integration/source to actuals import.

**Never do:** edit a frozen baseline without BCR; store budget in WBS/RBS (money lives in CBS only); delete Finance-entered entries (immutable); live-rate revaluation; silent closing/reopening.

---

## 9. Out of Scope (v1)

- Task dependencies / CPM / critical path engine (v2+)
- Full HR module (leave, payroll, recruiting) — stays external; HR-lite slice only
- Email/SMS notifications (v2; in-app only in v1)
- Per-advance cash tracking (v2; one big pot in v1)
- **Management reserve** (v2; every contract-value-changing addition goes through BCR in v1 — Q1b)
- **Multi-currency conversion** (v2; IDR only in v1, `currency` column reserved)
- Multi-tenant SaaS / commercial licensing (internal tool; tenant model if productized later)
- Mobile native app (responsive desktop-first only)
- Live FX revaluation engine
- Predictive/ML forecasting (EAC formulas + manual overrides only)

---

## 10. Open Questions (resolved during interview — for traceability)

| # | Decision |
|---|---|
| Q3 | WBS 50–200 lines v1, scalable; no hard caps |
| Q4 | Approvals: baseline lock (one-time) + BCR workflow, tiered by project size |
| Q5 | Forecast: auto EAC formula + manual override, both visible |
| Q6 | ~~Multi-currency at entry (rate snapshot)~~ **superseded v1.3**: single currency IDR for v1 (R2-9); `currency` column reserved. Separate income/cost streams stored, monthly view rendered |
| Q7 | Revenue: all 4 methods per project; billed vs recognized tracked |
| Q8 | Reports: portfolio + project dashboards + formal exports all v1 |
| Q9 | Migration: all projects, MariaDB + Excel → schema translation; x/y/z views die, become computed views |
| Q10 | Stack: Express + SQLite WAL + EJS + Alpine + TDD + Docker |
| Q11 | Per-project role assignments |
| Q12 | In-app notifications only |
| Q13 | Desktop-first responsive |
| Q14 | Hierarchy + dates only, no dependencies |
| Q15 | Import all projects incl. history |
| Q16 | Terms: LPB = Laporan Pengeluaran Bulanan (cash-advance usage); Dropping → "Cash Advance"; BAST = milestone certificate |
| **R2-20** | **Terminology rename (user, 2026-09-23):** UI uses **"Cash Advance"** (was: Dropping) and **"Expense Report"** (was: LPB), in English and Indonesian. Internal names keep legacy vocabulary (`type` = Dropping/LPB, table `lpb_statements`) so historical data stays self-explanatory. |
| R2-22 | **Ledger `type` = optional filter tag** (user: "we only classify some lines per transaction"): `Income | Expense | Receivable | Payable | LPB | Dropping`; **NULL allowed** — balancing offsets stay untagged by design. Double-entry integrity = debit/credit + account, not type. NULL-type → `line_role='other'`, cost basis excluded. |
| Q17 | Cash advance: one big pot per project (v1); per-advance v2 |
| Q18 | Company-standard WBS/RBS menu |
| Q19 | All 6 alerts with default thresholds |
| Q20 | Dark app / light print |
| Q21 | Milestone ticks for progress |
| Q22 | Email + password login |
| Sketch-1 | CBS = only money book; WBS/RBS dimensions |
| Sketch-2 | RBS derivation at total; CBS monthly buckets; invariant Σ=RBS |
| Sketch-3 | Project Controller (WBS/RBS/SPI) + Cost Controller (CBS/CPI) split; Project Admin = typing |
| Sketch-4 | BCR change control, freeze after approval, re-baseline, audit |
| Sketch-5 | HR-lite: assignment/rate/contract window only |
| Sketch-6 | 3-step close: operational → financial → contractual (retention) |
| R2-1 | Cost/income source: Finance ledger (bulk) + Project Admin/PM cash-advance detail (LPB); Cost Controller fills codes |
| R2-2 | LPB entered in a **dedicated in-app screen** (not Excel) |
| R2-3 | Cost Controller's check of LPB lines = **final** (no Finance approval step) |
| R2-4 | Ledger entry = **hybrid** (in-app entry for exceptions + fixed-template Excel import for bulk); app is book of record, Excel is a bridge |
| R2-5 | Import scope: ledger only — it carries receivables/payables; **fixed template** (columns follow the ERD schema) |
| R2-6 | Document no links invoice↔payment; due date = ledger date + payment terms (project register, editable for odd contracts) |
| R2-7 | Signs: income = credit = negative, cost = debit = positive (stored); natural signs on dashboards |
| R2-8 | **Superseded by TS-08:** English + Indonesian UI from day one; language stored on user profile. |
| R2-9 | **Single currency (IDR) v1** |
| R2-10 | Dual tagging: **CBS + WBS per cost line**, both by Cost Controller in one screen |
| R2-11 | Date model: `date` (Finance, immutable) + `effective_date` (Cost Controller correction); period = COALESCE(effective_date, date) |
| R2-12 | WBS additions: **internal replanning** (same contract value) = add directly + change log, no BCR; contract-value-changing = full BCR |
| R2-13 | De-scope = status field, never delete; prospective re-baseline; spent cost stays tagged; revenue per IFRS15 modification |
| R2-14 | **No management reserve in v1** |
| R2-15 | WBS line status: active / completed / de-scoped |
| R2-16 | **Ledger entry: debit OR credit, amount auto-computed** (verified 26/26 rows) |
| R2-17 | **Legacy ledger = strict double-entry** (full transaction groups net to zero; the 26-row sample's one partial extract is quarantined); migration gate = trial balance |
| R2-18 | **Dropping = cash advance (not cost yet); LPB detail lines (Project Admin) = real cost. Finance's bulk LPB settlement in the ledger is NOT itemized — it stays out of cost basis; the checked `lpb_statements` detail lines feed actuals via `v_cbs_actual`. No double count** |
| R2-23 | **Historical WBS tagging = (b) leave blank.** Imported history arrives WBS-less (only CBS tag). Cost Controller optionally fills them; nothing auto-guessed. Untagged-but-cost lines appear in `v_untagged_queue`. |
| R2-19 | **LPB reconciliation view** (user request): compares Finance's bulk settlement (ledger) vs Project Admin's detail lines (`lpb_statements`) per LPB no — status `balanced` / `difference` / `missing_detail` |
| R2-21 | **Legacy baseline reality:** only a **cost baseline** (`c_project_execution_budget`). WBS/RBS/CBS structuring is the user's NEW approach for centralization — legacy has no real EVM baseline. Old projects: EVM starts fresh; historical cost data imported for reference. New projects: full WBS/RBS/CBS from day one. |
| R2-25 | **Migration scope = (c) everything, closed projects hidden.** All projects migrate (centralized history); closed projects get `status='closed'` and are excluded from dashboards by default (toggle to view). |
| R2-24 | **`c_project_cost_adjustment` = the FORECAST.** User's own name for: "start dup of execution plan → edit against actuals per period → forecast" (R2-24, user 2026-09-23). Maps to `cbs_plan.plan_type='forecast'`. Legacy migration: rename table, keep rows. |
| R2-26 | **Counterparty recovery on migration = (b) heuristic from description + review queue.** Legacy has no partner table; the vendor/party is embedded in the free-text `description` (verified: 26/26 sample rows carry it — "PT SUMBER MATERIAL - 030(2024)", "Perjalanan dinas: Petugas A, …", "BPJS Tenagakerja …"). The migration script extracts a candidate (leading token / "PT SUMBER MATERIAL" pattern), matches against the seeded partner list, and flags unknowns to a review queue — **nothing silent, nothing guessed into the ledger**. Counterparty stays NULL until confirmed; partner reports cover only confirmed lines. |
| R2-27 | **Import template = new app's column names (b); import dedupe = detect & skip (a).** Import profiles store the column mapping; re-importing the same (transaction_id, document_no, date, amount, project) is blocked at the DB level. |
| **TS-01–TS-12** | **Technical architecture locked in `TECH-SPEC.md`:** username/email + Argon2id; SQLite sessions; 30-second alert polling; multipart staged import; SQLite-backed jobs; PDF + XLSX reports; single tenant; English + Indonesian; business dates + UTC audit timestamps; numbered migrations; feature-folder monolith; EJS + Alpine CSP build with narrow JSON endpoints. |
| **TS-13** | **Backup storage locked:** compressed hourly full snapshots; max 24h/7d/4w/12m retention set; local + encrypted offsite copies; storage monitoring; no automatic deletion without explicit user approval. RPO/RTO and restore-drill cadence remain open. |
| **TS-14** | **RPO locked at 1 hour:** at most work since last successful hourly snapshot may be lost. Failed/overdue backup alerts are mandatory. RTO and restore-drill cadence remain open. |
| **TS-15** | **RTO locked at 4 hours** (2026-09-24 correction): documented rebuild + restore on a single VPS within a working day; a 1-hour target requires an automated recovery image and is the documented upgrade path, not a v1 claim. |

---

## 11. Open Items

- [ ] Confirm this PRD v1.3 (or flag changes)
- [x] Baseline approver: PM (Admin excluded) — v1.2
- [x] Hybrid period freeze — v1.2
- [x] Billed/received/retainage + aging — v1.2
- [x] Report renamed Project Update Report — v1.2
- [x] Executable data model → `db/schema.sql` (38 tables / 9 views / 2 triggers) + `db/validate.py` — v1.3
- [x] Migration map: MariaDB/Excel tables → new tables → `docs/MIGRATION-MAP.md` — v1.3
- [x] `practis.graphml` received & parsed (35 tables / 40 FKs) → archived at `legacy/practis.graphml` + `legacy/erd-parsed.json`
- [x] MIGRATION-MAP §7 data questions answered: ledger signs/type/baseline/history/account-code/rupee units; remaining migration work is dry-run and reconciliation.
- [ ] Mockup pass (html-design skill) — after PRD approval, review-before-code
- [x] Tech spec drafted: `TECH-SPEC.md`; architecture/security/reliability/module contracts captured. RPO/RTO approval remains open.

**Scope note:** "Cost Performance Index" and "Revenue" mentioned in §5.2/§5.3 — terminology aligned: *CPI* = EV/AC (progress-weighted). The app also reports *cost variance %* (AC vs budget per month) for pure-cost questions — EVM-only CPI on a cost-heavy book can understate. **Resolved v1.3: report both** (implemented in `db/schema.sql` → `v_evm_period`).

Alerts computed & pushed **in-app** (plan against actual + current forecast; stable thresholds; project-overridable). Delivery = Notification inbox (Q12).
