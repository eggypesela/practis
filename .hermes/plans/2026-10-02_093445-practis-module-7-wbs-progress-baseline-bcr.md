# Module 7 — WBS / progress / RBS / CBS baseline / BCR — Implementation Plan

> **For Hermes:** execute part by part. Each part = its own commit + its own test file.
> Do NOT start part N+1 before part N's suite is green.

**Goal:** make the EVM engine work. With a baseline, some milestone ticks and some tagged
actuals, `v_evm_period` must return **non-NULL SPI and CPI**. That view has been dark since day
one because it has never had inputs.

**Architecture:** existing layered pattern, unchanged — `src/routes/<area>.js` (thin HTTP),
`src/lib/<area>-service.js` (rules, all validation, all writes), `src/db/queries.js` (prepared
statements), `views/` (EJS + `layout-app`). Money and progress writes go through ONE service per
concern so the rules cannot drift.

**Scope:** plan § "MODULE 7" at `.hermes/plans/2026-09-30_140100-practis-forward-development.md:842`.
Seven parts, in this order (dependency order, not plan order — see Part order note below).

---

## 1. Findings that shape this plan (measured, not assumed — 2026-10-02)

### F1. NO MIGRATION IS NEEDED. The data model is already complete.

Every table, column and index Module 7 needs already exists in `db/schema.sql`:

| Table | Status | Notes |
|---|---|---|
| `wbs_nodes` | exists | `status` CHECK `active\|completed\|de_scoped`, `version`, `superseded_by`, `de_scope_period`, `baseline_start/end`, UNIQUE(project_id, wbs_code, version) |
| `progress_milestones` | exists | `seq`, `name`, `pct_weight`, `ticked`, `ticked_at`, `ticked_by`, UNIQUE(wbs_node_id, seq) |
| `wbs_progress` | exists | `period_month`, `pct_complete` CHECK 0–100, `source` CHECK `milestones\|manual`, `frozen`, UNIQUE(wbs_node_id, period_month) |
| `rbs_load` | exists | `rate`, `units`, `unit_label`, `total_amount` ("materialised for the invariant check"), `version` |
| `cbs_plan` | exists | `plan_type` CHECK `baseline\|forecast\|bcr\|cost_adjustment`, `version`, `period_month`, `amount`, `wbs_node_id` |
| `bcr_register` | exists | full `draft→verified→approved\|rejected\|withdrawn` states, `old_baseline_json`, `new_baseline_json`, `effective_period` |
| `change_log` | exists | `action` CHECK `add_line\|split_line\|rename_line\|reparent\|restructure`, `contract_value_delta` ("must be 0 for internal replanning") |
| `projects.baseline_locked` | exists | plus `baseline_locked_at`, `baseline_locked_by` |

So this module is **all logic and UI**. Nothing in it is blocked on schema work. Do not add a
migration unless a part explicitly says so.

### F2. DEFECT RISK — `v_evm_period` will double-count PV if baseline rows are written twice.

The existing view (`db/schema.sql`, committed) reads:

```sql
pv AS (SELECT project_id, period_month, SUM(amount) AS pv
       FROM cbs_plan WHERE plan_type = 'baseline' GROUP BY project_id, period_month),
ev AS (... SUM(amount) AS ba FROM cbs_plan
       WHERE plan_type='baseline' AND wbs_node_id IS NOT NULL GROUP BY wbs_node_id ...)
```

- `pv` sums **every** baseline row — account-level AND WBS-tagged.
- `ev` uses **only WBS-tagged** rows.

The unique index permits both shapes for the same (account, month):
`uq_cbs_plan_bucket(project_id, transaction_account_id, COALESCE(wbs_node_id,0), plan_type, period_month, version)`.

**Therefore: if the app writes an account-total row AND its per-WBS breakdown rows, PV counts the
money twice and every SPI is wrong.**

