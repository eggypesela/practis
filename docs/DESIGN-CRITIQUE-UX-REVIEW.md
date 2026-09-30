# PRACTIS — Design Critique + UI/UX Workflow Review

Date: 2026-09-26
Reviewer: Hermes (design-critique + uiux-workflow-review skills)
Artifacts reviewed: `design/mockups-v2/` (01 design system, 02 dashboard, 03 ledger,
04 LPB, 05 collapsed) — desktop 1440 + mobile 430.
Spec cross-reference: `docs/TECH-SPEC.md` §6.1 routes, §7 screen map; `docs/PRD-PRACTIS.md` §2 roles, §4 workflow.

---

## PART A — Visual / Design Critique

### Surface identification
PRACTIS is a **Monitor + Operate** surface: dense tables of money, exception queues,
and monthly data entry. Not Explore. Not marketing. Judge it on scan speed and
error-prevention, not on visual novelty.

### 10-Point Anti-Slop Audit — **Score: 1/10** (lower = better)

| # | Tell | Fired? | Evidence |
|---|---|---|---|
| 1 | Tech gradient | No | Flat surfaces, one accent |
| 2 | Generic tech hue | No | `#2563eb` explicitly chosen by user, not indigo default |
| 3 | Feature-tile grid | No | KPI cards carry live figures, not icon+heading+sentence |
| 4 | Accent rail | No | None |
| 5 | Unearned blur | No | No glassmorphism |
| 6 | Monument stat | No | KPI figures 22px, sized for data not drama |
| 7 | Icon topper | No | Icons sit inline in the KPI label, not as rounded-square toppers |
| 8 | Center stack | No | Left-aligned, real composition |
| 9 | Default type | **Conscious** | Inter is the documented tell — but user chose it deliberately and it matches PocketStash. Accepted trade, not an oversight. |
| 10 | Wrong surface | No | Dashboard is Monitor, correct |

**Verdict: composition is sound.** No re-layout required. Remaining work is
depth/semantics/state polish, below.

### Data-Density Audit

| Check | Result | Note |
|---|---|---|
| Mono for numerics | PARTIAL (by choice) | Option A = Inter + `tabular-nums`. Columns align; loses the "code texture" that separates IDs from prose. Accepted. |
| 3-font max | PASS | One family, weight-differentiated |
| Green/red semantics | PASS | `#22c55e` positive, `#b91c1c` negative, never decorative |
| Status chip treatment | PASS | 10–16% opacity bg + full-opacity text |
| Neutrals carry ~90% | PASS | Accent only on actions/active |
| Hierarchy via luminance | **FAIL** | Cards separate by border + `box-shadow` (`--sh`). Skill rule: elevation should be background lightness steps (`--bg` / `--surface` / `--surface-2`), shadow as secondary. Currently shadows do the work. |
| Header row = data row height | PASS | 31px consistent |
| Sticky headers | NOT DESIGNED | 8 rows shown; real ledger is 2,340 rows → header must stick |
| Density toggle | NOT DESIGNED | Spec calls the app dense; power users may still want a compact/comfortable switch |
| Row actions on hover | PARTIAL | Ledger row actions not visible in mockup |
| Charts: type fits task | **FAIL** | Dashboard has progress bars only. No CPI/SPI trend line, no cashflow series — both required by PRD §7 ("CPI/SPI, exceptions, cashflow"). A Monitor dashboard for cost control with no trend line cannot show trajectory. |
| Chart labelling | N/A | No charts yet to label |
| Filters: chips/counts/saved views/URL state | **FAIL** | Ledger has 4 plain dropdowns. No saved views, no counts on options, no URL state → filters are not navigation. High-frequency users re-select the same filter set every visit. |
| Empty states | **FAIL** | None designed. Skill rule: zero-data must explain WHY + next action (e.g. "No untagged lines — all 2,340 lines have a CBS code"). |
| Loading states (skeleton = final structure) | **FAIL** | None designed |
| Error states (specific + recovery) | PARTIAL | `PERIOD_FROZEN` code exists in spec; not designed into any screen |
| Contrast ≥4.5:1 | PASS (assumed) | `--t1` #0f172a on white; muted tones need verification per token |
| Focus visible | PASS | Blue focus ring defined |
| Touch targets ≥44px | **FAIL (mobile)** | 31px dense rows are below 44px. Correct for desktop mouse; on the 430px breakpoint the row becomes a finger target. Mobile tables need taller rows or the card-stack treatment. |
| No horizontal scroll at 320/768/1024/1440 | PARTIAL | Table scroll is intentional at 430; must confirm no *page-level* scroll at 768/1024 (iPad portrait is a real site-office device) |

### Prioritised issues

