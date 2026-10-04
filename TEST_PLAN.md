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
| `SCH` | **Security hardening**: FULL sync, CSP headers, rate limit | `security.test.js` | 3905–3907 |
| `FX` | **Real-ledger fixture** regression (§8.3) | `fixture.test.js` | 3908 |
| `BOLA` | **Cross-project isolation** (scope, §0 task 0.9) | `bola.test.js` | 3902 (gate off) + 3903 (gate on) |
| `FP` | **Frozen periods** (§0 task 0.10, TECH-SPEC §8.4) | `periods.test.js` | 3910 |
| `PR` | **Portfolio register** (Module 6 tasks 6.1–6.3, §10 step 3) | `projects.test.js` | 3904 |
| `SCH-ERR` | Error pages: 404 contract + 500 content negotiation | `error-pages.test.js` | 3933 |

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

**Implemented 2026-09-30 (commit `e5fbd1d`): 17 tests, all green.** Actual shape differs slightly from
the sketch above — the suite that landed is:

| ID | Test | Assertion |
|----|------|-----------|
| AZ1.1–AZ1.3 | Viewer / PM denied `POST /ledger/entry`; **Finance allowed** | 403 + `accounting_ledger` count unchanged; allow-case asserts 302 + count +1 |
| AZ2.1–AZ2.3 | Viewer / PM denied `POST /ledger/:id/reverse`; **Cost Controller allowed** | 403 + zero reversal rows (one-shot slot intact) |
| AZ3.1–AZ3.3 | Viewer / PM denied `POST /queue/tag`; **Cost Controller allowed** | 403 + `cost_checked` still 0 |
| AZ4.1–AZ4.4 | Viewer/CC denied import stage; Viewer denied confirm; **Finance allowed** | 403 JSON + no batch staged; confirm asserts ledger unchanged |
| AZ5.1–AZ5.4 | Page visibility | Viewer 403 on `/ledger/entry` + `/import`; Viewer 200 on `/ledger`; Finance 200 on both forms |

Two rules the implementation enforces, worth keeping:
- **Every deny-test asserts the DATABASE, not the status.** Row counts are the evidence; a 302/200 is
  not.
- **Every capability gets an allow-test too.** A guard that blocks everyone is also a bug, so the
  permitted role must still get through.

`test/helpers/authz.js` signature is `asRole(Database, dbPath, origin, roleCode, opts)` — it takes
`Database` as an argument and uses its **own** better-sqlite3 handle. Never `require('../src/db/db')`
in a test helper: that binds the default DB path and the assertions silently read the wrong file.

## 11b. SCH — Security hardening (NEW — tasks 0.3–0.5)

`test/security.test.js`, ports **3905–3907**. Covers the three hardening tasks; 12 tests.

| ID | Test | Notes |
|----|------|-------|
| SCH-SYNC.1 | app connection runs `synchronous = FULL` | in WAL this pragma is **per-connection and not persisted**, so it must be asserted on the app's own connection |
| SCH-HDR.1–.6 | headers on every response; per-response nonce; nonce echoed on the page's own tags; no HSTS on plain HTTP; headers survive a CSRF 403 | HSTS only when HTTPS |
| SCH-HDR.7 | **no inline `on*=` handler survives on any page** | nonces do not authorise handler attributes — they need `unsafe-inline`; strip comments/scripts before matching or the rule's own comment false-positives |
| SCH-RL.1 | repeated logins from one IP → 429 | spawns its own server with tight `PRACTIS_RL_*` limits |
| SCH-RL.2 | **a token-less spray still hits the limiter** | guards the middleware ordering: if CSRF moved ahead of the limiter, a 403 spray would never be counted and the limiter would be bypassable |
| SCH-RL.3 | import API limited, answers **JSON** | mounts on a sub-path, so the handler must read `req.originalUrl` — `req.path` is stripped to `/` |
| SCH-RL.4 | ordinary browsing is not throttled | the global backstop must stay generous |

**Runner note:** `npm test` exports generous `PRACTIS_RL_*` limits because ~16 logins from 127.0.0.1
across the suite share one per-IP bucket; without it unrelated tests 429. The SCH-RL tests therefore
spawn their own servers rather than hammering the shared one.

## 12. Cross-project isolation (BOLA) — ✅ IMPLEMENTED 2026-10-01

PRD §2.3 requires **per-project role assignment**: *"users are assigned a role per project. PM sees
own projects; Finance sees all cost data; Viewer sees assigned dashboards."*
`user_roles.project_id` existed for exactly this and was **NULL in every row and consulted by zero
code** — so with two projects, a user read and *wrote* every project by changing `?project=<id>`.

Now enforced by `projectsFor(user)` in `src/lib/permissions.js` + `src/middleware/scope.js`
(`projectContext`), with assignments recorded on the admin screen and backfilled by migration 010.

**Enforcement is behind `SCOPE_ENFORCE=1` (default OFF)** — decision 4A: backfill first, enforce
second, because "assigned only" over an all-NULL column refuses every existing account. The tests
therefore run BOTH modes, on ports **3902 (gate off)** and **3903 (gate on)**.

| ID | Test | Expected | Status |
|----|------|----------|--------|
| BOLA1.1 | the switcher lists every project for an org-wide role | both projects in the menu | ✅ |
| BOLA1.2 | a scoped user is NOT offered an unassigned project | no link carrying the other id | ✅ |
| BOLA1.2b | a multi-project user IS offered each authorised project | menu works, not just hidden | ✅ |
| BOLA1.3 | gate OFF: `?project=other` falls back instead of leaking | 200, own project's data only | ✅ |
| BOLA1.4 | gate ON: `?project=other` refused with a reason | 403, no data, "not assigned" | ✅ |
| BOLA1.5 | gate ON: the user's own project still works | 200 — the guard is not a blanket deny | ✅ |
| BOLA1.6 | gate ON: Finance reaches both projects | per PRD §2.3 | ✅ |
| BOLA1.7 | **gate OFF: a cross-project WRITE still does not land** | row count unchanged | ✅ |
| BOLA1.8 | gate ON: the same cross-project write is refused | 403, row count unchanged | ✅ |
| BOLA1.9 | gate ON: the permitted role can still write its own project | 302 **and** +1 row | ✅ |
| BOLA1.10 | a role-less account sees no project data | fail closed, not fail open | ✅ |
| BOLA1.11 | unassigned global role keeps full visibility (v1 fallback) | documented behaviour, asserted | ✅ |
| BOLA1.12 | the admin screen records a per-project assignment | scoped row written, global row survives | ✅ |
| BOLA1.13 | clearing the assignment restores the default | no lock-out | ✅ |
| BOLA1.14 | an Administrator cannot be scoped | stays portfolio-wide | ✅ |
| BOLA1.15 | migration 010 leaves every account able to reach its project | no role left unassigned, all projects granted | ✅ |

**BOLA1.7 is the one that matters most.** "Enforcement off" means *the `?project` parameter is not
authoritative* — it must never mean *cross-project writes are allowed*. The audit's five original
bugs all returned a cheerful 302 while writing, so every deny-case asserts a **row count**, not a
status code.

**Also fixed in this slice:** `GET /` called `q.projects()` (the whole portfolio) instead of the
authorised set, so a project-scoped user's dashboard listed projects they are not on. Now
`res.locals.projects`.

**Not covered here, deliberately:** global reference data (COA / WBS / RBS) stays company-wide — it
is shared master data, not project data, so BOLA1.5's original sketch is satisfied by construction:
nothing in the scope layer filters a master-data query.

---

## 12b. FP — Frozen periods — ✅ IMPLEMENTED 2026-10-01

TECH-SPEC §8.4 requires *"Frozen period rejects ordinary backdated writes"* and *"the flagged
revision path remains explicit"*. The `frozen_periods` table has existed since migration 001 with
**zero rows, no trigger, no route and no reference anywhere in `src/`** — the invariant lived in the
spec and nowhere in the system, so a reported month could be backdated silently.

Enforced by `db/migrations/011_frozen_period_enforcement.sql`; resolution helpers in
`src/lib/periods.js`; freeze/unfreeze at `POST /periods/{freeze,unfreeze}` (`requireAdmin`), with the
screen at `GET /periods`. Port **3910**.

**The period follows `COALESCE(effective_date, date)`.** `effective_date` is the accounting date and
is what `v_ledger_period` groups by. Freezing on `date` alone would let a row into a frozen month by
backdating one column — FP1.6 asserts that path is closed.

**The door is the existing reversal mechanism, not a new flag** (decision 2026-10-01). A reversal
carries `reverses_ledger_id`; it is already the only legal way to correct a posted line, already
enforced by `trg_ledger_reversal_link_immutable` / `_must_negate`, and `lib/ledger-correction.js` is
its only writer. A parallel `revision_of` flag would be a second mechanism for the same job.

| ID | Test | Expected | Status |
|----|------|----------|--------|
| FP1.1 | a backdated write into a frozen month is refused | 400, message names the month, **period total unchanged and zero rows written** | ✅ |
| FP1.2 | the revision door: a reversal into a frozen month is admitted | 302, reversal negates, total moves by exactly the correction | ✅ |
| FP1.3 | unfreezing restores ordinary writes | refused while frozen, accepted after | ✅ |
| FP1.4 | a month that is not frozen is unaffected | 302, lands in its own period | ✅ |
| FP1.5 | freeze/unfreeze is audit-logged with the actor | 2 rows in `audit_log` | ✅ |
| FP1.6 | **the TRIGGER is the floor** — a direct insert is refused with no route involved | aborted, including a row dated elsewhere but **effective** in the frozen month | ✅ |
| FP1.7 | freezing is refused for a non-Administrator | 403, and provably no period frozen | ✅ |
| FP1.8 | a row accounted in an open month cannot be **walked** into the frozen month by editing `effective_date` | UPDATE aborted; NULLing it likewise; and the same UPDATE succeeds once unfrozen | ✅ |