**The design this plan adopts (and Part 4 must enforce):**
- **Every baseline row is WBS-tagged.** No account-level (`wbs_node_id IS NULL`) baseline rows.
- **The account total is DERIVED** — `SUM(amount) GROUP BY transaction_account_id` — never stored
  as its own row. This is exactly PRD §3.2 ("WBS/RBS *dimensions* read from cost accounts; never
  hold their own money copy") read consistently: the money row lives on the CBS and *carries* a WBS
  dimension.
- A guard refuses a baseline row with no WBS tag, and the invariant test (Part 4) fails if PV ever
  exceeds the sum of account totals.

### F3. A re-baseline MUST be prospective, and the view is why.

`v_evm_period` has **no `version` filter**. So if a BCR leaves v1 *and* writes v2 baseline rows for
the same months, PV becomes v1+v2. Two ways out:

| Option | Consequence |
|---|---|
| Add a version filter to the view | requires a migration touching a committed view; the view is a governable artefact and `db/schema.sql` is generated |
| **Replace, forward-only, archive the old JSON** *(chosen)* | no migration; matches `bcr_register.old_baseline_json`; and matches PRD §4.4 |

**Chosen rule for BCR approval:**
1. Archive the current baseline snapshot into `bcr_register.old_baseline_json`.
2. **DELETE** `cbs_plan` baseline rows **with `period_month >= effective_period` only.**
3. **INSERT** the new baseline rows, also from `effective_period` forward.
4. Write `new_baseline_json`, set `status='approved'`, stamp `approved_by`/`decided_at`.

**Past months are never touched.** That is not a nicety — it is PRD §4.4 / EIA-748 G-30
("cumulative values are never retroactively adjusted") and it is what makes the Part 7 test
("past months unchanged") meaningful.

### F4. `pct_weight` has a per-row CHECK, not a per-node total.

`pct_weight BETWEEN 0 AND 100` is per row. Nothing enforces that one WBS node's four milestone
weights sum to 100. `% complete = Σ(pct_weight WHERE ticked)/100` only lands in 0–100 if they do.
**The app must validate the SUM when weights are edited**, and Part 2 must decide what happens when
they do not sum to 100 (see Part 2, step 2.3).

### F5. Test trap that already cost a cycle — PV-reading tests must not create projects.

`test/helpers/authz.js` creates its users with a **timestamped email** (`role-${Date.now()}@test.local`),
and some test DBs live in `os.tmpdir()` (the shared `/tmp`) in a directory named after a *fixed*
prefix. Two suites that both create a project can collide, and because `PR2.11` asserts
`auditOf(project).length === 2`, a project left behind picks up a third audit row and the suite
goes red in a way that looks like a code bug.

Rules for every new test file:
- the DB directory name must include `Date.now()` **or** a name unique to that file;
- a test that only READS PV must not create a project — insert its `cbs_plan` rows against the
  seeded project instead.

### F6. The seed bug that would have silently starved every later test.

`seed-master.js` used to `process.exit(1)` when the demo project `PRJ-2026` was missing. On a real
install (project `JC-2026`) that meant **no master data at all** — including the lists that have
nothing to do with a project. Fixed in task 6.6: only the demo project's tree and milestones are
project-scoped now. Consequence for this module: **`rbs_code` is populated only after
`node src/db/seed-master.js` runs** on that database.

### F7. Free test ports.

Measured 2026-10-02 by grepping `PORT =` in `test/*.test.js`. **In use:** 3901, 3902, **3903**
(`bola.test.js` `PORT_ON`), 3904, 3905, 3906, 3908, 3910, 3911, 3912, 3913, 3914, 3933, 3994,
3996–3999.

**Module 7 allocation (corrected — the first draft wrongly claimed 3903, which `bola.test.js` holds
as its `SCOPE_ENFORCE=1` server):** 7.1 → **3907**, 7.2 → **3915**, 7.3 → **3916**, 7.4 → **3917**,
7.5 → **3918**, 7.6 → **3919**, 7.7 → **3920**, 7.8 → **3921**.

A collision shows up as `server did not start`, which names neither the port nor the other file.

### F8. Route/authorization plumbing to reuse (do not fork a fourth copy).

- `src/middleware/scope.js` `projectContext` sets `res.locals.project` (the user's first
  **authorised** project, or an explicitly requested one they are entitled to) and
  `res.locals.projects`. Mount it on every project-scoped page.
- `requireCapability(flag, message)` renders the `403` view. It exists **locally** in
  `src/routes/app.js`, `src/routes/projects.js` and `src/routes/master.js` — three deliberate small
  copies. Add a fourth in the new routers rather than refactoring three files.
- `page(res, title, subtitle, crumb, view, opts)` is the page-rendering idiom (title + sub-title are
  a standing UI rule).
- Refusals that a user should be told about use the **redirect-with-message** idiom
  (`?msg=…`), not an error page. Errors that are programming facts use 400/403/404.
- `permissions.js` `capabilities(user)` computes flags with `has(...roles)`; an Administrator passes
  every flag by design (`isAdmin`). Add the new flags there.

### F9. Milestone set: permissive on the way out, structured on the way in.

`progress_milestones` has no CHECK on `name`, and `buildWbsTree` creates `mobilize→install→test→
handover`. Do not add a CHECK on names now: a project may legitimately need a different set later,
and a strict CHECK would need a table rebuild to relax. Part 2 instead ships a validation helper
**and a test that records the tightness we actually have** (so the looseness is known, not
accidental).

---

## 2. Part order (and why it differs from the plan's list)

The plan lists WBS → progress → RBS → CBS → freeze → BCR → de-scope. That is the right *narrative*
but the wrong *build* order: parts 6 and 7 both need the baseline mutation that part 5's freeze
protects, and part 5 cannot be tested before that mutation exists.

| Part | What | Why here |
|---|---|---|
| **7.1** | WBS tree: view + line edits + change_log + the `contract_value_delta = 0` rule | nothing depends on it being later; it is the most test-driven part |
| **7.2** | Milestone ticks → `wbs_progress` (% complete) | needs 7.1's tree to tick |
| **7.3** | RBS load (rate × units = total_amount) | independent of 7.2 |
| **7.4** | CBS baseline (monthly buckets, WBS-tagged) + the Σ invariant | needs 7.1 (the WBS tag) and 7.3 (the RBS total to reconcile) |
| **7.5** | Baseline mutation service = `applyBaselineChange()` (prospective replace + archive) | **extracted first**, because 7.6 and 7.7 both call it |
| **7.6** | Freeze (`baseline_locked`) + BCR workflow driving 7.5 | needs 7.5 |
| **7.7** | De-scope (status + `de_scope_period`, budget leaves PV forward-only) | needs 7.5 and 7.6 |
| **7.8** | The EVM acceptance test (`v_evm_period` returns non-NULL SPI/CPI) | the module's definition of done |

**7.5 is a deliberate extraction, not a part the plan names.** If the freeze is built before the
mutation path exists, its trigger and its service check guard nothing and the tests prove nothing.

---

## Part 7.1 — WBS tree: view, line edits, and the contract-value rule — ✅ DONE 2026-10-02

**Objective:** see and edit the project's WBS tree, with internal replanning recorded and
contract-value-changing edits refused.

**Delivered:** `src/lib/wbs-service.js`, `src/routes/wbs.js`, `views/wbs.ejs`; router mounted in
`src/server.js` after `routes/master`; `canManageWbs` / `canApproveBaseline` / `canViewWbs` added to
`permissions.js` together with the new `hasExact()` helper (role membership only — no Administrator
bypass, required by PRD §4.2 step 4 and used by part 7.6); `q.wbsMasterCodes()`; sidebar WBS link
re-added (it was one of the five dead links removed in 6.6). Tests **WB7.1–WB7.10** in
`test/wbs.test.js`, port **3907** (NOT 3903 — see F7). Suite 331 → **341**.

**THE design decision this part turned on — `superseded_by` is a MARKER, not a redirect.** A
rename/split/reparent inserts `version + 1` and points the old row at the new one, leaving the old
row's `status` alone. Two views read `wbs_nodes` and disagree about versions:

- `v_evm_period` joins `wbs_progress → wbs_nodes` **per node**, so it must still see superseded
  versions — dropping them would silently erase earned value from the month it was reported.
- `v_descoped_lines` has **no version filter at all**, so a second ACTIVE version would make a
  de-scoped line report twice.

So each version exists once in exactly one state, superseded rows stay visible (dimmed, marked
`replaced`), and the service **refuses to edit a superseded row**. WB7.4 asserts the old row keeps
its original text AND `status='active'`; WB7.5 asserts a superseded row cannot be edited.

**Two refusal channels, deliberately different — and confusing them costs a cycle.** A ROLE refusal
renders the 403 page; a FORM-RULE refusal uses redirect-with-reason (`?err=`), like the master
screens. So a rule refusal answers **302 — the same status as success**. Asserting `status === 403`
on one fails while the rule works perfectly. `assertRefused()` in the test file asserts the redirect
carries `err=` and NOT `msg=`; every call site additionally asserts the database is unchanged.

**A line's code must exist in the `wbs_code` MASTER menu** (PRD §5.1 — the tree copies the menu, it
does not extend it). The service refuses an unknown code with a readable message rather than an FK
error. Test consequence: a code cannot be invented; insert it into `wbs_code` first (`freshCode()`).

