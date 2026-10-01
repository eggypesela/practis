// Period service — frozen accounting periods (PRD §2.3, TECH-SPEC §8.4).
//
// THE RULE: once a month's figures have been reported, an ordinary backdated
// write must not change them. `frozen_periods` held that intent as a table with
// zero rows, no trigger and no reader — the invariant existed in the spec and
// nowhere in the system.
//
// THE DOOR: a frozen month still has to accept a DELIBERATE, ATTRIBUTED
// correction, or people work around the lock and it becomes decoration. §8.4
// calls this "the flagged revision path remains explicit". PRACTIS already has
// exactly one correction mechanism — the reversing entry, which points back at
// the line it cancels (reverses_ledger_id) and whose only legal writer is
// lib/ledger-correction.js. Wiring the door to that link, rather than inventing
// a second `revision_of` flag, keeps ONE way to correct a posted line.
//
// So: an ordinary posting into a frozen month is refused; a REVERSAL of a line
// that already exists is admitted, because it carries proof of what it corrects.

'use strict';

const db = require('../db/db');

// Normalise any date-ish value to its 'YYYY-MM' period key. Accepts a full ISO
// date, an already-trimmed month, or null.
function monthOf(date) {
  if (!date) return null;
  const s = String(date).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// The date a write lands in. `effective_date` wins when set — that is the
// accounting date, and it is what the recon and CBS views group by, so freezing
// has to follow it rather than the wall-clock entry date. Falls back to `date`.
function periodKeyOf(row) {
  return monthOf(row?.effective_date) || monthOf(row?.date);
}

// Is this project's month frozen?
function isFrozen(projectId, date) {
  const month = monthOf(date);
  if (!month || projectId == null) return false;
  return !!db.prepare(
    `SELECT 1 FROM frozen_periods WHERE project_id = ? AND period_month = ?`
  ).get(projectId, month);
}

// The frozen row itself, for messages that need to name who froze it and when.
function frozenPeriod(projectId, date) {
  const month = monthOf(date);
  if (!month || projectId == null) return null;
  return db.prepare(`
    SELECT fp.*, u.email AS frozen_by_email
    FROM frozen_periods fp
    LEFT JOIN users u ON u.id = fp.frozen_by
    WHERE fp.project_id = ? AND fp.period_month = ?`).get(projectId, month) || null;
}

function frozenMonths(projectId) {
  return db.prepare(
    `SELECT period_month FROM frozen_periods WHERE project_id = ? ORDER BY period_month`
  ).all(projectId).map((r) => r.period_month);
}

// Every month the project has ledger activity in, newest first — what the freeze
// control offers, so an Admin picks from real months instead of typing one.
function monthsWithActivity(projectId) {
  return db.prepare(`
    SELECT DISTINCT substr(COALESCE(effective_date, date), 1, 7) AS period_month
    FROM accounting_ledger
    WHERE project_id = ? AND COALESCE(effective_date, date) IS NOT NULL
    ORDER BY period_month DESC`).all(projectId).map((r) => r.period_month);
}

// The guard every write path calls BEFORE inserting. Returns null when the write
// may proceed, or a refusal object describing why not and what to do instead.
//
// `reverses` is the line this write corrects, if any. It is what makes the
// revision door: a frozen month accepts a reversal because the reversal is
// provably a correction of something already inside that month (or of something
// else the same bookkeeper posted), not a new backdated entry.
function checkWrite(projectId, row, { reverses = null } = {}) {
  const key = periodKeyOf(row);
  if (!key) return null;
  if (!isFrozen(projectId, key)) return null;

  if (reverses) {
    // Admitted: a correction of an existing line. The reversal's own value is
    // the negation of a line already accounted for, so the period total moves
    // only by the correction the bookkeeper asked for.
    return null;
  }

  const fp = frozenPeriod(projectId, key);
  return {
    code: 'FROZEN_PERIOD',
    period: key,
    frozenAt: fp?.frozen_at || null,
    frozenBy: fp?.frozen_by_email || null,
    message: `Period ${key} is frozen${fp?.frozen_by_email ? ` (frozen by ${fp.frozen_by_email}${fp.frozen_at ? ` on ${fp.frozen_at.slice(0, 10)}` : ''})` : ''}. `
      + `Frozen periods reject ordinary backdated writes; correct an existing line instead, which is admitted.`,
  };
}

module.exports = {
  monthOf, periodKeyOf, isFrozen, frozenPeriod, frozenMonths,
  monthsWithActivity, checkWrite,
};
