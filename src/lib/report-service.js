// Project Update Report + period freeze (module 8, plan part 8.10; PRD §4.4, §5.4).
//
// WHY THIS FILE EXISTS
// PRD §5.4 asks for a monthly **Project Update Report** — SPI, CPI, receivable vs revenue, payable
// status, exceptions, and a prior-baseline vs current comparison. PRD §4.4 says the Controller
// compiles it, the PM approves it, "and then frozen for the period". `project_reports` has existed
// since migration 001 and has had **ZERO WRITERS** in `src/` — so nothing generated a report and
// nothing tied a report to a freeze.
//
// ---------------------------------------------------------------------------------------------
// DECISION A — THE PERIOD FREEZES ON *APPROVAL* (owner, 2026-10-04)
// ---------------------------------------------------------------------------------------------
// The PRD contradicts itself and the owner resolved it:
//   * §4.4 prose:      generated → reviewed → approved → THEN frozen     (freeze last)
//   * §4.4 calendar:   "when a period's report is GENERATED, that period freezes"  (freeze first)
// **Option A — freeze on APPROVAL — is the binding one.** Generating produces a draft and the month
// stays writable while the Controller reviews it; the PM's approval is what closes the period.
// That is the only reading in which "reviewed" and "approved" mean anything: freezing on generation
// would lock the month BEFORE anyone had read the numbers, and a wrong SPI/CPI could then only be
// corrected through the reversal path.
//
// Consequence for `status`: the resting states this workflow produces are `draft`, `reviewed` and
// `frozen`. **`approved` is never a resting state** — approval and the freeze are the same act, so
// approving moves straight to `frozen` with `approved_by`/`approved_at`/`frozen_at` all stamped.
// The column still permits `approved` (the schema predates this decision); nothing produces it, and
// `UP8.5` pins that.
//
// ---------------------------------------------------------------------------------------------
// THIS FILE COMPILES; IT DOES NOT COMPUTE
// ---------------------------------------------------------------------------------------------
// Every figure is read from the service that already owns that rule — `forecast-service` (EVM),
// `revenue-service` (recognition), the aging readers (receivables). Nothing is re-derived here.
// If a number is wrong, it is wrong in ONE place (its owner), and the report cannot drift away from
// the screens the reader checks it against. `UP8.2` asserts the report's figures EQUAL the owning
// service's, which is the test that keeps this honest.
//
// ONE EXCEPTION, stated plainly: `cost_variance_pct` has no owner. `forecast-service.variance()`
// exposes `cv_pct` (standard EVM, `cv_cum/ac_cum`), but `project_reports.cost_variance_pct` is a
// distinct column, so it is computed here from the view's `cost_variance` (`ac_cum - ev_cum`) over
// `ev_cum` — the EVM "cost overrun against earned value" reading, per the plan. This is the only
// arithmetic in the file and it is labelled as such.
//
// ---------------------------------------------------------------------------------------------
// POSITIONS TO DATE, NOT MONTH MOVEMENTS
// ---------------------------------------------------------------------------------------------
// `spi`, `cpi`, `cost_variance_pct` and `revenue_recognized` store **positions as at the report
// month** (the cumulative figures), because a monthly position report is read that way.
// Per-period movements (`ev`/`ac`/`pv` for the month, the recognised-this-month amount) live in
// `payload_json`. The screen states which is which.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const periods = require('./periods');
const forecast = require('./forecast-service');
const revenue = require('./revenue-service');

const STATUSES = ['draft', 'reviewed', 'approved', 'frozen'];
const STATUS_LABELS = {
  draft: 'Draft', reviewed: 'Reviewed', approved: 'Approved', frozen: 'Frozen',
};
// Under decision A the only moves are forward, one step, and approval is the last one.
const TRANSITIONS = { draft: ['reviewed'], reviewed: ['frozen'], approved: [], frozen: [] };

// The PRD names ONE tunable threshold ("SPI or CPI < 0.95"), but migration 023 created TWO separate
// settings — `spi_breach_threshold` and `cpi_breach_threshold` — so the portfolio tiles could be
// tuned independently. Read separately, because a report that quoted one number for both would
// contradict the dashboard the moment either was changed. Both default to 0.95.
const DEFAULT_THRESHOLD = 0.95;

