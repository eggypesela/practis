# PRACTIS — BAST acceptance register (Module 8, part 8.9)

**Status: PLAN — awaiting approval before any build.**
Written 2026-10-04. Follows on from 8.8 (`4f021ee`, PUSHED).

## 1. Why this part exists

Part 8.8 built the revenue recognition screen, which reads **BAST acceptance certificates** to get
the POC basis. Measured after 8.8 landed: **`acceptance_register` has ZERO WRITERS in `src/`** — the
revenue-service only reads it. So the POC screen can truthfully say "no accepted certificate, 0%"
and will say that forever, because there is no way to enter a BAST.

The PRD already describes the table (§4.2: "Acceptance (BAST) → `b_project_acceptance_register`,
milestone % certificate (+ `sequence`)") and the distinction it carries (§4.3: **"Progress % ≠ client
acceptance %… BAST acceptance certificates drive external billing/revenue. POC revenue uses BAST%;
EVM uses tick%. Both stored; never conflated."**).

This part makes the external side enterable. It is the missing input for 8.8, not a new feature
bolted on.

## 2. Owner decision taken 2026-10-04

**Question:** how does a certificate reach the state that lets it count as revenue?
**Answer: A — three-step status.** staff record a **draft** → **submit** it → a **Project Manager**
**accepts** it. Only `accepted` counts as revenue.

Consequences of A, recorded so they are not re-litigated:
* The `status` column **IS** the workflow. **No** separate `approvals-service` chain — a register
  does not get two competing approval mechanisms.
* Because it is an acceptance decision, the accepting capability is the same one that approves the
  other registers: `canApproveProjects` (= `project_manager`).
* A `rejected` certificate does not count and is **not deleted** — the register is a record.

## 3. What already exists (NO MIGRATION)

Checked before planning:
* `acceptance_register` (migration 001) has: `certificate_no`, **`sequence`**, `description`,
  `percentage_progress` (CHECK 0–100), `document_date`, **`handover_date`**, **`accepted_date`**,
  `invoice_date`, `status` (CHECK draft/submitted/accepted/rejected), `created_at`, `created_by`.
* `revenue_recognized.acceptance_id` FK → `acceptance_register(id)` (migration 001).
* `revenue-service.js` already reads `status='accepted'`, sums `percentage_progress`, caps at 100
  and **reports the cap** (overlapping certificates).
* `views/revenue.ejs` already renders the accepted-certificate count.

**So the schema is complete.** The only things missing are a service, routes and a view. A migration
would add nothing — deliberately not written.

## 4. Files to change

| File | Change |
|---|---|
| `src/lib/permissions.js` | + `canManageAcceptance` (record/submit), `canApproveAcceptance` (accept/reject) |
| `src/lib/acceptance-service.js` | **NEW** — validate, insert, transition, audit |
| `src/routes/projects.js` | + `/acceptance` list, `/acceptance/new` + POST, `/:id/submit`, `/:id/accept`, `/:id/reject`; add `/acceptance` to `PAGE_PATHS` |
| `views/acceptance.ejs` | **NEW** — the register |
| `views/acceptance-new.ejs` | **NEW** — the record form |
| `views/partials/sidebar.ejs` | + Acceptance entry |
| `test/acceptance.test.js` | **NEW** — BA8.1–BA8.9, port **3929** |
| `TEST_PLAN.md`, plan | docs |

## 5. Capabilities

* **`canManageAcceptance = has('project_controller', 'project_manager', 'project_admin')`** — who
  may RECORD and SUBMIT. Follows `canManageWbs`'s pairing (the people who own progress) plus
  `project_admin` as the hands-on uploader.
* **`canApproveAcceptance = canApproveProjects`** (`project_manager`) — who may ACCEPT. Not
  `hasExact`: this is not a baseline change, and the register deliberately reuses the same approval
  capability as clients/suppliers so there is one answer to "who approves things here".
* **Read:** signed in (`canViewAcceptance: true`) — same reasoning as `canViewForecast`. The register
  is a project figure (what the client has signed off), not Finance's customer-by-customer ledger
  (which is why `canViewReceivable` is gated and this is not).

## 6. The rules the service enforces

1. **`status` transitions only:** `draft → submitted`, `submitted → accepted`, `submitted → rejected`.
   Anything else is refused with a reason. A certificate cannot go straight to `accepted` from the
   form — that is what decision A means.
2. **A rejected certificate cannot be accepted later** — a new certificate supersedes it (the
   `sequence` column exists for exactly this ordering).
3. **`accepted_date` is stamped by the ACCEPT action**, not typed by the submitter. A person accepting
   on a date is a fact about the acceptance, not about the submission.
4. **`percentage_progress` is required and 0–100.** The DB CHECK is the floor; the service names the
   field so the form can mark it.
5. **An accepted certificate cannot be edited or deleted** — the basis POC revenue was computed from.
   Attempting it is refused and the refusal is asserted against the database.
6. **Every transition is audited** via `q.audit('acceptance_register', …)` with before/after.
7. **`sequence` defaults to max+1 per project** when not supplied, so the register orders itself.

## 7. Tests (BA8.1–BA8.9, port 3929)

| ID | What it pins |
|---|---|
| BA8.1 | a draft can be recorded and is NOT counted as revenue (`acceptance_id` link intact) |
| BA8.2 | **`draft` cannot jump to `accepted`** — refused, DB unchanged |
| BA8.3 | `draft → submitted → accepted` moves `revenue-service.bastPct` from 0% to the certificate's % |
| BA8.4 | **a `submitted` certificate does not move the basis**; accepting it does |
| BA8.5 | **only `project_manager` may accept**; a viewer/cost_controller gets 403 **and the DB is unchanged** |
| BA8.6 | a **rejected** certificate never counts, and **re-accepting it is refused** |
| BA8.7 | an accepted certificate **cannot be edited or deleted**; both refused, DB unchanged |
| BA8.8 | `sequence` auto-increments per project and the register is ordered by it |
| BA8.9 | **the end-to-end claim:** record → submit → accept → 8.8's screen shows the revenue. Proven by reading the `/reports/revenue` HTML, not by trusting the service |

BA8.9 is the important one: it is the only test that proves the two parts connect.

## 8. Risks / open notes

* **Two people, one certificate.** `certificate_no` has no UNIQUE constraint (legacy data may
  repeat). The service will warn on a duplicate rather than refuse — refusing could block a
  legitimate re-issue. Flagged, not fixed.
* **The 100% cap** already exists in 8.8 and reports itself. This part should make overlapping
  certificates *visible in the register* rather than only on the revenue screen — but that is a
  nice-to-have; the cap already prevents a wrong number.
* **`invoice_date` is captured but nothing bills from it.** Recording it here does not create an
  invoice; the ledger still has no funded-invoice writer. Recorded as a gap.

## 9. Immediate next action

Build 8.9 as above: permissions → service → routes → views → tests → full suite
(**512 → ~521**) → commit → **STOP for approval**.

---

## 10. ✅ BUILT 2026-10-04

**Status: implemented, 9/9 BA8 tests green. NO migration, as planned. Suite 512 → 521.**

Owner decision A (2026-10-04): three-step status draft → submitted → accepted; only `accepted` counts
as revenue. `status` IS the workflow — no second approval chain.

Built exactly as planned. Three details worth keeping:

**`record()` hard-codes `'draft'` and ignores a posted status.** BA8.2 posts
`status=accepted&accepted_date=2026-01-01` and pins that BOTH are dropped and the row is still a
draft, because a form-level check is not a control. The same test pins that even the **PM** cannot
jump a draft straight to accepted (409), so decision A holds on both paths.

**`bastPct` is AS-AT-MONTH, and the tests initially got this wrong.** It counts certificates accepted
*by the end of* the month asked about. Accepting today and asking about March 2026 correctly gives
**0%**. The first draft of the tests accepted "now" and expected March revenue — an implementation
with a time machine would have passed. Every acceptance in the tests now carries an explicit past
`accepted_date`, and BA8.3 additionally pins that February's basis does NOT include a March
acceptance.

**The `sequence` and duplicate behaviour:** `sequence` auto-increments per project (BA8.4). A repeated
`certificate_no` is recorded as a **warning** (`duplicateOf`), not a refusal — the column has no
UNIQUE constraint and a re-issue legitimately repeats it. Flagged in the register rather than ignored.

**Other test-side traps this part hit:**
* **SQLite REUSES rowids after a DELETE**, so audits from earlier tests collided on the same
  `entity_id` (the action list read `create, create, create, submitted, accepted`). Fixed with
  `.slice(-3)`.
* **A baseline fixture needs an `rbs_load` row** totalling the same figure as the buckets, or
  `spreadBaseline` refuses it (§7.4 Σ invariant).
* **`cost_controller` holds NEITHER acceptance capability** — the recorder is a project_controller,
  the reader a cost_controller.

**Gaps (recorded, not hidden):** `invoice_date` is captured but nothing bills from it; no DB trigger
freezes `acceptance_register`, so that freeze is service-level only; `certificate_no` is not unique.

**Files:** NEW `src/lib/acceptance-service.js`, `views/acceptance.ejs`, `views/acceptance-new.ejs`,
`test/acceptance.test.js` (BA8.1–BA8.9, port **3929**); MOD `src/lib/permissions.js`,
`src/routes/projects.js`, `views/partials/sidebar.ejs`, `TEST_PLAN.md` §12t.
