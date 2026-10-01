# PRACTIS — Technical Specification

**Status:** Draft · user decisions TS-01 through TS-25 captured
**Date:** 2026-09-24
**Inputs:** `PRD-PRACTIS.md` v1.3, `MIGRATION-MAP.md` v2.0, `db/schema.sql`, `db/validate.py`
**Purpose:** Define production architecture and technical contracts before implementation. No application code until this spec is approved.

---

## 1. Architecture

### 1.1 System shape

One deployable, one Node.js process, one SQLite database, one VPS.

```text
Browser
  │ HTTPS via reverse proxy
  ▼
Express 5
  ├─ EJS pages (server-rendered HTML)
  ├─ narrow JSON endpoints (alerts, inline edits, import jobs)
  ├─ authentication + project authorization middleware
  ├─ in-process job runner
  └─ SQLite WAL (busy timeout, FK enforcement, backups)
  │
  ▼
Persistent volume
  ├─ data/practis.db
  ├─ data/backups/
  ├─ data/imports/
  └─ data/reports/
```

**Single tenant v1.** No `tenant_id` in every query. Upgrade path documented, not pre-built.

**Why:** one company, nine roles, one VPS. Separate services would add deployment, networking, session, and failure modes without needed scale.

### 1.2 Runtime topology

- Node.js LTS on Docker VPS.
- Express binds loopback/internal container port only.
- Reverse proxy terminates TLS and serves static assets.
- One application process. No cluster mode in v1.
- SQLite WAL mode: concurrent reads while one write occurs.
- Write busy timeout prevents immediate `SQLITE_BUSY`; long writes stay in transactions.
- `PRAGMA foreign_keys = ON` every connection.
- UTC audit timestamps. Business dates stored as `YYYY-MM-DD`.
- Entry/display default: `Asia/Jakarta` (GMT+7).

### 1.3 Database files

- `data/practis.db` — application data.
- `data/practis.db-wal`, `data/practis.db-shm` — WAL runtime files; never edit.
- Temporary work under `data/tmp/`; backup staging under `data/backups/`.
- Filesystem permission boundary: application user read/write DB and data directories; no web-accessible static mapping.

### 1.4 Request lifecycle

```text
Request
  → security headers + request ID
  → body parser (bounded)
  → session load
  → locale resolution
  → CSRF token available
  → route
      → requireAuth
      → requireProjectAccess(projectId)
      → requireRole / requireResponsibility
      → validate input
      → service transaction
      → audit event
  → EJS HTML or JSON response
  → security headers preserved
```

Authorization runs on every protected request. Hidden buttons are usability only, never security.

---

## 2. Decisions captured