1. **[critical] Dashboard cannot show trajectory.** PRD requires CPI/SPI + cashflow; mockup ships progress bars only. A cost controller cannot see "are we drifting?" — the single most important question on this surface. Fix: add a CPI/SPI trend (12-month line, baseline vs actual) and a cashflow series.
2. **[major] Filters are not navigation.** 4 stateless dropdowns on the highest-frequency screen. Fix: saved views ("Unchecked only", "March, Citarum Bridge"), counts on options, URL-encoded state so a filtered view is shareable and bookmarkable.
3. **[major] No empty / loading / error states designed.** The app's hard cases (no data, 2,340 rows loading, frozen period) are exactly where users get lost. Fix: design the three states for the ledger and queue before building.
4. **[major] Elevation via shadow, not luminance.** Fix: use `--bg`/`--surface`/`--surface-2` steps as primary separation; keep shadow minimal.
5. **[minor] Touch targets under 44px on mobile.** Fix: taller rows ≤900px, or extend the card-stack pattern (already proven on dashboard) to ledger/LPB.
6. **[minor] Sticky table headers undefined.** With 2,340-row tables this is required, not optional.

---

## PART B — UI/UX Workflow Review

### Task inventory (ranked by frequency × importance)

| # | Task | Role(s) | Frequency | Surface |
|---|---|---|---|---|
| 1 | Ledger entry + CBS/WBS tagging | Finance → Cost Controller | Monthly, high volume | Operate |
| 2 | Cash Advance → Expense Report check | Project Admin → Cost Controller | Monthly, medium volume | Operate |
| 3 | Import Excel ledger (stage→preview→confirm) | Finance | Monthly | Operate |
| 4 | Project Update Report → freeze | Controller → PM | Monthly | Decide/Operate |
| 5 | BCR (baseline change) | Controller → Finance → PM | Occasional | Configure/Approval |

### ⚠️ Cross-cutting finding first: information architecture contradicts the spec

**The spec routes every money screen under a project** — `GET /projects/:id/ledger`,
`/projects/:id/queue`, `/projects/:id/expense-reports`, `/projects/:id/reconciliation`
(TECH-SPEC §6.1). The only portfolio-level screen is `/` (dashboard) and `/reports/*`.

**But my mockups present "Ledger" and "LPB Reconciliation" as top-level sidebar items
with an "all projects" filter** (03-ledger.png, 04-lpb.png). That is portfolio-scoped.

One of the two is wrong. Either:
- **(a)** The screens stay portfolio-wide (my mockup) → the spec routes need to change, and every row must display its project; or
- **(b)** The screens are project-scoped (spec) → the sidebar must nest them under a **project context switcher**, and the "all projects" filter disappears.

This is a genuine fork, not a style nit — it changes the nav, every route, and the
shape of every query. It needs your decision before either is built.

Related: **roles are per-project** (PRD §2.3) and one user may hold several, so nav
visibility must adapt to the selected project's role set. Not yet designed.

---

### Task 1 — Ledger entry + tagging (highest volume)

**Flow:** Login → Dashboard → Project → Ledger → "Add entry" form → save → navigate to Cost Controller queue → tag each line (CBS + WBS) → save.
(Across roles: Finance enters, Cost Controller tags. Two different people, two different pages.)

| Friction check | Verdict |
|---|---|
| Steps beyond 7±2 | OK (~7) |
| Info collected after it's needed | OK — tagging is deliberately a separate role |
| Happy path needs data user may lack | OK — doc no comes from the source document |
| Loading state | **Missing** |
| Empty state | **Missing** |
| Error state (frozen period) | **Missing in UI** — the code exists, the screen doesn't |
| Destructive action confirmation | PASS — corrections are reversing entries, never deletes |
| Data-loss risk on navigation | **At risk** — a long entry form with no draft/autosave |
| Keyboard path for repetitive entry | **Missing** — Finance types many lines a month; needs tab-through, Enter-to-save-and-keep, paste-from-Excel |
| Dead end | None |

**Severity 3 — no keyboard/bulk entry path.** Finance's monthly job is dozens of near-identical lines. Typing each into a mouse-driven modal is the single biggest time cost in the app.
**Severity 3 — no draft/autosave on the entry form.** Navigating away mid-entry can lose work; users then avoid the form until they have "enough time", which delays the month-end.
**Severity 2 — no "next untagged line" affordance.** After saving, the Cost Controller's queue is a separate page with no hand-off.
**Severity 2 — three UI states undesigned** (loading/empty/frozen-error).

**Best part of this flow:** tagging is a separate role from entry, and corrections are reversing lines — the ledger stays immutable and auditable. Keep that.

---

### Task 2 — Cash Advance → Expense Report check

**Flow:** Project Admin enters cash-advance usage lines (draft) → Cost Controller opens report → assigns/confirms CBS+WBS per line → checks → lines roll into cost actuals.

| Friction check | Verdict |
|---|---|
| Draft-until-checked model | PASS — strong, prevents untagged money entering cost |
| Progress visibility ("checked N of M") | **Missing** |
| Bulk check for volume | **Missing/undefined** |
| Partial failure (some lines invalid) | **Undefined** — 18 of 20 fine, 2 have a bad code: what happens? |
| Ambiguous exit | **At risk** — user can't tell if the report is fully checked |