**Steps** (as built — the order differed slightly from the draft):

1.1 ✅ **Test first.** WB7.1 renders the tree → FAILED 404, then PASSED once the route existed.
1.2 ✅ `tree()` returns depth-first order with the indent computed by the service, so the view does
    no grouping of its own; superseded versions are kept in the payload and in `counts.all`.
1.3 ✅ **WB7.3 — the PRD's own test.** A delta of **1 IDR** is refused, the message names the BCR, and
    `wbs_nodes` + `change_log` counts are unchanged.
1.4 ✅ `assertInternalReplanning(delta)`: refuses any non-zero delta. No threshold, no tolerance.
1.5 ✅ **WB7.4 — versioning, not overwriting.**
1.6 ✅ `versionLine()` shared by rename/reparent: insert `version+1`, set `OLD.superseded_by`, carry
    the milestone set forward **unticked**, and leave `wbs_progress` alone (progress stays on the node
    it was reported against, so history keeps its own numbers).
1.7 ✅ **WB7.7 — no delete route.** Asserts 404 for `/wbs/lines/:id/delete` and three other shapes,
    plus the row count.
1.8 ✅ `views/wbs.ejs` — title + sub-title, full width, tree indented by depth, milestone progress per
    line, change-log table, and an "Add a line" form that shows a **visible contract-value field**
    with the rule explained (hiding it would hide the boundary the PRD draws).

**Extra test added while building (worth keeping):** WB7.10 pins that the status control may move only
`active ↔ completed`, and that `de_scoped` is REFUSED with a message naming the BCR — that is
decision 3A ("exactly one door") enforced from part 7.1 rather than left for part 7.7 to remember.

**Verification:** WB7.1–WB7.10 green (10/10); MS6.7/MS6.8 sidebar contract still green; `npm test`
341/341.

**Commit:** `feat(wbs): WBS tree with versioned line edits and the contract-value rule`

---

## Part 7.2 — Milestone ticks → % complete