| ID | Decision | Rationale |
|---|---|---|
| TS-01 | Email + password; Admin-created accounts; Argon2id | Familiar, self-hosted, no mail dependency for authentication |
| TS-02 | Server-side sessions stored in SQLite; session ID in cookie | Immediate revocation; no JWT key/rotation complexity |
| TS-03 | In-app alerts delivered by browser polling every 30 seconds | Alert urgency does not justify live connection infrastructure |
| TS-04 | Multipart uploads; stage → validate → preview → confirm | Covers imports and attachments; prevents silent ledger writes |
| TS-05 | In-process job runner backed by SQLite `jobs` table | Crash-recoverable without Redis or a separate worker |
| TS-06 | Reports export to PDF and XLSX; HTML source retained as frozen artifact | Distribution and analysis; frozen record remains inspectable |
| TS-07 | Single-tenant v1 | Matches current requirement; multi-tenant added only when needed |
| TS-08 | English + Indonesian from day one; language on user profile | Daily users work in Indonesian; avoids later template-wide refactor |
| TS-09 | Business dates as plain dates; UTC timestamps; Asia/Jakarta default | Project periods are calendar facts, not instants |
| TS-10 | Numbered SQL migrations; `PRAGMA user_version`; migration runner | Reviewable, ordered, repeatable deployment |
| TS-11 | One Express monolith; feature folders | Matches single-process architecture |
| TS-12 | Server-rendered EJS + Alpine CSP build; narrow JSON endpoints | Lower client attack surface; avoids SPA/hydration failure modes |
| TS-13 | Compressed hourly full snapshots; 24h/7d/4w/12m retention; encrypted offsite copy; storage monitoring (user, 2026-09-24) | Predictable restore, bounded retention, simple recovery before incremental backup/WAL streaming |
| TS-14 | RPO = 1 hour | At most work since last successful hourly snapshot may be lost |
| TS-15 | RTO = 4 hours (user, 2026-09-24) | Realistic for a documented rebuild + restore on a single VPS; a 1-hour target needs an automated recovery image and is an upgrade path, not a v1 claim |
| TS-16 | Session timeout: 30 min idle / 12 h absolute (user, 2026-09-24) | Limits stolen-cookie window; configurable single values |
| TS-17 | Password reset: Admin-only, temp password, out-of-band delivery; second Admin as backup (user, 2026-09-24) | No SMTP dependency; fits small internal team; every reset audited |
| TS-18 | Reports: pdfmake for PDF + exceljs for XLSX (user, 2026-09-24) | Pure-JS, deterministic frozen output, small image; no headless browser |
| TS-19 | Restore drill quarterly; restore to isolated environment, validate FK + trial balance, time the restore (user, 2026-09-24) | Keeps RTO 4h honest; standard minimum for recovery-first business app |
| TS-20 | Attachment limits: 10 MB/file, 50 MB/project, indefinite retention; manual user-approved deletion only (user, 2026-09-24) | Audit evidence preserved; storage bounded; no auto-delete |
| TS-21 | Audit log retention: 10 years statutory (Indonesia), no auto-delete, cold-archive after (user, 2026-09-24) | Matches books/records retention statute; audit rows small; evidence preserved |
| TS-22 | Proxy topology: Tailscale Serve now; documented upgrade path to Caddy when public access needed (user, 2026-09-24) | Zero new moving parts, private by default, TLS + identity from tailnet |
| TS-23 | Health monitoring: internal `/health` JSON probe (app, DB, backup age, disk free, job queue, migration version) + Docker HEALTHCHECK + authenticated admin detail page; in-app alert when backup stale or disk low (user, 2026-09-24) | Real signal with zero new infrastructure; total-VPS outage covered by optional external probe later |
| TS-24 | Import staging: source file + staging rows kept 90 days live then cold-archived; committed imports immutable; re-upload detected and skipped, never re-applied (user, 2026-09-24) | Preserves import evidence; corrections go through ledger correction path only |
| TS-25 | Deployment: one container, one Node process (Express + job runner); DB, attachments and backups on bind-mounted host volumes; tailscaled on host terminates TLS (user, 2026-09-24) | Preserves SQLite single-writer correctness; data survives container replacement; rollback = image swap |
| TS-26 | Offsite copy: `rclone` to an encrypted cloud bucket (Backblaze B2 or Cloudflare R2), client-side encryption via `rclone crypt`; verified after each run; failure raises an in-app alert (user, 2026-09-24) | Deliverable RPO 1h needs a copy off the VPS; 3-2-1 rule; cents-per-month at this data size; `restic` is the upgrade path if dedupe becomes worthwhile |

### 2.1 Superseded PRD statements

- “English UI v1; translation later” is superseded. UI ships English and Indonesian.
- “Language translation / bilingual UI out of scope” is superseded.


---

## 3. Security specification

Security is a required module boundary, not a final-phase review.

Exact numeric limits below are **proposed defaults**, not user-approved decisions. Security
mechanisms and trust-boundary requirements are mandatory.

### 3.1 Authentication

- Administrator creates user; account starts disabled until invitation/setup completed.
- Password minimum: 12 characters. No composition rules.
- Hash: Argon2id, memory cost from current OWASP guidance; parameters versioned in app settings.
- Login compares using a dummy hash when account missing to reduce timing differences.
- Failed-login rate limit: 5 failures per account/IP window; 15-minute lockout; successful login clears counter.
- Password setup/reset tokens: random, single-use, short-lived, stored hashed.
- Session rotates after login, privilege change, password change, and manual revocation.
- Generic login error. No “user exists” or role disclosure.
- All login successes/failures, password changes, resets, and user enable/disable actions audited.

### 3.2 Sessions

- Store: SQLite. Cookie contains opaque random session ID only.
- ID entropy: at least 128 bits from cryptographically secure random source.
- Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, narrow `Path=/`; no `Domain` attribute.
- Generic cookie name; no Express default.
- Idle timeout: 30 minutes. Absolute timeout: 12 hours. (TS-16)
- Revocation on user disable, password reset, role removal, and “revoke all sessions” admin action.
- Proxy: only known reverse proxy/bridge peer trusted; do not trust arbitrary `X-Forwarded-*`.
- Production refuses startup if secure-cookie mode cannot recognize the trusted proxy path.
- Session ID never logged. If correlation needed, log salted hash.

### 3.3 CSRF

- Synchronizer token stored server-side in session.
- Token generated with CSPRNG. Rotated on login/session regeneration.
- Required for every state-changing HTML form: hidden `_csrf`.
- Required for every mutating Alpine/fetch request: `X-CSRF-Token`.
- Safe methods: `GET`, `HEAD`, `OPTIONS`.
- No CSRF token in URL, logs, or analytics.
- Rejections logged without token value.

