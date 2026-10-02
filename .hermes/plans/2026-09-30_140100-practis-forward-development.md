# PRACTIS — Forward Development Plan

> **For Hermes:** Use the `practis-development` skill plus TDD (`test-driven-development`) per task.
> This is a PLAN — no implementation is included in this turn.

**Goal:** Sequence the remaining PRACTIS work from the current state (modules 1–5 built, all local,
148/148 tests) to a shippable v1 prototype, following the binding module order.

**Authoritative order:** `docs/TECH-SPEC.md` §10 — *"Order gives each vertical slice a working test
before adding next domain."* Current position: **after §10 step 5**, plus one **finish-the-foundation**
item (§10 step 3) that got skipped.

**Architecture:** Express 5 + better-sqlite3 + EJS, one process, one vertical slice at a time
(route + service + test + template), DB triggers as the floor for every invariant.

**Tech stack:** as built. No new dependencies (only `busboy` has ever been approved).

---

## 0. MANDATORY FIRST — close the authorization hole (audit blockers B1–B5)

> Full evidence: `docs/AUDIT-2026-09-30.md`. Every claim was proven against a temp DB by asserting
> row counts before/after, never by trusting an HTTP status.

**Why this precedes everything:** five mutating routes that write money accept **any authenticated
user**, including a read-only Viewer. Proven, not theoretical:

```
POST /ledger/entry      as Viewer -> 302   ledger rows 6 -> 7   *** WRITE SUCCEEDED ***
POST /ledger/1/reverse  as Viewer -> 302   reversal written      *** WRITE SUCCEEDED ***
POST /queue/tag check=1 as Viewer -> 302   cost_checked 0 -> 1   *** WRITE SUCCEEDED ***
POST /api/imports/:id/confirm as Viewer -> 200, ledger row written
```

Every new route added on the current pattern inherits the omission, and Modules 6–9 add **a dozen
more mutating routes**. Fixing this after writing those means auditing all of them twice.

### Task 0.1 — Add the missing capability flags and guard the five routes

