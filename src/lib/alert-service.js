'use strict';
//
// Alert rules, delivery and the notification inbox — PRD §4.4, TECH-SPEC §4.4, TS-03, TS-23, TS-14.
//
// ============================================================================================
// WHAT THIS IS
// ============================================================================================
// PRD §4.4 names six alerts with default thresholds, and Q19 confirms all six ship in v1. Two more
// are mandated by the technical spec rather than the product spec — TS-14 ("backup pipeline must
// alert on a failed or overdue hourly snapshot") and TS-23 ("in-app alert when backup stale or disk
// low"). Those two are not optional politeness: an RPO of one hour that nobody is told about is not
// an RPO, and a backup that has been failing silently is discovered on the day it is needed.
//
// DELIVERY is the notification inbox (Q12: "in-app notifications only"). TS-03 fixes the transport:
// the browser polls every 30 seconds. There is no websocket, no mail, no SMS in v1 — mail is
// explicitly v2 (PRD §5.5). So this module WRITES inbox rows and the client READS them; nothing here
// pushes.
//
// ============================================================================================
// WHY EVALUATION IS A JOB AND THE READ IS NOT
// ============================================================================================
// Evaluation is a WRITE (it inserts inbox rows), so it runs on the job runner (§4.5) — never inside
// the GET that the browser polls. A read that mutates the database would make a poll a write on
// every tick, would break the read-only promise the rest of the app keeps, and would let one
// impatient browser tab change what everybody else is told.
//
// ============================================================================================
// DEDUPLICATION IS THE DATABASE'S JOB, NOT THIS CODE'S
// ============================================================================================
// `db/schema.sql` already carries a PARTIAL UNIQUE INDEX on the unread rows:
//
//   idx_notif_unread_unique (user_id, alert_type, COALESCE(project_id,0),
//                            COALESCE(entity_type,''), COALESCE(entity_id,0)) WHERE read_at IS NULL
//
// So "does this person already have this alert, unread?" is enforced by SQLite, by INSERT OR
// IGNORE. This module deliberately does NOT do a SELECT-then-INSERT: on a 60-second tick that is a
// race, and the index makes the race impossible. The index also defines the re-notification rule for
// free — once the alert is READ, the row leaves the partial index and a recurrence may be delivered
// again, which is the behaviour a person expects from "mark as read".
//
// Hmm — read that again, because it is the subtle part: reading an alert means "I have seen this",
// NOT "this is fixed". If the condition is still true an hour later the person is told again, which
// is correct for a condition that persists (cost still over budget) and mildly repetitive for one
// that does not. The alternative — suppressing until the condition clears — would need a "resolved"
// concept the schema does not have, and would be silent during exactly the window it matters.
//
// ============================================================================================
// WHO IS TOLD (this is the part that is an authorization decision, not a mailing-list decision)
// ============================================================================================
// §4.4 is silent on recipients. Two bad answers were available: send to EVERYONE (which hands
// Finance's customer-by-customer receivable position to every Viewer — the very leak
// `canViewReceivable` exists to prevent), or invent a new recipient table.
//
// The rule used instead reuses the app's existing decision: a person is told about a project alert
// if they can ALREADY SEE that project (`permissions.projectsFor` — fail-closed, respects the
// scoped/global role rules) AND they hold the capability the alert's SCREEN requires
// (`capabilities().can[...]`). So the inbox can never reveal a figure to someone whose page would
// refuse it. Each alert type names its capability in `RULES` below and the comment says which
// screen that is.
//
// The two system-wide alerts (stale backup, low disk) go to `canManageStructure` — that is the
// Administrator, who owns the machine. They are the operator's problem, not the project's, and
// putting them in every project user's inbox would train people to ignore the bell.

'use strict';

const db = require('../db/db');
const permissions = require('./permissions');
const forecast = require('./forecast-service');

// ---------------------------------------------------------------------------------------------
// Thresholds — read from `app_settings`, never hard-coded
// ---------------------------------------------------------------------------------------------