**FP1.6 and FP1.8 are the two that matter.** FP1.6 asserts the database is the guarantee and the
route only a courtesy — the app can be bypassed. FP1.8 came out of `db/validate.py` failing, not out
of reasoning: `effective_date` is *deliberately* editable (it is the sanctioned accounting-date
correction, and `validate.py` asserts it stays that way) and it is the column the reports group by,
so a row posted in a frozen month but accounted elsewhere could be walked into it by one UPDATE —
the same hole as the insert, reached one statement later. `trg_ledger_frozen_period_effective_date`
closes it.

**Where the rule is deliberately NOT enforced:** `lpb_statements` is guarded at the **check**
transition, not the draft insert. An lpb line is not cost until checked (`v_cbs_actual` and
`v_ledger_period` count `status='checked'` only), so a draft dated in a frozen month is harmless and
must stay legal — guarding it would block ordinary data entry for a month with no accounting effect.

**Known limit, recorded rather than pretended away:** the lpb door admits a line that a
previously-checked line points at via `superseded_by`. In the current correction flow that column is
only written at check time, so an lpb correction inside a frozen month is refused and an
Administrator must unfreeze. The ledger reversal door — the one the operator has a button for — is
unaffected. Widening it needs an lpb correction flow that marks the replacement before it is checked.

**Also fixed in this slice:** `db/seed-smoke.sql` has always frozen project 1 / **2026-01** as a
smoke fixture, and `validate.py` was writing throwaway probe rows **into** that month. Those probes
now live in open months, so a rejection there is once again the rule under test rather than the
frozen guard firing first.

---

## 12c. PR — Portfolio register — ✅ IMPLEMENTED 2026-10-01

The sidebar links `/projects` on **every page** and it returned **404**: `views/partials/sidebar.ejs`
had the link, no route existed. `src/routes/projects.js` + `views/projects.ejs` now serve it,
mounted in `src/server.js` after `routes/api`.

| ID | Assertion |
|---|---|
| PR1.1 | `GET /projects` renders the register with every visible project (was 404) |
| PR1.2 | contract value is rendered grouped (`12.480.000.000`) and baseline state is **labelled**, not blank |
| PR1.3 | house UI contract: `.hd` block carries `<h1>Projects</h1>` + a non-empty muted sub-title |
| PR1.4 | the sidebar switcher offers **each** project as a real `<a href="/?project=N">` |
| PR1.5 | anonymous → 302 `/login` |
| PR1.6 | a project-scoped user sees their project and **not** the one they are not on (asserted as DATA) |
| PR1.7 | a one-project user's page renders exactly **1** project code (no whole-portfolio leak) |

Two traps this file encodes, both of which would have produced a **false pass**:

- **PR1.4 needs TWO projects.** With one authorised project the sidebar deliberately renders a
  disabled button and no menu, so an "offers every project" assertion is vacuous. The test seeds
  `PRJ-2027`.
- **PR1.7 counts rendered codes, not status.** `q.projects()` (whole portfolio) and
  `projectsFor(user)` (authorised set) both render a perfectly good 200 — only counting the rows
  distinguishes them. This is the same class of bug as the dashboard leak in the BOLA audit.

Also: the scope on this page comes from `projectsFor(req.user)` directly, **not** `q.projects()`.

## 12d. PR2 — Project register + approval — ✅ IMPLEMENTED 2026-10-01

Registering a project in-app (PRD §4.1 steps 1–6), with the approval chain living in `approvals` as
rows, never a boolean column.

| ID | Assertion |
|---|---|
| PR2.1 | a Project Admin registers; the project starts **not baselined** and **not approved**, `created_by` recorded |
| PR2.2 | the create is audited; the **actor is not** notified to approve their own registration |
| PR2.3 | revenue method is required (PRD §4.1 step 5) |
| PR2.4 | an invalid revenue method is refused with a sentence, not a SQL error |
| PR2.5 | a duplicate code is **409**, not a 500 |
| PR2.6 | end date before start date is refused |
| PR2.7 | payment terms must be a positive whole number of days |
| PR2.8 | a Viewer cannot register (403 **and** row count unchanged) |
| PR2.9 | a Cost Controller cannot register (not a §4.1 initiator) |
| PR2.10 | **a different** PM approves; the `approvals` row records who and when |
| PR2.11 | the approval is audited, `self_approved: false` |
| PR2.12 | approving twice is 409 and adds no second row |
| PR2.13 | **the creator cannot self-approve without a reason** (DB still `pending`) |
| PR2.14 | **the creator CAN self-approve with a reason** — stored on the approval AND in the audit trail |
| PR2.15 | a one-character reason is not enough |
| PR2.16 | a Viewer cannot approve (403 and still pending) |
| PR2.17 | an edit is audited and **cannot change the project code** |
| PR2.18 | the register surfaces the approval state it manages |
| PR2.19 | the register offers no Register link to a Viewer |

**The load-bearing decision (owner, 2026-10-01).** LIGHT approval (8A) makes the PM both creator and
approver. A blanket `approver ≠ requester` rule deadlocks a one-person install — every project would
sit unapproved forever. The rule is therefore: **self-approval is allowed with a typed reason
(≥10 chars) recorded in the audit trail**; a different approver needs none. PR2.13/PR2.14 pin both
halves, so the control can never silently degrade to either "impossible" or "rubber stamp".

**Test-harness traps this file hit (all produced misleading failures):**

- **`client.post()` takes a URL-encoded body STRING.** Passing an object stringifies to
  `[object Object]`, CSRF rejects it, and the test sees **403** — which looks exactly like an
  authorization bug. `new URLSearchParams({...}).toString()`.
- **`res.text` is a METHOD, not a property** (undici Response). `assert.match(res.text, ...)` throws
  `Received type function`; the fix is `await res.text()`. This looked like a page-content failure.
- **`asRole()` generates one email per role**, so two tests using the same role in the same DB collide
  on `UNIQUE constraint failed: users.email` unless each passes a distinct `email` option.

---

## 12e. PR3 — Client register — ✅ IMPLEMENTED 2026-10-01

The client register (PRD §4.1 "Client register"), sharing the approval chain with the project register.

| ID | Assertion |
|---|---|
| PR3.1 | a client can be registered; starts NOT approved; the full chain is recorded |
| PR3.2 | the create is audited; the actor is not notified to approve their own record |
| PR3.3 | a duplicate code is 409, not a 500 |
| PR3.4 | payment terms must be positive when given (0 and negatives refused) |
| PR3.5 | a malformed email is refused with a sentence |
| PR3.6 | a Viewer cannot register (403 **and** row count unchanged) |
| PR3.7 | **the creator cannot self-approve without a reason** (DB still `pending`) |
| PR3.8 | **the creator CAN self-approve with a reason** — on the approval AND the audit trail |
| PR3.9 | a **different** approver needs no reason, `self_approved: false` |
| PR3.10 | approving twice is 409 and adds no second row |
| PR3.11 | a Viewer cannot approve (403 and still pending) |
| PR3.12 | an edit is audited; a posted code is **ignored**, not honoured |
| PR3.12b | an edit in the REAL UI shape (disabled code not submitted) succeeds |
| PR3.13 | a client is deactivated, never deleted (history stays readable) |
| PR3.14 | the register lists clients and surfaces approval state |
| PR3.15 | anonymous `/clients` redirects to `/login` |
| PR3.16 | the client list is **not** filtered by the selected project (org-wide master data) |
| PR3.17 | a project registers against a client and the register shows the client NAME |
| PR3.18 | the project form offers the client's payment terms as a default |

**The control is now shared, not copied.** Task 6.2 put the segregation-of-duties rule inside
`projects-service.js`; 6.3 extracted it to `src/lib/approvals-service.js` so projects, clients and
(6.4) suppliers all enforce ONE copy. PR3.7/PR3.8 mirror PR2.13/PR2.14 deliberately: if someone
"fixes" one register's rule and not the other's, one of the pairs fails.

**Plan 6.5b says "keep requester ≠ approver in all cases" — that is not implementable here.** Taken
literally it deadlocks a one-person install: the same operator creates and approves everything, and
nothing would ever be approved. The owner's decision (2026-10-01) is "self-approval allowed with a
written reason, recorded in the audit trail", applied uniformly.

**The plan's stated basis for this task was factually wrong, and the code was not changed to match it.**
Plan 6.3 says `clients.payment_terms_days` is what `v_aging` due dates depend on, and that a NULL
"silently breaks the aging report". In the real code:
- `v_aging` buckets on **fixed 30/60/90/120-day** offsets from `invoice_date` (PRD §5.2) and never
  reads `payment_terms_days`.
- PRD §5.2 does specify "Due date = ledger date + payment terms" — a due-date column that **does not
  exist yet**. Wiring it belongs to Module 8, where the aging report screen lives (plan line 772).
So the column is validated as the business term it is (positive days) without inventing a coupling
that isn't there. The misleading UI label "drives the aging report due date" was removed.

**Two real bugs found by building this, both fixed:**

1. **`clients` had no `created_by` column** (projects did). The SoD rule reads it, so the client
   register could not evaluate the control at all. Migration **012** adds it to `clients` **and**
   `suppliers`, so 6.4 does not need a second migration.
