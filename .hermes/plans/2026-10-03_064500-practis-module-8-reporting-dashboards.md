# Module 8 — EVM / revenue / aging / dashboards — Implementation Plan

> **For Hermes:** execute part by part. Each part = its own commit + its own test file.
> Do NOT start part N+1 before part N's suite is green.

**Goal:** turn Module 7's numbers into screens a human can act on — the project dashboard
(S-curves, EVM trend), the portfolio dashboard (traffic lights, cashflow, forecast), the aging
report Finance collects from, and revenue recognition. Plus **fix the two register views that
currently report the opposite of the truth**, which Module 8 is the first module to display.

**Architecture:** unchanged layered pattern — `src/routes/<area>.js` (thin HTTP),
`src/lib/<area>-service.js` (rules, all validation, all writes), `src/db/queries.js` (prepared
statements), `views/` (EJS + `layout-app`). New: a reporting route group + a small SVG chart
helper (there is no chart library, and the CSP forbids one — see F8).

**Scope:** plan § "MODULE 8" at `.hermes/plans/2026-09-30_140100-practis-forward-development.md:879`;
TECH-SPEC §10 step 7; PRD §4.4 (Monitoring & Control), §5.2 (Cost Control), §5.3 (Revenue),
§5.4 (Reporting / Dashboards).

---

## 1. Findings that shape this plan (measured, not assumed — 2026-10-03)

Every figure below was read off the running product, on a **copy** of `data/practis.db`, with the
shipped `db/schema.sql` loaded from disk. Probes are throwaway and live in `/opt/data/cache/`
(`m8probe.js` … `m8probe5.js`); nothing scratch is in the repo.

### F1. THE AR/AP REGISTERS REPORT THE OPPOSITE OF THE TRUTH. This is the headline finding.

`v_receivable` and `v_payable` are the "who owes us / who we owe" registers. They are the input to
the aging report, to the portfolio dashboard and to the Project Update Report. **On the real
database they contain one row, and it is the wrong row.**

Measured (`m8probe5.js`):

| Document | Type | line_role | `cost_category_id` | In the register? |
|---|---|---|---|---|
| `INV-0224` | Receivable | `receivable` | **NULL** | ❌ **hidden** |
| `RET-0044` | Receivable | `receivable` | **NULL** | ❌ **hidden** |
| `CASHIN-0114` | Income | `receivable` | **NULL** | ❌ **hidden** |
| `CASHOUT-0208` | Dropping | `funding` | 1 (Materials) | ✅ **shown**, at **−30,000,000** |

So the register reports **one document, at minus thirty million rupiah** — a cash-out with nothing
owed either way — and **hides all three real claims** (Rp 400,000,000 + Rp 40,000,000 +
Rp 300,000,000 received). A Finance user opening the aging report today sees *"one invoice, minus
30 million"*. The opposite of the truth, in the same class as the SPI=0 defect Module 7 fixed.

**Why.** The shipped join is:

```sql
JOIN cost_categories cc ON cc.id = r.cost_category_id
                       AND (cc.is_receivable = 1 OR r.line_role = 'funding')
```

Two errors in one line:

1. **It filters on a cost category where the PRD says "type + document no".** PRD §5.2 line 258,
   verbatim: *"Receivable/payable are computed views over the ledger (**filtered by type + document
   no**) — not separately keyed."* The view filters on `cost_category_id` instead.
2. **The `OR r.line_role = 'funding'` escape hatch was added to catch payments** — a payment line
   shares the invoice's document number and must net against it (validate.py: *"payment is a ledger
   line sharing the invoice's document_no… Same-doc lines must net"*). But the hatch is in the
   **JOIN**, so a **funding-only document with no claim line of its own is admitted as a register
   row**. `CASHOUT-0208` is exactly that: `funding_lines=1, other_lines=0`.

And the line is not merely possible — **the app writes it.** `ledger-builder.js:39` hard-codes
`cost_category_id: null` for every typed line, and the entry form posts no category at all. The two
legitimate paths to a claim line are:

* **Manual entry** (`/ledger/entry`): `cost_category_id` is always NULL → **a manually entered
  Receivable is invisible in the register.** This is a live product defect.
* **CSV import** (`import-map.js` maps a cost category) → category set → visible. This is why
  Module 7's fixture-era tests and `validate.py` never caught it: `validate.py` runs
  `seed-smoke.sql`, whose category 1 is literally `(1,'RCV','Receivable',is_receivable=1)`. The
  smoke fixture is built so the join works. **The dev database's category 1 is `MAT`/Materials.**

