# PRACTIS — Module 9: Reporting operations, jobs, alerts, health, backup

Written 2026-10-05. Follows 8.11 (`29f2719`, **pushed**). Suite **538/538** on disk, `user_version` **23**.

Sequencing authority is `docs/TECH-SPEC.md` §10, quoted: item **8 = "Reporting: PDF/XLSX, jobs,
alerts"** and item **9 = "Administration, recovery tooling, deployment hardening"**. The master plan
(`2026-09-30_…-forward-development.md`, line 894) calls the jobs/alerts block "MODULE 9", and I keep
that name below but note the §10 numbering so we do not invent a different order later.

**Exports (PDF/XLSX) shipped in 8.11.** What remains of §10 item 8 is **jobs + alerts**; item 9 is
**health, recovery tooling, deployment hardening**.

## What already exists (measured, not assumed)

| Thing | State |
|---|---|
| `jobs` table + `idx_jobs_due` | **EXISTS** (migration 002). Schema matches §4.5 exactly. **Nothing reads or writes it — no runner.** |
| `notification_inbox` table | **EXISTS** (schema.sql) with the six alert types named in a comment |
| Inbox query helpers | `insertNotification` / `listNotifications` / unread count in `src/db/queries.js` |
| `spi_breach_threshold`, `cpi_breach_threshold` | Seeded `0.95` (migration 023), read by `portfolio-service.js` for the tiles |
| `report-service.compile()` | Already emits `exceptions.raised` + `notEvaluated` — **the alert engine can reuse this** instead of recomputing |
| `db.backup()` | **Available** in better-sqlite3 13.0.3 (verified) |
| Health endpoints | **NONE.** No `/health*` route exists. |
| Request IDs | **NONE.** No `X-Request-Id`, no structured logging. |
| Backup / restore / retention | **NONE.** No `scripts/`, no snapshot, no drill. |
| Alert computation | **NONE.** The table and helpers exist; nothing ever inserts an alert. |
| Notification route / view / poll | **NONE.** |

`npm audit --omit=dev` → **2 moderate** (uuid via exceljs). §4.7 blocks on **critical/high** only, so
this does not block; `npm audit fix --force` would DOWNGRADE exceljs to 3.4.0 (breaking) — refused.

## The parts proposed

### 9.1 Jobs runner (§4.5, §8.2 row "jobs")

The foundation: both alerts and backups need something to run them on a schedule.

- `src/lib/jobs.js` — claim-check due jobs in ONE short transaction
  (`UPDATE … WHERE id = (SELECT id FROM jobs WHERE state='queued' AND run_at <= datetime('now') …)`),
  one job at a time (v1), handlers **idempotent**, `running → completed|failed`.
- **Crash recovery**: on boot, `running` rows older than a stale threshold return to `queued`
  (attempts already incremented, so a crash cannot loop forever).
- **Exponential backoff** on failure, bounded by `max_attempts` (3), `last_error` recorded.
- A **ticker** to enqueue recurring work. One process, so an in-process timer — *not* cron calling in,
  which would be a second writer (§4.1 "one writer at a time").
- Handlers register by `type`; 9.1 ships the machinery plus one trivial handler to prove the loop.

**Decision needed:** the recurring-tick interval and whether an unknown job `type` fails loudly or is
skipped. I propose: tick every 60 s; **unknown type → failed** with a clear `last_error` (a job nobody
handles is a bug, not a no-op).

### 9.2 Health, readiness, request IDs, structured logs (§4.3, §4.4, §6.3, TS-23)

Small, and it is what deployment (§4.6 "readiness check") depends on.

- `/health/live` — process alive, **no DB touch**.
- `/health/ready` — DB reachable, `foreign_keys` on, schema version current, disk free-space
  threshold, **job runner responsive** (needs 9.1).
- `/system/health` — Administrator only; full detail: backup age, disk free, queue depth.
- Public responses expose **status only** — no version stack, paths, or secrets (TS-23).
- **Request IDs** (§4.4): accept an inbound `X-Request-Id` or mint one; log
  `{utc, request_id, method, route template, status, duration, user_id, error_code}` as JSON.
  **Never log** query string, body, cookies, or ledger descriptions. Request ID surfaced on error
  pages so a user can quote it. `src/lib/error-handler.js` is where the 400/500 paths already live.

### 9.3 The six alerts + notification inbox (PRD §4.4, Q19)

| Alert | Trigger |
|---|---|
| CPI/SPI breach | `< 0.95` (tunable per project) |
| Cost overrun ahead | EAC > BAC |
| Progress not updated | no progress entry 14 days |
| Overdue invoice | unpaid past `due_date` |
| Unapproved BCR waiting | `> 3` days pending |
| Cash advance old | outstanding `> 60` days |

- `src/lib/alerts.js` — one function per alert, each **pure** (project → findings) so it is unit
  testable without a server, then a job handler writes rows into `notification_inbox`.
- **Idempotent**: re-running the check must not stack duplicate unread rows for the same
  unfinished condition. This is the part that most deserves a test.