### 3.4 Authorization and separation of duties

- Global system Administrator role remains distinct from PM baseline approval.
- Per-project `user_roles` rows define access.
- Project Admin creates progress and Expense Report detail.
- Cost Controller checks/tags expense detail and WBS/CBS.
- Finance posts immutable ledger records and recognizes revenue.
- PM approves baseline and BCR.
- Requester may not approve own record. Service layer enforces this independently of UI.
- Bulk operations resolve all record IDs, authorize every record, and commit atomically.
- Every protected service query includes project scope in its predicate.
- Finance and Administrator actions are high-risk audit events.

### 3.5 Input validation and output safety

- All request values validated before service use. Route and service boundaries both enforce critical invariants.
- SQL uses prepared statements only.
- Import fields constrained to explicit types, lengths, enum sets, and numeric ranges.
- EJS default output `<%= value %>` escaped. Raw `<%-` reserved for trusted static fragments only.
- No user-controlled EJS template path, source, or include.
- No `x-html` for stored data. Render untrusted text with `x-text` and escaped EJS.
- Rich HTML, if introduced, requires explicit sanitization dependency and allow-list.
- Uploaded file names never used as storage paths. Generated IDs only.
- Error pages expose request ID, not stack trace, SQL, secret, or raw input.

### 3.6 Content Security Policy and headers

- Use `@alpinejs/csp` build; no `unsafe-eval`.
- No CDN scripts in production. Pin and self-host Alpine, chart assets, and CSS/fonts.
- CSP: default-src self; no broad wildcard; no `unsafe-eval`; script nonces for small inline bootstrap where needed.
- HSTS enabled at proxy when HTTPS verified.
- `frame-ancestors 'none'`; no embedded PRACTIS pages.
- `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options` set explicitly.
- Remove `X-Powered-By`.

### 3.7 Uploads and import safety

- `multipart/form-data`; streaming to controlled staging path.
- Size limit: 10 MB per file for import and attachments; 50 MB total attachments per project (TS-20).
- Allowed extensions and MIME types; signature/content inspection, not extension alone.
- File names random; never path-traverse.
- Excel formulas: treat imported formula cells as text or reject formula cells; do not generate executable formula output.
- CSV/Excel export prevents formula injection: cells beginning `=`, `+`, `-`, `@` prefixed safely for spreadsheet readers.
- Import never overwrites existing tagged ledger lines.
- Import duplicate detection uses stable source identity; quarantines uncertain duplicates for review.
- Failed/expired staged files cleaned by job; confirmed import retains original file for audit.
- Malware scanning: not required v1; documented risk accepted explicitly.

### 3.8 Secrets

- Secrets in environment/secret file outside repo. Never database plaintext, logs, EJS locals, URLs, or audit JSON.
- Session secret and report-signing key separate.
- Production startup validates required secret presence and strength.
- Rotation: session secret rotation invalidates sessions; report-signing key rotation requires new key ID and retains old verification key.
- `.env`/secret file permissions restricted; backup encrypted or host-protected.

### 3.9 Audit and logging

- Separate operational logs from immutable business audit log.
- Audit: create/update/approve/reject/freeze/import/check/role changes/login/logout/password/session revocation/export.
- Audit includes UTC time, actor, request/session correlation, entity, outcome, and before/after for changes.
- Never log password hashes, CSRF/session IDs, secret values, or unrestricted ledger descriptions.
- Business audit rows cannot update/delete through application accounts. SQLite application account has no separate per-table DB ACL; filesystem backup + restricted DB access are mandatory controls.
- Critical events: auth failures, authorization failures, validation failures for finite enums, role changes, imports, exports, period freezes, ledger postings.
- Retention: operational logs 14 days; business audit log 10 years statutory (TS-21), no auto-delete, cold-archive after 10 years.

### 3.10 Security headers order and middleware order

```text
security headers/request ID
→ bounded body parsers
→ static files
→ session
→ locale
→ CSRF token
→ public health
→ auth/login limiter
→ protected routes
→ CSRF enforcement
→ not-found
→ error handler
```

CSRF must wrap protected page POST routes, not only `/api`.

### 3.11 Security acceptance checks

- No route reads `req.query` directly into EJS render context.
- No `x-html` with server/user data.
- No production CSP contains `unsafe-eval`.
- Every mutating endpoint/page passes auth, CSRF, project scope, and role/SoD.
- Session fixation test: pre-login session ID changes after login.
- Brute-force test: rate limit and lockout trigger.
- Upload traversal and formula-injection tests.
- Output escaping test: malicious description renders as text.
- Audit records for ledger, role, import, period-freeze, login actions.

---

## 4. Reliability and operations

### 4.1 SQLite durability

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