function threshold(settingKey) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(settingKey);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}
const spiThreshold = () => threshold('spi_breach_threshold');
const cpiThreshold = () => threshold('cpi_breach_threshold');

class ReportError extends Error {
  constructor(message, status = 400, field = null) {
    super(message);
    this.name = 'ReportError';
    this.status = status;
    this.field = field;
  }
}

const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));
const monthOf = (d) => String(d).slice(0, 7);
const round2 = (n) => Math.round(n * 100) / 100;

function project(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(projectId));
  if (!p) throw new ReportError('Project not found.', 404);
  return p;
}

function threshold() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'spi_cpi_threshold'").get();
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}

// ---------------------------------------------------------------------------------------------
// The EVM position, and WHICH MONTH it is dated from
// ---------------------------------------------------------------------------------------------

// The latest month AT OR BEFORE `month` that carries a REAL measurement.
//
// This is deliberately NOT `forecast.latestCumulative`, which is unbounded: a report for March must
// not quote a figure measured in December. It is also not "the row for March": migration 019's
// running totals mean a month with no measurement still has a row (carried forward from the last
// one), so reading the row for March would report a position that was never measured in March.
// Measured-ness is the same test 8.4's EAC and 8.7's health use: an index exists only when there is
// a numerator and a denominator.
function measuredAt(projectId, month) {
  return db.prepare(`SELECT period_month, pv, ev, ac, pv_cum, ev_cum, ac_cum,
      spi_cum, cpi_cum, cost_variance
    FROM v_evm_period
    WHERE project_id = ? AND period_month <= ?
      AND cpi_cum IS NOT NULL AND (ev <> 0 OR ac <> 0)
    ORDER BY period_month DESC LIMIT 1`).get(Number(projectId), String(month)) || null;
}

// ---------------------------------------------------------------------------------------------
// Exceptions — PRD §4.4's alert table, evaluated; and the ones NOT evaluated, named
// ---------------------------------------------------------------------------------------------

function exceptionsFor(p, month, evm) {
  const out = [];
  const thSpi = spiThreshold();
  const thCpi = cpiThreshold();

  if (evm) {
    // "CPI/SPI breach — < 0.95 (threshold tunable)". Each index is judged against ITS OWN setting
    // (migration 023 made them separately tunable), and the text names the threshold used so the
    // reader can see why the alert fired.
    for (const [flag, label, value, th] of [
      ['spi', 'SPI', evm.spi_cum, thSpi],
      ['cpi', 'CPI', evm.cpi_cum, thCpi],
    ]) {
      if (value !== null && value !== undefined && value < th) {
        out.push({
          kind: `${flag}_breach`,
          severity: 'warning',
          text: `${label} is ${value}, below the ${th} threshold as at ${evm.period_month}.`,
        });
      }
    }
  }

  // "Cost overrun ahead — EAC > BAC". The EAC rule lives in forecast-service; reusing it is the
  // whole point (it is the `BAC × AC ÷ EV` figure, never the 4dp-rounded CPI).
  const est = forecast.eac(p.id);
  if (est && est.over === true) {
    out.push({
      kind: 'eac_over_bac',
      severity: 'warning',
      text: `Forecast to complete is ${est.eac}, above the budgeted ${est.bac}.`,
    });
  }

  // "Overdue invoice — unpaid past due_date". Read from the aging list, which also excludes claims
  // that cannot be dated at all (migration 020 keeps those in their own group, so they can never be
  // reported as overdue). `overdue_days` is already clamped at 0 by the view, so `> 0` is the test —
  // comparing `days_aged` against `terms_days` here would double-apply the terms and fire early.
  const aging = q.receivableAging(p.id, 'amount');
  const overdue = aging.filter((r) => (r.overdue_days || 0) > 0);
  if (overdue.length) {
    out.push({
      kind: 'overdue_receivable',
      severity: 'warning',
      text: `${overdue.length} claim${overdue.length === 1 ? '' : 's'} worth `
        + `${overdue.reduce((s, r) => s + (r.outstanding_amount || 0), 0)} are past their due date.`,
    });
  }

  // "Cash advance old — outstanding > 60 days".
  const old = db.prepare(`SELECT COUNT(*) AS n FROM cash_advance
      WHERE project_id = ? AND status IN ('open','settling')
        AND issued_date IS NOT NULL AND julianday('now') - julianday(issued_date) > 60`)
    .get(p.id).n;
  if (old) {
    out.push({
      kind: 'stale_advance', severity: 'warning',
      text: `${old} cash advance${old === 1 ? '' : 's'} outstanding for more than 60 days.`,
    });
  }

  // "Unapproved BCR waiting — > 3 days pending".
  const bcrs = db.prepare(`SELECT COUNT(*) AS n FROM bcr_register
      WHERE project_id = ? AND status IN ('draft','verified')
        AND julianday('now') - julianday(initiated_at) > 3`).get(p.id).n;
  if (bcrs) {
    out.push({
      kind: 'pending_bcr', severity: 'warning',
      text: `${bcrs} baseline change${bcrs === 1 ? '' : 's'} waiting more than 3 days for a decision.`,
    });
  }

  // NOT EVALUATED, and said so. PRD §4.4 also lists "Progress not updated — no progress entry 14
  // days". There is no per-line "last progress at" column, so it cannot be evaluated here. Rather
  // than let an absent alert read as "no problem", the report names it as not checked.
  const notEvaluated = [
    { kind: 'progress_not_updated', reason: 'No per-line "last progress at" is recorded, so a 14-day staleness check cannot be made.' },
  ];

  return { raised: out, notEvaluated, spiThreshold: thSpi, cpiThreshold: thCpi };
}