2. **Every edit through the real UI failed.** `validate()` required `code` on update, but the edit
   views render the code `readonly disabled` — a browser does not submit a disabled input. PR2.17
   passed only because the test posted `code=HACKED` explicitly. Fixed in both services; PR2.17 now
   posts no code, PR2.17b proves a crafted code is ignored, and PR3.12b is the regression guard.

**Test-harness lesson:** a test that posts fields a browser would not post can pass while the real UI
is broken. When a field is disabled on purpose, the test must mirror the browser.

**CARRY-OVER DEFECTS FIXED IN THE NEXT COMMIT (this one shipped two red tests — a true report, not a
green one):**

- **AZ4.4** — "Finance CAN stage and confirm" failed with `8 !== 9`. `test/authz.test.js`'s
  `csvWith()` built a **single debit line**: a legal per-row shape, but not a double entry. §8.4 now
  quarantines it, so the row never reached the ledger and the test failed for a *balance* reason while
  looking like an authorization failure. Fixed by writing a real two-line entry (debit the cost,
  credit the bank, both against seeded COA codes) and asserting `before + 2`. **Do not "fix" this by
  weakening §8.4** — the export's own shape is two-leg and the fixture proves it.
- **I8.4** — "EVERY page route demands a session" reported `/invite/1` as a leak. It is not: the
  invitation-acceptance page MUST be public (a new user has no session yet), and it is safe because
  the token is the credential (32 random bytes, stored only as a hash, one generic message for
  missing/used/revoked). The route was simply absent from the test's `PUBLIC` list. Also note the
  list is now matched **before** the `:param → 1` substitution, so it can name the real route.
  **A test that accuses the code is not automatically right — check whether the data is legitimately
  public before "fixing" the app.**

---

## 12g. SP4 / TM4 — Supplier + team registers — ✅ IMPLEMENTED 2026-10-02

PRD §4.1 "Supplier register" (Procurement → Finance → Admin) and "Team register" (Admin creates the
team and its roles, invites members). The supplier register is the **third** consumer of
`approvals-service.js`, which is the point: the identical rule must hold in all three.

### Supplier (`test/suppliers.test.js`, port 3911)

| ID | Assertion |
|---|---|
| SP4.1 | registering records **all four** PRD §4.1 steps as `pending`; create is audited |
| SP4.2 | a duplicate code is refused with a sentence, no second row |
| SP4.3 | a supplier needs a name (whitespace is not a name) |
| SP4.4 | a malformed email is refused |
| SP4.5 | **an edit posting NO code (the real browser shape) still saves** |
| SP4.6 | a posted `code=SP-HACKED` is **ignored** — the code is set once |
| SP4.7 | a **different** approver needs no reason, `self_approved: false` |
| SP4.8 | the creator **cannot** self-approve without a reason (DB still `pending`, no actor) |
| SP4.9 | the creator **can** self-approve with a reason — stored on the approval **and** the trail |
| SP4.10 | approving twice is refused and adds no second approved row |
| SP4.11 | a Viewer cannot register (403 **and** row count unchanged) |
| SP4.12 | a Viewer cannot approve (403 and still `pending`) |
| SP4.13 | a supplier is deactivated, never deleted |
| SP4.14 | the register lists suppliers for a signed-in user |
| SP4.15 | an unknown supplier id is a 404 page, not a crash |
| SP4.16 | anonymous `/suppliers` redirects to `/login` |

### Team (`test/teams.test.js`, port 3912)

| ID | Assertion |
|---|---|
| TM4.1 | creating a team writes the row and an audit event |
| TM4.2 | a duplicate code is refused, nothing written |
| TM4.3 | a team needs a name |
| TM4.4 | the team list and the roster render |
| TM4.5 | an unknown team id is a 404 page |
| TM4.6 | anonymous visitors are redirected to sign in |
| TM4.7 | assigning an existing account sets `users.team_id` and audits it |
| TM4.8 | adding someone already in the team changes nothing (no second audit row) |
| TM4.9 | moving a member records **both** the old and the new team |
| TM4.10 | removing a member clears the assignment, keeps the account, **leaves roles untouched** |
| TM4.11 | inviting into a team creates the invitation **and** the membership in one step |
| TM4.12 | a Project Manager cannot create a team (403, nothing written) |
| TM4.13 | a Project Manager cannot open the team screens (403) |
| TM4.14 | a Viewer cannot add a member (403, DB unchanged) |
| TM4.15 | **a team carries NO approval chain** (`approvals` has zero `team` rows) |
| TM4.16 | editing posts no code and a crafted code cannot rename the team |

**Design decisions worth recording:**

- **Membership IS `users.team_id`.** The schema has no junction table (`db/schema.sql` line 546), so
  "add a member" is an assignment on the account, not a link-table insert. Moving someone records both
  ends so "who was where when" stays readable.
- **A team grants nothing.** Access comes from `user_roles`. TM4.10 and TM4.14 pin this: team changes
  must never touch a role row. Conflating a team with a permission set is the specific failure mode
  this register invites.
- **No approval chain for teams.** `approvals-service.js` covers project/client/supplier — registers of
  *parties*. A team is an internal grouping; PRD §4.1 gives it no verify/approve steps, and inventing
  one would be inventing a control. TM4.15 asserts the absence.
- **Invitations reuse `invites.sendInvite`.** The plan is explicit that a second invite path must not
  be written — two paths means two places for the token/expiry/hashing rules to drift. TM4.11 asserts
  a real `user_invitations` row, i.e. the shared machinery actually ran.
- **`suppliers.approved_by` / `approved_at` are deliberately left unmaintained.** They are legacy
  columns (nothing in `src/` reads them) that can hold one name and one date. The `approvals` table is
  authoritative because it records *which step*, by whom, when and why. Filling in the legacy pair too
  would create a second source of truth for the same fact, and the two would drift.

---

## 12h. SCH-ERR — error pages (404 contract + 500 content negotiation) — ✅ IMPLEMENTED 2026-10-02

| ID | Assertion |
|---|---|
| SCH-ERR.1 | a **browser** hitting a crashing page gets an HTML page (and `500.ejs` compiles) |
| SCH-ERR.2 | a client asking for JSON (`Accept: application/json`) still gets JSON |
| SCH-ERR.3 | a throw inside an **`/api/`** route returns JSON even though fetch sends `Accept: */*` |
| SCH-ERR.4 | a browser asking for `text/html` gets HTML, not JSON |
| SCH-ERR.5 | the 500 body never leaks the error message or stack (information disclosure) |
| SCH-ERR.6 | the 404 handler renders the `404` view with the documented locals |

The 500 handler previously answered `res.json({error:'internal error'})` for **every** request, so a
signed-in user whose page hit a bug saw the raw string `{"error":"internal error"}` — no navigation, no
way to tell whether their data saved. Meanwhile a *typo* in a URL got a properly designed 404 page.

The content-negotiation rule is **not** a naive `Accept: text/html` test: `fetch()` and XHR send
`Accept: */*`, so an error inside the import screen (an `/api/` route) must still answer JSON or the
screen tries to parse `<!DOCTYPE` as JSON. The URL space is the deciding signal
(`req.path.startsWith('/api/')`), mirroring how `requireApiCapability` already separates the two.

The handlers were **inline in `server.js`**, where no test could reach them — which is precisely why a
defect this visible survived 266 passing tests. They now live in `src/lib/error-handler.js` with a unit
test, so the error path is testable without a router internals hack.

---

## 12i. MA5 — Master data screens — ✅ IMPLEMENTED 2026-10-02

PRD §5.5. Nine datasets (`coa`, `cashflow`, `costcat`, `rescat`, `wbs`, `rbs`, `cbs`, `industry`,
`projecttype`) driven by ONE registry in `src/lib/master-service.js`.

| ID | Assertion |
|---|---|
| MA5.1 | the index and all nine lists render |
| MA5.2 | an unknown dataset is a **404, not a guess** |
| MA5.3 | anonymous `/master` redirects to `/login` |
| MA5.4 | Finance can add a cost category; a duplicate code is refused (no second row) |
| MA5.5 | a required name is enforced |
| MA5.6 | **an edit posting no code saves; a crafted `code=HACKED` cannot rename the row** |
| MA5.7 | **WBS structure is ADMIN-only** — Finance is refused, DB unchanged (PRD §8 "Ask first") |
| MA5.8 | **CBS is FINANCE-allowed** — the gate is not admin-only everywhere |
| MA5.8b | an Administrator may change WBS structure |
| MA5.8c | a Viewer cannot write master data at all |
| MA5.9 | **report integrity:** deactivating an UNUSED bucket moves no `v_cbs_actual` total |
| MA5.10 | deactivating a bucket still IN USE is allowed, audited, and its ledger line still reports |
| MA5.11 | reactivating restores the row |
| MA5.12 | industry/project types accept an edit and have **no** deactivate action (no `active` column) |
| MA5.13 | a lookup pointing at nothing is refused (no dangling reference) |
| MA5.14 | a valid lookup is accepted and the LIST shows the label, not the id |
| MA5.15 | a list page carries a title and a sub-title (owner UI rule) |

**The gate is two-level, and that is the point.** PRD §8 "Ask first" makes WBS/RBS *shape* changes an
Administrator decision; a cost bucket or ledger account is day-to-day Finance work. A single
admin-only rule would pass a naive test and lock the Cost Controller out of the lists they tag with.

**Nothing is deleted, and MA5.9 proves it against the VIEW.** `transaction_accounts` is the column
`v_cbs_actual` groups by, so a delete or a rename could silently re-bucket a historic cost report.
The test seeds a real ledger line onto one bucket, deactivates a *different* bucket, and asserts the
report total is unchanged. It also asserts the row SURVIVES — a hard delete would have passed the
"total unchanged" assertion while destroying the row.

