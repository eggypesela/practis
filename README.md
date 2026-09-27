# PRACTIS — app scaffold

Construction cost-management app (multi-user, replaces Excel + PowerQuery).
Stack: **Express 5 + better-sqlite3 + EJS (+ express-ejs-layouts)**. Design system
locked 2026-09-25/26: light, blue `#2563eb`, Inter, dense, minimal filled icons.

## Run

```bash
# node22 only — prebuilt better-sqlite3 targets ABI 127. Never rebuild it.
export PATH=/opt/data/node22/bin:$PATH

NPM=/opt/data/node22/lib/node_modules/npm/bin/npm-cli.js   # bare `npm` is blocked

cd /opt/data/practis
node $NPM install                    # once
node src/db/migrate.js               # applies db/migrations/*.sql  → data/practis.db
node src/db/seed.js                  # admin@practis.local / admin1234, project PRJ-2026
node src/db/seed-master.js           # cost categories, CBS accounts, wbs_code + WBS tree
node src/db/seed-demo.js             # optional: 6 demo ledger lines
node src/server.js                   # http://localhost:3003
```

Env: `PORT` (default 3003), `PRACTIS_DB` (default `data/practis.db`).

```bash
node --test --test-concurrency=1 test/*.test.js   # files spawn servers on own ports;
                                                   # concurrency=1 avoids port/DB races
```

## Layout

```
src/
  server.js              boot: migrate+seed, layouts, static, routes, 404/error
  db/
    db.js                singleton connection (WAL, busy_timeout 5000, FK on)
    migrate.js           runs db/migrations/*.sql, tracks PRAGMA user_version
    seed.js              roles + admin user + project PRJ-2026
    seed-master.js       cost categories, CBS accounts, wbs_code + project WBS tree
    seed-demo.js         demo ledger lines
    queries.js           prepared statements (plain function wrappers)
  middleware/auth.js     session cookie, page guard (302) vs API guard (401)
  routes/
    auth.js              GET/POST /login, POST /logout
    app.js               GET /, GET /ledger, GET /queue, POST /queue/tag
views/                   layouts + pages + partials (sidebar/topbar)
assets/                  app.css (design tokens), fonts.css + fonts/ (local Inter)
tools/appshot.sh         screenshot a snapshot page (headless Chrome flags for this box)
```

## Conventions / gotchas (each cost real debugging time)

1. **Never export raw bound statement methods.** `module.exports = { x: stmt.get }`
   then calling `q.x(v)` throws `TypeError: Illegal invocation` (loses `this`).
   Always wrap: `x: (v) => stmt.get(v)`.
2. **`require.main === module` guard in migrate.js / seed.js.** They close their
   connection at the end; without the guard, `require()`ing them from server.js
   closes the shared singleton → "The database connection is not open".
3. **migrate.js honours `PRACTIS_DB`** — tests point it at a temp file. Missing this
   makes tests silently migrate the dev DB and fail on "no such table: roles".
4. **Ledger triggers are strict** (001_initial.sql): whole-rupiah INTEGERs only,
   `amount = debit - credit`, ONE side non-zero (debit XOR credit), never 0, never
   negative sides; amount/date/type/document_no and 20+ financial fields are
   immutable (post a reversing line instead); rows are never deleted.
5. **`v_untagged_queue`** is the Cost Controller's queue: `cost_checked = 0` OR missing
   CBS tag OR (cost-basis line missing WBS). Cost actuals use `v_cbs_actual`
   (ledger `in_cost_basis=1` + **checked** LPB detail lines).
6. **Money formatting is display-only.** Store integer rupiah; format with
   `Intl.NumberFormat('id-ID')` → `Rp 12.480.000.000`.
7. **No hot reload** — edit → restart the server (`kill` + re-run).

## Status

Scaffold + tagging queue: boot, migrate, seed, session auth, dashboard, ledger,
**tagging queue (read + guarded write)**, 23 tests green.
- The queue's write path (`POST /queue/tag`) sets only `transaction_account_id`,
  `wbs_node_id`, `cost_category_id`, `cost_checked(+by/+at)` — the exact one-way
  transitions the DB triggers allow. Every tag writes an `audit_log` row (append-only,
  trigger-enforced). Retag / un-check / amount-edit / delete all abort at the DB.
- Auth is **PBKDF2 scaffold** for the bootstrap admin; spec'd Argon2id + invites +
  lockout (TS-01) lands with the auth feature.
- Sidebar links beyond Dashboard/Projects/Ledger/Queue are placeholders (`#`).
- Test plan: `TEST_PLAN.md`. Spec: `docs/TECH-SPEC.md`, `docs/PRD-PRACTIS.md`.
