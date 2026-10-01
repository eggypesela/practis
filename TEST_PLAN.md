# PRACTIS — Test Plan

**Authority:** `docs/TECH-SPEC.md` §8 (test strategy, module matrix, required invariants) and
`docs/PRD-PRACTIS.md` §4 (product workflow). This file tracks **what is actually asserted, by ID**.
Per-module tests are written RED→GREEN; the full suite must be green before any commit.

Run: `npm test` → `node --test --test-concurrency=1 test/*.test.js` (one temp-DB server per file, its
own port). Also run `python3 db/validate.py` — see §Schema below.

---

## 0. ID convention (fixed 2026-09-30)

**Previous IDs collided across files** — `C1.1` existed in three files, `A1.1`/`S1.3`/`T1.1` in two.
A duplicate ID makes traceability meaningless: "C1.1 failed" named three different tests.
**Every module owns a unique prefix**, and IDs are unique suite-wide:

| Prefix | Module | Test file | Port |
|---|---|---|---|
| `S` | Scaffold boot | `scaffold.test.js` | 3993 |
| `AU` | Auth: login, lockout, password | `auth.test.js` | 3995 |
| `CS` | CSRF + session lifecycle | `csrf.test.js` | 3995 |
| `LG` | Ledger entry (manual) | `entry.test.js` | 3997 |
| `IC` | Ledger correction (reversal) | `correct.test.js` | 3996 |
| `Q` | Tagging queue | `queue.test.js` | 3998 |
| `IM` | Ledger import (CSV) | `import.test.js` | 3999 |
| `CA` | Cash advance + Expense Report | `advances.test.js` | 3994 |
| `XO` | Checker options: Return / Block | `advances-options.test.js` | 3993 |
| `AD` | Administration / users | `admin.test.js` | 3993 |
| `AZ` | **Authorization matrix** (new, §0 of the dev plan) | `authz.test.js` | 3901 |

**Known legacy collisions to re-map when touched:** `advances.test.js` reuses `A1`,`E1`,`C1`,`S1`,
`R1`,`Z1`; `csrf.test.js` reuses `C1`,`S1`,`C2`,`C3`; `correct.test.js` reuses `C1`–`C4`;
`queue.test.js` reuses `T1`–`T4`; `auth.test.js` uses `T1`–`T5`. Re-map to the prefixes above as
files are next edited — do not leave two live meanings for one ID.

---

## 1. S — Scaffold boot

| ID | Test | Expected |
|----|------|----------|
| S1.1 | migrate runs on empty DB | schema at target version, tables exist, idempotent re-run |
| S1.2 | seed creates admin + project | admin user, roles seeded, project `PRJ-2026` |
| S1.3 | server boots, unauthenticated `GET /` | 302 → `/login` |
| S1.4 | login with seed creds | 302 → `/`, session cookie set |
| S1.5 | authed `GET /` | 200, dashboard renders KPI numbers |
| S1.6 | authed `GET /ledger` | 200, ledger rows render; whole-rupiah dot grouping |
| S1.7 | logout | session revoked, redirect to `/login` |

## 2. AU — Auth

| ID | Test | Expected |
|----|------|----------|
| AU1.1 | five wrong passwords | 429 + `locked_until` set |
| AU1.2 | correct password while locked | 429 (still generic) |
| AU1.3 | fresh seed is argon2id; legacy pbkdf2 upgrades at login | hash prefix changes on success |
| AU1.4 | wrong password vs legacy hash | does **not** upgrade it |
| AU1.5 | audit: `login_success` + failed attempts recorded | rows present |
| AU1.6 | unknown account always 401 | timing equalizer runs, no account disclosure |
| AU1.7 | **expired session** (absolute) treated as logged out | redirect to `/login` — *currently in `csrf.test.js` as "CS absolute expiry"* |
| AU1.8 | **idle timeout** (last_seen 31 min ago) | logged out — *currently CS idle* |

## 3. CS — CSRF + session lifecycle

| ID | Test | Expected |
|----|------|----------|
| CS1.1 | login page carries token, sets csrf cookie | both present |
| CS1.2 | POST without token | 403, no session issued |
| CS1.3 | POST with forged token | 403 |
| CS1.4 | token from another session rejected | 403 (session-bound) |
| CS1.5 | valid token | login succeeds |
| CS1.6 | login rotates session id | anti-fixation |
| CS1.7 | authed POST without token | 403 (ledger entry blocked) |
| CS1.8 | authed POST with header token | XHR path works |
| CS1.9 | logout requires token, revokes session | 403 without; revoked with |
| CS1.10 | `revokeUserSessions` kills others, spares caller | only caller's session survives |