**Objective:** ticking milestones produces the per-period `pct_complete` that feeds `ev`.

**Files:** Modify `src/lib/wbs-service.js`; create `views/wbs-progress.ejs`; test `test/progress.test.js`
(prefix **MP7**), port **3906**.

**Steps**

2.1 **The maths is the point — test it first as a pure function.**
```js
// MP7.1 % complete = sum of ticked weights / 100, for the four equal 25% defaults
test('MP7.1 two of four 25% milestones ticked = 50%', () => {
  assert.strictEqual(svc.pctFromMilestones([{pct_weight:25,ticked:1},{pct_weight:25,ticked:1},
                                            {pct_weight:25,ticked:0},{pct_weight:25,ticked:0}]), 50);
});
// MP7.2 all ticked = 100, none = 0
// MP7.3 weights need not be equal
test('MP7.3 60/20/10/10 with the first two ticked = 80%', ...)
```
2.2 Implement `pctFromMilestones(rows)` as `Math.min(100, Σ(pct_weight where ticked))`. The
`Math.min` is defensive: F4 means a bad weight set could otherwise exceed 100, and
`wbs_progress.pct_complete` has `CHECK (pct_complete BETWEEN 0 AND 100)` — without the clamp a bad
weight set becomes a **database error at write time** instead of a correct number. Test both.
2.3 **Test the sum-of-weights guard.**
```js
// MP7.4 a node whose weights sum above 100 is refused when the weights are set
test('MP7.4 weights summing to 120 are refused; the node keeps its old set', ...)
// MP7.5 weights summing BELOW 100 are allowed but the line can never reach 100%
test('MP7.5 weights summing to 80 are allowed and the ceiling is documented', ...)
```
Decision: **> 100 is refused, < 100 is allowed.** Refusing both would block a legitimate partial
weight set; allowing > 100 would make "% complete" exceed 100. A sub-100 set means the line tops out
below 100% — that is the honest report, and MP7.5 pins it so it is a known behaviour rather than a
surprise.
2.4 **Tick a milestone through the app and assert the DB:**
```js
// MP7.6 ticking writes wbs_progress for the period with source='milestones'
test('MP7.6 a tick writes one wbs_progress row for the period', async () => {
  // POST /wbs/milestones/:id/tick {period:'2026-06'}
  const row = db.prepare('SELECT * FROM wbs_progress WHERE wbs_node_id=? AND period_month=?')...
  assert.strictEqual(row.pct_complete, 25);
  assert.strictEqual(row.source, 'milestones');
  assert.strictEqual(row.reported_by, actorId);
});
```
2.5 **Test that progress is a snapshot per period, not a running total** (UNIQUE(wbs_node_id,
period_month) exists for this): ticking a second milestone in the SAME period **updates** that
period's row; ticking in a **later** period inserts a new one and leaves the earlier period alone.
```js
// MP7.7 a later period gets its own row and does not rewrite the earlier period
```
This is the same "never rewrite history" property as F3 and it is what makes the progress curve
truthful.
2.6 **Test that a frozen progress row cannot be rewritten** (`wbs_progress.frozen` already exists).
If `frozen = 1`, refuse and explain. Do not build the report-generation path here (that is Module 8)
— just honour the flag, so the column is not decorative.
```js
// MP7.8 a frozen progress row is refused, and the database is unchanged
```
2.7 Reuse the same vector for `pct_complete = 0` — a line with nothing ticked must produce a row
with 0, not a missing row. A missing row and a zero row are different facts (untouched vs. reported
as nothing done), and `ev` treats them the same way only if the row exists.

**Verification:** `node --test test/progress.test.js`, then full suite.
**Commit:** `feat(progress): milestone ticks drive per-period % complete`

---

## Part 7.3 — RBS load

**Objective:** resource plan per WBS line and CBS account, with `rate × units = total_amount`
materialised so the PRD's invariant can be checked against a stored number.

**Files:** Create `src/lib/rbs-service.js`, `src/routes/rbs.js`, `views/rbs.ejs`; test
`test/rbs.test.js` (prefix **RB7**), port **3907**.

**Steps**

3.1 **The arithmetic is the test:**
```js
// RB7.1 total_amount is rate × units, stored not computed on read
test('RB7.1 12 units at 250000 = 3000000 in the row', ...)
// RB7.2 rounding: whole rupiah, no fractional total
test('RB7.2 a fractional product is rounded to whole rupiah and the row stores an integer', ...)
// RB7.3 an edit recomputes total_amount
```
Money is whole-rupiah integers everywhere else (`trg_ledger_money_integrity_insert`); an RBS total
that is a float would break every reconciliation downstream. Round at write time,
`Math.round(rate * units)`, and assert `Number.isInteger`.
3.2 **Test that both tags are required:** `rbs_load` may carry `wbs_node_id` and
`transaction_account_id`. A load row must have at least one, or it belongs to no line and no
account and cannot be reconciled. Decide: **require `wbs_node_id`** (the resource is loaded against
work) and make the account optional — because the account assignment is the Cost Controller's
call and may come later. Test the refusal.
3.3 **Test the reference to the master list:** `rbs_code` is a FK to `rbs_code.code`. An unknown
code must be refused by the service with a readable message, not surfaced as an SQLite FK error.
```js
// RB7.4 an unknown rbs_code is refused with a message, not an FK crash
```
3.4 **Test versioning:** editing a load row's rate versions it (`version+1`) rather than
overwriting, consistent with `wbs_nodes` and `cbs_plan`. The UNIQUE includes `version`, so this is
already permitted.