- `synchronous = FULL` protects committed financial records against power loss at higher write cost. Revisit only with measured backup and durability requirements.
- Short write transactions only. No long report generation holding DB lock.
- One writer at a time. Read-heavy reports may use read-only DB connection.
- `PRAGMA integrity_check` during scheduled health check; `quick_check` for routine quick scan.
- `PRAGMA foreign_key_check` during validation and recovery verification.
- No `PRAGMA writable_schema`, `VACUUM` during business hours, or ad-hoc DB mutation.

### 4.2 Backup and restore

- Full consistent snapshot created hourly through SQLite Online Backup API or `better-sqlite3.backup()`; never copy live WAL DB files.
- Completed snapshot compressed with gzip. Keep hourly, daily, weekly, and monthly tiers; one snapshot may satisfy multiple tiers without duplication.
- Maximum retained set: 24 hourly + 7 daily + 4 weekly + 12 monthly snapshots (47 references maximum).
- Backup set includes DB, secret-file reference (never secret value), confirmed import originals, report artifacts, and app version.
- Keep local copy for fast recovery plus encrypted offsite copy for VPS/disk loss.
- Verify new backup before retention cleanup. Backup job never writes to or overwrites production DB.
- Monitor filesystem free space and backup-directory size. Refuse/alert before backup can exhaust application disk.
- Automatic retention deletion stays disabled until user explicitly approves deletion and tested restore. Proposed retention above is not deletion authority.
- Add incremental backup or WAL streaming only when measured storage or restore time proves full snapshots insufficient.
- Restore drill: restore latest copy to isolated path, run integrity, foreign-key, and app validation checks, then record result.
- Restore never overwrites production. Drill cadence: **quarterly (TS-19)**.
- **RPO: 1 hour.** Backup pipeline must alert on a failed or overdue hourly snapshot; latest successful snapshot defines accepted data-loss boundary.
- **RTO: 4 hours.** Keep deployment configuration, secret references, DNS/TLS steps, offsite backup access, and a tested restore runbook ready. Target is unproven until a drill restores a production-sized copy, runs integrity/FK/app checks, and reaches readiness within four hours. A 1-hour target requires an automated recovery image; treat it as an upgrade path, not a v1 claim.

### 4.3 Health and readiness

- `/health/live`: process alive; no DB dependency.
- `/health/ready`: DB reachable, foreign keys enabled, schema version current, disk free-space threshold, job runner responsive.
- `/health` public returns minimal status; no version stack, paths, or secrets to unauthenticated networks.
- Docker health check uses readiness endpoint.
- Metrics not required v1; structured logs + duration/status counts in log first.

### 4.4 Logging and request IDs

- JSON structured logs in production; human-readable local logs optional.
- Fields: UTC time, request ID, method, route template, status, duration, user ID when authenticated, error code.
- Never log query string, request body, cookies, secrets, or full ledger descriptions.
- Access logs through proxy; app logs business/security events.
- Request ID returned on errors; user can quote it for support.

### 4.5 Job runner

SQLite table (added by first migration):

```sql
CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY,
  type           TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  state          TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','running','failed','completed')),
  run_at         TEXT NOT NULL DEFAULT (datetime('now')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX idx_jobs_due ON jobs(state, run_at);
```

Rules:
- Single-process runner claims due jobs with one short transaction.
- One job at a time in v1. Job handlers are idempotent.
- Jobs move running → completed or failed; crash recovery returns stale running jobs to queued.
- Exponential backoff; max attempts prevents infinite retry.
- Import validation, report generation, alert checks, staged-file cleanup, backup orchestration can be jobs.
- Jobs table in same DB; terminal states pruned only with retention policy.

### 4.6 Migrations and deployment

- Existing `schema.sql` becomes generated fresh-install artifact after approval.
- Current design SQL copied to `db/migrations/001_initial.sql`; validator extended before first deployment.
- `PRAGMA user_version` records applied migration ID.
- Boot runs pending migrations before accepting traffic.
- Migration runner: checksum files, file order, transaction per migration, backup before live migration.
- SQLite DDL transactional caveats documented and tested per migration. Never “test migration” on production copy.
- Deployment: build image → backup → migrate → start new version → readiness check → switch traffic → retain previous image.
- Rollback: application image can roll back if schema backward compatible. Database rollback never via destructive reverse migration. Recovery is restore backup or forward-fix migration.
- No auto migration from old container while old process still writing.

### 4.7 Release safety

- Lockfile committed; exact versions pinned. Dependency review before merge.
- `npm audit` before release; critical/high findings block release.
- No new runtime dependency without short decision note and security review.
- Health check + smoke flow after every deploy.
- Startup requires backup/recovery readiness before accepting first write.

---

## 5. Module boundaries