**The rejected alternative, recorded:** making the entry form *require* a cost category on a
Receivable line would make the register work — but it contradicts PRD §5.2 ("filtered by type +
document no"), it does not fix the funding-only row, and it does not repair the rows already
written. The view is the thing that is wrong.

### F2. `v_aging` puts rows it cannot date into the WORST bucket.

```sql
CASE
  WHEN julianday('now') <= julianday(r.invoice_date) THEN 'current'
  ...
  ELSE '120_plus'
END AS aging_bucket
```

With `invoice_date IS NULL`, `julianday('now') - julianday(NULL)` is **NULL**, every `WHEN` is
falsy, and the row falls to `ELSE '120_plus'`. Measured on the shipped schema with a NULL-date row:
`days_aged = null`, `aging_bucket = "120_plus"`. That is a **claim** — "over 120 days overdue" —
about a document with no date to age from. Finance's collection list therefore leads with a
fabricated worst-case. Same class as F1 and as `spi=0`: a missing value reported as an alarming
one.

Measured on the real database: the single aging row is `CASHOUT-0208`, `invoice_date = null`,
`days_aged = null`, bucket **`120_plus`**.

### F3. No due date exists anywhere in the product, and PRD §5.2 names one.

PRD §5.2 line 259: *"Due date = ledger date + payment terms (from project register)."*
`projects.payment_terms_days` and `clients.payment_terms_days` both exist (and are settable in the
project form — `projects-service.js:104-111`, `project-edit.ejs:74`). No view computes a due date;
`v_aging` ages from `invoice_date`, not from a due date; and a repo-wide search for a view
mentioning `due` returns **nothing**. On the live project both values are null, so the fallback
chain matters.

### F4. Closed projects are not hidden — invariant 12 is unmet.

`docs/TECH-SPEC.md` §8.4 invariant 12: *"Closed projects hidden by default from live dashboards."*
`TEST_PLAN.md` §13 records it as ❌ untested. Measured: of `v_evm_period`, `v_receivable`,
`v_aging`, `v_cbs_actual` — **none joins `projects` to filter on status**. The three-step close
columns (`close_operational_at`, `close_financial_at`, `close_contractual_at`) exist on `projects`
and are all null today. Nothing in `src/` or `views/` reads them.

So the portfolio dashboard Module 8 builds would put closed projects in the live totals — the PRD
is explicit (§4.5) that each close step *excludes* the project from a different live view.

### F5. The dev database holds no Module 7 data at all, so 8.x tests must build their own.

Measured: `cbs_plan` 0 rows, `wbs_progress` 0 rows, `acceptance_register` 0, `revenue_recognized` 0,
`project_reports` 0, `notification_inbox` 0. The demo project is `JC-2026` on the dev DB but
`PRJ-2026` in the test fixture, and `seed-master.js` seeds master data against `PRJ-2026`. Every
8.x test therefore stands up its own baseline + progress + costs through the real services (the
`evm.test.js` pattern), and **never reads the dev database**.

Also: the dev DB's `v_evm_period` still carries the **pre-018 guard**
(`CASE WHEN COALESCE(ac.ac,0) <> 0 THEN ROUND(COALESCE(ev.ev,0)/ac.ac,4) END`), which is why it
printed `cpi = 0`. That is a stale dev copy, not a code defect — migrations 018/019 apply on
startup. Recorded so nobody "re-finds" it. **No `npm start` is needed to test anything here.**

### F6. Free test ports.

In use (measured from the files, `PORT = ` grep): 3901, 3902, 3904–3915, 3918, 3919, 3920, 3933,
3994, 3996, 3997, 3998, 3999. **3903 and 3916–3917 are free, and 3921+ is empty.** Module 8 takes
**3921–3928**, one per new test file. Never trust a port table that was not grepped.

### F7. Route/middleware plumbing already exists — do not fork a fifth copy.

`src/middleware/scope.js` resolves `?project=N` against the user's **authorised** set (the BOLA
fix). `requireCapability(flag, message)` is a deliberate three-copy convention (app.js, projects.js,
bcr.js, wbs.js, cbs.js, rbs.js, master.js) — the module 7 plan locked "three deliberate copies is
the established convention; do not refactor them mid-module". A new `routes/reporting.js` makes a
**new** copy, which is consistent. What it must NOT do is re-derive project scope: it mounts the
same `projectContext`. And note the **path-list trap**: a root-mounted router with a bare
`router.use(requirePage)` intercepts every URL in the app and answers 404s with a redirect to
/login. Every new router needs its own scoped path array (`PAGE_PATHS`), and the array form is
required — Express 5's `/x/{*path}` silently drops the guard on the bare prefix.

### F8. Charts must be server-rendered SVG. There is no chart library and the CSP forbids one.

`assets/` holds only `app.css`, `fonts.css` and four Inter woff2 files. The CSP is
`script-src 'self' 'nonce-…'` with **no `unsafe-eval`** (TECH-SPEC §3.6, the Alpine CSP build
rationale). So: no CDN charting library, no `eval`-based template engine. An S-curve is a
polyline; the honest implementation is a small helper that emits `<svg>` + `<path>` from an array
of points, server-side, requiring no client JavaScript at all. **This is also the better product
answer** — it prints correctly on the light print theme (PRD §5.4 / Q20c) and adds nothing to TBT.
Existing CSS already provides `.kpi`, `.chip.ok/.wn/.bd/.nt/.bl` and a `.k4`/`.k2` grid, so
traffic-light cards and KPI tiles need no new design system.

### F9. `validate.py` pins the AR/AP arithmetic — the F1 fix must not move those figures.

`db/validate.py` asserts, against `seed-smoke.sql`:

* `v_receivable` `INV-0224` → `outstanding = 60,000,000`, `paid = 300,000,000`, `retainage = 40,000,000`
* `v_payable` `PO-9001` → `billed = 90,000,000`, `paid = 30,000,000`, `outstanding = 60,000,000`
* `v_untagged_queue` size 1
* `v_evm_period` 2026-02 has non-null `spi` **and** `cpi`

In the smoke fixture `INV-0224`'s ledger line has `cost_category_id = 1`, which **is**
`is_receivable = 1`, so the current join admits it. A corrected view must keep those four figures
**byte-identical**. That is this module's version of EV7.4: fix the defect, prove no real figure
moved. `v_untagged_queue` must also stay at 1 — it reads `accounting_ledger` directly, not these
views, but the smoke run inserts a payment line before the payable check, so the order matters.

### F10. Revenue is entirely unwired — and the POC basis is not what a reader would guess.

`revenue_recognized` (columns `method`, `basis_pct`, `amount`, `cumulative`, `acceptance_id`,
`UNIQUE(project_id, period_month)`) and `acceptance_register` (`percentage_progress`, `status`) both
exist, both empty, and **nothing in `src/` or `views/` reads or writes either.** PRD §5.3 is
emphatic that the **POC method reads BAST acceptance % from `acceptance_register`, NOT the internal
milestone tick %** — "keep the two never conflated". There is no view summing BAST % per project.
`projects.revenue_method` exists and is settable in the form, but is **null on the live project**,
so a revenue screen must handle "not configured" first-class rather than guessing a method.