**Verification:** `node --test test/rbs.test.js`, then full suite.
**Commit:** `feat(rbs): resource load with materialised totals`

---

## Part 7.4 — CBS baseline, and the one invariant the PRD names

**Objective:** the monthly-bucketed money book that becomes `pv`.

**Files:** Create `src/lib/cbs-service.js`, `src/routes/cbs.js`, `views/cbs.ejs`; test
`test/cbs.test.js` (prefix **BL7**), port **3909**.

**Steps**

4.1 **Enforce F2 — the double-counting guard — and test it.**
```js
// BL7.1 a baseline row must carry a WBS tag
test('BL7.1 a baseline bucket with no wbs_node_id is refused', ...)
// BL7.2 THE INVARIANT: monthly buckets per account sum to the account total from RBS
test('BL7.2 Σ monthly buckets = account total = RBS total', async () => {
  // seed an rbs_load of 3,000,000 against account X
  // spread it over 3 months as 1,000,000 each
  const buckets = db.prepare(`SELECT SUM(amount) s FROM cbs_plan
      WHERE project_id=? AND transaction_account_id=? AND plan_type='baseline'`).get(pid, X).s;
  const rbs = db.prepare(`SELECT SUM(total_amount) s FROM rbs_load
      WHERE project_id=? AND transaction_account_id=?`).get(pid, X).s;
  assert.strictEqual(buckets, rbs, 'PRD §6 "Σ monthly buckets = account total = RBS total"');
});
// BL7.3 a bucket set that does NOT reconcile is refused before it is written
test('BL7.3 writing buckets that overshoot the RBS total is refused', ...)
```
4.2 Implement `spreadBaseline(accountId, months, amounts)` that validates the sum **before any
write**, inside one transaction. The PRD says the app enforces this invariant; making it a
pre-write check means a bad spread never exists, even momentarily.
4.3 **Test that the guard is about reconciliation, not equality of any single month:** a spread
with a zero month in the middle is legal; a spread with a negative month is not (money is
whole-rupiah, one side, never negative — consistent with the ledger triggers).
4.4 **Test auto-spread:** straight-line over the WBS line's `start_date`/`end_date`. The PRD allows
"direct entry OR auto-spread (straight-line over WBS duration, or milestone-weighted)". Implement
straight-line now; milestone-weighted is a follow-up and must be refused with a clear message rather
than silently straight-lining.
4.5 **Test that `plan_type='forecast'` is not accepted here.** The forecast is Module 8; an
accidental forecast row written as a baseline would corrupt PV. The route accepts only
`plan_type='baseline'` and refuses anything else by name.

**Verification:** `node --test test/cbs.test.js`, then full suite.
**Commit:** `feat(cbs): monthly baseline buckets with the Σ=RBS invariant enforced`

---

## Part 7.5 — `applyBaselineChange()` — the one mutation path (extracted)

**Objective:** ONE function that changes an applied baseline, used by both the BCR workflow (7.6)
and de-scope (7.7). Built before the freeze so the freeze has something to guard.

**Files:** Create `src/lib/baseline-service.js`; test `test/baseline.test.js` (prefix **BS7**),
port **3915**.

**Steps**

5.1 **Write the prospective-replacement test first — it is F3 made executable.**
```js
// BS7.1 a change applies from the effective period FORWARD and never rewrites the past
test('BS7.1 past months are byte-identical after a re-baseline', async () => {
  const before = db.prepare(`SELECT period_month, amount FROM cbs_plan
      WHERE project_id=? AND plan_type='baseline' AND period_month < '2026-07'
      ORDER BY period_month, transaction_account_id`).all(pid);

  await svc.applyBaselineChange({ projectId: pid, effectivePeriod: '2026-07',
    newRows: [...], actorId, reason: 'scope reduction' });

  const after = db.prepare(`...same query...`).all(pid);
  assert.deepStrictEqual(after, before,
    'EIA-748 G-30: cumulative values are never retroactively adjusted');
});
```
5.2 **Test that it archives before it replaces.**
```js
// BS7.2 the old baseline is archived, and the archive is what was actually there
assert.strictEqual(JSON.parse(bcr.old_baseline_json).length, beforeRows.length);
```
5.3 **Test atomicity:** a change that fails partway (e.g. a new row violating the Σ invariant)
leaves the old baseline **completely intact** — no half-replaced baseline.
```js
// BS7.3 a failed change leaves the baseline untouched
```
This is the single most important property of the whole module: a half-applied baseline would make
every subsequent SPI/CPI wrong in a way no report explains.
5.4 Implement: `db.transaction()` wrapping (a) snapshot → `old_baseline_json`, (b) `DELETE FROM
cbs_plan WHERE project_id=? AND plan_type IN ('baseline','bcr') AND period_month >= ?`,
(c) `INSERT` the new rows, (d) validate the post-condition sum inside the transaction and `throw` to
roll back if it does not reconcile. **The post-condition check must re-read from the table**, not
trust the inputs — that is what catches a bad DELETE.
5.5 Test the rollback explicitly by making step (c) throw and asserting `db.inTransaction === false`
and the row counts unchanged.