**Unknown dataset = 404.** The dataset key is a URL segment resolved against the registry, so
`/master/anything-else` is a clean 404 rather than a crash or a guess.

---

## 12j. MS6 — Project WBS/milestone defaults + sidebar contract — ✅ IMPLEMENTED 2026-10-02

| ID | Assertion |
|---|---|
| MS6.1 | a newly registered project gets a **15-node tree copied from the master menu** |
| MS6.2 | the tree nests: a child's parent is in the SAME project; top-level codes have none |
| MS6.3 | every WBS line carries the four defaults in order; **none is ticked** |
| MS6.4 | the four defaults carry **equal 25% weights** (decision 7A) and every line has exactly four |
| MS6.5 | the tree build is audited (`wbs_defaults_created`) with node/milestone counts |
| MS6.6 | a second project gets its OWN tree — no cross-project parents, 30 distinct rows |
| MS6.7 | **no sidebar link is a dead `href="#"`** |
| MS6.8 | **every sidebar link resolves to a real route** (200 or a deliberate 302, never 404) |
| MS6.9 | the sidebar offers Master data, and Finance can OPEN it while WBS writes stay admin-only |

**The empty-default problem this fixed.** PRD §5.1 says the project WBS tree comes from the
company-standard menu and each line carries the default milestones. Until task 6.6 a project
registered *through the UI* got **no tree and no milestones at all** — the seed script only ever
touched the single demo project. So there was nothing to tick and no way to record progress. The
gap was invisible in every existing test because none of them created a project and then looked for
its tree.

**MS6.4 is deliberately brittle.** `% complete` derives from the milestone weights (PRD §5.1), so if
decision 7A is ever revisited this test should fail loudly rather than let the number move quietly.

**MS6.7 and MS6.8 are a pair.** One asserts every link works; the other asserts no `href="#"` exists.
Without the second, the five removed dead links could come back one at a time and each removal would
be "fine" in isolation.

**Master data sits under a new Setup group, not Administration.** The Cost Controller and Finance
need it to maintain the buckets and accounts they tag with, and the Administration group is hidden
from them entirely — so an Administration placement would have made task 6.5 useless to its main
users. MS6.9 pins both halves: Finance can open `/master`, and still cannot write WBS structure.

**Identity leak (FIXED 2026-10-02):** the repo-local git identity was set to the personal Gmail
address rather than the `…@users.noreply.github.com` noreply alias the history rewrite used, so the
five commits after `eaf8def` (7c9cef3, 0f2c851, efc40b7, 241a4fb) republished it on the PUBLIC repo,
undoing that part of the rewrite. `git config user.email` is now the noreply alias for this repo, and
the already-pushed commits were rewritten so no commit metadata carries the address.

**A first draft of this note repeated the address verbatim**, which published it a second way — inside
a blob, where an email rewrite alone would not have reached it. It has been redacted and the blob
scrubbed. **Never write the PII you are reporting into the artefact that reports it.**

---

## 12k. EV7 — EVM acceptance: SPI and CPI are real, honest numbers — ✅ IMPLEMENTED 2026-10-03

`test/evm.test.js`, port **3920**. **This is the Module 7 gate** (plan part 7.8): everything the
module built exists to feed `v_evm_period`, and these tests measure that view directly — no mock,
through the real services, on a real migrated database.

| ID | Assertion |
|---|---|
| EV7.1 | a baseline with **no progress** gives a real PV, and **SPI/CPI are NULL — not 0** |
| EV7.2 | with ticks + tagged costs, **SPI = EV/PV = 5** and **CPI = EV/AC = 2.5**, computed by hand |
| EV7.3 | a second project's baseline **does not leak** into this project's rows (nor ours into theirs) |
| EV7.4 | PV equals the month's baseline rows **exactly** — a change order's new version is not added in |
| EV7.5 | **no row anywhere** claims an index it cannot compute; and real measurements are not blanked |
| EV7.6 | `cost_variance` is still **AC − EV** — the deliberate non-change is pinned |
| EV7.7 | every baseline month is reported **once**, in order — no month dropped by the FULL OUTER JOINs |
| EV7.8 | **`pv_cum`/`ev_cum`/`ac_cum` accumulate**, and every per-period figure is **untouched** by 019 |
| EV7.9 | **`spi_cum`/`cpi_cum` = EV_cum ÷ PV_cum / AC_cum**; same honesty rule (NULL, never 0) |
| EV7.10 | a month with **no activity carries the running totals forward** (the trend line never breaks) |
| EV7.11 | no cumulative index ever **contradicts its own numerator and denominator** (property check) |

**Two real defects were measured and closed by migration 018.** Migration 018 is the one
production change 7.8 needed, and the plan predicted it would need none — so the anomaly is
recorded rather than glossed.

1. **An index of `0` where no index exists.** The view gated each index on its denominator only,
   while folding a missing EV into a real `0` first. Measured on the seeded dev database:
   with a plan and no progress → `spi = 0`; with costs and no progress → `cpi = 0`. Both zeros are
   **claims** — "totally behind schedule", "cost efficiency is zero" — when the truth is that
   nothing has been measured. PRJ-2026 returned exactly `cpi = 0` for 2026-03
   (pv 0, ev 0, ac 175,000,000). The view's own guard already returned NULL for
   "cannot be computed"; the **numerator** was simply never covered. Now both must be non-zero.
2. **PV double-counting (F2), re-pinned from the report side.** Part 7.4 closed the version axis
   in the view (migration 014) and the account-total axis at the service (015). EV7.4 asserts it
   from where a user would notice: a month's PV equals its baseline rows, counted once.

**Verified before and after on the seeded database:** 6 impossible zeros became NULL, **no real
figure moved**, and `validate.py`'s existing "EVM Feb values present" assertion still passes
(Feb keeps `spi = 1.5`, `cpi = 2`).

**Deliberately NOT changed:** `cost_variance`. Nothing reads it and its sign convention is a
separate decision, so it is pinned as-is (EV7.6) rather than quietly "fixed".

**Honest scope limit, now CLOSED by migration 019.** This view's per-period `spi`/`cpi` answer
*"how did this month go?"*. Standard EVM also reports **cumulative** indexes — *"is the project
ahead or behind?"* — and those were **not derivable** from the per-period columns (you cannot add
monthly indexes). That was flagged to the owner as a decision rather than silently fixed, and the
answer was to add them: **migration 019** adds `pv_cum`, `ev_cum`, `ac_cum`, `spi_cum`, `cpi_cum`,
**additively** — no per-period column changes (proved by EV7.8). The reason it is a migration and
not Module 8 dashboard arithmetic is the rule this module has been bitten by three times: a number
must be computed where it is produced, not by each reader.

**The trap that bit 019's first draft, worth remembering:** a window function emits a row only for
its own input rows, so `SUM(ev) OVER (…)` over the `ev` CTE left the running total NULL in every
month that had no progress — producing *"reading, blank, blank, blank"*, i.e. the per-period problem
again with the blanks moved. The fix is an explicit **month grid** (the union of the months in
`pv`, `ev` and `ac`), so every month has a cumulative row and an idle month carries the total
forward. EV7.10 pins it.

**Still per-period and deliberately so:** `spi`/`cpi` themselves. They answer a real question
("which month slipped?") and removing them to force one scale would lose information.

---

## 12l. RG8 — Register honesty: the AR/AP join and the aging bucket — ✅ IMPLEMENTED 2026-10-03