Also measured: `v_receivable` computes `billed_amount`, `paid_amount`, `retainage_amount` and
`outstanding_amount` but there is **no `recognized` column** — the third timeline of PRD §5.2's
"billed ≠ revenue ≠ received" needs joining to `revenue_recognized`, not reading off this view.

### F11. `contract_amount` is editable after the baseline is locked.

`projects-service.js:94-101` accepts `contract_amount` on the edit path with no `baseline_locked`
check, and `project-edit.ejs:70` renders the field unconditionally. Today this is harmless (nothing
reads it as a control total) but **Module 8 is the first module to use it as the BAC envelope on a
dashboard**, at which point a silent post-lock edit would quietly restate every variance figure.
Flagged, not fixed here — it belongs to Module 10's hardening, but the dashboard must state which
number it is showing and where it came from.

---

## 2. Part order (and why it differs from the §10 one-liner)

§10 step 7 says "EVM / revenue / aging / dashboards" in one line. That is a topic list, not an
order. The order below is **dependency + defect-first**, and it follows the lesson Module 7 learned
the expensive way (part 7.8: the plan said "no production code expected" and it needed a migration
because the view was lying).

| # | Part | Why here |
|---|---|---|
| **8.1** | **Register honesty** — fix `v_receivable`/`v_payable` (F1) and `v_aging` (F2) | **First, and not negotiable.** The aging screen and every dashboard read these. Building a UI on a view that reports the opposite of the truth bakes the lie into the product. Migration **020**, view-only. |
| **8.2** | **Due dates** — `payment_terms_days` → a real due date (F3) | The aging screen is only worth building once it can age from a due date, which is what PRD §5.2 actually specifies. Migration **021**. |
| **8.3** | **Aging report screen** `/reports/aging` | Finance's collection priority list. First user-visible payoff, and it makes F1+F2 verifiable by eye. |
| **8.4** | **Forecast / EAC** — the `forecast` `plan_type` door + auto-EAC from CPI + manual override | PRD §4.4 step 1 and §5.4 ("portfolio-wide forecast"). The compute layer the portfolio dashboard needs. |
| **8.5** | **Variance** — PV/EV/AC variance, per period and cumulative | §10 step 7 names it. Small; sits on `v_evm_period`, no migration. |
| **8.6** | **Project dashboard** — S-curves, EVM trend, WBS drill-down | Needs 8.4 + 8.5 to have something to draw. |
| **8.7** | **Portfolio dashboard** — traffic lights, cashflow, forecast, **closed-project hiding** (F4) | Replaces the 35-line `dashboard.ejs`. Needs everything above. |
| **8.8** | **Revenue recognition** — the four methods, POC from BAST, three timelines (F10) | Most independent and least specified; last so it cannot block the dashboards. |

**Eight parts.** Each = one commit, one test file, suite green before the next.

---

## Part 8.1 — Register honesty: the AR/AP join and the aging bucket — *migration 020* — ✅ BUILT 2026-10-03

**Status: implemented, 8/8 RG8 tests green, suite 446 → 454, migration 020 pushed to the branch.**
Two defects were found IN THE FIX ITSELF while writing the tests; both are recorded below and in
`TEST_PLAN.md` §12l rather than smoothed over. The section that follows is the plan as written
before the build; where measurement corrected it, the correction is marked **CORRECTED**.

**The defect.** F1 and F2. Both are view-only; both need exactly one migration; both must move
**no real figure**.

**What the corrected `v_receivable` must do.**

1. **Select what a claim is, per the PRD: by `type` + `document_no`** — not by cost category.
   A claim document is one carrying a `receivable`-role line (`type IN ('Income','Receivable')`,
   `line_role = 'receivable'`). Keep the document-level grouping exactly as it is.
2. **Admit a `funding` (payment) line only when the SAME document already carries a claim line.**
   That is what "same-doc lines must net" means, and it removes the funding-only row that is F1's
   visible symptom. A funding-only document is a cash movement, not a receivable.
3. **Keep `billed_amount`, `paid_amount`, `retainage_amount`, `outstanding_amount` arithmetic
   byte-identical** for every document the view admits. This is the acceptance condition: on
   `seed-smoke.sql`, `validate.py`'s four figures must not move. **Verified: all six pinned figures
   identical after 020.**
4. **`invoice_date` stays `MIN(date)` of the non-payment lines** — for a corrected view the claim
   line always exists, so this stops being NULL for real claims (it was NULL before only because
   the claim line was excluded from the aggregate).

**CORRECTED — two things the original step 1/2 wording got wrong, both caught by RG8.3:**

* **The type test must not be applied to a funding line.** A payment can itself carry a claim's
  `type`; `db/validate.py` inserts exactly that (`type='Payable', line_role='funding'`) to test
  netting, and the first draft admitted one as a claim. The predicate is now `(line_role <> 'funding'
  AND claim-test) OR (line_role = 'funding' AND claim exists on the same document)`.
* **`invoice_date` needs `NULLIF(r.date, '')`, not a bare `MIN`.** `accounting_ledger.date` is
  NOT NULL, which blocks an *absent* date but not a *blank* one — `date=''` is accepted, and plain
  `MIN(date)` over a document mixing a blank and a real date returns the blank, so one undated line
  erases the whole document's date.

`v_payable` gets the same treatment against payable documents. **Careful — it is already partly
right, and must not regress.** Its `WHERE` is
`(line_role = 'payable' OR type = 'Payable' OR line_role = 'funding')` with an inner
`JOIN projects`, so on the real database it correctly shows **three** rows:
`INV-2026-001` at `25,000,000` and `PO-0897` at `90,000,000` (both `type='Payable'` with **no cost
category** — which is why the payable view escapes F1 while the receivable view does not), **plus**
`CASHOUT-0208` at `-30,000,000` (the same funding-only defect). So the payable fix is narrower: keep
the two real payables at their exact figures, drop the funding-only row.

