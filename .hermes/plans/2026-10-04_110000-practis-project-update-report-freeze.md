# PRACTIS — Project Update Report + period freeze (Module 8, part 8.10)

**Status: PLAN — awaiting approval before any build.**
Written 2026-10-04. Follows 8.9 (`6682624`, committed, not yet pushed).

## 1. What the "Module 8 remainder" actually is

The plan file for Module 8 ends at part 8.8, so "period freeze + report generation" was never
written down as a part. Reconstructed from the binding specs:

* **PRD §5.4:** *"**Project Update Report** — scheduled monthly: SPI, CPI, receivable vs revenue,
  payable status, exceptions, prior-baseline vs current comparison."*
* **PRD §4.4:** *"Project Controller compiles the Project Update Report… generated on a monthly
  schedule, reviewed by Controller, **approved by PM, then frozen for the period**."*
* **PRD §4.4 month-end calendar (hybrid freeze):** *"**When a period's Project Update Report is
  generated, that period freezes:** entries tagged to a frozen period are rejected by the system and
  must be tagged to the next period… This preserves EVM history: old reports stay truthful."*
* **`project_reports` table** (exists since migration 001, **ZERO WRITERS in `src/`** — measured):
  `project_id`, `period_month`, `status` (`draft`/`reviewed`/`approved`/`frozen`), `spi`, `cpi`,
  `cost_variance_pct`, `receivable_amount`, `revenue_recognized`, `payable_amount`, `payload_json`,
  `generated_at`, `approved_by`, `approved_at`, `frozen_at`, `UNIQUE(project_id, period_month)`.

**What already exists and must NOT be rebuilt:** freezing works **today** as a **manual
Administrator action** — `GET /periods`, `POST /periods/freeze|unfreeze` (`src/routes/app.js`, gated
`requireAdmin`, backed by `src/lib/periods.js`). That was task 0.10 and it is fine. The gap is that
freezing is **manual only**: nothing ties it to report generation, and nothing writes
`project_reports`, so there is no report surface at all.

**Nothing exists for:** generating a report, the reviewed → approved → frozen chain, or the report
body. This part supplies all of it, and **no migration is needed** — the table is already there.

## 2. THE DESIGN QUESTION THAT NEEDS THE OWNER'S DECISION

**When exactly does the period freeze?** The PRD says two different things and only one can be true:

* §4.4 prose: *generated → reviewed → **approved** → **then frozen*** — the freeze is last.
* §4.4 calendar: *"when a period's report is **generated**, that period freezes"* — the freeze is
  first.

They cannot both hold. This is a genuine product decision, not an implementation detail, because it
decides whether a freshly generated report can still be corrected.

| Option | Behaviour | Trade-off |
|---|---|---|
| **A (recommended)** | **Freeze on APPROVAL.** Generating produces a *draft*; the month stays writable while Controller reviews and PM approves; **the approval freezes the period** (and writes `frozen_periods`). | A typo or a late entry discovered during review is still fixable — which is the point of reviewing. Matches the report's own `status` column ending at `frozen`, and matches §4.4's own sentence order. Slightly contradicts the calendar bullet. |
| **B** | **Freeze on GENERATION**, exactly as the calendar bullet says. | Literal PRD compliance. But the period is locked before anyone has read the report: a wrong SPI/CPI is then only correctable through the reversal path, and "reviewed/approved" become bookkeeping *after* the doors closed. |
| **C** | **Keep it manual**: the report is generated and stored, and an Administrator still presses freeze on `/periods` when ready. | Smallest change, no new automation, and the Admin keeps explicit control. But the PRD's "hybrid freeze" is then not implemented at all, and the two features (report, freeze) stay unconnected — a PM can approve a report for a month that is still open. |

**Recommendation: A.** It is the only option where "reviewed" and "approved" mean anything, and it
makes the freeze a consequence of a *reviewed* artefact rather than of pressing a button. The
calendar bullet's intent — *old reports stay truthful* — is satisfied by A just as well, because the
freeze still happens in the same month-end act.