## 4. LG — Ledger entry (manual)

| ID | Test | Expected |
|----|------|----------|
| LG1.1 | `GET /ledger/entry` renders form | 200 |
| LG1.2 | missing amount | 400, nothing posted |
| LG1.3 | non-integer amount | 400 |
| LG2.1 | valid Expense debit | posts; `line_role=expense`, `in_cost_basis=1` |
| LG2.2 | valid Income credit | posts; opposite side, `in_cost_basis=0` |
| LG2.3 | NULL type | `line_role=other`, `in_cost_basis=0` (conservative) |
| LG2.4 | entry writes a create audit row | row present |
| LG3.1 | `amount ≠ debit − credit` | aborted by trigger |
| LG3.2 | both sides set | aborted by trigger |
| LG3.3 | negative credit | aborted by trigger |
| LG4.1 | manual duplicate | ALLOWED (dedupe index is import-only) |
| LG4.2 | import duplicate | rejected at schema level |
| LG5.1 | POST without session | 302 `/login` |

## 5. IC — Ledger correction (reversal)

| ID | Test | Expected |
|----|------|----------|
| IC1.1 | `GET /ledger/:id/correct` | read-only line + reversal form |
| IC1.2 | DB refuses edit/delete of a posted line | trigger aborts |
| IC2.1 | reverse posts a negating line, original intact | both present, sums to 0 |
| IC2.2 | reversal with no CBS tag follows original into queue | appears in `v_untagged_queue` |
| IC2.3 | reversal carries original cost tags | nets to zero in CBS |
| IC2.4 | writes both audit trails | reverse + create rows |
| IC3.1 | cannot reverse twice | 409 |
| IC3.2 | DB refuses second reversal even if route bypassed | trigger aborts |
| IC3.3 | non-negating reversal | aborted by trigger |
| IC3.4 | reversal link never moved/cleared | trigger aborts |
| IC3.5 | reversal of another project's line | refused |
| IC4.1 | ledger flags reversed pair, hides Correct | `REVERSED #n` / `REVERSAL of #n` |
| IC4.2 | reversal needs session + CSRF token | 403 without each |
| **IC4.3** | **a Viewer cannot reverse** | **403 AND row count unchanged — MISSING (audit B1)** |

## 6. Q — Tagging queue

| ID | Test | Expected |
|----|------|----------|
| Q1.1 | `GET /queue` renders untagged lines with pickers | 200 |
| Q1.2 | untagged lines come from `v_untagged_queue` | all demo lines |
| Q2.1 | POST tag assigns CBS + WBS, checks the line | `cost_checked=1` |
| Q2.2 | tagging writes append-only audit row | row present |
| Q2.3 | tagged line leaves the queue | count decreases |
| Q2.4 | batch: several lines in one submit | all tagged |
| Q3.1 | rewriting an existing tag | aborted by trigger |
| Q3.2 | un-checking a line | aborted by trigger |
| Q3.3 | changing an amount | aborted by trigger |
| Q3.4 | deleting a ledger row | aborted by trigger |
| Q3.5 | audit rows append-only | update/delete aborted |
| Q4.1 | POST without session | 302 `/login` |
| Q4.2 | submit with no line ids | tags nothing |
| Q4.3 | submit with no action | tags nothing |
| **Q4.4** | **a Viewer cannot tag/check** | **403 AND `cost_checked` stays 0 — MISSING (audit B2)** |

## 7. IM — Ledger import (CSV)

| ID | Test | Expected |
|----|------|----------|
| IM1.1 | `GET /import` renders upload screen | 200 |
| IM2.1 | stage valid file | 201, **nothing written to ledger** |
| IM2.2 | missing required column | 400, no batch staged |
| IM2.3 | no file in request | 400 |
| IM2.4 | upload without CSRF header | blocked |
| IM3.1 | preview reports new vs invalid with row numbers | counts + line numbers |
| IM3.2 | Indonesian number formats + Revenue type map | parsed correctly |
| IM4.1 | confirm posts staged rows, `source=import`, audit | rows present |
| IM4.2 | re-confirm same batch | no-op (idempotent, TS-24) |
| IM4.3 | confirm never-staged → 409; unknown batch → 404 | both |
| IM5.1 | re-upload same rows | 0 new, skip recorded |
| IM5.2 | duplicate inside one file | skipped once, first wins |
| IM6.1 | imported row cannot bypass money triggers | aborted |
| IM6.2 | signing out does not expose import register | redirect |
| **IM2.5** | **oversize file → 413** (§8.2, §3.7) | **MISSING** |
| **IM2.6** | **formula cell `=`,`+`,`-`,`@` rejected, never evaluated** (§3.7 — guard exists at `csv.js:113`, untested) | **MISSING** |
| **IM2.7** | **filename never used as a storage path / no traversal** (§3.7) | **MISSING — no guard in code either** |
| **IM2.8** | **MIME/signature content inspection, not extension alone** (§3.7) | **MISSING — not implemented** |
| **IM4.4** | **a Viewer cannot stage or confirm** | **403 AND row count unchanged — MISSING (audit B3)** |