**The asymmetry is the diagnostic, and worth stating:** the two views are written differently —
`v_receivable` filters on `cost_category_id`, `v_payable` filters on `type`. The PRD names one rule
for both ("type + document no"), and the view that followed it works while the view that did not is
blind. That is the evidence that A is the fix, not a preference.

**What the corrected `v_aging` must do.** An undatable row must not be *reported as aged* at all.
The old `CASE` fell through every `<=` comparison to `ELSE '120_plus'`. **CORRECTED by measurement:**
the guard is **not** `invoice_date IS NULL` — `date` is NOT NULL, so a blank string arrives instead
and that guard never fires. The correction is `invoice_date IS NULL OR invoice_date = ''` plus an
explicit `WHERE invoice_date IS NOT NULL AND invoice_date <> ''`, i.e. **`v_aging` excludes undatable
rows rather than labelling them**. `days_aged` was already NULL and stays NULL. The five real bucket
boundaries (30/60/90/120) are untouched. The "no date" to-do list is served by querying
`v_receivable` directly, and part 8.3 renders it on the aging screen.

**Files:** NEW `db/migrations/020_ar_ap_document_scope.sql`; `db/schema.sql` (regenerated);
NEW `test/reporting.test.js` (RG8.1–RG8.8, port **3921**); `TEST_PLAN.md` (§12l); this plan.

**Tests (each expectation computed by hand in a comment) — 8/8 green:**

| ID | Assertion |
|---|---|
| RG8.1 | a claim written by the **manual** entry path (no cost category) **is** a receivable — and the deployment fact that makes D1-B impossible is asserted first: **zero** receivable-capable cost categories exist after `seed-master.js` |
| RG8.2 | a funding-only document is **not** a receivable and **not** aged; no row anywhere reports a negative amount owed to us |
| RG8.3 | a same-document payment **nets** against its claim (partial: outstanding falls, `paid_amount` rises); a different-document payment does not move it; **and a payment carrying a claim's `type` is still not a claim** |
| RG8.4 | a payment for a **different** document does not reduce this claim (the validate.py rule, re-asserted); a fully-paid invoice leaves `v_aging` |
| RG8.5 | a **blank** date is excluded from `v_aging` (not bucketed at all, and never `120_plus`); a mixed blank+real document keeps its real date |
| RG8.6 | the five real bucket boundaries are unchanged at 30/60/90/120 (relative offsets, so the test cannot rot) |
| RG8.7 | billed − paid − retainage = outstanding holds: 250,000,000 − 80,000,000 − 25,000,000 = **145,000,000**; net_amount **170,000,000** |
| RG8.8 | `v_payable` does not regress: real payables keep their figures, funding-only documents are dropped |

**Gates:** `node db/dump-schema.js` then `--check` clean ✅; `python3 db/validate.py` ALL CHECKS PASS
(∀ six AR/AP figures byte-identical) ✅; full suite **446 → 454** ✅.

**This is the one part I would not skip, defer, or soften.** If the owner disagrees with anything
in this module, disagree with the ordering, not with this.

---

## Part 8.2 — Due dates: `payment_terms_days` becomes real — *migration 021* — ✅ BUILT 2026-10-03

**Status: implemented, 7/7 AG8 tests green, migration 021, suite floor raised.**
**CORRECTED DURING THE BUILD — read this first: the paragraph below originally said "aging then ages
from `due_date`". That was WRONG and would have been a regression.** The buckets stay on the
**invoice** date (TECH-SPEC §13, PRD §5.2, `db/validate.py` and RG8.6 all pin them there); re-pointing
them at `due_date` would have silently re-labelled 30/60/90/120 as *days past due* and moved every
aged figure — RG8.6 would have failed, correctly. `due_date` and `overdue_days` are **added beside**
the buckets. AG8.6 proves the two are independent by constructing a row where they disagree.

**The gap.** F3. PRD §5.2: due date = ledger date + payment terms from the project register.

**The rule (decision D3, answered A):** project `payment_terms_days` → else the
client's `payment_terms_days` → else a **system default of 30 days** held in `app_settings` under a
new key `default_payment_terms_days`. The fallback chain is exposed, not hidden: the register says
which one applied (`terms_source`), because "30 days" that is really "nobody set this" is a different
fact from "30 days, our terms". **Measured:** `app_settings` carries *no business settings at all*
after `seed-master.js` (only the argon2 tuning keys and `csrf_secret`), so migration 021 seeds the
row with `INSERT OR IGNORE` **before** the view that reads it — otherwise the view would return NULL
terms on every real installation and no screen could show or change the value.