```text
src/
  app.js
  server.js
  config/
  shared/
    db/                 connection, pragmas, transaction helper
    auth/               session middleware, policy helpers
    validation/         schema validators, date/rupiah helpers
    i18n/               EN/ID catalogs, t() helper
    jobs/               runner, handlers
    audit/              business/security audit
    errors/             typed error contract
    money/              integer rupiah, signs
  auth/                 login, sessions, invitations, user management
  admin/                master data, roles, teams, settings
  projects/             projects, clients, teams, assignment access
  planning/             WBS, RBS load, CBS plan, baseline, BCR
  execution/            ledger, cash advance, Expense Report, progress,
                        procurement, acceptance, revenue
  reporting/            EVM, dashboards, aging, monthly report, exports
  imports/              upload, parse, validate, stage, reconcile, commit
  alerts/               rule evaluation, notification inbox
views/
  layouts/
  partials/
  pages/
  reports/
locales/
  en.json
  id.json
db/
  schema.sql
  migrations/
  validate.py
  fixtures/
  seed-smoke.sql
tests/
  unit/
  integration/
  e2e/
  security/
```

Rules:
- Routes validate HTTP input and select response format. Business rules live in services.
- Services own transactions and invariants. SQL never interpolates external input.
- Views contain presentation only. No business calculations beyond lightweight format helpers.
- `shared/db` is the only module that opens production DB connections.
- New feature starts as one vertical slice: route + service + test + template.
- No service-to-service HTTP. Feature folders are code organization, not distributed boundaries.

---

## 6. API and page contracts (draft)

Rendering rule (TS-12): pages are server-rendered EJS. JSON endpoints exist only for the four
bounded interactions below. Everything else is a form POST → redirect → GET.

### 6.1 Page routes (HTML)

Every route below is protected unless marked public, carries the CSRF token on any mutating
request, and resolves project scope before touching data.

| Method | Route | Purpose | Access |
|---|---|---|---|
| GET | `/login` | Login form | public |
| POST | `/login` | Authenticate | public, rate-limited |
| POST | `/logout` | End session | authenticated, CSRF |
| GET/POST | `/invite/:token` | Set password from invitation | public, single-use token |
| GET | `/` | Portfolio dashboard | authenticated |
| GET | `/projects` | Project list | authenticated |
| GET | `/projects/:id/overview` | Health, schedule/cost, open work | project member |
| GET | `/projects/:id/wbs` | WBS tree, dates, milestones | project member |
| GET | `/projects/:id/cbs` | Monthly baseline/forecast | project member |
| GET | `/projects/:id/ledger` | Finance lines, entry form | Finance |
| GET | `/projects/:id/queue` | Cost Controller tagging queue | Cost Controller |
| GET | `/projects/:id/advances` | Cash advance pots, aging | project member |
| GET | `/projects/:id/expense-reports` | Expense Report detail | Project Admin |
| GET | `/projects/:id/reconciliation` | Finance bulk vs Admin detail | Finance, Cost Controller |
| GET | `/projects/:id/revenue` | Billed / recognized / received | Finance |
| GET | `/projects/:id/procurement` | PO, items, supplier status | project member |
| GET | `/projects/:id/acceptance` | Certificates, milestones | project member |
| GET | `/projects/:id/report` | Project Update Report | PM, reviewer |
| POST | `/projects/:id/report/freeze` | Freeze period | PM, SoD enforced |
| GET | `/bcr` | BCR register | PM, Finance |
| GET | `/reports/aging` | Receivable priorities | Finance |
| GET | `/reports/portfolio` | Cross-project comparison | authenticated |
| GET | `/admin/users` | User, role, team management | Administrator |
| GET | `/admin/master-data` | COA, WBS/RBS/CBS, categories | Administrator |
| GET | `/system/jobs` | Job and import batch status | Administrator |
| GET | `/system/health` | Operator health detail | Administrator |

### 6.2 JSON endpoints (the only ones)

| Method | Route | Purpose | Notes |
|---|---|---|---|
| GET | `/api/alerts` | Alert inbox polling (TS-03) | 30 s interval; returns unread only; project-scoped |
| POST | `/api/alerts/:id/read` | Mark alert read | CSRF |
| POST | `/api/ledger/lines` | Inline ledger line save | CSRF; same validation and service path as the form route |
| POST | `/api/imports` | Multipart upload → stage (TS-04) | CSRF; returns `batchId`, never writes ledger |
| GET | `/api/imports/:batchId/preview` | Row count, new vs skipped (R2-27) | read-only |
| POST | `/api/imports/:batchId/confirm` | Commit staged import | CSRF; idempotent per batch; immutable after commit (TS-24) |