**Verification:** `node --test test/baseline.test.js`, then full suite.
**Commit:** `feat(baseline): a single prospective, archiving, atomic baseline mutation`

---

## Part 7.6 — Baseline freeze + BCR workflow

**Objective:** lock the baseline, and route every subsequent change through a BCR.

**Files:** Create `src/lib/bcr-service.js`, `src/routes/bcr.js`, `views/bcr.ejs`,
`views/bcr-new.ejs`; modify `src/lib/permissions.js`; test `test/bcr.test.js` (prefix **BC7**),
port **3916**.

**Steps**

6.1 **Test the freeze.**
```js
// BC7.1 the PM freezes the baseline and the project records who and when
test('BC7.1 POST /projects/:id/baseline/freeze sets baseline_locked, locked_at, locked_by', ...)
// BC7.2 ADMIN IS NOT THE BASELINE APPROVER (PRD §4.2 step 4: "Admin does NOT approve baselines")
test('BC7.2 an Administrator-only user is REFUSED the baseline approval', async () => {
  const res = await adminOnly.post('/projects/1/baseline/freeze', ...);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(db.prepare('SELECT baseline_locked FROM projects WHERE id=1').get().baseline_locked, 0);
});
```
**This is the module's SoD trap.** Everywhere else an Administrator passes every `has(...)` check by
design. Here the PRD explicitly excludes them. If `canApproveBaseline` is written with the plain
`has('project_manager')` helper, an Administrator passes it and BC7.2 fails. Implement it as a
capability that **ignores `isAdmin`** and requires an actual `project_manager` role assignment
(which is why `permissions.js` needs a variant helper — see 6.3).
6.3 In `permissions.js`, add `hasExact(...)` (role membership only, no admin bypass) next to `has`,
and define:
```js
canApproveBaseline = hasExact('project_manager');   // NOT has() — PRD §4.2 excludes Admin
canManageWbs       = has('project_controller', 'project_manager');
canManageCbs       = has('cost_controller', 'project_manager');
canInitiateBcr     = has('project_controller', 'cost_controller', 'project_manager');
```
6.4 **Test that a locked baseline refuses a direct edit at the SERVICE and that the refusal is not
merely a hidden button.**
```js
// BC7.3 with the baseline locked, a direct cbs_plan write via the service is refused
test('BC7.3 a locked baseline rejects a direct baseline edit', ...)
```
6.5 **Test the BCR happy path end to end — the workflow the PRD describes.**
```js
// BC7.4 draft → verified → approved, and approval re-baselines
test('BC7.4 an approved BCR changes PV from the effective period forward', async () => {
  const pvBefore = pvFor('2026-08');       // helper reading v_evm_period
  // initiate → verify → approve
  const pvAfter = pvFor('2026-08');
  assert.notStrictEqual(pvAfter, pvBefore, 'the August PV moved — it is at/after the effective period');
  assert.strictEqual(pvFor('2026-05'), pvBeforeForMay, 'and May did NOT move');
});
```
6.6 **Test SoD on the BCR:** the initiator cannot verify or approve their own BCR. The existing
`checkSoD` in `permissions.js` and the `self_approved` reason pattern in `approvals-service.js` are
the precedent — reuse the *pattern*, and keep it a hard refusal for approval (a BCR is an external
change; unlike a register record, there is no "typed reason" escape).
```js
// BC7.5 the initiator cannot approve their own BCR, and no state changes
```
6.7 **Test the illegal transitions:** `approved → draft`, `rejected → approved`, double-approval.
The CHECK constrains the *values*, not the transitions, so the service must police them.
```js
// BC7.6 an approved BCR cannot be re-approved or reopened
```
6.8 **Test that a rejected BCR changes NOTHING** — the strongest negative in the module.
```js
// BC7.7 a rejected BCR leaves the baseline byte-identical
```
6.9 Refuse a BCR while the baseline is NOT yet locked (there is nothing to change), and refuse a
BCR with no `effective_period` — a BCR without a period cannot be applied prospectively, and
defaulting it to "now" would silently rewrite whatever month it landed in.
```js
// BC7.8 a BCR with no effective_period is refused
```
6.10 Add the two nav links Module 7 owns: **WBS** and **CBS plan** under the project group, and
**BCR register** under Control. They were among the five dead links removed in 6.6, so re-adding
them is the "close the dead nav links" work the plan asks for — and the sidebar contract tests
(MS6.7/MS6.8) will fail if a link is added without a working route.

**Verification:** `node --test test/bcr.test.js`, then full suite.
**Commit:** `feat(bcr): baseline freeze and the BCR change-control workflow`

---

## Part 7.7 — De-scope