// ---------------------------------------------------------------------------------------------
// The prior-baseline vs current comparison — PRD §5.4's "what changed this period, BCRs applied"
// ---------------------------------------------------------------------------------------------

function baselineChangesFor(p, month) {
  const rows = db.prepare(`SELECT id, bcr_no, change_type, title, impact_cost, status,
      effective_period, approved_by, decided_at
    FROM bcr_register
    WHERE project_id = ? AND status = 'approved'
      AND (effective_period = ? OR (effective_period IS NULL AND substr(decided_at, 1, 7) = ?))
    ORDER BY id`).all(p.id, String(month), String(month));

  return {
    rows,
    totalImpact: rows.reduce((s, r) => s + (r.impact_cost || 0), 0),
    // Empty is stated as a real answer: "nothing changed this period" is information.
    note: rows.length
      ? `${rows.length} approved baseline change${rows.length === 1 ? '' : 's'} take effect in this period.`
      : 'No baseline change was approved or effective in this period.',
  };
}

// ---------------------------------------------------------------------------------------------
// Compile — the whole report body, WITHOUT writing anything
// ---------------------------------------------------------------------------------------------

// Returns everything the report states. Pure read: this is what `preview` exposes and what
// `generate` stores, so the two can never disagree (`UP8.2`).
function compile(projectId, month) {
  const p = project(projectId);
  if (!isValidMonth(month)) {
    throw new ReportError('A report month is required, as YYYY-MM.', 400, 'period_month');
  }
  const m = String(month);

  const evm = measuredAt(p.id, m);

  // WHAT THE CLIENT STILL OWES — the ageable outstanding balance, summed from `v_aging`, because
  // that is the reader the aging screen uses and the two must not disagree. (`v_receivable` has no
  // `amount` column: it exposes `billed_amount`, `paid_amount` and `outstanding_amount`, and
  // `v_aging` further excludes claims with no invoice date. Summing `outstanding_amount` from
  // `v_aging` is therefore "receivable", not "billed" — the report says which.)
  const receivable = db.prepare(`SELECT COALESCE(SUM(outstanding_amount), 0) AS s
      FROM v_aging WHERE project_id = ?`).get(p.id).s;

  // Claims that exist but cannot be dated are NOT in `v_aging` (migration 020). They are still money
  // owed, so the report counts them separately rather than letting them vanish from the total.
  const undated = q.receivablesWithoutDate(p.id)
    .reduce((s, r) => s + (r.outstanding_amount || 0), 0);

  // `payable` and `tax` lines in the cost basis are what the project owes. (The same role list
  // `q.costToDate` uses for spend.)
  const payable = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM v_ledger_period
      WHERE project_id = ? AND in_cost_basis = 1 AND line_role IN ('payable','tax')`).get(p.id).s;

  // Recognition: the position to date, from the service that owns the rule.
  const reg = revenue.register(p.id);
  const rec = reg.rows.find((r) => r.period_month === m);
  const recLast = reg.rows.length ? reg.rows[reg.rows.length - 1] : null;
  const recognisedPosition = reg.rows
    .filter((r) => r.period_month <= m)
    .reduce((s, r) => s + (r.amount || 0), 0);

  const spi = evm ? evm.spi_cum : null;
  const cpi = evm ? evm.cpi_cum : null;
  // The file's only arithmetic — see the header. Cumulative, so the sign tells the reader whether
  // the project has spent more than it has earned to date.
  const costVariancePct = (evm && evm.ev_cum)
    ? round2(((evm.ac_cum - evm.ev_cum) / evm.ev_cum) * 100)
    : null;

  return {
    period_month: m,
    // Which month the EVM position is actually dated from. When this is EARLIER than
    // `period_month`, the report says so rather than pretending the month was measured.
    measured_month: evm ? evm.period_month : null,
    evm_stale: !!(evm && evm.period_month !== m),
    spi, cpi, cost_variance_pct: costVariancePct,
    receivable_amount: receivable,
    // Money owed but undatable, reported beside the receivable rather than folded into it: adding it
    // would silently mix a chaseable claim with a data-quality problem.
    receivable_undated: undated,
    revenue_recognized: recognisedPosition,
    payable_amount: payable,
    method: p.revenue_method || null,
    recognition: {
      // The per-period movement, kept beside the position so the two cannot be confused.
      period_month: rec ? m : null,
      period_amount: rec ? rec.amount : 0,
      period_basis_pct: rec ? rec.basis_pct : null,
      position_to_date: recognisedPosition,
      last_recorded_month: recLast ? recLast.period_month : null,
      note: !p.revenue_method
        ? 'No revenue method is configured, so nothing is recognised.'
        : (rec ? null : 'Nothing has been recognised for this month.'),
    },
    evm_period: evm
      ? { pv: evm.pv, ev: evm.ev, ac: evm.ac, pv_cum: evm.pv_cum, ev_cum: evm.ev_cum, ac_cum: evm.ac_cum }
      : null,
    exceptions: exceptionsFor(p, m, evm),
    baseline_changes: baselineChangesFor(p, m),
    contract_amount: Number(p.contract_amount) || 0,
    generated_for: m,
  };
}

// ---------------------------------------------------------------------------------------------
// Stored report readers
// ---------------------------------------------------------------------------------------------

function byId(id) {
  return db.prepare('SELECT * FROM project_reports WHERE id = ?').get(Number(id)) || null;
}

function forMonth(projectId, month) {
  return db.prepare('SELECT * FROM project_reports WHERE project_id = ? AND period_month = ?')
    .get(Number(projectId), String(month)) || null;
}

function list(projectId) {
  return db.prepare(`SELECT * FROM project_reports WHERE project_id = ? ORDER BY period_month DESC`)
    .all(Number(projectId));
}

// ---------------------------------------------------------------------------------------------
// generate — compile and store
// ---------------------------------------------------------------------------------------------

// Stores as a DRAFT. Regenerating is allowed while the report is not yet frozen, because a draft or
// a reviewed report is not a commitment; once frozen the numbers are the period's history and are
// never rewritten (PRD §4.4: "old reports stay truthful"). Regeneration is audited with the
// before and after, so a changed figure is attributable.
function generate({ projectId, month, actorId }) {
  const p = project(projectId);
  const body = compile(p.id, month);
  const existing = forMonth(p.id, body.period_month);

  if (existing && existing.status === 'frozen') {
    throw new ReportError(
      'This month\u2019s report is frozen and cannot be regenerated \u2014 frozen figures are the period\u2019s history. Reopen the period first if a correction is genuinely needed.',
      409);
  }

  if (existing) {
    db.prepare(`UPDATE project_reports SET status = 'draft', spi = ?, cpi = ?,
        cost_variance_pct = ?, receivable_amount = ?, revenue_recognized = ?, payable_amount = ?,
        payload_json = ?, generated_at = datetime('now'), approved_by = NULL, approved_at = NULL,
        frozen_at = NULL
      WHERE id = ?`).run(body.spi, body.cpi, body.cost_variance_pct, body.receivable_amount,
      body.revenue_recognized, body.payable_amount, JSON.stringify(body), existing.id);
    q.audit('project_reports', existing.id, 'regenerate', actorId, existing,
      { ...body, id: existing.id });
    return { ok: true, report: byId(existing.id), regenerated: true };
  }

  const info = db.prepare(`INSERT INTO project_reports (project_id, period_month, status, spi, cpi,
      cost_variance_pct, receivable_amount, revenue_recognized, payable_amount, payload_json)
      VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.id, body.period_month, body.spi, body.cpi, body.cost_variance_pct, body.receivable_amount,
      body.revenue_recognized, body.payable_amount, JSON.stringify(body));
  const id = Number(info.lastInsertRowid);
  q.audit('project_reports', id, 'create', actorId, null, { ...body, id });
  return { ok: true, report: byId(id), regenerated: false };
}