## 8. CA — Cash advance + Expense Report

| ID | Test | Expected |
|----|------|----------|
| CA1.1 | open a cash advance | `open`, non-zero whole rupiah |
| CA1.2 | non-whole or zero advance | refused |
| CA1.3 | viewer without relevant role | 403, not a hidden link |
| CA2.1 | Project Admin enters a usage line | lands as `draft` |
| CA2.2 | DRAFT line contributes NOTHING to actual cost | absent from `v_cbs_actual` |
| CA2.3 | the advance itself is never cost | excluded from cost basis |
| CA2.4 | non-whole amount | refused before the table |
| CA3.1 | checking sets `checked_by`/`checked_at`, is final | both set |
| CA3.2 | checked line cannot be edited/un-checked/deleted | aborted |
| CA3.3 | draft line cannot be checked without checker identity | aborted |
| CA3.4 | checking twice | refused |
| CA3.5 | a check must carry a CBS account | refused |
| CA4.1 | the ENTERER cannot also CHECK | SoD (test with a user holding BOTH roles) |
| CA4.2 | Cost Controller cannot enter lines | 403 |
| CA4.3 | Project Admin cannot check | 403 |
| CA4.4 | a rejection needs a reason, records the rejecter | both |
| CA5.1 | settlement with no detail | `missing_detail` |
| CA5.2 | detail matching settlement | `balanced` |
| CA5.3 | detail disagreeing | `difference` + the gap |
| CA5.4 | detail with no settlement yet | `awaiting_settlement`, NOT `missing_detail` |
| CA5.5 | un-numbered detail line cannot pollute reconciliation | excluded |
| CA6.1 | every module-5 page needs a session | redirect |
| CA6.2 | every module-5 POST needs a CSRF token | 403 |
| CA6.3 | Administrator can do everything (system owner) | all actions allowed |

## 9. XO — Checker options: Return / Block