**Objective:** remove a line from scope without deleting it and without rewriting history.

**Files:** Modify `src/lib/wbs-service.js`, `src/lib/baseline-service.js`, `src/routes/wbs.js`;
test `test/descope.test.js` (prefix **DS7**), port **3917**.

**Steps**

7.1 **Test that a de-scope never deletes.**
```js
// DS7.1 the line survives, with status='de_scoped' and a period
test('DS7.1 a de-scoped line stays in the list and in history', ...)
```
7.2 **Test that a de-scope requires an approved BCR** (PRD §4.4: "External change (if contract
value drops) → Full BCR + the rules below"). A de-scope without one must be refused at the service.
```js
// DS7.2 a de-scope without an approved BCR is refused and nothing changes
```
7.3 **Test that progress freezes at its last value.**
```js
// DS7.3 after de-scope the line's last pct_complete is unchanged and no new period appears
```
7.4 **THE test for this part — past months unchanged.** Compare `v_evm_period` rows before/after, as
the plan demands. This is the PRD's EIA-748 G-30 rule and it is stronger than checking the plan
table, because it tests what a user would actually see.
```js
// DS7.4 de-scope removes budget from the PV curve FORWARD ONLY
test('DS7.4 past v_evm_period rows are byte-identical; forward months lose the budget', async () => {
  const pastBefore = rows('SELECT * FROM v_evm_period WHERE project_id=? AND period_month < ?');
  await svc.deScope({ nodeId, period: '2026-09', bcrId, actorId });
  assert.deepStrictEqual(rows('...same...'), pastBefore, 'G-30: past months untouched');
  assert.ok(rows('...period_month >= ?...').pv < forwardBefore, 'and the forward PV dropped');
});
```
7.5 **Test that spent cost stays tagged** — the point of the de-scope rule is that you can still ask
"what did we spend on the cancelled part". `v_descoped_lines` already provides it.
```js
// DS7.5 cost already booked to the line is still reported by v_descoped_lines
```
7.6 Implement: set `status='de_scoped'`, `de_scope_period`, then call
`applyBaselineChange()` (7.5) to drop the remaining budget from the effective period forward. **No
`wbs_progress` rows are deleted and no `accounting_ledger` row is touched.** Assert both.
7.7 **Test that a de-scoped line cannot be ticked** (progress is frozen) and **cannot be
re-activated** without a new BCR.

**Verification:** `node --test test/descope.test.js`, then full suite.
**Commit:** `feat(descope): prospective de-scope that leaves history intact`

---

## Part 7.8 — The acceptance test: EVM finally has inputs

**Objective:** the module's definition of done, in one test.

**Files:** Create `test/evm.test.js` (prefix **EV7**), port **3918**. No production code expected —
**if this test needs new production code, a previous part is wrong.**

**Steps**