**Files:**
- Modify: `src/lib/permissions.js` — add flags, **keep every existing one** (the `canOpenAdvance`
  near-miss is documented; dropping a flag 403s a whole workflow):
  - `canWriteLedger` — `finance` (+ Administrator).
  - `canCorrectLedger` — **`finance`, `cost_controller`** *(decision 2A — the set is deliberately
    small because a reversal is irreversible: NOT project_admin, NOT viewer)*.
  - `canTagCost` — `cost_controller`, `project_controller` (the checker's job).
  - `canImportLedger` — `finance` (+ Administrator).
- Modify: `src/routes/app.js`
  - `POST /ledger/entry` → `requireCapability('canWriteLedger', …)` (line 88)
  - `POST /ledger/:id/reverse` → `requireCapability('canCorrectLedger', …)` (line 187)
  - `POST /queue/tag` → `requireCapability('canTagCost', …)` (line 259)
  - `GET /ledger/entry`, `GET /queue`, `GET /import`, `GET /ledger/:id/correct` → page visibility
    flags (a Viewer should not be shown a form it cannot submit). **Pages and actions get separate
    flags** — the Project Admin lesson from module 5.
- Modify: `src/routes/api.js` — both `requireAuth` on the import endpoints →
  `requireAuth` **plus** `requireCapability('canImportLedger', …)`; the JSON guard must return
  `401/403` JSON, never an HTML page.
- Test: `test/authz.test.js` — **new port `3901`**. This is the missing-test file; see Task 0.2.

**The guard must be the floor, not the ceiling.** Adding a route guard is necessary and not
sufficient — the audit's point is that the *test* was missing, so a future route can regress. Task
0.2 is what makes it stick.

### Task 0.2 — Authorization test harness (the actual root-cause fix)

**Objective:** make "wrong role is denied" a mechanical assertion for every mutating route, so this
class of bug cannot come back.

**Files:** Create `test/helpers/authz.js`; create `test/authz.test.js`.

`test/helpers/authz.js` exports `asRole(origin, roleCode)`:
1. seed a fresh user, then demote: `is_system_admin=0` and `user_roles.role_code = <role>` via the
   test's **own** better-sqlite3 handle (never `require('../src/...')` — that binds the default DB).
2. return a logged-in `client` for it.

Then one table-driven test that walks every mutating route × every role and asserts:

| # | Case | Expected |
|---|---|---|
| 1 | anonymous | redirect to `/login` (page) or 401 (JSON) |
| 2 | no CSRF token | 403 |
| 3 | **authenticated wrong role (Viewer)** | **403 AND no DB row written** |
| 4 | correct role | succeeds (302/200) |

**Step 3's row-count assertion is the whole point** — a status-code-only test would have passed on
all of B1–B3.

**Regression tests to add verbatim (these currently FAIL, which is the proof they are real):**

```js
test('a Viewer cannot post a ledger entry', async () => {
  const before = count('accounting_ledger');
  const res = await viewer.post('/ledger/entry', 'type=Expense&date=2026-09-30&side=debit&amount=777000');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(count('accounting_ledger'), before, 'and nothing was written');
});

test('a Viewer cannot reverse a ledger line', async () => {
  const before = count('accounting_ledger');
  const res = await viewer.post(`/ledger/${lineId}/reverse`, 'date=2026-09-30');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(count('accounting_ledger'), before);
  assert.strictEqual(reversalsOf(lineId), 0, 'the one-shot correction slot is untouched');
});

test('a Viewer cannot mark a cost line as checked', async () => {
  const res = await viewer.post('/queue/tag', `line=${id}&check=1`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(checkedOf(id), 0, 'the checker role is the only way into the cost report');
});

test('a Viewer cannot confirm an import', async () => {
  const before = count('accounting_ledger');
  const res = await viewer.postJson(`/api/imports/${batchId}/confirm`);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(count('accounting_ledger'), before);
});
```

### Task 0.3 — `synchronous = FULL`

**Files:** Modify `src/db/db.js:11` → `db.pragma('synchronous = FULL')`. TECH-SPEC §4.1 requires it;
NORMAL can lose committed transactions on power loss. Verify with a fresh connection:
`PRAGMA synchronous` must return `2`.

### Task 0.4 — Security headers + CSP (TECH-SPEC §3.6, §3.10)

**Files:** Create `src/lib/security-headers.js`; modify `src/server.js`. Add
`Content-Security-Policy` (with **nonces** for the inline `<script>` blocks in `views/import.ejs`
and friends — the app has real inline JS, so a bare policy would break the import screen),
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and HSTS when served over HTTPS.
Keep the middleware order from §3.10: headers must sit before routes and after cookies.

**Verify:** assert the headers on a real response in a test; then load `/import` and confirm the
Alpine/vanilla script still runs with CSP enforced (no console violations).

### Task 0.5 — Rate limiting + cookie `secure`

**Files:** Modify `src/server.js` (per-IP limit on `/login` and the JSON import endpoints),
`src/routes/auth.js:63` (add `secure:` gated on an env flag so local HTTP dev still works).

*Decision 3A — **approved**: install `express-rate-limit`* (the second dependency ever approved, after
`busboy`). Re-implementing a correct sliding window by hand is worse than one well-known package.

**Key on `req.ip`, not the account.** Account lockout (AU1.1 `locked_until`) only fires after 5 failures
*for one account* — an attacker spraying 1,000 emails never trips it. Requires
`app.set('trust proxy', …)` with the **real** proxy hop count (nginx/tailscale sits in front here), or
the limiter keys every request to the proxy's own IP and throttles all users at once. Return `429` +
`Retry-After`; keep the login window generous so a fat-fingered legitimate user is not locked out.

### Task 0.6 — Remove the two raw-SQL leaks in routes

**Files:** Modify `src/routes/app.js:278` and `:518` → move into `src/db/queries.js`.
TECH-SPEC §5. **This is the same habit that produced B2** (the unguarded `/queue/tag` writes
`lpb_statements` inline), so fix it now rather than inheriting it into Modules 6–9.

### Task 0.7 — Repair the schema validator (it was green while lying) — ✅ DONE 2026-10-01

**Files:** new `db/dump-schema.js`; regenerated `db/schema.sql`; `db/validate.py`; `package.json`.

**What shipped:** `db/dump-schema.js` rebuilds `schema.sql` from a freshly-migrated throwaway DB,
copying DDL **verbatim out of `sqlite_master`** and emitting it in dependency order
(tables → indexes → triggers → views — SQLite validates a view against its tables at CREATE time).
`--check` compares without writing, and `npm test` now runs
`node db/dump-schema.js --check && python3 db/validate.py` before the node suite. `validate.py` gained
a **drift gate** asserting 9 named guards exist (reversal trio, CBS/blocked triggers, dedupe index)
plus the dedupe index's partial predicate, and **5 reversal-guard tests** that previously had nothing
to bite on because the guards were missing from the file it read.

**Verified by removing a guard and confirming exit 1** — a gate that has never been seen to fail is
not a gate.

`db/validate.py` runs `db/schema.sql` and passes — but the app runs `db/migrations/`, and the two have
diverged. Measured:

| Object | migrations | schema.sql |
|---|---|---|
| triggers | **21** | **14** |
| tables | 43 | 44 |

**7 triggers existed only in the migrations** — including `trg_ledger_reversal_must_negate`,
`trg_ledger_reversal_link_immutable`, `trg_lpb_checked_requires_cbs*`,
`trg_lpb_blocked_needs_reason*`, `trg_lpb_no_check_from_blocked`. `v_lpb_reconciliation`,
`v_cbs_actual`, `accounting_ledger`, `lpb_statements`, `cash_advance` and `import_batches` all differ.
So the validator asserts invariants against a schema that lacks the guards. It is also **not wired
into `npm test`** — it only runs if invoked by hand.

- Regenerate `schema.sql` as the migrated result (copy DDL **verbatim** out of `sqlite_master` — never
  retype; see the skill's rebuild section).
- Add `"test": "node --test --test-concurrency=1 test/*.test.js && python3 db/validate.py"` so the
  validator's exit code fails the suite.
- Add SCH1.1–SCH1.4 (drift check) to `TEST_PLAN.md` §14.

### Task 0.8 — Wire in the declared-but-unused fixtures — ✅ DONE 2026-10-01

**Files:** `db/fixture-ledger-export.tsv` (26 rows, was referenced by **zero** tests),
`db/seed-smoke.sql` (used by `validate.py` only), new `test/fixture.test.js` — **port `3908`**
(the plan said 3909, which the skill reserves for the fixture-probe port).

TECH-SPEC §8.3: *"The real-ledger fixture is regression-checked on every run."* It was not.
FX1.1–FX4.2 (9 tests) now drive it end to end: parse → stage → preview → confirm → ledger rows →
re-import dedupe.

**Wiring it in found 3 real defects the existing CSV unit tests could not, because every CSV test in
the suite is comma-separated with ISO dates while the real export is neither:**

1. **No TAB delimiter support** — the real file is tab-separated and the parser split on `,`/`;` only,
   so each row collapsed to ONE cell and all 26 quarantined as *"missing transaction_id"*.
2. **No Excel serial dates** — the real file carries `45200`, which `toIsoDate` rejected, so every row
   also failed on *"bad date"*.
3. **`.tsv` rejected by the upload route** (`ALLOWED_EXT`) — the canonical real file could not be
   uploaded at all, despite the parser being able to read it.

Fixed in `src/lib/csv.js` + `src/routes/api.js`. The delimiter fix had to be real *detection*, not
"also split on tab": real descriptions contain commas, so splitting on both would cut text fields.

**Found but NOT fixed (out of §0 scope):** §8.4's *"every imported transaction group balances to zero
or is quarantined"* is not implemented — `import-service.js` validates per row only. On the fixture,
`SAL-24-10-0038` is a lone 14,200,000 debit with no credit leg and imports without comment. Ask
the owner before implementing.

### Task 0.9 — Project scope (BOLA): the PRD requirement that was never built — ✅ BUILT 2026-10-01

**This was the largest single gap found, and it was a design gap, not a missing guard.**

PRD §2.3: *"**Per-project assignments** (junction table): users are assigned a role **per project**.
PM sees own projects; Finance sees all cost data; Viewer sees assigned dashboards."*

`user_roles.project_id` existed for exactly this — and was **NULL in every row and read by zero
code**. Measured with two projects, before the fix:

```
user reads  /ledger?project=2      -> 200  *** PROJECT B DATA VISIBLE ***
user writes /ledger/entry?project=2-> 302  *** WROTE INTO ANOTHER PROJECT ***
```

**What shipped:**

| Piece | Where |
|---|---|
| `projectsFor(user)` / `canAccessProject(user, id)` / `scopeReason(user)` | `src/lib/permissions.js` |
| Scope-aware project context (replaces the duplicated `projectContext` in app.js AND admin.js) | **new** `src/middleware/scope.js` |
| Per-project assignment UI + `POST /admin/users/:id/projects` | `src/routes/admin.js`, `views/admin-users.ejs` |
| Real project switcher (was a dead `<button>`) | `views/partials/sidebar.ejs` + `views/layout-app.ejs` + `assets/app.css` |
| Backfill of every existing account | `db/migrations/010_project_scope_backfill.sql` |
| 16 tests, both gate modes | `test/bola.test.js` (ports 3902 gate-off, 3903 gate-on) |

**Resolution order in `projectsFor` — the plan's "which default?" question, answered explicitly:**

1. unknown user → **nothing** (fail closed)
2. org-wide role (`administrator`, `finance`, `human_capital`, `procurement`) or `is_system_admin` → **every project**
3. has project-scoped grants → **exactly those**
4. non-admin holding ONLY a scoped role, unassigned → **nothing** (a `project_manager` with no project is a half-finished config; granting the portfolio inverts the scoped role)
5. global role, no scoped grants → **every project** (the pre-scoping behaviour, i.e. the plan's documented v1 fallback)

Only rules 3 and 4 change what an existing account sees when the gate flips — deliberate, so the
backfill can be verified before enforcement. Rule 5 is asserted in BOLA1.11 so the fallback is a
decision on record rather than an accident.

**Two further leaks found while building this, both now fixed:**

- **`GET /` leaked every project name to any signed-in user.** The dashboard route called
  `q.projects()` (the whole portfolio) instead of the authorised set, so a project-scoped PM got a
  dashboard listing projects they are not on. Now `res.locals.projects`.
- **A write path that "not enforced" must still refuse.** `SCOPE_ENFORCE` off means *the ?project
  parameter is not authoritative*, NOT *cross-project writes are allowed*. BOLA1.7 asserts the
  row count is unchanged with the gate OFF — the audit's five original bugs all returned a cheerful
  302 while writing.

**Backfill design (migration 010 is DATA-ONLY — no DDL, safe before or after enforcement):**

- Org-wide roles and system admins stay GLOBAL (`project_id IS NULL`). Scoping Finance to one
  project would break "Finance sees all cost data". The role list must stay in step with
  `ORG_WIDE_ROLES` in `lib/permissions.js`.
- Every other role is scoped to **every project that existed at migration time**. With one project
  (PRJ-2026) this is exactly decision 1A ("assign all four accounts to PRJ-2026"), generalised so it
  stays correct on a multi-project install. **No account loses access**, which is the entire point
  of backfill-then-enforce.
- **The global role row is deliberately KEPT alongside the scoped one.** The roster
  (`q.allUsers`, `q.userWithRole`) and the sidebar role name all join on `project_id IS NULL`, so
  deleting it would blank out every user's displayed role. The scoped row is what the scope layer
  reads; the global row is what the UI reads as the account's role.
- `INSERT OR IGNORE` against `UNIQUE (user_id, role_code, project_id)` makes it idempotent.

**Still needs the owner:** nothing to build — but enforcement stays OFF until **Ayu** assigns the four real
accounts to PRJ-2026 (or confirms the backfill already did it, which it does for the current
single-project install). Flipping `SCOPE_ENFORCE=1` is then a one-line change on the host.

**Ordering:** built before Module 6, which creates the second project that turns the latent flaw into
a live leak.

### Task 0.10 — Frozen period — ✅ DONE 2026-10-01

TECH-SPEC §8.4: *"Frozen period rejects ordinary backdated writes"* and *"the flagged revision path
remains explicit"*. The `frozen_periods` table existed since migration 001 with **zero rows, no
trigger, no route and no reference anywhere in `src/`** — the invariant was in the spec and nowhere
in the system.

**Three assumptions in the original plan were wrong, and were corrected against the DB:**

| Plan said | Reality |
|---|---|
| modify `src/lib/periods.js` | did not exist — created |
| triggers on `ledger` | table is **`accounting_ledger`** |
| "unless a `revision_of` marker is present" | no such column; reversals use `reverses_ledger_id` |

**Built:**
- `db/migrations/011_frozen_period_enforcement.sql` — `trg_ledger_frozen_period_insert` (on
  `accounting_ledger`) and `trg_lpb_frozen_period_check` / `_check_insert` (on `lpb_statements`).
- `src/lib/periods.js` — `monthOf` / `periodKeyOf` / `isFrozen` / `frozenPeriod` / `frozenMonths` /
  `monthsWithActivity` / `checkWrite`.
- `src/db/queries.js` — `freezePeriod` / `unfreezePeriod`.
- `src/routes/app.js` — `/periods` (view), `/periods/freeze`, `/periods/unfreeze`, gated on the
  **existing** `requireAdmin`; entry POST refuses before inserting so the message is a sentence, not
  a raw `RAISE(ABORT)`.
- `views/periods.ejs` + sidebar nav entry.
- `test/periods.test.js` — FP1.1–FP1.7, port **3910**.

**Key design decisions, and why:**

1. **The date is `COALESCE(effective_date, date)`.** `effective_date` is the accounting date and is
   what `v_ledger_period` / `v_cbs_actual` group by. Freezing on `date` alone would let a row into a
   frozen month by backdating one column. FP1.6 asserts the backdate path is closed.
2. **The door is the EXISTING reversal mechanism, not a new `revision_of` flag.** The plan assumed a
   flag. Reusing `reverses_ledger_id` keeps exactly ONE way to correct a posted line — the reversal
   is already the only legal correction, already enforced by
   `trg_ledger_reversal_link_immutable` / `_must_negate`, and already the only thing
   `lib/ledger-correction.js` writes. A parallel flag would be a second mechanism doing the same job,
   and the one nobody exercises is the one that rots.
3. **`lpb_statements` is guarded at the CHECK transition, not the draft insert.** An lpb line is not
   cost until checked (`v_cbs_actual` counts `status='checked'` only), so a draft in a frozen month is
   harmless and must stay legal — guarding it would block ordinary data entry for no accounting
   effect. The check is what books the cost, so the check is what freezes. The door there is
   `superseded_by`, already set at check time by the correction flow from migration 009.
4. **No `accounting_ledger` UPDATE trigger.** The columns that could move a row into another month
   are already immutable once posted (`trg_ledger_no_amount_update`,
   `trg_ledger_immutable_financial_fields`), so such a trigger would be dead code.

**Two real bugs the tests caught during the build:**
- A second `requireAdmin` was being written when `middleware/auth.js` already exports one — the
  duplicate caused 403s and was removed.
- The csrf test helper takes a URL-encoded **body string**, not an object. Passing an object
  stringified to `[object Object]` and failed CSRF, which surfaced as a misleading 403 before the
  route ran.

**Definition of done:** `npm test` green at **210** (202 + 8 FP); the route refuses with the period
named; the trigger refuses a direct insert with no route involved (FP1.6 — the guarantee, not the
courtesy); a reversal into a frozen month is admitted and moves the total by exactly the correction;
freeze/unfreeze is audit-logged with the actor; a non-Administrator cannot freeze; and a row cannot be
**walked** into a frozen month by editing `effective_date` (FP1.8 — the hole `validate.py` found).

---

## 1. Verified current state (2026-09-30)

Measured on disk, not from memory:

| Fact | Value |
|---|---|
| Git | `9d069e9` HEAD, working tree **clean**, all commits **local** (no remote) |
| DB | `data/practis.db` **user_version 9**, `integrity ok` |
| Tests | **148/148 pass** — *but see §0: the suite tests authentication, not authorization* |
| Migrations | `001`–`009` |
| Route files | `auth.js`, `admin.js`, `api.js`, `app.js` |
| Views | 20 files incl. 403/404, login, dashboard, ledger, queue, import, advances, expenses, reconciliation, admin-users |
| Projects in DB | 1 — `PRJ-2026` "Citarum Bridge" |
| Ledger lines | 9 |
| LPB lines | 0 |
| Audit | `docs/AUDIT-2026-09-30.md` — 5 blockers, 10 should-fix, 7 verified-good |

### What §10 orders 1–5 delivered

1. Foundation ✅ 2. Auth ✅ 3. Project setup ⚠️ **partial** 4. Ledger ✅ 5. Cash Advance + Expense Report ✅

### The gap that shapes this plan

§10 step 3 (**Project setup**) was **skipped**. Consequences, measured:

- **`/projects` returns 404.** `views/partials/sidebar.ejs:14` links to `/projects`; **no route exists**.
  A dead nav link visible to every user.
- **There is no create-project UI.** The single project `PRJ-2026` came from `src/db/seed.js`.
  PRACTIS cannot register a second project through the app.
- **There is no client / supplier / team register UI** — `clients`, `suppliers`, `teams`,
  `employees` tables exist and are empty of management screens.
- **No master-data UI** for the company-standard menus (`wbs_code`, `rbs_code`,
  `chart_of_accounts`, `cashflow_categories`, `cost_categories`, `transaction_accounts`).
  Today `seed-master.js` is the only way they change — which the PRD §8 explicitly puts under
  **"Ask first"** for WBS/RBS menu changes.
- **The project switcher in the sidebar is a dead `<button>`** — it renders `PRJ-2026` but cannot
  switch. `projectContext` (in `app.js`) resolves the project from `?project=<id>` via
  `all.find(p => p.id === Number(req.query.project)) || all[0]`, so switching works only if you
  hand-type the query param.
- **`rbs_code` is empty (0 rows)** and `progress_milestones` is empty (0 rows).

### Downstream blockers (why step 3 cannot be deferred further)

- **`cbs_plan` has 0 rows → the EVM engine has no PV.** `v_evm_period` derives `pv` from
  `cbs_plan WHERE plan_type='baseline'`. No baseline ⇒ **SPI is permanently NULL** and the
  portfolio dashboard cannot show EVM. Baseline creation is §10 step 6, and **RBS containment
  verification needs a WBSTree**.
- **`-WBS node counts.** `wbs_nodes` = 15 rows, `progress_milestones` = 0 — the milestone ticks
  that drive EV (PRD §5.1) are unpopulated, so `v_evm_period`'s `ev` is 0 even with a baseline.
- **Two NAV dead links still point at `#`**: *WBS*, *CBS plan*, *Overview*, *Revenue*, *Reports*.

### Honest status of the five built modules

Modules 4–5 are built, tested and auditable (212 assertions in the correction path, three checker
outcomes, CBS guard). But **they are not yet reachable end-to-end**, because the screens that create
the objects they operate on (`/projects`, WBS, CBS plan) do not exist. This is why §10 step 3 comes
first: everything downstream is currently exercised only by seed data and tests, never by a human.

---

## 2. Proposed approach

**One more foundation slice (Module 6), then proceed strictly in §10 order.**

The temptation is to jump at the visible feature (WBS tree + CBS baseline + BCR), which is §10 step 6
and the thing that unblocks EVM. But doing it before the project register means the WBS screens can
only ever operate on `PRJ-2026`, and every subsequent module inherits the same dead switcher. Step 3
is a prerequisite, not a detour — and it is the smallest of the remaining slices.

Rules taken from the PRD/spec, binding on every task below:

- **Never break modules 4–5.** They are the only complete, tested workflows. Any change to
  `permissions.js`, `queries.js` or `app.js` must keep **148/148** green.
- **Keep every capability flag when editing the role map** (the `canOpenAdvance` near-miss is
  documented in the skill). A dropped flag 403s a whole workflow.
- **Business rules live in services; routes only validate HTTP and pick a response.**
- **Money only in `cbs_plan` + ledger.** WBS/RBS hold no money.
- **WBS/RBS menu edits need Admin approval** (PRD §8 "Ask first") — the UI must gate them.
- **Baselines are never edited post-approval without a BCR**; de-scope is prospective only.
- **No new dependencies.**
- **No push.** Commits stay local (no remote, PAT invalid).

---

## 3. Step-by-step plan

**Sequence: §0 authorization + hardening → Module 6 (project setup) → Modules 7–11 in §10 order.**
§0 is not optional and not parallelisable — it is the floor every later module stands on.

### MODULE 6 — Project setup & register (finishes §10 step 3)

Everything in this module is one vertical slice: **route + service + test + template + nav fix**.

---

#### Task 6.1 — `/projects` portfolio register page (fixes the 404) — ✅ DONE 2026-10-01

**Objective:** Make the dead nav link work — list every project with its register state, and make
the sidebar switcher actually switch.

**Outcome.** Built as `src/routes/projects.js` + `views/projects.ejs`, mounted in `src/server.js`
after `routes/api`. Test file `test/projects.test.js`, IDs **PR1.1–PR1.7**, port **3904** (see the
port note below). The switcher half needed **no work**: task 0.9 had already replaced the dead
`.pc-btn` button with real `<a href="/?project=N">` links rendered from the AUTHORISED list, so
PR1.4 asserts that existing behaviour rather than building it again.

Two things the plan got wrong, both corrected against the code:

- **Port `3903` was already taken by `test/bola.test.js`** (it runs two servers, 3902 gate-off and
  3903 gate-on). Used **3904**. Free ports as of this build: 3904, 3907, 3909, 3911+.
- **The plan's switcher assertion `href="/?project=1"` is vacuous with one project.** With a single
  authorised project the sidebar deliberately renders a **disabled** button and no menu at all, so
  the test seeds a second project (`PRJ-2027`) and asserts both links — otherwise it would pass on
  a broken switcher.

**The register lists `projectsFor(req.user)`, NOT `q.projects()`.** Those differ, and choosing the
wrong one is precisely the BOLA leak already found on the dashboard. PR1.7 counts the rendered
project codes for a one-project user and asserts exactly **1** — a status-only assertion would pass
on a page that listed the whole portfolio.

Also note `seed.js` creates **`PRJ-2026 / Citarum Bridge`** (contract 12,480,000,000). The dev DB
carries `JC-2026 / Jembatan Citarum` because the owner edited it; tests always use the seeded code.

**Files (actual):**
- Create: `src/routes/projects.js`, `views/projects.ejs`, `test/projects.test.js`
- Modify: `src/server.js` (one mount line)

---

#### Task 6.1 — original plan text (kept for reference)

**Files:**
- Create: `src/routes/projects.js` (mount in `src/server.js` after `middleware/auth.attachUser`)
- Create: `views/projects.ejs`
- Modify: `views/partials/sidebar.ejs:14` (keep `/projects`), and turn the dead `.pc-btn`
  `<button>` into a real form that submits `?project=<id>` (or a small Alpine CSP dropdown with
  plain `<a href="/?project=N">` links — **no `unsafe-eval`**, per PRD non-functional §6)
- Test: `test/projects.test.js` — **new port `3903`** (3901 = authz, 3902 = bola, 3903 = projects;
  3993–3999 legacy. Verify with `grep -h "PORT = " test/*.test.js` before committing)

**Step 1 — failing test**

```js
// test/projects.test.js — harness copied verbatim from test/entry.test.js
// (mkdtemp DB → migrate → seed → seed-master → spawn server → csrf client)
test('GET /projects lists the seeded project with its register state', async () => {
  const res = await client(origin).get('/projects');
  assert.equal(res.status, 200);
  assert.match(res.text, /PRJ-2026/);
  assert.match(res.text, /Citarum Bridge/);
});

test('the sidebar switcher offers every project', async () => {
  const res = await client(origin).get('/');
  assert.match(res.text, /href="\/\?project=1"/);
});
```

**Step 2 — run, expect failure:** `node --test test/projects.test.js` → 404 / no route.

**Step 3 — implement**

- `src/routes/projects.js`: `GET /projects` → `q.projects()` (already exists), render
  `views/projects.ejs`. Show per project: code, name, client, contract amount, `baseline_locked`,
  status, and a "not baselined" chip when `baseline_locked = 0` (PRD §4.1 step 6 language).
- Page contract, per the user's standing UI rule: **title + muted sub-title + full-width PC**,
  dense Inter/tabular-nums, style tokens copied from an existing view (`views/advances.ejs`) —
  do **not** invent a new look.
- `active: 'Projects'` so the sidebar highlights.

**Step 4 — verify:** `node --test test/projects.test.js` → PASS; then full `npm test` → **150/150**.

**Step 5 — commit:** `feat(projects): portfolio register page and a working project switcher`

---

#### Task 6.2 — Project register: create/edit with the approval workflow — ✅ DONE 2026-10-01

**Outcome.** `src/lib/projects-service.js` + routes in `src/routes/projects.js` + `views/project-new.ejs`
/ `project-edit.ejs`. Tests **PR2.1–PR2.19** (same file, same port 3904). Suite floor **217 → 236**.

**THE DECISION THIS TASK NEEDED (owner, 2026-10-01).** PRD §4.1 gives the project register four
different actors (PM starts → Finance → PM → Admin). Decision 8A collapses it to *"the PM approves"* —
and the PM is also the one who starts it, so creator and approver are the same person. A blanket
`approver ≠ requester` rule would **deadlock this install**: every project would sit unapproved
forever, because there is no second user.

The answer: **self-approval is allowed, but only with a typed reason (≥10 characters) recorded in the
audit trail.** The control is not "you may not approve your own work" — it is "approving your own work
is a deliberate, attributable act that has to be justified on the record". A different approver needs
no reason. `checkSelfApproval()` is the predicate; PR2.13–PR2.15 pin both halves, and PR2.11 asserts
the reason lands in `audit_log.after_json.reason` with `self_approved: true`.

**Approval is DATA (plan 6.5b).** `REQUIRED_STEPS` / `RECORDED_STEPS` in the service; every step is
written to `approvals` as a pending row at registration, and only `pm_approve` is *required* under the
light chain. Switching to the full PRD chain is then a data change, not a refactor — and no history is
lost because all four steps were always recorded.

**Two things that 500'd and why (both real, both fixed):**
1. `svc.clientNameFor is not a function` — the helper was defined but **not exported**. The register
   500'd on every render. Caught by reading the server's stderr in a debug script, not by guessing.
2. `notification_inbox.alert_type` has **no CHECK constraint** (it is only a comment), so
   `approval_pending` is a legal value. `severity` IS constrained to `info|warning|critical`.

**`industry_type` and `client_id` are optional and their tables are EMPTY.** `industry_types` and
`project_types` are seeded by an Administrator (PRD §4.1 step 1) — that is task 6.5, not built yet —
so making them mandatory would make registration impossible on a fresh install. They render as
optional selects.

**The form does not promise visibility.** A scoped PM who registers a project cannot necessarily open
it (`projectsFor` grants only assigned projects; `SCOPE_ENFORCE` governs refusal). The POST therefore
redirects to `/projects?saved=N` with a confirmation, rather than into the project.

**Files (actual):**
- Create: `src/lib/projects-service.js`, `views/project-new.ejs`, `views/project-edit.ejs`
- Modify: `src/routes/projects.js`, `src/db/queries.js`, `src/lib/permissions.js`
  (+ `canManageProjects`, `canApproveProjects`, `canViewProjects` — **added, nothing restructured**)

---

#### Task 6.2 — original plan text (kept for reference)

**Objective:** Let a PM/Controller/Project Admin register a project in-app (PRD §4.1 steps 1–6).

**Files:**
- Create: `src/lib/projects-service.js` (business rules + transaction)
- Modify: `src/routes/projects.js`
- Create: `views/project-new.ejs`, `views/project-edit.ejs`
- Modify: `src/lib/permissions.js` — add **`canManageProjects`** (`project_manager`,
  `project_controller`, `project_admin`) and **`canApproveProjects`** (`project_manager`; Admin
  holds all roles by design). **Keep every existing flag** — add, do not restructure.
- Test: extend `test/projects.test.js`

**Step 1 — failing tests**

```js
test('a Project Admin can register a project; it starts not-baselined', async () => { ... });
test('revenue method is required at registration (PRD 4.1 step 5)', async () => { ... });
test('a Viewer cannot register a project (403 with a reason, not a hidden link)', async () => { ... });
test('the project code must be unique', async () => { ... });  // UNIQUE(code) → 409, not 500
```

**Step 2 — run, expect failure.**

**Step 3 — implement**
- `projects-service.js` owns the transaction: insert `projects` row (`code`, `name`, `client_id`,
  `industry_type`, `contract_amount`, `revenue_method`, `payment_terms_days`, `start_date`,
  `end_date`, `created_by`), then `insertAudit('project', id, 'create', …)`.
- `revenue_method` ∈ `milestone|poc|time_based|on_billing` (CHECK constraint already enforces it) —
  validate before insert so the user gets a sentence, not a SQL error.
- Approval state lives in the existing **`approvals`** table; record PM approval + Admin approval
  as rows, never a boolean column.
- Route: `POST /projects` gated on `canManageProjects`, `POST /projects/:id/approve` gated on
  `canApproveProjects`. **Pages and actions get separate flags** (the Project Admin lesson).
- **Publication switch creates in-app notifications** — insert `notification_inbox` rows for the
  Finance verify / PM verify / Admin approve steps (PRD non-functional: in-app only).

**Step 4 — verify:** new tests pass; full suite green; `PRAGMA foreign_key_check` clean.

**Step 5 — commit.**

---

#### Task 6.3 — Clients register (Finance verifies, Admin approves) — ✅ DONE 2026-10-01

**Outcome.** `src/lib/clients-service.js`, `views/clients.ejs`, `views/client-new.ejs`,
`views/client-edit.ejs`; routes in `src/routes/projects.js`; migration `012_client_provenance.sql`.
Tests **PR3.1–PR3.18**. Suite floor **236 → 266** (264 green at first commit: two pre-existing
tests, AZ4.4 and I8.4, were broken by this work and fixed immediately after — see below).

**THE SHARED-CONTROL REFACTOR.** 6.2 had the segregation-of-duties rule inside
`projects-service.js`. Copying it here would be how a control drifts, so it was extracted to
`src/lib/approvals-service.js` — ONE implementation of the chain (`REQUIRED_STEPS`,
`RECORDED_STEPS`), the SoD predicate, the notification fan-out and the approval transaction.
Projects, clients and (6.4) suppliers all call it. The 6.2 tests still pass unchanged, which is the
evidence the extraction was behaviour-preserving.

**THE CONFLICT THIS TASK EXPOSED.** Plan 6.5b's table says clients are approved by "PM approves;
Finance/Admin recorded if present", and then in the very next paragraph says to keep
**"requester ≠ approver" enforced in all cases**. Both cannot hold: with one operator the same
person creates and approves, so a strict rule approves nothing, ever. PRD §4.1's two-actor chain
(Finance verifies → Admin approves) has the same defect for a solo install. Resolved the same way as
6.2 — **self-approval with a written reason** — and applied to *every* register rather than
per-register, so there is no register with an unusable chain.

**TWO REAL BUGS FOUND (neither was visible from the plan):**

1. **`clients` had no `created_by` column** — `projects` did. The SoD rule reads it, so the client
   register could not evaluate the control at all. Migration **012** adds it to `clients` **and**
   `suppliers`, deliberately in one migration so 6.4 does not need its own. It is nullable: existing
   rows have no known creator and are NOT backfilled with a guess; a NULL creator means "allowed"
   (nothing to be segregated from), which is the correct reading for a pre-provenance row.
2. **Every edit through the real UI failed.** `validate()` required `code` on update, but the edit
   views render the code `readonly disabled` — and a browser does not submit a disabled input. So
   the service saw no code, refused with "A client code is required.", and the operator could not
   edit anything. PR2.17 had passed only because the test posted `code=HACKED` explicitly: **the test
   was validating a request shape no browser produces.** Fixed in both services; PR2.17 now posts no
   code, PR2.17b proves a crafted code is ignored, PR3.12b is the regression guard.

**THE PLAN'S PREMISE WAS WRONG, AND THE CODE WAS NOT BENT TO MATCH IT.** Plan 6.3 states
`clients.payment_terms_days` is "the default that `v_aging` due dates depend on" and that a NULL
"silently breaks the aging report". Checked against the real code:
- `v_aging` buckets on **fixed 30/60/90/120-day** offsets from `invoice_date` and never reads
  `payment_terms_days`.
- PRD §5.2 DOES specify "Due date = ledger date + payment terms (from project register)" — but that
  due-date column **does not exist yet**. It belongs to Module 8, where the aging report screen lives
  (plan line 772 "Aging report — the `v_aging` view already buckets...").
So the column is validated as the business term it is (positive whole days) without manufacturing a
coupling that isn't in the code — and the misleading UI label "drives the aging report due date" was
removed. **Module 8 must add the due-date column and surface it; that is the follow-up this task
could not do.**

**Clients are NOT project-scoped.** One client serves many projects, so the register reads
`q.clientsAll()` and is deliberately not filtered by the current project (PR3.16 pins this). The
same-client-many-projects fact is also why the register lives under Portfolio, not under a project.

**Files (actual):**
- Create: `src/lib/approvals-service.js`, `src/lib/clients-service.js`,
  `views/clients.ejs`, `views/client-new.ejs`, `views/client-edit.ejs`,
  `db/migrations/012_client_provenance.sql`
- Modify: `src/routes/projects.js`, `src/db/queries.js`, `src/lib/projects-service.js`,
  `views/partials/sidebar.ejs` (+ Clients nav), `views/project-new.ejs` (client terms prefill),
  `db/schema.sql` (regenerated), `TEST_PLAN.md`

---

#### Task 6.3 — original plan text (kept for reference)

**Objective:** PRD §4.1 "Client register" — create a client with payment terms and industry type.

**Files:** Create `src/lib/clients-service.js`, `views/clients.ejs`, `views/client-new.ejs`;
modify `src/routes/projects.js`; extend `test/projects.test.js`.

**Key detail:** `clients.payment_terms_days` is the default that `v_aging` due dates depend on
(PRD §5.2: "Due date = ledger date + payment terms (from project register)"). Validate it as a
positive integer; a NULL here silently breaks the aging report.

**Approval shape:** `draft → verified (Finance) → approved (Admin)`, recorded in `approvals`, exactly
as the project register. **Finance/Admin are two different actors — reuse the SoD predicate style.**

**Verify:** new tests + full suite; then prove the aging path: create a client with 30-day terms,
bill an invoice, confirm `v_aging.days_aged` moves off `current` only after the terms window.

**Commit.**

---

#### Task 6.4 — Supplier and team registers — ✅ DONE 2026-10-02

**Objective:** PRD §4.1 "Supplier register" (Procurement → Finance → Admin) and "Team register"
(Admin creates team + roles, invites members).

**Built:** `src/lib/suppliers-service.js` (delegates the chain to `approvals-service.js`, which
already carried the supplier steps), `src/lib/teams-service.js`, `views/suppliers.ejs`,
`views/supplier-new.ejs`, `views/supplier-edit.ejs`, `views/teams.ejs`, `views/team.ejs`; supplier
routes in `src/routes/projects.js`, team routes in `src/routes/admin.js`; supplier/team accessors in
`src/db/queries.js`; capabilities in `src/lib/permissions.js`; sidebar links; tests
**SP4.1–SP4.16** (port 3911) and **TM4.1–TM4.16** (port 3912).

**Decisions taken while building:**

- **No migration was needed.** 012 already added `suppliers.created_by`, and `approvals-service.js`
  already had the supplier REQUIRED/ RECORDED steps and approver roles. Nothing new was invented.
- **Teams have NO approval chain.** A team is an internal grouping, not a register of parties; the
  PRD gives it no verify/approve steps. Membership IS `users.team_id` (no junction table exists).
- **A team grants no access.** Roles do. Team changes must never touch `user_roles` (pinned by tests).
- **`suppliers.approved_by`/`approved_at` are left unmaintained** — legacy columns nothing reads; the
  `approvals` table is authoritative and a second source of truth would drift.
- **Invitations reuse `invites.sendInvite`** rather than a second invite path.

---

#### Task 6.5b — Approval depth (decision 8A: LIGHT)

> **Locked by the owner 2026-09-30.** PRD §4.1 describes a 3-step verify/approve chain. This is a
> **solo-operator install**, so v1 enforces the **light** variant. Tasks 6.2–6.4 change accordingly:

| Register | PRD §4.1 chain | **v1 enforced (decision 8A)** |
|---|---|---|
| Project | verify → approve → finance | **PM approves.** Finance/Admin rows recorded but **optional** |
| Client | Finance verifies → Admin approves | **PM approves**; Finance/Admin recorded if present |
| Supplier | Procurement → Finance → Admin | **PM approves**; others recorded if present |

Implementation note: the `approvals` table already models this generically, so the difference is
**which steps are required for a record to count as approved** — express that as data (a
`required_steps` list per register type), **not** as branching inside each service. When the
organisation grows and decision 8 is revisited, only the required-steps data changes. Keep the SoD
predicate (**requester ≠ approver**) enforced in **all** cases — that is the part that actually
matters, and it is what the audit found missing on the checker path.

---

#### Task 6.5 — Master data screens (with the "Ask first" gate) — ✅ DONE 2026-10-02

**Objective:** PRD §5.5 — manage `chart_of_accounts`, `cashflow_categories`, `cost_categories`,
`resource_categories`, `wbs_code`, `rbs_code`, `transaction_accounts` (CBS).

**Built data-driven.** Nine datasets share ONE registry and ONE validated code path
(`src/lib/master-service.js`), because nine near-identical services would be nine copies of the
same validation and the copies would drift — the failure the 2026-09-30 audit already found on the
checker path. A dataset is DECLARED, not implemented; SQL is built from the registry and never from
request input, so a crafted form cannot reach a column that is not declared.

**Files:** `src/lib/master-service.js`, `src/routes/master.js`, `views/master/{index,list,form}.ejs`;
mounted in `src/server.js`; capabilities `canManageMaster` / `canManageStructure` in
`src/lib/permissions.js`; sidebar entry; tests **MA5.1–MA5.15** (port 3913).

**The two rules the plan named, implemented:**

1. **WBS/RBS menu changes are Administrator-only** (PRD §8 "Ask first"). This is a SEPARATE
   capability (`canManageStructure`) from ordinary master data (`canManageMaster`), so the same
   screen does not become admin-only for cost buckets. Both halves are pinned: MA5.7 (Finance
   refused on WBS) and MA5.8 (Finance ALLOWED on CBS) — a single admin-only rule would pass one
   test and defeat the purpose.
2. **CBS is what `v_cbs_actual` groups by, so nothing is deleted.** MA5.9 asserts against the
   VIEW, not the column: a ledger line is seeded onto another bucket, the test bucket is
   deactivated, and the cost-report total must be unchanged. MA5.10 shows the reference counts the
   screen reports, so the blast radius is visible before someone finds it in a report.

**Schema facts that shaped the screens (measured, not assumed):**

- `industry_types` / `project_types` have **no `code` and no `active` column**, so they are the one
  dataset type that cannot be set-once-and-deactivate: a rename applies everywhere at once. The
  screen says so out loud (MA5.12) instead of pretending they behave like the others.
- `chart_of_accounts` and `cashflow_categories` each carry a **legacy duplicate column**
  (`category`→`account_type`, and `inflow_outflow`→`direction`), each with its own CHECK. One form
  field writes BOTH, so they can never disagree — a disagreement would be invisible until a report
  read the other one.

**Commit.**

---

#### Task 6.6 — RBS + milestone defaults, no dead nav links — ✅ DONE 2026-10-02

**Built:**
- `src/lib/wbs-defaults.js` — a NEW project now gets its WBS tree (copied from the `wbs_code`
  master menu) AND the four default milestones per line, inside the project's own transaction. Until
  now a project registered through the UI got NOTHING: no tree, no milestones, so there was no
  progress to record. That empty default was invisible until someone tried to tick a milestone.
- `src/db/seed-master.js` — RBS **proposal** (5 resource categories + 24 RBS codes), industry types
  (7) and project types (6), both previously EMPTY (which is why the client form said "optional —
  set up by an Administrator" and had nothing to offer), plus milestones on the demo project.
- `views/partials/sidebar.ejs` — the FIVE remaining `href="#"` links (Reports, Overview, WBS, CBS
  plan, Revenue) are REMOVED, not hidden: an advertised link that goes nowhere reads as "broken",
  not "not built yet". Master data added under a new Setup group.

**Why Setup and not Administration:** the master-data screen is needed by the Cost Controller and
Finance to maintain the cost buckets and accounts they tag with, and the Administration group is
hidden from them entirely. The WBS/RBS lists inside stay Administrator-gated. A link they cannot
reach would have made task 6.5 useless to its main users.

**Decision 6B honoured literally:** the RBS list is marked in the seed as a starting proposal, and
every code is a plain abbreviation of its own name (L-CAR = Carpenter). **No code is dressed up to
look like a company standard**, because a resource list that is silently wrong is worse than an
empty one — it gets used, and then the cost breakdown is wrong in a way nobody questions.

**Acceptance (plan's own wording):** `select count(*) from rbs_code` = 24 (> 0 ✓); a newly created
project gets four milestone rows at 25% each ✓ (MS6.3/MS6.4); every sidebar `href` resolves to a real
route ✓ (MS6.8), with a companion test asserting no `href="#"` can come back (MS6.7).

**Commit.**

---

#### Task 6.6 — Populate RBS + milestone defaults, close the `#` nav links

**Objective:** Remove the last dead links and fix the empty-default problem.

**Files:** Modify `src/db/seed-master.js` (add `rbs_code` rows + default milestone set
mobilize → install → test → handover per PRD §5.1, **equal 25% weights — decision 7A**),
modify `views/partials/sidebar.ejs` (repoint *WBS* and *CBS plan* only once their routes exist —
until then **remove** them rather than leave `#`), extend tests.

**RBS list — decision 6B: I propose, the owner edits.** No company standard exists in the PRD, so seed a
conventional construction resource list (labour by trade, plant/equipment by type, materials,
subcontract, overhead) with stable short codes, then hand it to the owner for edit. **Do not invent codes
that look authoritative** — mark the set clearly as a starting proposal in the seed comment. A resource
list that is silently wrong is worse than an empty one because it gets used.

**Verify:** `select count(*) from rbs_code` > 0; a newly created project gets its four default
milestone rows at 25% each; every sidebar `href` resolves to a real route (assert with a test that
walks the sidebar and hits each link).

**Commit.**

---

### MODULE 7 — WBS / progress / RBS / CBS baseline / BCR (§10 step 6)

The largest remaining slice and the one that **unblocks EVM**. Do not start before Module 6 lands.

**Order within the module (each its own commit + test):**

1. **WBS tree UI** — `src/routes/wbs.js`, `src/lib/wbs-service.js`, `views/wbs.ejs`.
   Tree from `wbs_nodes` (`parent_id`, `sort_order`); status `active|completed|de_scoped`;
   **lines are never deleted** (PRD §4.4). Edits version the line (`version`, `superseded_by`).
   Internal replanning (add/split/rename, **contract_value_delta = 0**) writes a `change_log` row
   with no BCR; anything else needs a BCR. **Assert the delta rule in a test** — it is the PRD's
   explicit test ("the test is the contract, not a size threshold").
2. **Milestone ticks → % complete** — `progress_milestones` (`pct_weight`, `ticked`, `ticked_by`)
   → `wbs_progress` (`period_month`, `pct_complete`, `source='milestones'`). This is what feeds
   `ev` in `v_evm_period`, so nothing EVM works before it.
3. **RBS load** — `rbs_load` (rate × units = `total_amount`, materialised for the invariant).
4. **CBS baseline** — `cbs_plan` with `plan_type='baseline'`, monthly buckets per
   `transaction_account_id`. **This is the money book and the source of `pv`.** Enforce the PRD
   invariant **Σ monthly buckets = account total = RBS total** in a test — it is the one invariant
   the PRD names explicitly (§6 "Data integrity invariants").
5. **Baseline freeze** — `projects.baseline_locked = 1` + `baseline_locked_at/by`, PM approves
   (Admin excluded — PRD §4.2 step 4). After this, edits are refused at the service **and** by a
   trigger.
6. **BCR workflow** — `bcr_register` (`draft → verified → approved|rejected|withdrawn`),
   `old_baseline_json` / `new_baseline_json` archival, `effective_period` prospective. Approved BCR
   re-baselines: old numbers archived, new become `pv`.
7. **De-scope** — `status='de_scoped'` + `de_scope_period`; **progress freezes**, budget leaves the
   PV curve **from that period forward only** (past months untouched — PRD §4.4, EIA-748 G-30);
   spent cost **stays tagged** (already visible via `v_descoped_lines`). Assert "past months
   unchanged" directly by comparing `v_evm_period` rows before/after a de-scope.

**Verification for Module 7 (the acceptance that matters):** with a baseline, some ticks and some
tagged actuals, `v_evm_period` returns **non-NULL SPI and CPI** for the project — proving the engine
that has been dark since day one finally has its inputs.

---

### MODULE 8 — EVM / revenue / aging / dashboards (§10 step 7)

1. **Project dashboard** — S-curves (PV from baseline, EV from ticks × CBS, AC from ledger), EVM
   trend, WBS drill-down. `v_evm_period` is already written; this is the view layer.
   **Render natural signs** (income +, cost +, net = income − cost) — the sign convention lives in
   the view, per PRD §5.2 "Signs".
2. **Portfolio dashboard** — replace the current minimal `dashboard.ejs` with CPI/SPI traffic-light
   cards, current-month cashflow, portfolio forecast.
3. **Revenue recognition** — `revenue_recognized` per project method. **POC reads BAST %** from
   `acceptance_register`, **not** the internal tick % (PRD §5.3) — keep the two never conflated.
   Billed vs recognized vs received are three separate timelines (IFRS15/PSAK72): use
   `v_receivable` for billed/received and `revenue_recognized` for recognized.
4. **Aging report** — the `v_aging` view already buckets 30/60/90/120+; this is the screen.
5. **Retainage** — surfaced separately, never buried in regular AR (`v_receivable.retainage_amount`).

### MODULE 9 — Reporting, jobs, alerts (§10 step 8)

- **Project Update Report** — monthly, per project: SPI, CPI, receivable vs revenue, payable
  status, exceptions, prior-baseline vs current. **Freezing the period** inserts `frozen_periods`
  and rejects entries tagged to a frozen period (PRD §4.4 month-end calendar).
- **The six alerts** (PRD §4.4 table) + `notification_inbox`, polled in-app every 30s.
  Thresholds tunable per project.
- **Exports** — PDF + XLSX report pack, **light print theme** (dark app / light print).
- **Jobs runner** — TECH-SPEC §4.5 (`jobs` table already exists).

### MODULE 10 — Admin hardening, recovery tooling, deployment (§10 step 9)

- Backup/restore + quarterly drill (TECH-SPEC §12.4/12.5, TS-19), RPO/RTO — **still open, §9.1/9.2**.
- Docker + one container/one process (TS-25), Tailscale Serve (TS-22).
- Health/readiness endpoints (`/health`, `/ready`).

### MODULE 11 — Legacy migration rehearsal + cutover (§10 step 10)

- `docs/MIGRATION-MAP.md` is written; remaining work is a **dry run and reconciliation**.
- Migration is **TS-04's staged import** against real data, with the dedupe index doing the work.

---

## 4. Files likely to change

| Module | Create | Modify |
|---|---|---|
| 6.1 | `src/routes/projects.js`, `views/projects.ejs`, `test/projects.test.js` | `src/server.js`, `views/partials/sidebar.ejs` |
| 6.2 | `src/lib/projects-service.js`, `views/project-new.ejs`, `views/project-edit.ejs` | `src/lib/permissions.js`, `src/routes/projects.js` |
| 6.3 | `src/lib/clients-service.js`, `views/clients.ejs`, `views/client-new.ejs` | `src/routes/projects.js` |
| 6.4 | `src/lib/suppliers-service.js`, `views/suppliers.ejs`, `views/teams.ejs` | `src/routes/projects.js`, `src/routes/admin.js` |
| 6.5 | `src/routes/master.js`, `src/lib/master-service.js`, `views/master/*.ejs` | `src/server.js` |
| 6.6 | — | `src/db/seed-master.js`, `views/partials/sidebar.ejs` |
| 7 | `src/routes/wbs.js`, `src/lib/wbs-service.js`, `src/lib/cbs-plan-service.js`, `src/lib/bcr-service.js`, `views/wbs.ejs`, `views/cbs-plan.ejs`, `views/bcr.ejs` | `src/lib/permissions.js`, `views/partials/sidebar.ejs` |
| 8 | `src/routes/reporting.js`, `views/project-dashboard.ejs`, `views/portfolio.ejs`, `views/revenue.ejs`, `views/aging.ejs` | `views/dashboard.ejs` |
| 9 | `src/lib/alerts.js`, `src/lib/report-export.js`, `views/notifications.ejs` | `src/routes/*` |
| 10–11 | Dockerfile, compose, `docs/RUNBOOK.md` | `docs/TECH-SPEC.md` (RPO/RTO) |

**Migration files:** Module 7 will likely need `010_wbs_versioning.sql` and
`011_cbs_plan_freeze.sql`. **Use the modern rebuild order** (create-new → copy → drop → rename) and
copy index/trigger/view SQL **verbatim from `sqlite_master`** — the 003 rebuild is the cautionary
example in the skill. Re-audit with `PRAGMA foreign_key_check` +
`instr(COALESCE(sql,''),'_old') = 0` immediately after.

---

## 5. Tests / validation

**Per task:** failing test first → minimal implementation → green → commit. Test files must **not**
`require('../src/...')` app modules (binds the default DB, not the temp DB) — use the test's own
better-sqlite3 handle for fixtures.

**Ports:** one fresh port per NEW test file. In use: `3993`, `3994`, `3995`, `3996`, `3997`, `3998`,
`3999`. **§0 uses `3901`** (`authz.test.js`); Module 6 uses `3902`–`3908`. Grep before committing.

**Regression floor:** `npm test` must stay green, starting from **148/148**. §0 → ~156.
**Modules 4–5 must never go red** — they are the only complete workflows.

**Every mutating route added from here on needs all four authorization cases** (see §0 Task 0.2):
anonymous blocked · no-CSRF blocked · **wrong role → 403 with the DB row count unchanged** ·
correct role succeeds. The third case is the one that was missing and is what would have caught
B1–B3; a status-code-only assertion is not a security test.

**Invariant tests that prove real correctness (not just coverage):**
- Σ monthly CBS buckets = account total = RBS total (PRD-named invariant).
- De-scope: `v_evm_period` rows for **past months are byte-identical** before/after a de-scope.
- Baseline freeze: a direct `db` write attempting a post-lock baseline edit **throws** (trigger is
  the floor, not the route).
- Internal replanning with `contract_value_delta <> 0` is refused without a BCR.
- Aging: due date moves only after the client's `payment_terms_days` window.
- Deactivating a CBS does not move any existing cost-report total.
- **Authorization: a *** attempting each of the five money-writing routes writes zero rows.**

**Definition of done for v1 prototype:**
1. A project can be created, baselined, and de-scoped **entirely through the UI**.
2. `v_evm_period` returns non-NULL SPI/CPI for a real project.
3. A rejected Expense Report line can be corrected and re-checked without leaving a ghost.
4. Every sidebar link resolves to a real route (no `#`).
5. **No route that writes money is reachable by a role that should not write it** (proven by test).
6. `npm test` green, `integrity_check ok`, `foreign_key_check` clean, `synchronous = 2`.

---

## 6. Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| **Unauthorized money writes (realised, not hypothetical)** | 5 routes accept any session; a Viewer wrote ledger rows, reversed a line and marked cost checked | §0: guard + the four-case authz test. Do this before adding routes |
| **Status-code-only security tests** | `correct.test.js` "needs a session" passes while a Viewer succeeds — anon ≠ wrong role | Always assert **row count unchanged** on the wrong-role case |
| **Capability-map regression** | Dropping a flag while restructuring 403s a whole workflow (happened once with `canOpenAdvance`) | Add flags only; a route-level test per workflow asserts each role's access |
| **`/projects` was never routed yet sidebar advertised it for weeks** | Dead links normalise; users stop trusting nav | Task 6.6 asserts every sidebar href resolves |
| **Migration rebuild corrupts FK text** | `no such table: x_old` surfaces sessions later, elsewhere | Modern rebuild order; verbatim `sqlite_master` SQL; `foreign_key_check` after every migration |
| **Baseline freeze is the point of no return** | Post-freeze edits silently destroy EVM history | Freeze enforced by trigger, not just route; archival via `old_baseline_json` |
| **De-scope retroactivity** | Retroactive adjustment invalidates already-issued reports (EIA-748 G-30) | Past `v_evm_period` rows asserted unchanged in a test |
| **better-sqlite3 drops unmapped params silently** | A new column no-ops every INSERT while the route returns 302 | Add the column to **every** writer and read it back in the test |
| **`synchronous = FULL` slows bulk import** | fsync per commit on a no-swap host | Measure once during Module 11 dry run; document if a deviation is ever justified |

## 7. Edge-case coverage — the direct answer

**Both of the workflow documents are stale or absent, and the edge-case coverage has a specific shape:
what is built is tested deeply; what is not built has no test at all.**

| Workflow document | State |
|---|---|
| `TEST_PLAN.md` | **was a 32-line stub** — documented only scaffold + auth, with `L1 Ledger` marked *"next feature"* **while the ledger, queue, import, correction, advances, expenses and reconciliation were all built and shipping 148 tests**. Rewritten 2026-09-30 (this file). |
| `docs/AUDIT-2026-09-30.md` | new — codebase audit with proof-of-write evidence. |

**Are the edge cases already in the test plan? Partly — and the split is exactly along "is it built":**

| Area | Edge-case coverage |
|---|---|
| Money invariants (one side, integer rupiah, `amount = debit − credit`, negatives) | ✅ **strong** — asserted at both route and trigger level |
| Reversal / correction (double reversal, non-negating, link immutability, cross-project refusal) | ✅ **strong** — 13 tests incl. two that bypass the route and hit the trigger |
| Checker three outcomes (Return / Block / clear / cannot re-check) | ✅ **strong** — 12 tests, each fixture breaking ONE rule |
| Import (dedupe, re-upload, in-file duplicate, idempotent confirm, missing column, no file) | ✅ **good** |
| Reconciliation (all four statuses incl. the NULL-vs-0 trap) | ✅ **good** |
| **Authorization (wrong ROLE, not wrong session)** | ❌ **effectively zero** — only `admin.test.js` + `advances*.test.js`. A Viewer wrote ledger rows, reversed a line, checked cost, and posted an import while 148/148 stayed green |
| **Cross-project isolation (BOLA)** | ❌ **none, and unenforceable** — `user_roles.project_id` is NULL everywhere and read by no code; any user reads *and writes* any project via `?project=` |
| **Frozen period rejects backdated writes** (§8.4) | ❌ **untested and unenforced** — table exists, 0 rows, no trigger, no route, no `src/` reference |
| **Upload safety** (oversize 413, formula cell, traversal, MIME/signature) | ❌ **untested**; only the formula-cell guard exists in code (`csv.js:113`) — traversal and signature checks are **not implemented at all** |
| **XSS escaping / CSP** | ❌ **no test**; no headers, no CSP |
| **Per-IP rate limiting** | ❌ **no test**; only per-account lockout (AU1.1/AU1.2) |
| **E2E critical path** (login → project → baseline → progress → expense → check → report → freeze) | ❌ **absent** — impossible before Modules 6–8 |
| **Recovery** (backup restore, FK check, migration rehearsal) | ❌ **absent** (Module 10) |
| **Required fixtures** (`fixture-ledger-export.tsv` "regression-checked on every run") | ❌ **file exists, referenced by zero tests** |
| **Schema validator** (`validate.py`) | ⚠️ **exists and passes against a STALE `schema.sql`** — missing 7 triggers incl. both reversal guards; not wired into `npm test` |

**Workflow steps in PRD §4 with no test at all** — because they are not built: project init + per-project
role assignment (§4.1), planning/WBS/RBS/CBS/baseline/freeze (§4.2), progress ticks + revenue recognition
+ billed≠recognized≠received (§4.3), EVM/BCR/aging/dashboards (§4.4), closing (§4.5).

**The pattern to hold onto:** this project's tests are genuinely rigorous *within* a built module and
completely silent *between* modules — no authorization across roles, no isolation across projects, no
end-to-end path across steps. §0 of the plan plus the AZ/BOLA/SCH/FX sections of `TEST_PLAN.md` close
that seam.

---

## 8. Tradeoffs

- **Doing Module 6 before the more interesting Module 7 (WBS/BCR).** Slower to a visible feature,
  but Module 7 built on an unroutable project register would have to be redone. Foundation first.
- **Master-data screens are more surface than v1 strictly needs**, but the PRD puts WBS/RBS menu
  changes behind Admin approval, and today only a seed script can change them — an approval gate
  with no UI is not a gate.
- **`rbs_code` has no rows today.** Populating it is in 6.6, but the PRD has no concrete company
  standard list; this needs **your** input, not a guess.

### Decisions locked (the owner, 2026-09-30) — all 12 answered

| # | Question | **Decision** |
|---|---|---|
| 1 | Work order | **A — §0 security fix FIRST**, then Module 6. (Trap 1 in §0 removes the earlier "6 before 7" ambiguity: the two run themselves out of test files. No conflict.) |
| 2 | Who may reverse a ledger line | **A — Finance + Cost Controller.** New capability `canCorrectLedger`; **NOT** Project Admin, **NOT** Viewer. |
| 3 | Rate limiting | **A — install `express-rate-limit`.** Second approved dep (after `busboy`). |
| 4 | Project scope (BOLA) | **A — backfill each account to the project they actually work on, THEN enforce "assigned only".** Needs the user→project mapping from the owner before 0.9 can be turned on. |
| 5 | Frozen period | **A — build it now** (handler + `trg_ledger_frozen_period` + flagged revision path). Task 0.10 becomes real work, not a deferral. |
| 6 | RBS code list | **B — I propose a standard construction resource list, the owner edits it.** |
| 7 | WBS milestone defaults | **A — equal weights** (mobilize / install / test / handover = 25% each). |
| 8 | Approval depth | **A — light:** PM approves; Finance/Admin recorded but optional. Changes 6.2–6.4. |
| 9 | SQLite durability | **A — `synchronous = FULL`** as §4.1 requires. |
| 10 | RPO / RTO | **A — RPO ≤ 1 day, RTO ≤ 4 hours** (TECH-SPEC §9.1/§9.2). Module 10 target. |
| 11 | Untagged imported cost | **A — leave the 2 untagged rows** (Rp 85.000.000 Mar, Rp 26.750.000 Sep); the Tagging queue exists to resolve them. |
| 12 | Scratch files | **A — delete all.** |

**Still outstanding from the owner:** the **user → project mapping** (blocking task 0.9) and a review of the
**proposed RBS list** (task 6.6). Everything else is unblocked.

**Revised test floor:** 148 → **~172** (8 authz, 5 BOLA, 4 schema-drift, 2 fixture, 5 frozen-period).

---

## 9. Immediate next action

**Task 0.1 + 0.2** — add the four capability flags, guard the five money-writing routes, fix
`synchronous`, and land `test/authz.test.js` with the four regression tests that currently fail.

**Then, in order:** 0.3–0.6 (durability, headers/CSP, rate limit — `express-rate-limit` approved,
raw-SQL removal) → 0.7 (schema-drift repair) → 0.8 (fixtures) → **0.9 BOLA** *(steps 1 and 4 now;
the backfill waits on the owner's user→project mapping)* → **0.10 frozen period** → **Module 6**.

**Recording this** at the owner's request (2026-09-30), so a future session has the decisions in
context without re-reading the whole audit.

Smallest slice with the largest consequence, and it removes the class of bug rather than the three
instances.

Then **Task 6.1** — `/projects` register page + a working switcher.

Awaiting: answers to open questions 1–3 (sequencing, who may reverse, the rate-limit dependency).