- Thresholds read from `app_settings`, **per-project override** (PRD: "project-overridable").
- `views/notifications.ejs` + a route; **30-second in-app poll** (TS-01) on a narrow JSON endpoint
  (§6.2 — the only JSON endpoints are the import ones and this).
- Recipients: project-scoped roles (PM / project controller / project admin) + system admins for
  system-level alerts.

**Decision needed:** the recipient rule above, and whether an alert row is written once per
condition-episode or refreshed daily while the condition persists. I propose: **one unread row per
(alert_type, project, entity)**, refreshed read-state only when the condition clears.

### 9.4 Backup, retention, restore drill (§4.2, TS-13, TS-14, TS-19)

Protects real financial data — the highest business value of the four, but it needs 9.1 to schedule.

- Hourly consistent snapshot via `db.backup()` — **never** copy live WAL files. gzip.
- Tiers: 24 hourly + 7 daily + 4 weekly + 12 monthly (47 max references), one snapshot may satisfy
  several tiers.
- **Retention DELETION stays DISABLED.** §4.2: *"Automatic retention deletion stays disabled until
  user explicitly approves deletion and tested restore. Proposed retention above is not deletion
  authority."* So 9.4 ships **tiering + a retention report**, and deleting is a separate approved act.
- Refuse/alert before a backup can exhaust free disk (§4.2).
- `scripts/restore-drill.sh` — restore the latest snapshot **to an isolated path**, run
  `integrity_check` + `foreign_key_check` + `db/validate.py`, and record the result. **Never
  overwrites production.**
- **RPO 1 h is locked (TS-14)** — an overdue/failed hourly snapshot must ALERT (gap #1 in the PRD's
  own gap list: alert delivery detail was never closed).
- **RTO 4 h is a target, not a claim** (§4.2): unproven until a production-sized drill runs.
  The plan records the drill; it does not claim the time.
- Offsite encrypted copy: **NOT in 9.4.** It needs a destination + key-management decision (§3.8).

## Locked-in decisions I am NOT re-opening

- SQLite stays single-writer, `synchronous=FULL` (§4.1). No new datastore.
- No new runtime dependency unless separately approved (§4.7). Everything above is stdlib +
  better-sqlite3 + `gzip`.
- Exports already synchronous (8.11) — 9.1 does **not** retro-fit them into the job runner, because
  §558's "frozen report artifact hash stable" needs a storage decision first.
- Backup never writes to or overwrites the production DB (§4.2).
- No automatic deletion of anything (user rule, and §4.2).

## Tests (ports free at 3932, 3934+; 3931 = export.test.js)

| Part | File | What it pins |
|---|---|---|
| 9.1 | `test/jobs.test.js` | claim is single-transaction; one at a time; idempotent handler; retry with backoff; max_attempts stops the loop; **crash recovery returns stale `running` → `queued`**; unknown type fails loudly |
| 9.2 | `test/health.test.js` | live needs no DB; ready reports FK/schema/disk/runner; **public body leaks no version/path/secret**; `/system/health` is 403 for non-admin; request ID present on an error and echoed from the inbound header; log line omits query string and body |
| 9.3 | `test/alerts.test.js` | each of the six triggers fires at its boundary and not below it; **re-running does not duplicate**; tunable threshold honoured; inbox is scoped to the right recipients; the poll endpoint is authenticated |
| 9.4 | `test/backup.test.js` | snapshot is a consistent DB (integrity + FK check on the copy); gzip; tiering references ≤ 47; **retention does NOT delete**; disk-low refuses; restore drill validates into an isolated path and leaves prod untouched |

Regression floor: `npm test` must stay **538 green**. Every mutating route gets all four
authorization cases (anonymous · no-CSRF · wrong role 403 with row count unchanged · allowed).

## Recommended order, and why

**9.1 → 9.2 → 9.4 → 9.3.**

- 9.1 first: alerts and backups both need a scheduler, and the `jobs` table is already sitting unused.
- 9.2 next: tiny, and `/health/ready` is what §4.6's deploy sequence calls — it also *proves* the
  runner from 9.1 is responsive.
- **9.4 before 9.3**: backups protect the real ledger. Alerts are valuable but they are a convenience
  on top of data that must not be lost. TS-14's 1-hour RPO is a locked promise we currently cannot
  keep at all.
- 9.3 last: the largest surface (six rules, a view, a poll, recipient rules), and it is the only part
  that is safe to defer.

**Alternative if you prefer features over infrastructure:** 9.1 → 9.2 → 9.3 → 9.4.

## Flagged, NOT in this module

1. **Offsite encrypted backup** (§4.2, TS-13) — needs destination + key decisions.
2. **"Frozen report artifact hash stable"** (§8.2) — still needs artefact storage; unmoved from 8.11.
3. **Docker / Tailscale Serve / deployment** (§10 item 9's remainder, TS-22/TS-25) — a separate part.
4. **Legacy migration rehearsal + cutover** (§10 item 10) — Module 11's work.
5. **Retention DELETION** — deliberately disabled; a separate approved act after a tested restore.

## Immediate next action

Owner picks: the part order (9.1→9.2→9.4→9.3 recommended) and answers the two decisions in 9.1/9.3.
Then: failing test per part → implement → green → full suite → commit → **STOP for approval**.