**Implementation.** NEW view `v_receivable_due` — column-for-column a superset of `v_receivable`,
plus `terms_days`, `terms_source` (`project`|`client`|`default`) and `due_date`
(`date(invoice_date, '+' || terms || ' days')`, SQLite's own arithmetic — no new dependency).
`v_aging` is recreated from it and **keeps its exact contract** (invoice-date buckets, datable +
still-outstanding only), gaining `terms_days`, `terms_source`, `due_date` and `overdue_days`.
`overdue_days = max(0, julianday('now') - julianday(due_date))` — **clamped at 0**, because a
not-yet-due invoice reported as "-12 days overdue" would sort ahead of genuinely overdue invoices.
`days_aged` (invoice date) is kept alongside it: the two answer different questions and Finance uses
both. An unknown default is reported as unknown (`terms_days` NULL → `due_date` NULL), never
invented as 30 — the rule migration 018 set for SPI/CPI.

Note `date(x, '+30 days')` is SQLite's own date arithmetic — no new dependency, and it is
deterministic given the row.

**Files:** NEW `db/migrations/021_receivable_due_date.sql`; `db/schema.sql` (regenerated); NEW
`test/aging.test.js` (AG8.1–AG8.7, port **3922**); `TEST_PLAN.md` (§12m); this plan.

**Tests (each expectation computed by hand in a comment) — 7/7 green:**

| ID | Assertion | Expected |
|---|---|---|
| AG8.1 | the default is **read from `app_settings`**, not baked into the view | set 30 → due 2026-03-31; changed to 45 → due **2026-04-15**; `terms_source='default'` |
| AG8.2 | with no terms anywhere the due date is **NULL**, never an invented 30 | `terms_days` NULL, `due_date` NULL; restoring 30 → 2026-04-09 |
| AG8.3 | a project with no terms inherits the **client's**, and says so | 60 days → due **2026-04-02**, `terms_source='client'` |
| AG8.4 | the **project's** terms win over the client's (R2-6) | 15 days → due **2026-03-16**, `terms_source='project'` |
| AG8.5 | an invoice **inside** its terms has `overdue_days = 0`, not a negative | 10 days old, 90-day terms → overdue **0**, `days_aged` 10.x, bucket `1_30` |
| AG8.6 | the 30/60/90/120 buckets still measure from the **INVOICE** date | 75 days old / 60-day terms → bucket **`61_90`**, overdue **15**; the five boundaries re-pinned |
| AG8.7 | undatable rows stay out of aging but reachable on the register; settled rows keep their due date | blank date → absent from `v_aging`, present in the no-date to-do; paid in full → out of `v_aging` |

---

## Part 8.3 — Aging report screen — `/reports/aging` — ✅ BUILT 2026-10-03

**Status: implemented, 9/9 RP8 tests green, sidebar Reports group restored in the same commit.**

**PRD §5.4:** *"Aging report (receivables): 30/60/90/120+ buckets"*, and §5.2: *"sortable by
amount — Finance's collection priority list"*. Screen map row: `Reports | Aging | receivable
priorities`.

**Built as planned, with two structural corrections found while writing it:**

* **The sidebar link points at `/reports` (an index), not at `/reports/aging`.** MS6.7/MS6.8 assert
  the sidebar carries no dead link and that every href resolves, so the link had to land with a
  route. A report LIST absorbs the module's later reports (forecast, variance, portfolio) without
  re-pointing the link. New **MS6.10** pins that the restored link and its route landed together.
* **Nothing else in the product renders `v_aging` yet** (measured: no `FROM v_aging` anywhere in
  `src/`, `views/` or `test/` before this part), so the aging view could be extended with
  `terms_days` / `due_date` / `overdue_days` in 8.2 without a compatibility shim. It is now read
  through `db/queries.js` — configured views are not queried inline in a route.

**Page:** `GET /reports` (index) and `GET /reports/aging`, capability **`canViewReceivable`** — a NEW
flag = **Finance + Cost Controller**, deliberately *not* the flat `true` the WBS/budget/ledger screens
use. Those expose a project's own plan; these registers expose what the company is owed and by which
customer. A Viewer gets a rendered **403 with the reason**.

Buckets from `v_aging`, **grouped and totalled**, each bucket a `.kpi` tile with the count and total;
the table sortable server-side by amount / most-overdue / due-soonest; the **"cannot be dated" group
shown as its own labelled to-do**, never folded into 120+ (that was F2) and never counted in the
overdue totals; **retainage its own tile and its own column** (PRD §5.2: *"retainage held separately
(never buried in regular AR)"*), read from the register so a settled-but-still-retained claim keeps
its figure. **Honest empty state:** with nothing outstanding the page says so in words, not with a
table of zeros. Page furniture per house style: title + muted sub-title + full-width.

**Tiles and table come from ONE result set** (`bucketTiles()` rolls up the same rows the table
prints), so a tile cannot disagree with the rows under it — and RP8.4 recomputes the tile totals
**from the table HTML** to prove it. `?sort=` is a **whitelist**: three prepared statements with
literal `ORDER BY` in `db/queries.js`; an unknown key falls back to the PRD default instead of
throwing, and RP8.7 drives `sort=outstanding_amount;DROP` and requires a 200.

**Files:** NEW `src/routes/reporting.js`; NEW `views/aging.ejs`, `views/reports-index.ejs`; MOD
`src/db/queries.js`, `src/lib/permissions.js` (`canViewReceivable`), `src/server.js`,
`views/partials/sidebar.ejs` (Reports restored), `test/wbs-defaults.test.js` (MS6.10); NEW
`test/reporting-screen.test.js` (RP8.1–RP8.9, port **3923**); `TEST_PLAN.md` (§12n).

**Tests:** RP8.1 authorization (Viewer refused with the reason, DB row count unchanged, both routes) ·
RP8.2 anonymous → `/login` · RP8.3 the corrected register renders (real claim, amount, project name) ·
RP8.4 **tile ↔ table agreement recomputed from the HTML** · RP8.5 undatable = labelled to-do, never
overdue · RP8.6 retainage separate (200M claim, 60M held → 140M outstanding) · RP8.7 sort works and
an unknown sort cannot reach SQL · RP8.8 due date **and its source** on screen · RP8.9 the restored
link resolves for a role that may open it.

**A latent defect this part's suite run exposed (and fixed here).** The full-suite run for 8.3 came
back `SUITE_EXIT=1` with four red tests — I8.4, MA5.1, PR2.1, PR3.1, all
`SqliteError: no such column: terms_days`. They were **not** caused by migration 021: `import.test.js`,
`projects.test.js` and `master.test.js` require app modules **in-process** but handed `PRACTIS_DB`
only to the child server, so `src/db/db.js` fell back to `data/practis.db` — the **DEV database**.
They had been reading (and could have been writing) real development data all along; migration 021
adding a column to `v_aging` only made the consequence visible. Fixed by setting
`process.env.PRACTIS_DB = dbPath` in each `before()`, plus a **guard in `src/db/db.js`** that throws
when a `node --test` child process reaches it with no database chosen. Measured harm on this box:
none (dev DB unchanged — `user_version 12`, 9 ledger rows, 4 users). Full write-up: `TEST_PLAN.md`
§12n.1.

---

## Part 8.4 — Forecast / EAC

**PRD §4.4 step 1:** *"Project Controller updates `c_wbs_forecast`; Cost Controller updates
`c_cbs_forecast` (**auto EAC from CPI** + manual override)."* The `cbs_plan.plan_type` CHECK already
admits `'forecast'`, and BL7.14 already proves a forecast row is **not** PV (it is invisible to
`v_evm_period`). The door exists; nothing walks through it.

**The rule.** `EAC = BAC / CPI`, seeded from the latest cumulative CPI (`v_evm_period.cpi_cum`,
migration 019), with `ETC = EAC − AC`. Then the Cost Controller may **override per month**, and an
override is marked `is_manual_override = 1` (the column exists) so the screen can show "system
said X, a human said Y" instead of silently replacing one with the other. **A forecast never
touches the baseline** — that is what BCRs are for, and Module 7 built them.

**Honesty rule, same as 018/019:** with no CPI there is **no** auto-EAC. The screen shows a blank
with the reason ("no earned value measured yet"), never `EAC = BAC` by accident and never a
division by zero.

**Files:** NEW `src/lib/forecast-service.js`; `src/lib/cbs-service.js` (a forecast read/write path
that mirrors the baseline one but is deliberately **not** the same function — the baseline path
enforces the Σ = RBS invariant, which does not apply to a forecast); `views/cbs.ejs` (a forecast
tab/section); NEW `test/forecast.test.js` (FC8.1–FC8.7, port **3924**); `TEST_PLAN.md`; plan.

**Tests:** auto-EAC = BAC ÷ CPI hand-computed; no CPI → **no** EAC and a stated reason; a manual
override is recorded **and** flagged, and the system value is still recoverable; **a forecast row
does not change PV, EV, AC, SPI or CPI** (re-assert BL7.14 from the other side); a forecast cannot
be written without the right capability (403 **with the row count unchanged**); writing a forecast
does **not** modify `cbs_plan` rows where `plan_type='baseline'` (row-count and checksum both).

---

## Part 8.5 — Variance

**§10 step 7 names "variance"; PRD §5.4 names "EVM trend".** Small and view-level.

`cost_variance` already exists per period (`AC − EV`, deliberately pinned by EV7.6, **not** changed
here). What is missing is the human-facing pair:

* **Schedule variance** `SV = EV − PV`, **cost variance** `CV = EV − AC`, **variance at completion**
  `VAC = BAC − EAC` — each **per period and cumulative**, sign convention stated on the screen
  (PRD §5.2 "Signs": dashboards render **natural signs** — income +, cost +, net = income − cost).
* Percentages alongside absolute values (`SV%`, `CV%`), because a Rp 500,000,000 variance means
  something different on a Rp 2 mld contract and a Rp 500 mld one.

**Where it is computed:** in the view/service, **once** — not re-derived by each screen (the rule
this module has been bitten by three times: 013/014/015, then 018, then 019).

**Files:** `db/migrations/022_evm_variance.sql` **only if** the clean home is a view; otherwise a
`variance()` reader in `src/lib/evm-service.js`. **Decide from the code, and record which.** No new
test file — variance asserts inside `test/forecast.test.js`'s sibling → NEW `test/variance.test.js`
(VR8.1–VR8.6, port **3925**).

**Tests:** each variance hand-computed; the sign convention is pinned to a **known-shape** example
(over budget → CV negative) so nobody "fixes" a sign; per-period and cumulative do not contradict
their own components (the EV7.11 property check, one scale up); `VAC` is blank when EAC is unknown.

---

## Part 8.6 — Project dashboard (S-curves, EVM trend, WBS drill-down)

**PRD §5.4:** *"EVM S-curves (project dashboard): PV from baseline (CBS monthly buckets), EV from
ticks×CBS (internal, not BAST), AC from ledger actuals. Calendar-rendered."* Plus *"Project
dashboard (PM/Controller): S-curves, EVM trend, cashflow actual vs forecast, WBS drill-down."*

**Charts:** server-rendered SVG (F8). A helper `src/lib/svg-chart.js` emitting:
`lineChart(points, {width, height, labels})` for the S-curve (PV/EV/AC as three paths on one axis,
calendar x-axis), and a small `barChart` for per-period variance. **No client JavaScript, no
library, prints cleanly.** Tests assert on the **emitted SVG's numeric attributes**, not on a
screenshot — deterministic and diffable.
The `Y` scale is a stated figure on the page (so a reader can check a point by hand), and an
all-zero series renders as a labelled empty state rather than a flat line at 0 pretending to be
data.

**Screens:** `GET /projects/:id/overview` (the screen map's Project Overview — **it does not exist
today**; only `/?project=N` does) as `/reports/project`, with the current UI's project switcher
carried over. WBS drill-down: a line's cumulative PV/EV/AC for the selected period, read through the
same service — never a second implementation of the EVM maths.

**Files:** NEW `src/lib/svg-chart.js`, NEW `views/project-dashboard.ejs`, `src/routes/reporting.js`
(+route), NEW `test/dashboard.test.js` (DB8.1–DB8.8, port **3926**), `TEST_PLAN.md`, plan,
`views/partials/sidebar.ejs`.

**Tests:** the SVG contains one point per month with the **hand-computed** cumulative value; a
project with **no** baseline renders the empty state, not a broken chart; PV/EV/AC match
`v_evm_period` exactly (no re-derivation); the drill-down total equals the sum of its lines; the
page is scoped — a PM on project A gets **403 + unchanged row count** asking for project B;
capability gating (a viewer without `canViewPortfolio` cannot open another project's dashboard).

---

## Part 8.7 — Portfolio dashboard + closed-project hiding

Replaces the 35-line `views/dashboard.ejs`.

**PRD §5.4:** *"Portfolio dashboard (exec/Viewer): all projects, CPI/SPI traffic-light cards,
current-month cashflow, portfolio-wide forecast."*

**Traffic lights** from **cumulative** `spi_cum`/`cpi_cum` (migration 019 — the per-period columns
read "5.0, blank, blank, blank" down a year and are NOT a health indicator; this is exactly the
decision 7.9A the owner made). Threshold: the PRD §4.4 alert table says `< 0.95` for a breach,
"threshold tunable" — read from `app_settings` (`spi_breach_threshold`, `cpi_breach_threshold`),
default 0.95, and **state the threshold on the page** so a green tile is checkable.
**A blank index is a grey "not measured" tile — never green, never red.** That is the whole point of
018/019 and it must survive into the UI.

**Invariant 12 (F4):** closed projects are **excluded from the live totals by default**, with an
explicit, visible `?include_closed=1` toggle. Each close step excludes from a different view (PRD
§4.5): operational → out of the live schedule; financial → out of live cashflow/forecast;
contractual → archived. So the toggle needs to say **which** projects it is adding and why they were
out, and **closed projects stay in the historical totals forever** (PRD §4.5: "Closed projects
remain in portfolio history totals forever"). Two numbers on the page: **live** and **including
closed**, labelled.

**Files:** `views/dashboard.ejs` (rewrite), `src/routes/app.js` (`/` route — or move it to
`reporting.js`; decide from the code and record which), NEW `test/portfolio.test.js`
(PF8.1–PF8.9, port **3927**), `TEST_PLAN.md`, plan.

**Tests:** a closed project is absent from the live tiles and present under the toggle, with the
same figure in each place; each close step excludes from its own list; a **blank** `spi_cum` renders
grey-not-green; a real breach renders red at a hand-computed value either side of the threshold;
the threshold is read from `app_settings` (change it → the tile changes); the portfolio totals equal
the sum of the projects **the user may see** (the BOLA rule — this exact page leaked project names
in the audit).

---

## Part 8.8 — Revenue recognition

**PRD §5.3**, four methods on `projects.revenue_method`: `milestone`, `poc`, `time_based`,
`on_billing`.

* **`poc`** reads **BAST acceptance %** from `acceptance_register` — **never** the internal tick %
  (PRD §5.3, emphatic). `revenue_recognized.acceptance_id` is the link, and `basis_pct` records the
  % used. The two numbers must be provably different in the test, or the test proves nothing.
* **`time_based`** straight-lines over the contract window (`projects.start_date`…`end_date`).
* **`on_billing`** recognizes exactly what is invoiced (join to `v_receivable` billed).
* **`milestone`** recognizes on an **approved** certificate — `acceptance_register.status =
  'accepted'`, not merely present.
* `method` must be **configured**; with `revenue_method` NULL the screen says "not configured"
  rather than defaulting to one. (Measured: it is NULL on the live project, so this is the *first*
  state a real user meets.)
* `UNIQUE(project_id, period_month)` means one recognition per month; re-running must be an **upsert
  or a refusal**, not a constraint error shown to the user. Decide and record which.
* **`cumulative`** is carried forward the way 019's `*_cum` columns are — an arithmetic running
  total, so a quiet month does not break the series.

**Files:** NEW `src/lib/revenue-service.js`, NEW `views/revenue.ejs`, `src/routes/reporting.js`,
NEW `test/revenue.test.js` (RV8.1–RV8.9, port **3928**), `TEST_PLAN.md`, plan, sidebar.

**Tests:** each method hand-computed on a fixture; **POC uses BAST % and NOT the tick %** — with a
fixture where the two deliberately differ; an unapproved certificate does not recognize; a second
recognition in the same month is refused/upserted deliberately (not a raw SQL error); recognition
posts **no ledger line** (it is not a cash movement); `billed ≠ recognized ≠ received` is proved as
three separate figures on one period (invariant 10); method not configured renders the stated empty
state.

---

## 3. Files likely to change

**New — migrations:** `db/migrations/020_ar_ap_document_scope.sql` (8.1),
`021_receivable_due_date.sql` (8.2), possibly `022_evm_variance.sql` (8.5, decide from the code).

**New — services:** `src/lib/forecast-service.js`, `src/lib/revenue-service.js`,
`src/lib/svg-chart.js`, possibly `src/lib/evm-service.js`.

**New — routes:** `src/routes/reporting.js`.

**New — views:** `views/aging.ejs`, `views/project-dashboard.ejs`, `views/revenue.ejs`.

**New — tests:** `test/reporting.test.js` (3921), `test/aging.test.js` (3922),
`test/reporting-screen.test.js` (3923), `test/forecast.test.js` (3924), `test/variance.test.js`
(3925), `test/dashboard.test.js` (3926), `test/portfolio.test.js` (3927), `test/revenue.test.js`
(3928).

**Modified:** `src/server.js` (mount), `src/lib/permissions.js` (+3 flags), `src/db/queries.js`
(report statements), `src/lib/cbs-service.js` (forecast path), `views/dashboard.ejs` (rewrite),
`views/cbs.ejs` (forecast section), `views/partials/sidebar.ejs` (Reports group), `db/schema.sql`
(regenerate), `TEST_PLAN.md`, this plan.

**Explicitly NOT changed:** `v_evm_period`'s per-period arithmetic, `cost_variance` (pinned by
EV7.6), `v_evm_period`'s `spi`/`cpi` guard (pinned by EV7.1/7.5), anything in Module 7's services.

---

## 4. Tests / validation

- Per part: its own file, then the full suite. **Floor is 446 and must only go up.**
- Test-run env: `PRACTIS_RL_LOGIN_MAX=100000 PRACTIS_RL_WRITE_MAX=100000 PRACTIS_RL_GLOBAL_MAX=100000`.
- **The correct suite command is `node --test --test-concurrency=1 test/*.test.js`** (what `npm test`
  runs). `node --test test/` is WRONG — it fails after ~119 s with "Could not find 'test/'".
- Long suites: foreground `terminal` caps at 600 s → `background=true` + `notify_on_complete=true`.
- Gates before each commit: `node db/dump-schema.js --check` (clean), `python3 db/validate.py`
  (ALL CHECKS PASS), `git var GIT_AUTHOR_IDENT` = the noreply alias, and
  `git show --format="" --name-status HEAD` must match the commit message's claims.
- **Every deny-case asserts the DATABASE, not the HTTP status alone** (a status-code-only assertion
  is not a security test — it is what missed B1–B3).
- **Every expected number is hand-computed in a comment.** A test that reads its expectation back
  out of the code under test proves nothing.
- Charts and dashboards assert on **emitted markup/numbers**, never on a screenshot: headless
  Chrome is unreliable on this 2 GB no-swap host (memory: bound every browser wait; prefer
  server-rendered evidence).

---

## 5. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Building the aging screen on the lying view** | the defect becomes a *displayed* fact, and the UI "confirms" it | 8.1 lands first, and 8.3's tests read the corrected view |
| **The AR fix moving real figures** | silently restates published receivables | RG8.6 re-asserts validate.py's four figures; and validate.py itself still runs in the gate |
| **The `funding` rule over-corrected** | legitimate partial payments stop netting, so paid invoices look unpaid | RG8.3 and RG8.4 pin both halves — same-doc nets, other-doc does not |
| **A dashboard re-deriving EVM arithmetic** | a second implementation drifts from the view and no one notices | dashboards read `v_evm_period`; DB8.4 asserts equality against it; the "compute it where it is produced" rule |
| **A blank index rendered green** | the exact class of lie 018/019 removed, reintroduced in CSS | PF8.3 pins grey-not-green for a blank index |
| **Closed projects leaking into live totals** | invariant 12, and the PRD's 3-step close becomes decorative | PF8.1/PF8.2; the toggle is explicit and labelled |
| **`contract_amount` edited after lock (F11)** | restates every variance silently | flagged for Module 10; the dashboard states its source figure |
| **A new root-mounted router answering 404s with /login** | the Express-5 path-list trap, already hit twice | every new router gets its own `PAGE_PATHS` array; MS6.8 covers the sidebar half |
| **Port collision** | two test files on one port fail nondeterministically | 3921–3928 measured free; grep `PORT = ` before every commit |
| **Scope creep across 8 parts** | context loss; a red suite with no attribution | one commit per part; stop for review after each; suite green before the next |
| **Charts needing client JS** | CSP forbids `unsafe-eval`; a CDN chart lib is a supply-chain risk and breaks print | server-rendered SVG (F8), zero client JS |

---

## 6. Decisions — ANSWERED by the owner 2026-10-03

Asked in plain language with a recommendation each (re-explained simply as short sentences with a
worked Rp example per question). **Owner answer: `1A 2A 3A 4A 5A` — every recommendation accepted.
These are now binding spec; the build must not deviate without a new decision.**

| # | Question | Options | Answer |
|---|---|---|---|
| **D1** | The register shows *"one document, minus 30 million"* and hides every real claim. How do we fix it? | **A** fix the view to follow the PRD ("type + document no") and require a claim line before a payment line is admitted · **B** keep the view, make Finance set a cost category on every claim · **C** leave it, label the screen with a caveat | **A ✅ (locked)** — B contradicts the PRD and leaves the already-written rows broken; C ships a known lie |
| **D2** | A receivable with no invoice date currently reports as *"120+ days overdue"*. What should it say? | **A** its own **"no date"** group · **B** "current" · **C** leave as 120+ | **A ✅ (locked)** — it is a real Finance to-do, and honest |
| **D3** | Due date = ledger date + payment terms. Where do the terms come from? | **A** project → client → a system default (30 days) in settings, and **say which applied** · **B** project only; blank if unset · **C** no due dates, age from invoice date | **A ✅ (locked)** |
| **D4** | Closed projects on the dashboards? | **A** hidden from live tiles by default, with an explicit "include closed" toggle that says what it added · **B** hidden entirely · **C** shown with a badge | **A ✅ (locked)** — invariant 12 says "by default", and PRD §4.5 keeps them in history totals forever |
| **D5** | How much of "forecast" belongs in Module 8? | **A** build it now (auto-EAC from CPI + per-month manual override) · **B** defer it to Module 9 and ship dashboards on the baseline · **C** auto-EAC only, no editable forecast | **A ✅ (locked)** — PRD §4.4 and §5.4 both name it, and §10 step 7 lists forecast with the dashboards |

**Already-decided defaults in this plan, flagged rather than re-asked** (say so if you disagree):
the traffic-light threshold is 0.95 read from `app_settings`; a blank index is grey;
charts are server-rendered SVG; the module is eight parts in the order above.

---

## 7. Immediate next action

**Write nothing until D1–D5 are answered.** Then: Part 8.1 first — migration 020, `test/reporting.test.js`
on port 3921, suite 446 → 452+, gates green, commit, STOP for review before 8.2.

Note for the VPS when this ships: migrations **016–021** (and 022 if 8.5 needs it) apply on
start-up, and `node src/db/seed-master.js` still has to be run **once** — unchanged from Module 7.