**Severity 3 — no bulk check + no progress indicator.** A 40-line report one-checkbox-at-a-time, with no "12 of 40 done", is slow and leaves the component in an unknown state.
**Severity 2 — partial-failure handling undefined.** Must be specified: block the check, or check what's valid and flag the rest?

**Best part:** the advance is excluded from cost basis and only *checked* detail becomes actual cost. That's the correct accounting spine — keep it.

---

### Task 3 — Import Excel ledger

**Flow:** Upload → stage → preview (new vs skipped) → confirm → committed, immutable.

| Friction check | Verdict |
|---|---|
| Preview before commit | PASS — R2-27 gives new-vs-skipped counts |
| Row-level validation errors | **Missing** — must show line number + reason, with a downloadable error file |
| Irreversibility warning at confirm | **Missing** — commit is immutable per TS-24; the user must be told *before* confirming |
| Partial-failure policy | **Undefined** — reject whole batch, or import valid rows and quarantine bad ones? |
| Success verifiability | **Missing** — must state exactly what changed (N added, M skipped, reasons) |

**Severity 3 — no row-level error report.** An import that fails silently on row 47 of 200 wastes a whole cycle.
**Severity 3 — confirm dialog must state irreversibility** and the recovery path (reversing entries).
**Severity 2 — partial-failure policy must be explicit**, not implicit.

**Best part:** the stage → preview → confirm split is right; import never overwrites tagged lines. Keep it.

---

### Task 4 — Project Update Report → freeze

**Flow:** Controller compiles → review → PM approves → freeze period (posts to a frozen period are then rejected).

| Friction check | Verdict |
|---|---|
| Confirmation on irreversible action | **Missing** — freezing must state the consequence |
| Async job progress | **Missing** — generation is a job; needs progress + failure handling |
| Success state | **Missing** — must confirm which period froze and what changed |
| SoD enforced | PASS — PM cannot approve own submission |

**Severity 3 — freeze confirmation must name the consequence** ("No entries can be tagged to March 2026 after this. Later entries must be tagged to April and logged as a revision.").
**Severity 2 — job progress + failure path** undefined.

**Best part:** report generation is what freezes the period — EVM history can never be silently rewritten. Keep it.

---

### Task 5 — BCR (baseline change)

**Flow:** Controller initiates → Finance verifies → PM approves → baseline re-baselines (old numbers archived).

| Friction check | Verdict |
|---|---|
| Stale-item alert | PASS — spec alerts if pending > 3 days |
| Hand-off clarity (who is waiting on whom) | **At risk** — does Finance know they must act? Does the PM get notified the moment Finance verifies? |
| Reversibility | Irreversible by design — needs clear before/after |
| Before/after visibility | **Missing** — the approver must see old vs new numbers side by side |

**Severity 2 — hand-off notifications between verify → approve must be explicit.** A BCR stuck on an un-notified approver costs a month of baseline accuracy.
**Severity 2 — approver needs an old-vs-new diff view**, not just the request text.

**Best part:** the 3-day pending alert and the full audit trail (who asked, who approved, what changed). Keep it.

---

### Nielsen heuristic pass — violations

| # | Heuristic | Violation |
|---|---|---|
| 1 | Visibility of system status | No loading/empty/success states designed (Tasks 1–4) |
| 3 | User control and freedom | No draft/autosave on the ledger form (Task 1) |
| 5 | Error prevention | Import confirm doesn't warn of irreversibility (Task 3) |
| 5 | Error prevention | Freeze doesn't state its consequence (Task 4) |
| 7 | Flexibility / efficiency | No keyboard or bulk path for Finance's repetitive entry (Task 1) |
| 9 | Error recovery | No row-level import error report (Task 3) |
| 2 | Match with real world | PASS — glossary maps UI terms (Cash Advance, Expense Report) to the team's legacy terms |

### Severity tally

- **4** (catastrophe): 0
- **3** (major): 6 — no keyboard/bulk entry; no autosave; no bulk check/progress (Expense Report); no row-level import errors; no irreversibility warning at import confirm; no freeze consequence
- **2** (minor): 7 — next-untagged navigation; 3 missing UI states; partial-failure policies ×2; BCR hand-off notifications; BCR diff view
- **1** (cosmetic): 0

---

## Recommended next step (pick ONE)

**Decide the IA fork (Part B, cross-cutting finding): project-scoped vs portfolio-scoped money screens.**

Everything else — nav, routes, the project context switcher, role-adaptive visibility — is
downstream of that one answer. The visual critique's fixes (charts, filters, states) are
real but can proceed in parallel without blocking it.

Second priority after that: **design the three missing states (loading / empty / error)
and the bulk+keyboard entry path** — those carry most of the Severity-3 findings.