Not JSON: report generation and download are page routes plus a job; the file is delivered by
`GET /projects/:id/report/:jobId/download` after the job reports success.

### 6.3 Health endpoints

| Route | Returns | Auth |
|---|---|---|
| `/health/live` | process alive | public, minimal body |
| `/health/ready` | DB reachable, FK on, schema version, disk, job runner | public, minimal body |
| `/system/health` | full detail: backup age, disk free, queue depth | Administrator |

Public health responses expose status only — no version stack, paths, or secrets (TS-23).

### 6.4 Rules fixed now

- Page routes render EJS; JSON APIs only for bounded interactions: alert polling, inline save, import preview/progress, report download status.
- All errors use stable code. Example:

```json
{
  "error": {
    "code": "PERIOD_FROZEN",
    "message": "This reporting period is already frozen.",
    "requestId": "req_..."
  }
}
```

- Validation errors include field-level details without echoing unsafe input.
- 400 malformed/invalid; 401 unauthenticated; 403 unauthorized/CSRF; 404 missing/inaccessible; 409 state conflict/duplicate; 413 upload too large; 422 business rule failure; 429 rate limited; 500 internal.
- Redirect after successful form POST (POST-redirect-GET). Prevent duplicate submission.
- No mass-assignment: explicit allow-list fields per operation.
- JSON response media type `application/json`; never render untrusted JSON as HTML.

---

## 7. Screen map (draft)

| Area | Page | Primary purpose |
|---|---|---|
| Public | Login / invitation setup / password setup | Authentication |
| Portfolio | Dashboard | Live projects, CPI/SPI, exceptions, cashflow |
| Project | Overview | Health, schedule/cost, open work |
| Project | WBS | Tree, dates, milestones, progress |
| Project | CBS plan | Monthly baseline/forecast, RBS derivation |
| Project | Ledger | Finance lines, debit/credit entry, import |
| Project | Cost Controller queue | WBS+CBS tagging, effective-date corrections |
| Project | Cash Advances | Advance pots, aging |
| Project | Expense Reports | Project Admin detail, Cost Controller check |
| Project | Expense Report reconciliation | Finance bulk vs Admin detail |
| Project | Revenue | Billed, recognized, received |
| Project | Procurement | PO/item/supplier status |
| Project | Acceptance | certificates, milestones, percentages |
| Project | Project Update Report | review, approval, freeze, PDF/XLSX |
| Control | BCR register | initiate/verify/approve baseline changes |
| Reports | Aging | receivable priorities |
| Reports | Portfolio report | cross-project comparison |
| Administration | Users/roles/teams | access management |
| Administration | Master data | COA, WBS/RBS/CBS, categories |
| System | Jobs/import batches | operational status, failures |
| System | Health | authenticated detail for operators |

---

## 8. Test strategy

### 8.1 Test layers

1. **Schema/contract tests** — `validate.py`: executable DDL, FK integrity, invariants, real-ledger regression, LPB flow, import dedupe.
2. **Unit tests** — integer rupiah, signs, dates/periods, authorization policies, validation, EVM math, reconciliation.
3. **Integration tests** — route + real SQLite DB + service + transaction, including failed rollback and FK errors.
4. **Security tests** — auth, session fixation, CSRF, XSS escaping, authorization/BOLA, upload traversal/formula injection, rate limits, CSP.
5. **E2E tests** — login → create project → baseline → progress → expense report → check → report → freeze. Critical write path only; not every screen.
6. **Recovery tests** — backup restore to isolated location; foreign-key check; migration rehearsal on production-sized copy.

### 8.2 Module test matrix (per implementation step)

Each module ships its own tests before the next begins (see §10 order). Minimum per module:

| Module | Unit | Integration | Security | Evidence required |
|---|---|---|---|---|
| Foundation (config, pragmas, migrations) | pragma assertions, migration checksum/order | boot on fresh DB; boot on DB one version behind | startup refuses on missing secret | `validate.py` PASS; migration up-path test |
| Auth (login, sessions, invitation, reset) | password policy, dummy-hash timing path, rate-limit counter | login/logout, session rotation, revoke-all, admin reset | session fixation, brute force lockout, generic error text | login/logout audit rows; fixation test |
| Projects & master data | role resolution, project-scope predicate | create project, assign roles, COA/WBS/RBS/CBS CRUD | BOLA: user A cannot read/modify project B | authorization-negative tests per route |
| Ledger | `amount = debit - credit`; one-side-only; integer rupiah | post line, correction path, frozen-period rejection | prepared statements, mass-assignment allow-list | imbalance rejected; frozen write rejected |
| Cash advance & Expense Report | advance excluded from cost basis; only `checked` detail counts | advance → detail → check → actual cost; reconciliation balanced/difference/missing_detail | role separation on check action | `v_lpb_reconciliation` cases (all three statuses) |
| Import | dedupe key, type/length/enum/range validation | upload → stage → preview → confirm; re-upload skipped | traversal, formula injection, oversize 413, MIME/signature | preview counts match commit; no duplicate ledger rows |
| WBS/progress/RBS/CBS/baseline/BCR | EVM math (SPI/CPI), baseline vs forecast split, BCR gate | baseline freeze, BCR approve → baseline mutation | SoD: requester cannot approve | BCR gate rejects unapproved mutation |
| EVM/revenue/aging/dashboard | four revenue methods; billed ≠ recognized ≠ received; aging buckets | dashboard reads closed projects hidden by default | scope filter on every aggregate | closed project absent from live dashboard |
| Reporting (PDF/XLSX), jobs, alerts | job state machine, retry/backoff, idempotency | job crash → recovery to queued; report download after success | exported formula-injection guard | frozen report artifact hash stable; job recovery test |
| Administration, recovery tooling | restore script arguments, health thresholds | restore to isolated path, run integrity/FK/app checks | audit retention tamper resistance | Q drill record: restore timed < 4 h (RTO) |

### 8.3 Test environment rules

- Integration tests use a real SQLite DB created from migrations, never mocks.
- Every test DB starts from `db/migrations/001_initial.sql` forward, then `seed-smoke.sql` where domain data is needed.
- The ledger-export fixture (`fixture-ledger-export.tsv`, 26 rows) is regression-checked on every run.
- No test writes to `data/practis.db`. Test DBs live under a temp path and are deleted after the run.
- Security tests are part of CI, not a manual pre-release step.

### 8.4 Required invariants

- `amount = debit - credit`.
- One side only on user entry.
- Every imported transaction group balances to zero or is quarantined.
- Cash advances and bulk Expense Report settlement excluded from cost basis.
- Only checked Expense Report detail contributes actual cost.
- Historical WBS stays NULL until human assignment.
- Frozen period rejects ordinary backdated writes; flagged revision path remains explicit.
- BCR approval required before baseline mutation.
- Requester cannot approve own record.
- Billed ≠ recognized ≠ received.
- Import never overwrites existing tagged lines; duplicates skipped/counted.
- Closed projects hidden by default from live dashboards.
- English and Indonesian catalogs have identical key sets.

- `PRAGMA foreign_keys = ON`; `PRAGMA foreign_key_check` returns zero violations.
- Current validator executes `PRAGMA foreign_key_check` and reports zero violations.

---

## 9. Open technical decisions — one at a time

Resolved and recorded in §2: TS-13 to TS-25 (recovery, backup, session timeout, password reset,
report libraries, restore drill, attachment limits, audit retention, proxy topology).

Open:

1. Multi-tenant upgrade path detail (deferred; TS-07) — outline only, no build.

### 9.1 RPO/RTO definitions

- RPO: maximum acceptable data loss measured in time.
- RTO: maximum acceptable restoration time.
- RPO locked: **1 hour**.
- RTO locked: **4 hours** (user, 2026-09-24). Prepared configuration, restore runbook, offsite backup access, and a successful timed drill are prerequisites for claiming this target.

### 9.2 Backup and storage policy

- Backup mechanism: SQLite Online Backup API / better-sqlite3 `backup()`. No file copy of a live
  database; snapshot is consistent and taken while writes continue.
- Frequency: **hourly** snapshot.
- Compression: gzip each completed snapshot.
- Retention: 24 hourly + 7 daily + 4 weekly + 12 monthly, one snapshot may serve multiple tiers.
- Offsite: encrypted copy after every backup run; local-only backup is not a backup.
  - Mechanism (TS-26): `rclone` to a cloud bucket (Backblaze B2 or Cloudflare R2) with client-side
    encryption (`rclone crypt`); provider stores ciphertext only. Upgrade path: `restic` for
    incremental dedupe if storage growth justifies it.
  - Applies the accepted **3-2-1 rule**: 3 copies, 2 media types, 1 offsite (CISA/CMU, *Data Backup Options*).
  - Each run verified (`rclone check`); a failed or overdue upload raises an in-app alert (TS-23).
- Storage: size monitoring with alert; backup never fills the application disk; backup volume
  separate from data volume.
- Safety: newest backup verified before any older one is removed; **no automatic deletion
  without user approval**; retention cleanup runs only on explicit approval.
- Deduplication/incremental streaming: add only if measured storage or restore time requires.

---

## 10. Module implementation order

