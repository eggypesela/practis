-- ============================================================================
-- 002_auth_and_jobs.sql — auth/sessions/jobs/staging gaps (spec §B, §C)
-- Applies on top of 001_initial.sql. PRAGMA user_version → 2.
-- Decisions: TS-01 (auth: Argon2id, Admin invite/reset), TS-02 (SQLite sessions),
--   TS-05 (SQLite jobs), TS-20 (attachments), TS-24 (import staging retention).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. users: lockout + locale/timezone (spec §C)
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;          -- UTC; NULL = not locked
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','id'));
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta';

-- ---------------------------------------------------------------------------
-- 2. sessions (TS-02): server-side, SQLite-backed, revocable
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,             -- random session id (cookie value, hashed at rest)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,                -- 30 min idle / 12 h absolute (TS-16), app computes
  ip_address    TEXT,
  user_agent    TEXT,
  revoked_at    TEXT                          -- NULL = active; set on logout/disable/reset/role change
);
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- 3. attachments (TS-20): 10 MB/file, 50 MB/project, indefinite retention
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,                -- lpb_statement|expense_report|receipt|document
  entity_id     INTEGER,
  filename      TEXT NOT NULL,
  stored_path   TEXT NOT NULL UNIQUE,         -- relative path under attachments volume
  mime_type     TEXT,
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),  -- 10 MB cap
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT                          -- soft delete; hard delete only with explicit approval
);
CREATE INDEX idx_attachments_project ON attachments(project_id);

-- ---------------------------------------------------------------------------
-- 4. jobs (TS-05): in-process runner, crash-recoverable
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Password resets (TS-17): admin-only, temp password, out-of-band
-- ---------------------------------------------------------------------------
CREATE TABLE password_resets (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  temp_password_hash TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,                          -- NULL = unused
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pwreset_user ON password_resets(user_id);

-- ---------------------------------------------------------------------------
-- 5b. user_invitations (TS-01): Admin invites a new user; token single-use, expiring
-- ---------------------------------------------------------------------------
CREATE TABLE user_invitations (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash    TEXT NOT NULL UNIQUE,   -- SHA-256 of the emailed token (never store raw)
  invited_by    INTEGER NOT NULL REFERENCES users(id),
  role_id       TEXT REFERENCES roles(code),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,          -- 72 h (spec 3.4: single-use, time-limited)
  used_at       TEXT,                   -- NULL = unused; set on consumption
  revoked_at    TEXT                    -- NULL = active; set on cancel
);
CREATE INDEX idx_invites_pending ON user_invitations(email) WHERE used_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5c. import_batches: extend base table with TS-24 staging lifecycle
--     (base 001 already has id/profile_id/project_id/filename/row_count/
--      inserted_count/skipped_count/error_json/imported_at/imported_by)
-- ---------------------------------------------------------------------------
ALTER TABLE import_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('staged','previewed','confirmed','failed','expired'));
ALTER TABLE import_batches ADD COLUMN original_name TEXT;
ALTER TABLE import_batches ADD COLUMN uploaded_by INTEGER REFERENCES users(id);
ALTER TABLE import_batches ADD COLUMN new_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_batches ADD COLUMN confirmed_at TEXT;   -- set on commit; after this the batch is immutable
ALTER TABLE import_batches ADD COLUMN expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 days'));  -- TS-24 live window
CREATE INDEX idx_imports_project_status ON import_batches(project_id, status);
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN outcome TEXT; -- success|failure
ALTER TABLE audit_log ADD COLUMN session_hash TEXT;

-- ---------------------------------------------------------------------------
-- 7. app_settings: argon2id parameter versioning (spec §3.1)
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (key, value) VALUES ('argon2_memory_kib', '19456');
INSERT INTO app_settings (key, value) VALUES ('argon2_iterations', '2');
INSERT INTO app_settings (key, value) VALUES ('argon2_parallelism', '1');

-- ============================================================================
-- Version
-- ============================================================================
PRAGMA user_version = 2;