// The PRD's own default. Used only when a setting is absent or unreadable, so a bare installation
// still behaves as the PRD states while a tuned one is honoured. The dashboard (`portfolio-service`)
// and the report (`report-service`) read the same keys — one number, one place, or the alert and the
// tile start disagreeing and both look broken.
const DEFAULT_BREACH = 0.95;
const DEFAULT_STALE_PROGRESS_DAYS = 14;   // PRD §4.4: "no progress entry 14 days"
const DEFAULT_BCR_PENDING_DAYS = 3;       // PRD §4.4: "> 3 days pending"
const DEFAULT_ADVANCE_AGED_DAYS = 60;     // PRD §4.4: "outstanding > 60 days"

function settingNumber(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    if (!row) return fallback;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function thresholds() {
  return {
    cpi: settingNumber('cpi_breach_threshold', DEFAULT_BREACH),
    spi: settingNumber('spi_breach_threshold', DEFAULT_BREACH),
    staleProgressDays: settingNumber('stale_progress_days', DEFAULT_STALE_PROGRESS_DAYS),
    bcrPendingDays: settingNumber('bcr_pending_days', DEFAULT_BCR_PENDING_DAYS),
    advanceAgedDays: settingNumber('cash_advance_aged_days', DEFAULT_ADVANCE_AGED_DAYS),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const idr = (n) => 'Rp ' + Number(n || 0).toLocaleString('en-US');
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// `entity_type` per alert, so the index keys on a real entity where one exists. Where the rule
// aggregates a CLASS of rows (three overdue invoices) there is no single entity, and entityId is
// null — the dedupe key then collapses to (user, type, project) and the person is told once per
// project per condition, with the count in the body. That is the intended granularity: one alert
// per condition, not one per row, or a 40-invoice project would bury the other five alerts.
const ENTITY = {
  cpi_spi_breach: 'project',
  cost_overrun: 'project',
  progress_stale: 'project',
  invoice_overdue: 'project',
  bcr_pending: 'project',
  cash_advance_aged: 'project',
  submission_overdue: 'acceptance',
  backup_overdue: 'system',
  disk_low: 'system',
};

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** One alert, ready to deliver. `capability` decides WHO may be told (see the module header). */
function alert(projectId, alertType, severity, title, body, capability, entityId = null) {
  return { projectId, alertType, severity, title, body, capability,
    entityType: ENTITY[alertType] || 'project', entityId };
}

/** Latest cumulative EVM row with a usable CPI/SPI. Mirrors `forecast-service.latestCumulative`,
 *  which is the same source the dashboard uses — so the alert and the tile cannot disagree about
 *  which month they are describing. */
function latestEvm(projectId) {
  return db.prepare(`SELECT period_month, pv_cum, ev_cum, ac_cum, cpi_cum, spi_cum
    FROM v_evm_period
    WHERE project_id = ? AND cpi_cum IS NOT NULL AND (ev <> 0 OR ac <> 0)
    ORDER BY period_month DESC LIMIT 1`).get(Number(projectId)) || null;
}

// 1. CPI/SPI breach — PRD §4.4 "< 0.95 (threshold tunable)".
//
// Read from the CUMULATIVE columns, which is the decision already recorded in migration 023 for the
// portfolio tiles: the per-period figures read "5.0, blank, blank, blank" down a year and are not a
// health indicator. Alerting on a per-period dip would fire on normal early-project noise.
function ruleCpiSpiBreach(project, t) {
  const row = latestEvm(project.id);
  if (!row) return [];
  const out = [];
  const bad = [];
  if (row.cpi_cum !== null && row.cpi_cum < t.cpi) {
    bad.push(`cost performance (CPI) is ${Number(row.cpi_cum).toFixed(2)}, below the ${t.cpi} threshold`);
  }
  if (row.spi_cum !== null && row.spi_cum < t.spi) {
    bad.push(`schedule performance (SPI) is ${Number(row.spi_cum).toFixed(2)}, below the ${t.spi} threshold`);
  }
  if (!bad.length) return out;
  out.push(alert(project.id, 'cpi_spi_breach', 'warning',
    `${project.code}: performance below threshold`,
    `As at ${row.period_month}, ${bad.join(', and ')}. `
    + `Cumulative to that month: earned value ${idr(row.ev_cum)}, actual cost ${idr(row.ac_cum)}, `
    + `planned value ${idr(row.pv_cum)}.`,
    'canViewForecast'));
  return out;
}

// 2. Cost overrun ahead — PRD §4.4 "EAC > BAC".
//
// Uses `forecast.eac()`, which already carries two decisions this rule would otherwise have to
// re-derive: the override path (a human forecast beats the CPI projection) and the unrounded-ratio
// arithmetic. Re-deriving either here would let the alert and the forecast screen disagree.
function ruleCostOverrun(project, t, eac) {
  if (eac === null || eac.over !== true) return [];
  const gap = eac.eac - eac.bac;
  const pct = eac.bac ? Math.round((gap / eac.bac) * 1000) / 10 : null;
  return [alert(project.id, 'cost_overrun', 'warning',
    `${project.code}: forecast to finish over budget`,
    `Estimate at completion ${idr(eac.eac)} against a budget of ${idr(eac.bac)}`
    + (pct === null ? '' : ` — ${pct}% over`)
    + `. Committed so far ${idr(eac.ac_cum)}; work completed ${idr(eac.ev_cum)}.`,
    'canViewForecast')];
}

// 3. Progress not updated — PRD §4.4 "no progress entry 14 days".
//
// "No update" is normally good news on a project that has finished reporting, so this is `info` and
// not `warning`: it asks a question ("is this still moving?"), it does not report a breach.
function ruleProgressStale(project, t) {
  const row = db.prepare(`SELECT MAX(reported_at) AS last FROM wbs_progress wp
    JOIN wbs_nodes n ON n.id = wp.wbs_node_id WHERE n.project_id = ?`).get(project.id);
  const last = row && row.last ? row.last : null;
  // A project with NO progress at all is a different condition (nothing has started, or nobody is
  // reporting at all) — report it against the project's own start so the alert is actionable, and
  // say which case it is rather than claiming a "last update" that does not exist.
  const since = last || project.start_date || project.created_at;
  if (!since) return [];
  const age = Math.floor((Date.now() - Date.parse(`${String(since).slice(0, 10)}T00:00:00Z`)) / DAY_MS);
  if (!(age >= t.staleProgressDays)) return [];
  return [alert(project.id, 'progress_stale', 'info',
    `${project.code}: progress not updated for ${days(age)}`,
    last
      ? `The last progress entry was on ${String(last).slice(0, 10)} — ${days(age)} ago, past the `
        + `${t.staleProgressDays}-day threshold.`
      : `No progress has ever been recorded on this project, and it began on `
        + `${String(since).slice(0, 10)} — ${days(age)} ago.`,
    'canManageWbs')];
}

// 4. Overdue invoice — PRD §4.4 "unpaid past due_date".
//
// `v_aging` already computes `overdue_days` clamped at 0 with the terms-resolution rules (migration
// 021), so this rule adds no date arithmetic of its own — it only asks the question.
function ruleInvoiceOverdue(project) {
  const rows = db.prepare(`SELECT document_no, outstanding_amount, due_date, overdue_days
    FROM v_aging WHERE project_id = ? AND overdue_days > 0 ORDER BY overdue_days DESC`).all(project.id);
  if (!rows.length) return [];
  const total = rows.reduce((s, r) => s + Number(r.outstanding_amount || 0), 0);
  const worst = rows[0];
  const shown = rows.slice(0, 3).map((r) => `${r.document_no || '(no number)'} (${days(r.overdue_days)})`).join(', ');
  return [alert(project.id, 'invoice_overdue', 'warning',
    `${project.code}: ${rows.length} overdue invoice${rows.length === 1 ? '' : 's'}`,
    `${idr(total)} outstanding past due. Oldest: ${shown}`
    + (rows.length > 3 ? `, and ${rows.length - 3} more` : '')
    + `. Worst is ${days(worst.overdue_days)} past its ${worst.due_date} due date.`,
    'canViewReceivable')];
}

// 5. Unapproved BCR waiting — PRD §4.4 "> 3 days pending".
//
// `decided_at` is the column the BCR workflow sets on a decision, so "pending" is a row that has
// neither decided nor reached a terminal state. Counting from `initiated_at` matches the PRD's
// wording ("waiting"), i.e. the age of the REQUEST, not of the current step.
function ruleBcrPending(project, t) {
  const rows = db.prepare(`SELECT bcr_no, title, status, initiated_at
    FROM bcr_register
    WHERE project_id = ? AND status IN ('draft','verified')
      AND CAST(julianday('now') - julianday(initiated_at) AS INTEGER) > ?
    ORDER BY initiated_at`).all(project.id, t.bcrPendingDays);
  if (!rows.length) return [];
  const oldest = Math.floor((Date.now() - Date.parse(`${String(rows[0].initiated_at).replace(' ', 'T')}Z`)) / DAY_MS);
  return [alert(project.id, 'bcr_pending', 'info',
    `${project.code}: ${rows.length} change request${rows.length === 1 ? '' : 's'} awaiting a decision`,
    `Waiting longer than ${days(t.bcrPendingDays)}: `
    + rows.slice(0, 3).map((r) => r.bcr_no || r.title || '(untitled)').join(', ')
    + (rows.length > 3 ? `, and ${rows.length - 3} more` : '')
    + `. Oldest has been open ${days(oldest)}.`,
    'canInitiateBcr')];
}

// 6. Cash advance old — PRD §4.4 "outstanding > 60 days".
//
// `status` is the workflow column ('open' → 'settling' → 'settled' → 'closed'), so "outstanding" is
// an advance that has not started settling. The clock runs from the date the money left: `issued_date`
// when present, else `approved_date` — the same fallback the schema comment records ("taken =
// approved_date when absent").
function ruleCashAdvanceAged(project, t) {
  const rows = db.prepare(`SELECT advance_no, amount, status, COALESCE(NULLIF(issued_date,''), approved_date) AS taken
    FROM cash_advance
    WHERE project_id = ? AND status = 'open' AND COALESCE(NULLIF(issued_date,''), approved_date) IS NOT NULL
      AND CAST(julianday('now') - julianday(COALESCE(NULLIF(issued_date,''), approved_date)) AS INTEGER) > ?
    ORDER BY taken`).all(project.id, t.advanceAgedDays);
  if (!rows.length) return [];
  const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const oldest = Math.floor((Date.now() - Date.parse(`${String(rows[0].taken).slice(0, 10)}T00:00:00Z`)) / DAY_MS);
  return [alert(project.id, 'cash_advance_aged', 'warning',
    `${project.code}: ${rows.length} cash advance${rows.length === 1 ? '' : 's'} still unsettled`,
    `${idr(total)} outstanding for more than ${days(t.advanceAgedDays)}: `
    + rows.slice(0, 3).map((r) => r.advance_no || '(no number)').join(', ')
    + (rows.length > 3 ? `, and ${rows.length - 3} more` : '')
    + `. Oldest has been outstanding ${days(oldest)}.`,
    'canViewExpense')];
}

// ---------------------------------------------------------------------------------------------
// System-wide alerts (TS-14, TS-23) — the operator's, not the project's
// ---------------------------------------------------------------------------------------------

// TS-14: "Backup pipeline must alert on a failed or overdue hourly snapshot."
//
// The age comes from the SAME reader the health endpoint and the admin page use, so the alert and
// the readiness check cannot disagree. A database with NO backup at all reports `null`, and null
// must alert — it is the worst case, not the best.
function ruleBackupOverdue(t, now) {
  const backup = require('./backup-service');
  let age = null;
  let dir = null;
  try {
    dir = backup.backupsDir();
    age = backup.backupAgeSeconds(now, dir);
  } catch (err) {
    return [alert(null, 'backup_overdue', 'critical',
      'Backup state could not be checked',
      `The backup directory could not be read (${err.message}), so whether this installation has a `
      + `recent recovery copy is unknown. Nothing about the ledger is at risk from this alert `
      + `itself, but the backup pipeline needs attention before it is trusted.`,
      'canManageStructure')];
  }
  if (age !== null && age < 3600) return [];
  return [alert(null, 'backup_overdue', 'critical',
    age === null ? 'No backup has ever been taken' : 'The latest backup is overdue',
    age === null
      ? 'This installation has no verifiable recovery copy, so a disk failure would lose the '
        + 'ledger entirely. The hourly backup job has either never run or never succeeded.'
      : `The newest verified backup is ${Math.floor(age / 60)} minutes old, past the one-hour `
        + `recovery point (TS-14). Work since then would be lost by a disk failure.`,
    'canManageStructure')];
}

// TS-23: "in-app alert when ... disk low". The filesystem measured is the one holding the DATABASE,
// not the root volume — the same rule `health-service` had to get right, and for the same reason:
// on this host `/` is a small near-full overlay while the data lives on a large separate volume, so
// a root-volume check would alarm forever about a filesystem the app cannot fill.
function ruleDiskLow() {
  const health = require('./health-service');
  let free = null;
  try { free = health.diskFreeBytes(); } catch { return []; }
  if (free === null || free >= health.DISK_WARN_BYTES) return [];
  return [alert(null, 'disk_low', 'critical',
    'Disk space is low',
    `The filesystem holding the database has ${Math.round(free / (1024 ** 2))} MB free, below the `
    + `${Math.round(health.DISK_WARN_BYTES / (1024 ** 2))} MB threshold. Backups refuse to run below `
    + `this line rather than filling the disk, so recovery copies stop being taken while it lasts.`,
    'canManageStructure')];
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

/** Every alert currently true for one project. Pure with respect to the database: reads only, no
 *  writes. Exported so a test (and the drill, if it ever wants one) can ask "what is true?" without
 *  delivering anything. */
function evaluateProject(projectId, now = new Date()) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(projectId));
  if (!project || project.status !== 'active') return [];
  const t = thresholds();

  // One EAC read, passed to the rule that needs it. `eac()` throws when the project row is missing,
  // but a caller-supplied id could be stale, so a failure here degrades to "no overrun alert"
  // rather than aborting the whole evaluation of every other project.
  let eac = null;
  try { eac = forecast.eac(projectId); } catch { eac = null; }

  return [
    ...ruleCpiSpiBreach(project, t),
    ...ruleCostOverrun(project, t, eac),
    ...ruleProgressStale(project, t),
    ...ruleInvoiceOverdue(project),
    ...ruleBcrPending(project, t),
    ...ruleCashAdvanceAged(project, t),
  ];
}

function systemAlerts(now = new Date()) {
  return [...ruleBackupOverdue(thresholds(), now), ...ruleDiskLow()];
}

/** Who should be told about `a`. See the module header: can ALREADY SEE the project, AND holds the
 *  capability the alert's screen requires. System alerts ignore the project rule and go to the
 *  operator. */
function recipientsFor(a) {
  const users = db.prepare('SELECT * FROM users WHERE is_active = 1').all();
  const out = [];
  for (const user of users) {
    // TRAP: `capabilities()` returns the flags FLAT on the object — `caps.canManageStructure`, not
    // `caps.can.canManageStructure`. Its no-user early return (`{roles, isAdmin, can: {}}`) uses a
    // different shape, so a `caps.can[...]` lookup reads undefined here and throws. Read flat.
    const caps = permissions.capabilities(user);
    if (!caps[a.capability]) continue;
    if (a.projectId !== null) {
      const visible = permissions.projectsFor(user).some((p) => p.id === Number(a.projectId));
      if (!visible) continue;
    }
    out.push(user.id);
  }
  return out;
}

/** Write the alerts that are true right now. Returns what happened, because a silent deliverer is
 *  how a broken alert pipeline looks healthy for a month. */
function evaluateAll(now = new Date()) {
  const created = [];
  const skipped = [];
  const projects = db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY id").all();

  const pending = [];
  for (const p of projects) pending.push(...evaluateProject(p.id, now));
  pending.push(...systemAlerts(now));

  const ins = db.prepare(`INSERT OR IGNORE INTO notification_inbox
    (user_id, project_id, alert_type, severity, title, body, entity_type, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const a of pending) {
    const ids = recipientsFor(a);
    if (!ids.length) { skipped.push({ alert: a.alertType, projectId: a.projectId, reason: 'no recipient holds the capability' }); continue; }
    for (const userId of ids) {
      // `OR IGNORE` + the partial unique index is the dedupe decision (see header). `changes` is
      // 0 when the index suppressed the row, which is the honest count of "told again".
      const info = ins.run(userId, a.projectId, a.alertType, a.severity, a.title, a.body,
        a.entityType, a.entityId);
      if (info.changes > 0) created.push({ userId, ...a });
      else skipped.push({ alert: a.alertType, projectId: a.projectId, userId, reason: 'already unread' });
    }
  }
  return {
    evaluated: pending.length,
    created: created.length,
    skipped: skipped.length,
    byType: created.reduce((m, c) => { m[c.alertType] = (m[c.alertType] || 0) + 1; return m; }, {}),
    skipReasons: skipped,
  };
}

// ---------------------------------------------------------------------------------------------
// The inbox (reads)
// ---------------------------------------------------------------------------------------------

/** The alerts FOR THIS USER that are still unread. TS-03: "returns unread only".
 *
 *  No extra project filter is applied or needed: the row is addressed to a user id, and it was
 *  only ever written for users who can already see that project (see `recipientsFor`). Adding a
 *  second scope check here would be re-deciding an authorization question this module already
 *  answered — and if the two ever disagreed, the inbox would silently show less than was delivered.
 */
function inboxFor(user, { projectId = null, limit = 50 } = {}) {
  if (!user || !user.id) return [];
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = projectId
    ? db.prepare(`SELECT * FROM notification_inbox
        WHERE user_id = ? AND read_at IS NULL AND project_id = ?
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 created_at DESC, id DESC LIMIT ?`).all(user.id, Number(projectId), cap)
    : db.prepare(`SELECT * FROM notification_inbox
        WHERE user_id = ? AND read_at IS NULL
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 created_at DESC, id DESC LIMIT ?`).all(user.id, cap);
  // Severity first, then newest: a critical disk alert must not sit under five progress reminders.
  return rows.map((r) => ({
    id: r.id,
    alertType: r.alert_type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    projectId: r.project_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    createdAt: r.created_at,
  }));
}

function unreadCount(user) {
  if (!user || !user.id) return 0;
  const row = db.prepare('SELECT COUNT(*) AS n FROM notification_inbox WHERE user_id = ? AND read_at IS NULL')
    .get(user.id);
  return row ? row.n : 0;
}

/** Mark one alert read. Scoped to the owner in the WHERE clause, so no separate ownership check can
 *  be forgotten: a row that is not yours is not found. Returns false for "not yours", "already
 *  read" and "does not exist" alike — the caller must not distinguish, or the 404 becomes an
 *  existence oracle for other people's alert ids. */
function markRead(user, alertId) {
  if (!user || !user.id) return false;
  const info = db.prepare(`UPDATE notification_inbox SET read_at = datetime('now')
    WHERE id = ? AND user_id = ? AND read_at IS NULL`).run(Number(alertId), user.id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------------------------
// The runner hook (§4.5)
// ---------------------------------------------------------------------------------------------

const JOB_TYPE = 'alerts.evaluate';

/** Register with the job runner. Safe to run on a plain tick without a lock: evaluating twice in a
 *  row delivers nothing the second time, because the partial unique index (`idx_notif_unread_unique`)
 *  suppresses every duplicate at INSERT OR IGNORE. That is what makes the job naturally idempotent —
 *  it is enforced by the schema, not by a flag on the runner. */
function registerAlertJob(jobs) {
  jobs.register(JOB_TYPE, async () => evaluateAll());
  return JOB_TYPE;
}

function enqueueEvaluation(jobs) {
  return jobs.enqueue({ type: JOB_TYPE });
}

module.exports = {
  thresholds, evaluateProject, systemAlerts, evaluateAll, recipientsFor,
  inboxFor, unreadCount, markRead,
  registerAlertJob, enqueueEvaluation, JOB_TYPE,
  DEFAULT_BREACH,
};