1. Foundation: config, DB pragmas, migrations, FK validator, test harness.
2. Auth: users, Argon2id, SQLite sessions, CSRF, authorization policy, audit.
3. Project setup: teams, clients, projects, roles, master data.
4. Ledger: one-side entry, import staging, dedupe, immutable correction path.
5. Cash Advance + Expense Report + reconciliation.
6. WBS/progress/RBS/CBS baseline/BCR/freeze.
7. EVM/revenue/aging/dashboard.
8. Reporting: PDF/XLSX, jobs, alerts.
9. Administration, recovery tooling, deployment hardening.
10. Legacy migration rehearsal and production cutover.

Order gives each vertical slice a working test before adding next domain.

---

## 11. Research references

These sources informed the rendering, security, and recovery constraints. They do not change
user-approved requirements without a new decision.

1. **Rendering.** web.dev, *Rendering on the Web* — SSR generally improves FCP and reduces client JavaScript work; CSR bundle growth can hurt TBT/INP.
   https://web.dev/articles/rendering-on-the-web
2. **Express security.** Express production security guidance — server-side sessions, secure cookie options, input validation, rate limiting, dependency checks.
   https://expressjs.com/en/advanced/best-practice-security.html
3. **EJS output safety.** EJS project security notes — `<%=` escapes; `<%-` is unescaped; caller owns input validation.
   https://github.com/mde/ejs
4. **Alpine CSP.** Alpine CSP build — removes normal build's `unsafe-eval` requirement but restricts some inline expressions.
   https://alpinejs.dev/advanced/csp
5. **CSRF.** OWASP CSRF Prevention Cheat Sheet — stateful applications use synchronizer tokens and validate mutating requests.
   https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
6. **Sessions.** OWASP Session Management Cheat Sheet — opaque high-entropy cookie IDs, secure flags, revocation, timeout management.
   https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
7. **SQLite backup.** SQLite Online Backup API — consistent snapshot of a live database; normal writes may continue during backup.
   https://www.sqlite.org/backup.html
8. **Node SQLite driver backup.** better-sqlite3 `backup()` API — online backup with progress callback; mutation source should use one connection.
   https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backup
9. **Container recovery.** Docker restart policies — automatic restart after a process/container exit; this is availability, not data recovery.
   https://docs.docker.com/engine/containers/start-containers-automatically/
10. **Offsite backup rule.** CISA/US-CERT & Carnegie Mellon, *Data Backup Options* — the 3-2-1 rule: 3 copies, 2 media types, 1 offsite; cloud encryption with established algorithms and TLS in transit.
   https://www.cisa.gov/sites/default/files/publications/data_backup_options.pdf

---

## 12. Deployment and recovery runbook

Shaped by TS-22 (Tailscale Serve), TS-25 (one container, one process), TS-15 (RTO 4 h).

### 12.1 Volumes and paths on the host

```text
/opt/practis/
  app/            image tag + compose file + .env (secret references, 0600)
  data/
    practis.db        bind mount → /data/practis.db
    attachments/      bind mount → /data/attachments/
    imports/          bind mount → /data/imports/      (90 days live, TS-24)
    reports/          bind mount → /data/reports/
  backups/          separate volume where possible → /data/backups/
```

Data lives on the host, not inside the container layer: replacing the container must never touch
the database, attachments, or backups.

### 12.2 Deploy (routine release)

1. Build and tag the image (`practis:<version>`), never reuse a tag.
2. Take a fresh snapshot and confirm it is verified.
3. Run migrations against a copy first; confirm `user_version` advances and checks pass.
4. Start the new container; await `/health/ready` = healthy.
5. Run the smoke flow (login → one project page → one read-only report).
6. Keep the previous image for rollback.

### 12.3 Rollback

- Application rollback: start the previous image tag. Allowed only when the schema change was
  backward compatible.
- Schema is never rolled back by a destructive reverse migration. Recovery is either a forward-fix
  migration or a restore from backup.
- Migrations run only after the old process is stopped. Two processes must never write the DB.

### 12.4 Restore procedure (target: complete within 4 hours)

1. Provision or reach a target host; install Docker and the tailnet.
2. Retrieve the latest verified offsite snapshot (TS-26) and its app version tag.
3. Decrypt, gunzip, decompress to a staging path. Never restore directly over a live DB.
4. Run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`; both must be clean.
5. Run the application validator; all checks must pass.
6. Attach the restored DB, start the matching image version, confirm `/health/ready`.
7. Record the drill: date, snapshot used, checks run, elapsed time, outcome.

### 12.5 Quarterly drill (TS-19)

Restore the latest production-sized snapshot to an isolated environment, run integrity/FK/app
checks, and time the whole path. RPO/RTO stay unproven claims until a drill proves them.

### 12.6 Backup job

Hourly, from the job runner: snapshot → gzip → verify → upload encrypted copy → alert on failure.
Retention cleanup runs only on explicit approval; no automatic deletion of backups.