| ID | Test | Expected |
|----|------|----------|
| XO1.1 | Project Admin cannot block or clear a block | 403 (checker's control) |
| XO1.2 | blocking needs a reason, records who blocked | both |
| XO1.3 | blocked line is NOT cost, and is visible to chase | absent from cost, present in "Needs attention" |
| XO1.4 | clearing a block returns to `draft`, then checkable | works |
| XO1.5 | a checked line cannot be blocked | refused (the check is final) |
| XO1.6 | a returned line cannot be silently checked later | refused — the fix is a new line |
| XO1.7 | correction closes the loop: new line links back | `superseded_by` set |
| XO1.8 | a check without a CBS account is refused | refused (missing-code hole closed) |
| XO1.9 | the CBS report can only contain attributable cost | no NULL-account row |
| XO2.1 | Project Admin can open the pot and its enter form | 200 |
| XO2.2 | Cost Controller sees screens but cannot enter lines | 403 on enter |
| XO2.3 | opening a cash advance needs the opening capability | 403 without |

## 10. AD — Administration / users

Covered today (31 tests, no IDs assigned yet): anonymous blocked · non-admin 403 on pages and POSTs ·
invitation creates a DISABLED account · token stored hashed · cannot sign in before accept ·
malformed email/name/role refused · short/mismatched password refused · invite link works once ·
reissue invalidates previous · revoke kills the link · invite to an existing account refused ·
disable revokes sessions · re-enable restores · unknown user 404 · role change revokes sessions ·
promote/demote sets/clears the system flag · **last administrator cannot be demoted or disabled** ·
reset issues temporary password + clears lockout · every admin action audited.

**Assign `AD1.x`–`AD6.x` on the next edit.**

## 11. AZ — Authorization matrix (NEW — §0 of the dev plan)

**The missing layer.** 148/148 green while a Viewer could write money, because authorization was tested
in only two places (`admin.test.js`, `advances*.test.js`). `test/helpers/authz.js` exposes
`asRole(origin, roleCode)` — seed a user, demote via the test's **own** better-sqlite3 handle, return a
logged-in client per role.

**Every mutating route × every role must assert all four cases:**

| # | Case | Expected |
|---|---|---|
| 1 | anonymous | 302 `/login` (page) or 401 (JSON) |
| 2 | no CSRF token | 403 |
| 3 | **authenticated WRONG ROLE (Viewer)** | **403 AND the DB row count is UNCHANGED** |
| 4 | correct role | succeeds |

**Case 3's row-count assertion is the point.** A status-code-only test passes on every bug below.

| ID | Test | Expected |
|----|------|----------|
| AZ1.1 | Viewer → `POST /ledger/entry` | 403, `accounting_ledger` count unchanged |
| AZ1.2 | Viewer → `POST /ledger/:id/reverse` | 403, no reversal row, one-shot slot intact |
| AZ1.3 | Viewer → `POST /queue/tag` | 403, `cost_checked` still 0 |
| AZ1.4 | Viewer → `POST /api/imports` (stage) | 403, no batch |
| AZ1.5 | Viewer → `POST /api/imports/:id/confirm` | 403, ledger count unchanged |
| AZ1.6 | Viewer → `GET /ledger/entry`, `/queue`, `/import` | 403 (no form you cannot submit) |
| AZ2.1 | Finance → ledger entry + reversal | allowed |
| AZ2.2 | Cost Controller → queue/tag | allowed; → ledger entry | 403 |
| AZ2.3 | Project Admin → enter expense line | allowed; → check | 403 |
| AZ2.4 | anonymous → each of the five writes | 302/401 |
| AZ3.1 | no-CSRF → each of the five writes | 403 |

## 12. Cross-project isolation (BOLA) — NEW, currently UNIMPLEMENTABLE

PRD §2.3 requires **per-project role assignment**: *"users are assigned a role per project. PM sees
own projects; Finance sees all cost data; Viewer sees assigned dashboards."*
`user_roles.project_id` exists for exactly this — and is **NULL in every row and consulted by zero
code** (`permissions.js` and `app.js` never read it).

**Measured:** with two projects, a user reads and *writes* every project by changing `?project=<id>`:
`/ledger`, `/queue`, `/advances`, `/` and `/ledger/entry` all returned project B's data, and a POST
wrote a ledger row into project B.

| ID | Test | Expected |
|----|------|----------|
| BOLA1.1 | user scoped to A cannot read B's ledger | 403/404, no B data in body |
| BOLA1.2 | user scoped to A cannot write into B | 403, B's row count unchanged |
| BOLA1.3 | `?project=<unauthorised>` falls back to an authorised project | never silently serves B |
| BOLA1.4 | Finance sees all projects; Viewer sees only assigned | per PRD §2.3 |
| BOLA1.5 | global reference data (COA/WBS/RBS) remains company-wide | readable regardless of scope |

**Blocker:** needs a project-scope predicate in `permissions.js` + enforcement in `projectContext`.
Cannot be written until that layer exists — **do not close this as "test missing"**.

---

## 13. Workflow coverage vs PRD §4

The product workflow, step by step, and whether a test exists. **Empty rows are the real answer to
"is the edge case in the test plan" — most of the workflow has no test because it is not built.**

| PRD § | Workflow step | Status |
|---|---|---|
| 4.1 | Initialisation: create project, assign roles **per project**, COA/WBS/CBS setup, team, client/supplier, approval chain | ❌ **no tests, no UI** (skipped §10 step 3; Module 6) |
| 4.2 | Planning: WBS tree, milestones + weights, RBS load, CBS budget, **baseline**, **freeze** | ❌ no tests (Module 7) |
| 4.3 | Execution: progress ticks → EV · actual cost from ledger + checked lines · revenue recognition · billed vs received | ⚠️ **partial** — actual cost ✅ (CA2.2, XO1.9); ticks, revenue, billed≠received ❌ |
| 4.4 | Monitoring: EVM SPI/CPI, forecast, variance, **de-scope/BCR**, aging, dashboards | ❌ no tests (Module 8) |
| 4.5 | Closing (3-step): close, final reconciliation, archive, **hide from live dashboards** | ❌ no tests (Module 8) |

### TECH-SPEC §8.4 required invariants — coverage

| # | Required invariant | Status |
|---|---|---|
| 1 | `amount = debit − credit` | ✅ LG3.1, `validate.py` |
| 2 | One side only on user entry | ✅ LG3.2 |
| 3 | Every imported transaction group balances to zero or is quarantined | ❌ not tested |
| 4 | Cash advances + bulk LPB settlement excluded from cost basis | ✅ CA2.3 |
| 5 | Only checked detail contributes actual cost | ✅ CA2.2, CA3.1 |
| 6 | Historical WBS stays NULL until human assignment | ⚠️ implicit in Q1.2, not asserted directly |
| 7 | **Frozen period rejects ordinary backdated writes** | ❌ **untested AND unenforced** — `frozen_periods` table exists, 0 rows, **no trigger, no route, no `src/` reference** |
| 8 | **BCR approval required before baseline mutation** | ❌ untested (Module 7) |
| 9 | Requester cannot approve own record | ⚠️ SoD for *check* ✅ CA4.1; **approval chain** ❌ (Module 6) |
| 10 | **Billed ≠ recognized ≠ received** | ❌ untested (Module 8) |
| 11 | Import never overwrites tagged lines; duplicates skipped/counted | ✅ IM5.1, IM5.2 |
| 12 | **Closed projects hidden by default from live dashboards** | ❌ untested (Module 8) |

### TECH-SPEC §8.1 test layers — status

| Layer | Status |
|---|---|
| 1. Schema/contract (`validate.py`) | ⚠️ **exists and passes, but tests a STALE `db/schema.sql`** — see §14 |
| 2. Unit | ✅ (money, formats, mapping, reconciliation) |
| 3. Integration | ✅ 148 tests, real SQLite from migrations, no mocks |
| 4. Security | ⚠️ **partial** — auth/CSRF/fixation ✅; authorization ❌, BOLA ❌, XSS ❌, upload safety ❌, rate-limit per-IP ❌, CSP ❌ |
| 5. **E2E critical path** (login → create project → baseline → progress → expense → check → report → freeze) | ❌ **no test** — impossible until Modules 6–8 exist |
| 6. **Recovery** (backup restore to isolated path, FK check, migration rehearsal) | ❌ **no test** (Module 10) |

---

## 14. Schema-validator drift (found 2026-09-30)

`db/validate.py` executes **`db/schema.sql`** and asserts DB-level invariants — it passes ("ALL CHECKS
PASS"). But the app runs **`db/migrations/`**, and the two have diverged:

| Object | migrations | schema.sql |
|---|---|---|
| tables | 43 | 44 (+`schema_migrations`) |
| views | 9 | 9 (**`v_lpb_reconciliation`, `v_cbs_actual` differ**) |
| triggers | **21** | **14** |

**7 triggers exist only in the migrations** — including `trg_ledger_reversal_must_negate`,
`trg_ledger_reversal_link_immutable` and `trg_lpb_checked_requires_cbs`. Also `accounting_ledger`,
`lpb_statements`, `cash_advance` and `import_batches` have **different DDL**, and `validate.py` never
sees `block_reason` / `superseded_by`.

So the schema validator is green while the guards it claims to verify are absent from the schema it
reads. It also is **not wired into `npm test`** — it runs only if invoked by hand.

| ID | Test | Expected |
|----|------|----------|
| SCH1.1 | `schema.sql` DDL is byte-identical to the migrated result | no drift |
| SCH1.2 | `schema.sql` contains all 21 triggers | none missing |
| SCH1.3 | `validate.py` runs inside `npm test` | non-zero exit fails the suite |
| SCH1.4 | migration rehearsal: fresh DB reaches `user_version` 9 | matches dev |

---

## 15. Required fixtures — declared, unused

| Artifact | Spec | Reality |
|---|---|---|
| `db/fixture-ledger-export.tsv` (26 rows) | §8.3: "regression-checked **on every run**" | **exists (28 lines), referenced by ZERO tests** |
| `db/seed-smoke.sql` | §8.3: every test DB seeded from it where domain data is needed | **exists, used by nothing** — tests use `seed-master.js` + `seed-demo.js` |

| ID | Test | Expected |
|----|------|----------|
| FX1.1 | real-ledger fixture imports with 0 invalid rows | all 26 rows parse |
| FX1.2 | fixture regression: totals + dedupe match the frozen expectation | stable across runs |

---

## 16. Priority of the gaps

1. **AZ1.x** + **`authz.test.js`** — five money-writing routes accept any session. Fix + test (§0 of
   the dev plan). *Highest.*
2. **BOLA1.x** — cross-project read **and write** leak; needs the scope layer built first.
3. **§14 schema drift** — the validator cannot be trusted until `schema.sql` matches the migrations.
4. **IM2.5–IM2.8** — upload edge cases (oversize, formula, traversal, signature).
5. **§8.4 invariants 7 + 12** — frozen period (unimplemented) and closed-project hiding.
6. **FX1.x** — wire the real-ledger fixture in.
7. **Security layer remainder** — CSP, per-IP rate limit, XSS escaping test.

**None of items 2–7 should start before item 1.**