## 3. Proposed build (Part 8.10)

**Service** `src/lib/report-service.js`:

* `generate({ projectId, month, actorId })` — compile the report **from the services already built
  in Module 8**, never by re-deriving the maths here:
  * `spi` / `cpi` / `cost_variance_pct` ← `v_evm_period` via the 8.5 variance columns (`cpi` must be
    the **latest month with a REAL measurement**, per 8.4's rule — not the latest row);
  * `receivable_amount` ← 8.1/8.2 aging;
  * `revenue_recognized` ← 8.8 `revenue-service`;
  * `payable_amount` ← ledger payables;
  * `payload_json` ← the full body: **exceptions** (which alerts from PRD §4.4's table fired) and
    the **prior-baseline vs current comparison** (BCRs applied this period, from Module 7).
  * **Refuses if a report for that month already exists** (UNIQUE) unless explicitly regenerating a
    `draft`; a `frozen` report is never regenerated.
* `review({ id, actorId })` — `draft → reviewed`.
* `approve({ id, actorId })` — `reviewed → approved`; **and, under option A, freezes the period**
  (writes `frozen_periods` through the existing `src/lib/periods.js` — no new freeze mechanism).
* `reportFor(projectId, month)` and `list(projectId)`.

**Capabilities:** generate + review = project_controller / project_manager / project_admin
(`canManageReport`); **approve = project_manager** (`canApproveReport`) — reusing the established
split so "who approves things" has one answer. Reading a report follows the existing report guards.

**Routes** (in `src/routes/reporting.js`): `GET /reports/update` (the month's report or its empty
state), `GET|POST /reports/update/generate`, `POST /reports/update/:id/approve`. **`/reports/update`
must be added to `REPORT_PATHS`** — the Express 5 guard only covers listed paths (learned at 8.8).

**Views:** `views/report-update.ejs` (the report body + the flow controls),
`views/reports-index.ejs` (a row), `views/partials/sidebar.ejs` (a link beside Revenue).

**Freeze wiring:** on approve, call the existing `periods.freeze(projectId, month, actorId)`. A test
must prove a **backdated entry to the frozen month is then REFUSED** — that is the entire purpose of
the feature, and it is the only assertion that would catch a freeze that only writes a row.

## 4. Tests (UP8 series, port 3930) — expected suite 521 → ~530

| # | Claim |
|---|---|
| UP8.1 | Generating on a month with no measurement produces a report whose SPI/CPI are **stated as absent**, not zero |
| UP8.2 | The report's figures EQUAL the services they came from (SPI/CPI vs `v_evm_period`, revenue vs `revenue-service`) — no re-derivation drift |
| UP8.3 | `cpi` is dated by the **latest month with a real measurement**, not the latest row (8.4's carry-forward trap) |
| UP8.4 | Generating the same month twice does not silently overwrite a non-draft report |
| UP8.5 | **draft → reviewed → approved** is the only path; `draft → approved` is refused |
| UP8.6 | **Only a Project Manager approves**, and a refusal leaves the DB unchanged |
| UP8.7 | **Approve FREEZES the period, and a subsequent backdated ledger write to that month is REFUSED** — the point of the whole part |
| UP8.8 | A `frozen` report cannot be regenerated or re-approved (409), and its figures do not move |
| UP8.9 | The prior-baseline vs current comparison names the BCRs applied in the period, and is empty (not blank-but-implied) when none were |

**UP8.7 is the one that matters.** Everything else could pass with a report that is just a stored
row; only UP8.7 proves the report actually closes the period.

## 5. Deliberately NOT in this part (recorded as gaps, not faked)

* **PDF + Excel export pack with the light print theme** (PRD §5.4) — a substantial separate piece.
  The report body is designed so a later part can render it without reshaping the data.
* **The 30-second browser polling / in-app alert inbox** for the PRD §4.4 alert table — this part
  *records which alerts fired* into `payload_json`; delivering them is a separate concern.
* **Scheduled automatic generation** (PRD: "monthly schedule") — this part makes generation a
  deliberate act. A cron/scheduler is a later part; nothing here blocks it.
* **`c_wbs_forecast` / `c_cbs_forecast` manual forecast updates** (PRD §4.4 step 1) — the tables may
  not exist yet; out of scope here.

## 6. Immediate next action

Await the owner's answer on §2 (freeze on **approve** vs **generate** vs stay manual). Then build
8.10 as §3: service → capabilities → routes → views → UP8 tests → full suite (**521 → ~530**) →
commit → **STOP for approval**.

---

## 11. ✅ BUILT 2026-10-04

**Status: 8.10 COMPLETE — service, routes, view, 9 tests (UP8), all green; full suite 521 → 530.**

Owner decision **A** confirmed 2026-10-04 ("Freeze on Approval"): the period freezes when the report
is APPROVED, not when it is generated.

### What was built

| Piece | Where |
|---|---|
| Report compile + store + status machine + freeze | `src/lib/report-service.js` (413 lines) |
| Routes | `src/routes/reporting.js` — `GET /reports/update`, `POST .../generate`, `POST .../:id/review`, `POST .../:id/approve` |
| Screen | `views/report-update.ejs` |
| Capabilities | `src/lib/permissions.js` — `canViewReport`, `canManageReport`, `canApproveReport` |
| Freeze recording the report | `src/db/queries.js` — `freezePeriodForReport` → `frozen_periods.report_id` |
| Sidebar + index | `views/partials/sidebar.ejs`, `views/reports-index.ejs` |
| Tests | `test/report-update.test.js` (UP8.1–UP8.9, port 3930) |

### Decisions taken during the build (all recorded in code comments)

1. **`status` is a DRAFT → REVIEWED → FROZEN ladder; `approved` is never a resting state.** Approval
   and the freeze are one act (decision A), so the row lands on `frozen`. `approved_by`/`approved_at`
   still record who approved it.
2. **The report COMPILES, it does not compute.** SPI/CPI come from `v_evm_period`; revenue from
   revenue-service; receivables from `v_aging`. The only figure computed here is
   `cost_variance_pct`, and UP8.2 pins every one of them against its owning service.
3. **The position is dated by the last measured month AT OR BEFORE the report's month**
   (`measuredAt`), not `forecast.latestCumulative`. Quoting December's CPI on a March report is a
   silent lie about a month nobody measured.
4. **`freezePeriodForReport` records `report_id`** — migration 001 created the column and nothing had
   ever written it. An Administrator's manual freeze leaves it NULL, so the two doors stay
   distinguishable.
5. **One alert is named as NOT CHECKED.** PRD §4.4 wants "progress not updated in 14 days"; there is
   no per-line "last progress at" column, so the report says so rather than letting an absent alert
   read as a clean bill of health.

### Bugs the tests caught (all real)

| Bug | Caught by |
|---|---|
| The route nested locals under a `locals:` key; `page()` spreads its argument flat, so the view threw `periods is not defined` and Express answered **500** | A new "the page actually renders" assertion in UP8.6 — the 403 checks passed anyway |
| `exceptionsFor` still referenced the removed `th` variable after the two-threshold fix | UP8.2 (`ReferenceError`) |
| My own test asserted the **receivable** moved when cost was booked — it cannot; receivables come from invoices. Changed to assert CPI | UP8.4 |
| My own test hit a non-existent `GET /reports/update/generate` (404, not the 403 it expected) | UP8.6 |
| My own test hardcoded CPI 0.625 but ran after an earlier test added cost (0.5882) | UP8.9 |

### Still not built

- **PRD §5.4 PDF + Excel exports** with a light print theme. Deliberately out of scope; the report
  body is shaped so they can be added without a redesign.
- Module 8 is otherwise complete.

---