Module 8's first part, and the one that had to come first: every dashboard this module adds renders
`v_receivable` ("who owes us money"), `v_payable` or `v_aging` (Finance's collection priority list).
Measured before any screen was built, `v_receivable` returned **one row, and it was the one document
that is not a receivable** — `CASHOUT-0208`, a cash movement, reported at **minus 30,000,000** —
while every real claim was invisible (`INV-0224` 400M claim / 300M paid / 40M retainage, `RET-0044`
40M, `CASHIN-0114` 300M). PRD §5.2 names the rule that was broken: *"Receivable/payable are computed
views over the ledger (filtered by type + document no)"*. `v_payable` followed it and worked;
`v_receivable` filtered on `cost_category_id` and did not.

**Migration 020** rewrites both registers to that rule and gives `v_aging` an honest undatable case.
The defect is the same class migration 018 removed from the EVM view — a missing value presented as
a confident figure — which is why it is pinned with the same discipline.

| ID | Assertion | Expected |
|---|---|---|
| RG8.1 | a claim written by the **manual entry path** **IS** a receivable, with **no cost category anywhere** | billed 250,000,000, outstanding 250,000,000; and the deployment fact is asserted first: `SELECT COUNT(*) FROM cost_categories WHERE is_receivable=1` = **0** |
| RG8.2 | a **funding-only** document is **not** a receivable and is not aged | absent from both views; no row anywhere reports a negative amount owed to us |
| RG8.3 | a **same-document** payment nets; a **different-document** payment does not | billed 100,000,000, paid 40,000,000, retainage 10,000,000, outstanding **50,000,000**; `has_retainage` = 1 |
| RG8.4 | an invoice paid in full **drops out** of the aging list | outstanding 0 → zero rows in `v_aging` |
| RG8.5 | a **blank** invoice date is **excluded** from aging, and cannot blank a document that has a real date | register reads NULL not `''`; no `120_plus` false alarm; a mixed document keeps its real date |
| RG8.6 | the 30/60/90/120 boundaries still mean what they meant | −15→`1_30`, −45→`31_60`, −75→`61_90`, −105→`91_120`, −200→`120_plus`, +10→`current` |
| RG8.7 | billed − paid − retainage = outstanding holds on a mixed document | 250,000,000 − 80,000,000 − 25,000,000 = **145,000,000**; net_amount **170,000,000** |
| RG8.8 | `v_payable` keeps working (it was correct before — it must not regress) | 90,000,000 billed → 60,000,000 outstanding after a same-doc payment; funding-only document dropped |

**Two defects were found in the FIX itself, both by these tests, both recorded rather than smoothed
over.** (1) The first draft tested `type` before excluding `funding`, so a **payment carrying a
claim's type** — which `db/validate.py` inserts deliberately, `type='Payable', line_role='funding'` —
was admitted as a claim. RG8.3 caught it. The predicate is now written as *claim* OR *payment-against-
a-claim*, with `line_role <> 'funding'` on the claim branch. (2) The aging guard `invoice_date IS NULL`
**does not fire**: `accounting_ledger.date` is NOT NULL, which blocks an absent date but not a blank
one — `date=''` is accepted, `julianday('')` is NULL, so the row fell through every comparison to
`ELSE '120_plus'` and led the collection list as the most overdue item. Worse, plain `MIN(date)` over
a document mixing a blank and a real date returns the **blank**, so one undated line erased the whole
document's date. Closed by `NULLIF(r.date,'')` in the register and an explicit `IS NULL OR = ''`
filter in aging.

**A consequence worth stating, because it changes what `v_aging` is FOR:** it is the register of
*datable, still-outstanding* claims. A row it cannot date is not aged and does not belong in it; the
"no date" to-do list is served by querying `v_receivable` directly (part 8.3 renders it on the aging
screen), which is why `aging_bucket = 'no_date'` is deliberately never populated by the view.

**Two gaps were measured and are NOT fixed here, deliberately:** (a) **no app path writes
`line_role='funding'` at all** — the UI's six Types map only to `receivable`/`expense`/`dropping`, so
payment legs in these tests are fixture data standing in for a workflow the product does not have
(that is the second half of F1, and it is a build task, not a view fix); (b) a manual claim has **no
partner** — there is no client field on the entry form and no trigger fills one, so `partner_type` is
NULL. Neither moves a figure; both are recorded for part 8.3.

**Not changed, and it must not change:** `db/validate.py` pins `INV-0224` outstanding 60,000,000 /
paid 300,000,000 / retainage 40,000,000 and `PO-9001` 90,000,000 / 30,000,000 / 60,000,000. All six
figures are **byte-identical** after 020 — verified, not assumed. (On the old view `INV-0224` was not
visible at all, so the validator's read of it would have returned `None`; that the four figures only
became *readable* after the fix is further evidence the old filter was wrong rather than a preference.)

---

## 12m. AG8 — Due dates: `payment_terms_days` becomes real — ✅ IMPLEMENTED 2026-10-03

PRD §5.2 and R2-6 promise *"due date = ledger date + payment terms (from project register)"*. Before
migration 021 nothing in the product computed one: `v_aging` bucketed on fixed 30/60/90/120 offsets
from the **invoice** date, and the two stored `payment_terms_days` columns (`projects`, `clients`)
were read by nothing — `src/lib/clients-service.js` says so in its own header. Terms without a due
date cannot answer the question a collection call needs: *how long past its terms is this?*

**Decision D3 (owner, 2026-10-03):** project terms → client terms → system default in
`app_settings.default_payment_terms_days` (30 days). The chain is **exposed, not hidden**:
`terms_source` names which link applied, because "30 days" that is really "nobody set this" is a
different fact from "30 days, our terms".

**Migration 021** seeds that setting (`INSERT OR IGNORE`, before the view that reads it — measured,
`app_settings` held **no business settings at all** on a seeded database, only the argon2 tuning keys
and `csrf_secret`, so a view reading a missing key would return NULL terms on every real
installation). It adds `v_receivable_due` and extends `v_aging` with `terms_days`, `terms_source`,
`due_date` and `overdue_days`.

### The trap this part did NOT walk into — and it was measured, not theorised

The part's own plan originally said *"aging then ages from `due_date`"*. **That would have been a
regression.** TECH-SPEC §13 pins the ageing contract for this phase beside "billed ≠ received"; PRD
§5.2 defines the buckets as offsets from the **invoice** date; `db/validate.py` and RG8.6
(`test/reporting.test.js`, committed as `2fe33f8`) pin the five boundaries there. Re-pointing the
buckets at `due_date` would have silently re-labelled 30/60/90/120 as *days past due* and moved every
aged figure in the product — **RG8.6 would have failed, correctly.** So the buckets stay on the
invoice date and `due_date` / `overdue_days` are **added beside** them. Both are real and answer
different questions: `days_aged` prioritises the collections list, `overdue_days` justifies the call.
AG8.6 proves they are independent by **constructing a row where they disagree** (75 days old, 60-day
terms → bucket `61_90`, `overdue_days` 15), rather than asserting it in prose.

`overdue_days` is **clamped at 0**: not-yet-due is 0 overdue, never negative — a negative would sort
ahead of genuinely overdue invoices and invent a priority Finance would act on. An unknown default is
reported as unknown (`terms_days` NULL → `due_date` NULL), never invented as 30 — the same rule
migration 018 applied to SPI/CPI.

| ID | Assertion | Expected |
|---|---|---|
| AG8.1 | the default is **read from `app_settings`**, not baked into the view | setting 30 → due 2026-03-31; changed to 45 → due **2026-04-15**; `terms_source='default'` |
| AG8.2 | with no terms anywhere the due date is **NULL**, never an invented 30 | `terms_days` NULL, `due_date` NULL; restoring 30 → 2026-04-09 |
| AG8.3 | a project with no terms inherits the **client's**, and says so | 60 days → due **2026-04-02**, `terms_source='client'` |
| AG8.4 | the **project's** terms win over the client's (R2-6: "overrides client default") | 15 days → due **2026-03-16**, `terms_source='project'` |
| AG8.5 | an invoice inside its terms has `overdue_days = 0`, not a negative | 10 days old, 90-day terms → overdue **0**, `days_aged` 10.x, bucket `1_30` |
| AG8.6 | the 30/60/90/120 buckets still measure from the **invoice** date | 75 days old / 60-day terms → bucket **`61_90`**, overdue **15**; five boundaries re-pinned |
| AG8.7 | undatable rows stay out of aging but reachable on the register; settled rows keep their due date | blank date → absent from `v_aging`, present in the no-date to-do; paid in full → out of `v_aging` |

**Gates:** `dump-schema.js --check` clean (43 tables, 45 indexes, 30 triggers, **10 views**) ✅;
`python3 db/validate.py` **ALL CHECKS PASS** ✅; `test/aging.test.js` **7/7** (port 3922) ✅.

**No figure moved.** Migration 021 is view-only plus one setting row; `v_aging`'s existing contract
(invoice-date buckets, datable + still-outstanding only) is byte-for-byte what migration 020 left.

---

## 12n. RP8 — The receivables aging screen — `/reports` + `/reports/aging` — ✅ IMPLEMENTED 2026-10-03

PRD §5.2: *"Aging report view (30/60/90/120+ day buckets), sortable by amount — Finance's collection
priority list."* PRD §5.4 names the same report; screen map (TECH-SPEC §10) has `Reports | Aging |
receivable priorities`. This part is **the first thing in the product that renders the registers
parts 8.1 and 8.2 fixed** — which is why those two had to land first.

**Three measured defects shaped the screen, not the other way round:**

1. **The register it renders was inverted** before migration 020 (it showed the one document that is
   *not* a receivable and hid every real claim). The screen had to be built on the corrected view or
   it would have shipped the lie to Finance's morning screen.
2. **An undatable claim is a data-quality TO-DO, not an urgency.** `v_aging` deliberately excludes
   those rows (migration 020) so the old `CASE` cannot call an undated invoice `120_plus`. The screen
   therefore gives them their own **labelled group** that says "fix the data" — visible and
   actionable, never mixed into the chase list and never counted in the overdue totals.
3. **Retainage is its own figure** (PRD §5.2: *"retainage held separately (never buried in regular
   AR)"*), read from the **register** rather than from the aging list, so a claim that has been
   settled but is still retained keeps its figure.

**Two things the screen is structurally careful about:**

* **The tiles and the table are rendered from ONE result set.** `bucketTiles()` in
  `routes/reporting.js` rolls up the same `q.receivableAging` rows the table prints. A tile computed
  from a second query will eventually disagree with the rows beneath it, and a dashboard that
  contradicts itself is worse than one with no tiles. RP8.4 recomputes the tile totals from the
  **table HTML** and requires them to match.
* **`?sort=` is a WHITELIST, never a passthrough.** Three separate prepared statements live in
  `db/queries.js` with literal `ORDER BY` clauses; the route only chooses between them, and an
  unknown key falls back to the PRD default rather than throwing. RP8.7 drives `sort=outstanding_amount;DROP`
  and requires a 200 with the list intact.

**Authorization — deliberately narrower than the WBS/budget screens.** New capability
`canViewReceivable` = **Finance + Cost Controller**, *not* the flat `true` that `canViewWbs`,
`canViewCbs` and `canViewProjects` use. Those expose a project's own plan and tree; these registers
expose **what the company is owed and by which customer**, which is Finance's book. A Viewer gets a
**rendered 403 carrying the reason**, not a silently shorter list.

| ID | Assertion | Expected |
|---|---|---|
| RP8.1 | a **Viewer** is refused both register routes, **with the reason**, and the DB is unchanged | 403 ×2, body matches *"Finance and Cost Control"*, ledger row count identical |
| RP8.2 | an anonymous request is sent to the login page | 302 → `/login` on both routes |
| RP8.3 | the screen renders a real claim posted through the **entry path** | `RP8-INV-1` present, `100.000.000` rendered, the project's own name in the sub-title |
| RP8.4 | **every bucket tile agrees with the rows the table renders** | tile totals recomputed from the table HTML = **100,000,000**; all six buckets rendered including the empty ones |
| RP8.5 | an undatable claim is a **labelled to-do group**, never counted as overdue | shown once (in the to-do group only), never in the chase table, totals unchanged |
| RP8.6 | retainage is **held separately** (PRD §5.2) | Rp 200,000,000 claim with 60,000,000 retained → retainage **60.000.000**, outstanding **140.000.000**, row marked |
| RP8.7 | the sort works and an **unknown sort cannot reach SQL** | largest-first leads with the 140,000,000 claim; `sort=…;DROP` → **200**, not 500 |
| RP8.8 | the due date **and its source** reach the screen (decision D3) | `default, 30d` named beside the date; 2026-03-10 + 30 → **2026-04-09** |
| RP8.9 | the restored Reports link resolves **for a role that may open it** | Finance sees the link and gets **200** with the real register |

**The sidebar's Reports link returns here, in the same commit as the route.** MS6.7/MS6.8
(`wbs-defaults.test.js`) assert the sidebar carries no dead link and that *every* href resolves;
task 6.6 had removed five dead links including Reports. So the link and its route land together, and
**MS6.10** (new, same file) pins that they did. The link points at the report **index** (`/reports`),
not directly at the aging report, so the module's later reports do not require re-pointing it.

**Files:** NEW `src/routes/reporting.js`; NEW `views/aging.ejs`, `views/reports-index.ejs`; MOD
`src/db/queries.js` (4 statements + the sort whitelist), `src/lib/permissions.js` (`canViewReceivable`),
`src/server.js` (mount), `views/partials/sidebar.ejs`, `test/wbs-defaults.test.js` (MS6.10);
NEW `test/reporting-screen.test.js` (RP8.1–RP8.9, port **3923**).

**Gates:** `dump-schema.js --check` clean ✅ (this part changes no schema); `python3 db/validate.py`
ALL CHECKS PASS ✅; `test/reporting-screen.test.js` **9/9** ✅; full suite **461 → 471** ✅.

### 12n.1 A latent test defect that migration 021 exposed — four test files read the DEV database

**Found by the full-suite run for 8.3, which failed with `SUITE_EXIT=1` and four red tests:
I8.4, MA5.1, PR2.1, PR3.1 — all `SqliteError: no such column: terms_days` at `queries.js:593`
(migration 021's new `v_aging` columns).**

The failures were not caused by migration 021. They were **pre-existing and always wrong**, exposed
on coincidence. `import.test.js`, `projects.test.js` and `master.test.js` require app modules
**in-process** (`import-service`, `projects-service`, `approvals-service`, `master-service`, and
`src/server` itself for I8.4's route-table walk). `src/db/db.js` binds its connection to
`process.env.PRACTIS_DB` **or falls back to `data/practis.db` — the DEV database** — and those files
handed `PRACTIS_DB` **only to the child server process**, never to the test process. So every
in-process require opened the dev database:

* it read whatever schema and data the dev database happened to have;
* it could **write** to the dev database (`applyBaselineChange`, audit rows, …);
* it went unnoticed while the dev database was a schema-version match for the temp one — which it
  was until migration 021 added `terms_days`/`terms_source`/`due_date`/`overdue_days` to `v_aging`.

Full-suite runs had simply **never executed the in-process paths** since before any Module 7/8
migration, so the stale read was invisible. The four files now set `process.env.PRACTIS_DB = dbPath`
in their `before()`, and the parent-panel false positive (`fixture.test.js`, `wbs.test.js` — their
`require('../src/…')` sits inside a comment) was checked and needs no change.

**Measured harm: none on this box.** The dev database is `user_version 12`, 9 ledger rows, 4 users,
project `JC-2026` — exactly as before, so no test run ever committed a write to it here.

**The class is now loud, not silent** — the guard below in `src/db/db.js`. On a dev machine the dev
database is perfectly openable, so without a guard the mistake produces plausible numbers instead of
an error, which is the worst failure mode for a book of record:

```js
if (!process.env.PRACTIS_DB && process.env.NODE_TEST_CONTEXT) {
  throw new Error("db.js: PRACTIS_DB is unset in a test process, so this would open the DEV database …");
}
```

`NODE_TEST_CONTEXT` is set by `node --test` in each test child process (measured: `child-v8`), so the
guard cannot fire for `node src/server.js` on the VPS, for `migrate.js`, or for any ordinary script —
only for a test process that has not chosen a database.

**Audit of the whole suite:** scanned every `test/*.test.js` for an in-process `require('../src/…')`;
9 files do it, 5 of them (`admin`, `cbs`, `csrf`, `progress`, `rbs`) already set `PRACTIS_DB` in the
parent, 1 (`fixture`) is safe by construction, and `admin`/`fixture`'s **top-level** requires
(`src/lib/policy`, `src/lib/csv`) were checked to **not** reach `db.js` (neither has a `require` of
its own), so they cannot trip the guard before their `before()` runs.

---

## 12o. FC8 — Forecast / EAC — ✅ IMPLEMENTED 2026-10-03

PRD §4.4 step 1: *"Project Controller updates `c_wbs_forecast`; Cost Controller updates
`c_cbs_forecast` (**auto EAC from CPI** + manual override)."* Two things were missing: nothing
computed EAC, and nothing wrote a forecast row.

**Two numbers, deliberately not merged.** The **system estimate** (`eac()`) is arithmetic —
`EAC = BAC / CPI`, `ETC = EAC − AC`, `VAC = BAC − EAC`. The **human forecast** is a `cbs_plan` row
with `plan_type='forecast'` and `is_manual_override=1`. The screen shows both; setting one never
replaces the other, which is why `is_manual_override` is a column rather than the write path
overwriting `amount`.

**The honesty rule, carried into the UI.** With no cost performance there is **no** estimate:
`eac`, `etc`, `vac` and `over` are all `null`, and a `reason` sentence explains it. It is never
`EAC = BAC` — that would present a project nobody has measured as perfectly on budget. The reason
**distinguishes the two different blanks** ("no progress has been measured" vs "no cost has been
booked") because the reader's next action differs.

**Grain, decided from the data.** The override is one figure per (cost account, month), stored with
`wbs_node_id IS NULL`. The baseline is per (account, work line, month), but `cbs_plan` permits a
NULL work line for every plan type **except** `baseline` (015's trigger constrains only baseline),
so the override can be coarser without a schema change, and the screen offers one box per
account-month instead of a grid.

**Tests (FC8.1–FC8.7, port 3924):** blank-not-BAC with a real budget and no measurement · the
arithmetic hand-computed against independent table reads (BAC 1,000,000, EV 500,000, AC 200,000 →
CPI 2.5 → EAC 400,000, ETC 200,000, VAC 600,000 positive-means-under) · the two blank reasons
proved different in one test · an override flagged, its previous version still readable, hand-back
writes `is_manual_override=0` rather than deleting · bad months/amounts refused with no row written ·
**no baseline row and no EVM figure moves** (fingerprint + row count, and PV/EV/AC/SPI/CPI read
before and after) · the report renders for the Cost Controller, 403s a Viewer **with the row count
unchanged**, and prints its own basis (`BAC ÷ CPI`) on the page.

### 12o.1 A real defect FC8.2 caught — the estimate was dated by the calendar, not by measurement

`latestCumulative()` first read *"the newest `v_evm_period` row with a non-null `cpi_cum`"*. That is
wrong because **019 carries the cumulative columns forward**: a project with a March–December
baseline measured only to March has a non-null `cpi_cum` in every month to December, all holding the
March value. The screen therefore read **"as at 2026-12"** — telling a reader the project had been
measured through December when nothing had been measured after March. Wrong in the dangerous
direction for a book of record.

Fixed to the latest month where the cumulative figures were **actually moved by data** — `ev <> 0
OR ac <> 0` (earned value or actual cost; PV moves by being *planned*, not observed). FC8.2's
`cpi_month === '2026-03'` assertion is the regression test, and its comment records why.

**Gates:** `dump-schema.js --check` clean ✅ (no schema change — `plan_type='forecast'` and
`is_manual_override` already existed); `python3 db/validate.py` ALL CHECKS PASS ✅;
`test/forecast.test.js` **8/8** ✅; full suite **471 → 479** ✅.

---

## 12p. VR8 — Variance: SV, CV and VAC — ✅ IMPLEMENTED 2026-10-03

PRD §5.4: *"Project dashboard (PM/Controller): S-curves, **EVM trend** …"*; TECH-SPEC §10 step 7
names *"variance"*. There was no schedule variance anywhere, and `cost_variance` already existed
with a sign that **contradicts** standard EVM.

**The sign trap this part exists to close.** Two figures, one English name, opposite signs:

| Column | Expression | Positive means |
|---|---|---|
| `cost_variance` (018, pinned by EV7.6) | `AC − EV` | **OVER** budget |
| `cv` (022) | `EV − AC` | **UNDER** budget |

Both are plausible numbers on a real project, so a screen that rendered the wrong one under the
label "Cost variance" would **invert every verdict silently** — and a test asserting only that "a
number is shown" passes either way. So: **the screen renders `cv` only and never renders
`cost_variance` at all**, the convention is printed in words from `v.sign` (not left to the
reader's memory of the textbook), and VR8.5 pins the sign on a deliberately over-budget fixture.

**Computed once, in the view.** `sv`, `cv`, `sv_cum`, `cv_cum` are **columns on `v_evm_period`**
(migration 022, additive). The rule this module has been bitten by three times — 013/014/015, then
018, then 019 — is that a figure derived in two places eventually disagrees with itself. The
service reads the columns; it does not re-derive them. VAC (`BAC − EAC`) lives in the service
because EAC does, and travels with the estimate's own `reason`.

**`EAC` is now computed from the unrounded ratio.** Dividing by `cpi_cum` carried the view's
4-decimal rounding into the estimate: BAC 1,000,000 at CPI 0.5882 gave **1,700,102** instead of
1,700,000. Trivial here, but the error scales with the project — roughly **Rp 18 million** of pure
artifact on a Rp 300 bn contract, presented as a finding. `BAC ÷ (EV ÷ AC)` is algebraically
`BAC × AC ÷ EV`: same figure, no rounded intermediate. **Caught by VR8.6** (the FC8.2 fixture's
exact 0.625 had hidden it).

**Design decision recorded:** the variance report sits on the **CBS/baseline router** (the forecast's
home), not a new one. No `evm-service.js` exists — `spi_cum`/`cpi_cum` have been read straight from
the view since 019 — and VAC needs `eac()`, so a separate module would mean a circular dependency
or a second reader of the same figures. One writer, one reader, one place to change.

**Authorization, decided and now expressed in code:** the variance report is **read-only** and PRD
§5.4 gives "EVM trend" to the exec/Viewer portfolio view, so a **Viewer MAY read it** (VR8.7 asserts
200, in both directions). The **write** on the same router stays restricted — a Viewer POSTing the
forecast gets a rendered **403 with the reason and zero rows written**. A `reportGuard` now makes
that read decision explicit rather than implied: a page on that router with no guard is a page
nobody decided about.

**Tests (VR8.1–VR8.7, port 3925):** the view's signs per-period and cumulative · running totals are
the literal sum of the monthly figures (checked against the table) and a month can be behind while
the project is ahead (both facts stand) · percentages use PV for SV and AC for CV, blank with no
denominator, and **−100% is real while `null` is the blank** (the two are not the same thing) ·
service output is byte-identical to the view's columns, and 022 is **additive** (EV7.6's
`cost_variance` unchanged) · **over budget ⇒ CV negative**, with the ledger-side figure positive in
the same month · VAC = BAC − EAC, blank with the reason when there is no EAC, dated at the last
measured month · the screen renders, prints the convention, **lets a Viewer read it, refuses the
Viewer's write with rows unchanged**, and states how many empty months it is hiding (with `?all=1`
to show them).

**Gates:** `dump-schema.js --check` clean ✅ (10 views); `python3 db/validate.py` ALL CHECKS PASS ✅;
`test/variance.test.js` **7/7** ✅; full suite **479 → 486** ✅.

---

## 12q. DB8 — Project dashboard / S-curves — ✅ IMPLEMENTED 2026-10-03

PRD §5.4: *"EVM S-curves (project dashboard) … Calendar-rendered"* and *"Project dashboard
(PM/Controller): S-curves, EVM trend, cashflow actual vs forecast, WBS drill-down"*.
Screen: `GET /reports/project` (the screen map's "Project Overview" — **it did not exist before**).

**Charts are self-hosted Chart.js** (4.5.1, MIT, vendored from the npm registry tarball, sha256
pinned). No CDN (TECH-SPEC §3.6), **no CSP change** — the CSP already allows `'self'` and Chart.js 4
uses **no `eval` / `new Function`**, which was the only real hazard (verified, see F8 in the plan).

**The split that keeps it testable — the point of this part.** Chart.js paints a `<canvas>`, and a
canvas **cannot be asserted on in this environment** (no reliable headless Chrome at 2 GB / no
swap). So **no arithmetic happens in the browser**: `src/lib/chart-config.js` builds every figure
server-side and returns a plain object; the view serialises it into an
`application/json` block (the `terms-by-client` pattern from `project-new.ejs`) and a small nonce'd
script only reads it. DB8.6 asserts the browser script carries **no monetary figure**, so the
separation cannot rot back.

**Files:** NEW `assets/vendor/chart.js/chart.umd.min.js` + `LICENSE.md`; NEW
`src/lib/chart-config.js`; NEW `views/project-dashboard.ejs`; `src/routes/reporting.js`
(`/reports/project`, `REPORT_PATHS`); `views/reports-index.ejs`, `views/partials/sidebar.ejs`;
NEW `test/dashboard.test.js` (DB8.1–DB8.8, port **3926**).

**Three defects this part's own tests caught, all worth recording:**

1. **The `<script src>` tag was missing entirely.** The page rendered, the JSON was right, the
   canvases were there — and the library never loaded, so every chart would have been **blank**.
   DB8.7 asserts the tag. Note DB8.8 (the file exists on disk, right hash) passed while this was
   broken: the file was fine, the *tag* was not. Both assertions are needed.
2. **`isMeasured` was judged on per-period figures only**, so a project with a spread budget and no
   ticks yet was told *"nothing has been measured against the budget"* while its budget sat right
   there. Split into two predicates: `isMeasured` (per-period — right for the bars) and `reached`
   (cumulative — right for the curve). DB8.3 pins all **four** states with four different sentences.
3. **The test hardcoded the project name** (`Jembatan Citarum`); the fixture seeder creates
   **`Citarum Bridge`**. Same lesson as RP8's `PRJ-2026`: read it from the DB, do not guess.

**Scoping, asserted in both directions.** A user with **no role** resolves to no project and is
told so, and `?project=N` does **not** widen scope (the BOLA rule). An **org-wide** role (Cost
Controller, rule 5 of `projectsFor`) legitimately reaches every project, and the switch is
honoured — pinned deliberately so a later silent narrowing fails the suite.

**Tests (DB8.1–DB8.8, port 3926):** every point on each series is the view's own `*_cum` column,
per month (no re-derivation) · the curve accumulates — each point is the previous plus that month's
values · the **four** distinct states (no baseline / baseline-not-measured / cost-but-no-plan /
measured) give four different answers and none is a zeroed series · the stated Y scale covers the
peak and rounds up to a readable step · the bars are the **per-period** figures while the curve is
cumulative (same month, deliberately different numbers) · **the browser script contains no figure** ·
the page renders, names its project, emits the JSON + the script tag, loads nothing from a CDN, and
is scoped both ways · **the vendored bundle exists, is served, and matches the pinned sha256**, with
the MIT notice shipped.

**Gates:** `dump-schema.js --check` clean ✅ (no schema change); `python3 db/validate.py`
ALL CHECKS PASS ✅; `test/dashboard.test.js` **8/8** ✅; full suite **486 → 494** ✅.

---

## 12r. PF8 — Portfolio dashboard + closed-project hiding — ✅ IMPLEMENTED 2026-10-03

PRD §5.4: *"Portfolio dashboard (exec/Viewer): all projects, CPI/SPI traffic-light cards,
current-month cashflow, portfolio-wide forecast."* PRD §4.4 (threshold), §4.5 (3-step close).
Screen: `GET /` — **the 35-line `views/dashboard.ejs` replaced**.

**It stays in `routes/app.js`.** Decided from the code, not by taste: `/` is in `APP_PATHS` and
asserted by TEST_PLAN §12f, and the reporting router also runs `projectContext` — mounting `/` in
both would register one path twice and depend on mount order (`server.js` mounts reporting before
app). One route, one home.

**Migration 023** seeds `spi_breach_threshold` / `cpi_breach_threshold` = 0.95 (INSERT OR IGNORE,
following 021's precedent). **No schema change** — `app_settings` is data, not DDL, so
`dump-schema.js --check` stays clean. Measured first: the dev DB held **no** threshold of any kind,
so without the row PRD §4.4's "tunable" would have been untrue.

**Three defects this part's tests caught:**

1. **The footer disagreed with the table.** The first version printed the *all-projects* total in
   the footer of a page rendering *live* rows only — two numbers on one screen meaning different
   things. Now `totals.shown` is the sum of the rows actually rendered, and PF8.5/8.7 assert it
   equals that sum to the rupiah.
2. **"Latest row with a cumulative index" reads a month the project has not reached.** Migration
   019 carries `spi_cum`/`cpi_cum` **forward** across the grid, so the naive query returns
   **`2026-12`** while nothing was measured after March. Identical to the Part 8.4 forecast defect.
   The service reuses `forecast.latestCumulative`, whose guard excludes carried-forward months, so
   the portfolio, forecast and variance screens **cannot disagree about which month they describe**.
   PF8.4 asserts the naive answer (`2026-12`) AND the correct one (`2026-03`) side by side.
3. **The fixture guard used a 1e-9 tolerance on a `ROUND(x,4)` column.** `cpi_cum` is exactly
   **0.5556**, not 5/9 — the same rounding that caused the 8.5 EAC defect. Asserted against what
   the view emits, with the reason recorded.

**Threshold is READ, not baked in.** PF8.8 changes the `app_settings` row to `6` and watches SPI
5.00 move from `within` to `breached`, then back — proof the number is live. A `DELETE` proves the
absent-setting fallback renders instead of throwing.

**PRD §4.5's three close steps are kept distinct**, not collapsed to one boolean: operationally
closed leaves the live schedule, financially closed leaves live cashflow/forecast, contractually
closed is archived. Each carries the step name **and what it left**, and the toggle **names each
project it would add** with the step it left at — a bare count would be a number nobody can check.
`totals.live` and `totals.all` are both present: "closed projects remain in portfolio history
totals forever".

**Tests (PF8.1–PF8.9, port 3927):** the three index states as a unit, incl. **a real 0 IS a breach
while NULL is not** · an unmeasured project is grey, never red · one project can be `within` on SPI
and `breached` on CPI at the same time · the carry-forward trap, naive vs correct · closed projects
out of live / back under the toggle / **same figure both ways** / the advertised addition reconciles
· each close step distinct and named · the printed total equals the sum of rows rendered · the
threshold read from settings and re-tuned · the page renders, states the threshold, shows a
**grey** (never green) tile for an unmeasured index, the toggle works, and **BOLA**: a role-less
user is shown no project name and no rupiah figure.

**Gates:** `dump-schema.js --check` clean ✅; `python3 db/validate.py` ALL CHECKS PASS ✅;
`test/portfolio.test.js` **9/9** ✅; full suite **494 → 503** ✅.

---

## 13. Workflow coverage vs PRD §4

The product workflow, step by step, and whether a test exists. **Empty rows are the real answer to
"is the edge case in the test plan" — most of the workflow has no test because it is not built.**

| PRD § | Workflow step | Status |
|---|---|---|
| 4.1 | Initialisation: create project, assign roles **per project**, COA/WBS/CBS setup, team, client/supplier, approval chain | ❌ **no tests, no UI** (skipped §10 step 3; Module 6) |
| 4.2 | Planning: WBS tree, milestones + weights, RBS load, CBS budget, **baseline**, **freeze**, **de-scope** | ✅ **complete** — WBS tree (WB7.1–WB7.10), milestones + per-period % complete (MP7.1–MP7.15), RBS load (RB7.1–RB7.17), **CBS budget + the Σ = RBS invariant (BL7.1–BL7.18)**, **baseline change: prospective + atomic (BS7.1–BS7.13)**, **baseline freeze + BCR workflow (BC7.1–BC7.13)**, **de-scope: history intact (DS7.1–DS7.13)** |
| 4.3 | Execution: progress ticks → EV · actual cost from ledger + checked lines · revenue recognition · billed vs received | ⚠️ **partial** — actual cost ✅ (CA2.2, XO1.9); progress ticks ✅ (MP7.x); revenue, billed≠received ❌ |
| 4.4 | Monitoring: EVM SPI/CPI, forecast, variance, **de-scope/BCR**, aging, dashboards | ⚠️ **partial** — **EVM SPI/CPI ✅ (EV7.1–EV7.11 — the module gate: `v_evm_period` returns real, honest indexes, per-period AND cumulative; migrations 018 + 019)**, BCR change control ✅ (BC7.1–BC7.13, incl. the SoD rule that an Administrator does not approve baselines); de-scope ✅ (DS7.1–DS7.13, prospective only — past months byte-identical); forecast, variance, aging, dashboards ❌ (Module 8) |
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

## 14. Schema-validator drift — FIXED 2026-10-01

`db/validate.py` executes **`db/schema.sql`** and asserts DB-level invariants — it passes ("ALL CHECKS
PASS"). But the app runs **`db/migrations/`**, and the two had diverged:

| Object | migrations | schema.sql (before) | schema.sql (now) |
|---|---|---|---|
| tables | 43 | 44 (+`schema_migrations`) | 43 |
| views | 9 | 9 (`v_lpb_reconciliation`, `v_cbs_actual` differ) | 9 |
| triggers | **21** | **14** | **21** |

So the validator was green while the guards it claimed to verify were **absent from the schema it
read**. Fixed on 2026-10-01:

- **`db/dump-schema.js`** regenerates `schema.sql` from a freshly-migrated throwaway DB, copying DDL
  **verbatim out of `sqlite_master`** (never retyped — retyping is how the dedupe index lost its
  `WHERE source='import'` predicate in migration 003). Objects are emitted in dependency order:
  tables → indexes → triggers → views, because SQLite validates a view against its tables at CREATE
  time. `--check` mode compares without writing.
- **`npm test` now runs `node db/dump-schema.js --check && python3 db/validate.py` before the node
  suite**, so drift and validator failure both fail the build.
- **`validate.py` gained a drift gate**: it asserts 9 named guards are present (the reversal trio, the
  CBS/blocked triggers, the dedupe index) and that the dedupe index kept its partial predicate. It
  also gained **§15-style reversal tests** — with the guards previously absent from `schema.sql` these
  would have had nothing to bite on.

| ID | Test | Status |
|----|------|--------|
| SCH1.1 | `schema.sql` DDL matches the migrated result | ✅ `dump-schema.js --check` in `npm test` |
| SCH1.2 | `schema.sql` contains all 21 triggers | ✅ asserted by the generator + drift gate |
| SCH1.3 | `validate.py` runs inside `npm test` | ✅ first two commands of the `test` script |
| SCH1.4 | migration rehearsal: fresh DB reaches `user_version` 9 | ✅ the generator does exactly this each run |
| SCH1.5 | the drift gate actually FAILS when a guard is removed | ✅ verified by deleting `trg_ledger_reversal_must_negate` and confirming exit 1 |

**Deliberately not asserted: that `schema.sql` byte-equals a dump of `data/practis.db`.** It is
generated from the *migrations*, which is the schema a fresh install gets. The dev DB is a separate
concern and may legitimately carry extra staging-state rows.

---

## 15. Required fixtures — now wired in

| Artifact | Spec | Reality |
|---|---|---|
| `db/fixture-ledger-export.tsv` (26 rows) | §8.3: "regression-checked **on every run**" | **was referenced by ZERO tests** → now driven end-to-end by `test/fixture.test.js` (FX series) |
| `db/seed-smoke.sql` | §8.3: every test DB seeded from it where domain data is needed | used by `validate.py`; the timed test suite uses `seed-master.js` + `seed.js` instead |

**Wiring the fixture in found three real defects that the CSV unit tests could not**, because every
CSV test in the suite is comma-separated with ISO dates while the real export is neither:

| # | Defect | Symptom |
|---|--------|---------|
| 1 | **No TAB delimiter support.** The real file is tab-separated; the parser split on `,`/`;` only. | Every row collapsed to ONE cell → all 26 quarantined as "missing transaction_id" — a misleading symptom for a delimiter problem. |
| 2 | **No Excel serial dates.** The real file carries `45200`, not `2023-10-01`. | `toIsoDate` returned null → every row failed on "bad date". |
| 3 | **`.tsv` rejected by the upload route.** `ALLOWED_EXT` allowed only `.csv`/`.txt`. | The canonical real file could not be uploaded at all — `400 BAD_EXTENSION`, despite the parser handling tabs fine. |

All three fixed in `src/lib/csv.js` / `src/routes/api.js`. Note defect 1's fix had to be *delimiter
detection*, not "also split on tab": the real descriptions contain commas
(`"Perjalanan dinas: Petugas A, Site Utama 02 sd 05 Oktober 2023"`), so splitting on both characters would cut
text fields in half.

| ID | Test | Expected | Status |
|----|------|----------|--------|
| FX1.1 | fixture is TAB-separated, parses to its real 14 columns | 26 rows, correct column alignment | ✅ |
| FX1.2 | comma-bearing descriptions do not split the row | comma stays inside its cell | ✅ |
| FX1.3 | Excel serial dates decode to the right calendar day | `45200` → `2023-10-01` | ✅ |
| FX2.1 | all 26 real rows stage clean (0 quarantined) and confirm | `inserted = 26` | ✅ |
| FX3.1 | imported rows satisfy the ledger invariants | `amount = debit - credit`, one side, whole rupiah | ✅ |
| FX3.2 | decoded dates land in the real Oct-2023 window | `2023-10-01` … `2023-10-25`, 13 with `effective_date` | ✅ |
| FX3.3 | type column maps to the legacy vocabulary | Payable/Expense `in_cost_basis=1`; Dropping `=0` | ✅ |
| FX4.1 | re-importing the same real file adds nothing | all 26 counted as duplicates, ledger unchanged | ✅ |
| FX4.2 | `.tsv` allowed but unknown extensions still rejected | `.xlsx` → 400 `BAD_EXTENSION` | ✅ |

**Known gap this exposed and did NOT fix (not in §0 scope):** §8.4 requires "every imported transaction
group balances to zero or is quarantined", but `import-service.js` validates **per row only** — there
is no group-level balance check. Measured on the fixture: 10 of its 11 `transaction_id` groups balance
to zero; `SAL-24-10-0038` is a lone 14,200,000 debit with no credit leg, and the importer accepts it
without comment. Raise with the owner before implementing — it may be a deliberate partial-batch decision.

---

## 16. Priority of the gaps

1. ✅ **AZ1.x** + **`authz.test.js`** — DONE (`e5fbd1d`): five money-writing routes guarded, 17 tests.
2. **BOLA1.x** — cross-project read **and write** leak; needs the scope layer built first (§0 task 0.9).
3. ✅ **§14 schema drift** — DONE (`7b32b92` + this slice): `schema.sql` regenerated, drift gate added.
4. **IM2.5–IM2.8** — upload edge cases (oversize, formula, traversal, signature).
5. **§8.4 invariants 7 + 12** — frozen period (unimplemented, §0 task 0.10) and closed-project hiding.
6. ✅ **FX1.x** — DONE: the real-ledger fixture is now driven end-to-end every run.
7. ✅ **Security layer** — DONE (`7b32b92`): CSP + nonce, per-IP rate limit, cookie `secure`.