8.1 Read `v_evm_period` on a project with a baseline but no ticks or actuals: PV must be non-zero
and `spi` must be **NULL** (not zero — the view's `CASE WHEN pv <> 0 THEN ... END` returns NULL for a
genuine "cannot be computed"; a 0 would read as "totally behind schedule").
```js
// EV7.1 with only a baseline, PV is real and SPI/CPI are NULL (not zero)
```
8.2 Tick milestones and post a tagged actual. Assert SPI and CPI are now **non-NULL and correct**:
```js
// EV7.2 with ticks and tagged actuals, SPI and CPI are non-NULL and arithmetically right
test('EV7.2 SPI = EV/PV and CPI = EV/AC on the numbers we just wrote', async () => {
  // baseline 1,000,000 over 10 months; by month 5 PV = 500,000
  // ticks worth 50% of a 1,000,000 budget → EV = 500,000
  // two tagged expenses of 100,000 → AC = 200,000
  const row = db.prepare(`SELECT * FROM v_evm_period WHERE project_id=? AND period_month=?`)...;
  assert.strictEqual(row.pv, 500000);
  assert.strictEqual(row.ev, 500000);
  assert.strictEqual(row.ac, 200000);
  assert.strictEqual(row.spi, 1);            // 500000/500000
  assert.strictEqual(row.cpi, 2.5);          // 500000/200000
});
```
Compute the expected numbers by hand in the comment, as above — a test that reads its expectation
out of the same code proves nothing.
8.3 Assert **no project leaks into another project's numbers**: a second project's baseline must not
appear in the first project's rows. `v_evm_period` groups by `project_id`, but the `FULL OUTER
JOIN`s in that view are the kind of SQL where a missing join predicate hides, so pin it.
```js
// EV7.3 one project's baseline does not appear in another project's EVM rows
```
8.4 **Assert the F2 double-count guard from the report side**, which is where a user would notice it:
a project's `pv` on a period must equal the sum of its `cbs_plan` baseline rows for that period —
proving no row is counted twice.
```js
// EV7.4 PV equals the baseline rows exactly — no double counting
```

**Verification:** `node --test test/evm.test.js`, then the FULL suite. This is the module gate.
**Commit:** `test(evm): prove the EVM engine produces non-NULL SPI and CPI`

---

## 3. Files likely to change

**New — services:** `src/lib/wbs-service.js`, `src/lib/rbs-service.js`, `src/lib/cbs-service.js`,
`src/lib/baseline-service.js`, `src/lib/bcr-service.js`
**New — routes:** `src/routes/wbs.js`, `src/routes/rbs.js`, `src/routes/cbs.js`, `src/routes/bcr.js`
**New — views:** `views/wbs.ejs`, `views/wbs-progress.ejs`, `views/rbs.ejs`, `views/cbs.ejs`,
`views/bcr.ejs`, `views/bcr-new.ejs`
**New — tests:** `test/wbs.test.js`, `test/progress.test.js`, `test/rbs.test.js`, `test/cbs.test.js`,
`test/baseline.test.js`, `test/bcr.test.js`, `test/descope.test.js`, `test/evm.test.js`
**Modified:** `src/server.js` (mount 4 routers), `src/lib/permissions.js` (`hasExact` + 5 flags),
`src/db/queries.js` (tree + plan statements), `views/partials/sidebar.ejs` (WBS, CBS plan, BCR),
`TEST_PLAN.md` (§12k), the plan document (mark 7.x done)
**Not changed:** `db/schema.sql`, `db/migrations/*` — **no migration is expected** (F1). If any part
thinks it needs one, stop and re-read F1/F2/F3 first.

## 4. Tests / validation

- Per part: its own file, then the full suite. Suite floor is **331** — it must go up, never down.
- Test-run environment for local runs:
  `PRACTIS_RL_LOGIN_MAX=100000 PRACTIS_RL_WRITE_MAX=100000 PRACTIS_RL_GLOBAL_MAX=100000`
  (rate limiting otherwise throttles a test suite that logs in repeatedly).
- Gates before each commit: `node db/dump-schema.js --check` (clean),
  `python3 db/validate.py` (ALL CHECKS PASS), `git var GIT_AUTHOR_IDENT` = the noreply alias, and
  `git show --format="" --name-status HEAD` must match the commit message's claims.
- **Every deny-case asserts the DATABASE**, not the HTTP status alone.
- The module gate is Part 7.8: `v_evm_period` returning non-NULL SPI and CPI.

## 5. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **PV double-counting** (F2) | every SPI in the product is wrong, silently | WBS tag required on baseline rows; BL7.2 + EV7.4 assert from the report side |
| **A half-applied re-baseline** (5.3) | history becomes un-reconcilable and no report explains it | single `applyBaselineChange()` in one transaction with a re-read post-condition |
| **Retroactive baseline edit** (F3) | breaks EIA-748 G-30 and the honesty of every published report | delete/insert strictly `>= effective_period`; BS7.1 and DS7.4 compare rows before/after |
| **Permissions copy-paste** | a fourth `requireCapability` could drift from the other three | three deliberate copies is the established convention; do not refactor them mid-module |
| **`canApproveBaseline` written with `has()`** | silently lets an Administrator approve a baseline, breaking a stated SoD rule | `hasExact`; BC7.2 is a dedicated test for exactly this |
| **Shortcutting to 7.8** | building the acceptance test against a mock instead of the real view proves nothing | 7.8 asserts against `v_evm_period` in a real migrated DB, and is expected to need zero new code |
| **A very long module in one go** | context loss, and a failed suite becomes hard to attribute | one commit per part; stop for review after each |

## 6. Decisions — LOCKED by the owner 2026-10-02

All four were put to the owner with the trade-off and a recommendation. The answers below are the
binding spec; the build must not deviate without a new decision.

| # | Question | Decision | Consequence in the build |
|---|---|---|---|
| **1** | Who makes a BCR effective? | **A — PM approval alone** | `verified` is still RECORDED (Finance may verify) but is NOT required for effectiveness. The initiator still cannot approve their own BCR — a HARD refusal, with no typed-reason escape (unlike the register chain, a BCR is an external change). Mirrors decision 8A's shape. |
| **2** | Must an RBS load name its CBS account? | **A — WBS line required, CBS account optional** | `wbs_node_id` is required by the service; `transaction_account_id` may be NULL at load time and filled in later by the Cost Controller who owns cost accounts. |
| **3** | Where does a de-scope start? | **A — from the WBS line, always with an approved BCR** | Exactly one door. The service refuses a de-scope with no approved `bcr_register` row of `change_type='de_scope'`. |
| **4** | Milestone weights that do not sum to 100? | **A — refuse > 100, allow < 100** | A set summing above 100 is refused when the weights are edited. A sub-100 set is allowed and the line tops out below 100% — pinned by MP7.5 so the ceiling is known, not a surprise. |

Note on decision 1: the PRD's three steps stay **recorded** in the approval chain exactly as decision
8A does for the registers — only the *required* set is narrowed. Widening it later is a data change.

## 7. Immediate next action

Start **Part 7.1**. Write `test/wbs.test.js` WB7.1 (the tree renders), watch it fail, then build
`src/routes/wbs.js` + `src/lib/wbs-service.js` until it passes — then WB7.2/WB7.3, the
contract-value rule, which is the part the PRD calls the contract.