// ---------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------

function transition({ projectId, id, to, actorId }) {
  const p = project(projectId);
  const rep = byId(id);
  if (!rep || rep.project_id !== p.id) throw new ReportError('Report not found for this project.', 404);
  if (!STATUSES.includes(to)) throw new ReportError(`"${to}" is not a report status.`, 400);
  if (!(TRANSITIONS[rep.status] || []).includes(to)) {
    throw new ReportError(
      `A ${rep.status} report cannot be moved to ${to}.`
      + (rep.status === 'frozen' ? ' A frozen report is the period\u2019s history.' : ''),
      409);
  }
  db.prepare('UPDATE project_reports SET status = ? WHERE id = ?').run(to, rep.id);
  q.audit('project_reports', rep.id, to, actorId, rep, { ...rep, status: to });
  return byId(rep.id);
}

function review({ projectId, id, actorId }) {
  return transition({ projectId, id, to: 'reviewed', actorId });
}

// APPROVE IS THE ACT THAT CLOSES THE PERIOD (decision A).
//
// It does three things that must not come apart: stamps the approval, marks the report frozen, and
// freezes the period in `frozen_periods` through the EXISTING `q.freezePeriod` — the same call the
// Administrator's `/periods/freeze` button makes. There is one freeze mechanism in this app, not
// two, so an administrator looking at `/periods` sees exactly what the PM's approval did.
//
// The `frozen` status and the report's own `frozen_at` are stamped here rather than by a later step,
// because under decision A approval and freezing are the same act.
function approve({ projectId, id, actorId }) {
  const p = project(projectId);
  const rep = byId(id);
  if (!rep || rep.project_id !== p.id) throw new ReportError('Report not found for this project.', 404);
  if (rep.status === 'frozen') {
    throw new ReportError('This report is already approved and the period is frozen.', 409);
  }
  if (!(TRANSITIONS[rep.status] || []).includes('frozen')) {
    throw new ReportError(
      `A ${rep.status} report cannot be approved \u2014 it must be reviewed first.`, 409);
  }

  // The freeze itself, recording WHICH report closed the period in `frozen_periods.report_id` — the
  // column migration 001 created for exactly this. `freezePeriodForReport` is idempotent and
  // backfills the link when an Administrator had already frozen the month by hand, so approving a
  // month that was frozen manually is not an error — it is the same outcome through the other door,
  // and it records the reason.
  const alreadyFrozen = periods.isFrozen(p.id, rep.period_month);
  const r = q.freezePeriodForReport(p.id, rep.period_month, actorId, rep.id);
  if (r.changes === 1) {
    const fp = periods.frozenPeriod(p.id, rep.period_month);
    q.audit('frozen_periods', fp ? fp.id : null, 'freeze', actorId, null,
      { project_id: p.id, period_month: rep.period_month, by: 'report approval', report_id: rep.id });
  }

  db.prepare(`UPDATE project_reports
      SET status = 'frozen', approved_by = ?, approved_at = datetime('now'), frozen_at = datetime('now')
      WHERE id = ?`).run(actorId, rep.id);
  q.audit('project_reports', rep.id, 'frozen', actorId, rep, {
    ...rep, status: 'frozen', period_frozen: true, was_already_frozen: alreadyFrozen,
  });
  return { report: byId(rep.id), period: rep.period_month, alreadyFrozen };
}

module.exports = {
  ReportError, STATUSES, STATUS_LABELS, TRANSITIONS,
  compile, preview: compile,
  byId, forMonth, list, generate, review, approve, transition,
  measuredAt, exceptionsFor, baselineChangesFor, spiThreshold, cpiThreshold,
};
