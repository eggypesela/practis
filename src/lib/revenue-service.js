// Revenue recognition (module 8, plan part 8.8; PRD §5.3).
//
// PRD §5.3: four methods on `projects.revenue_method` — `milestone`, `poc`, `time_based`,
// `on_billing`.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE, in the PRD's own words:
//
//   "`poc` reads BAST acceptance % from `acceptance_register` — NEVER the internal tick %"
//
// Those are two different numbers and the whole point of the `poc` method is that revenue follows
// the CLIENT's acceptance, not our own optimism. The internal percentage is what we tick off in the
// WBS. The BAST percentage is what the client signed. On the development database the gap is real:
// the internal figure is available (cost is booked, progress is ticked) while
// `acceptance_register` holds ZERO rows — so the honest POC answer today is 0% recognized,
// and a screen that quietly fell back to the internal percentage would report revenue the client
// has not accepted. `test/revenue.test.js` builds a fixture where the two deliberately differ and
// asserts the POC figure follows BAST — if they were equal the test would prove nothing.
//
// THREE STATES ARE NOT THE SAME, and the schema provides all three:
//   * `revenue_method` NULL       → nothing is configured, so nothing is recognized. The screen
//                                   says so rather than defaulting to a method. MEASURED: this is
//                                   the state the live project is in, so it is the FIRST state a
//                                   real user meets.
//   * a method set, but no basis  → the method is configured and has nothing to work from (no
//                                   approved certificate, no baseline, no contract window). 0
//                                   recognized, with the reason stated.
//   * a method set and a basis    → recognize.
//
// CUMULATIVE FIRST, PERIOD SECOND. Every method computes the CUMULATIVE figure to date (basis %
// × contract), and the period amount is `cumulative(this month) - cumulative(recognized through
// the previous month)`. Two consequences, both deliberate:
//   * a quiet month carries the cumulative figure forward instead of breaking the series, the same
//     way migration 019's `*_cum` columns do;
//   * if the basis FALLS (a certificate rejected after the fact), the period amount goes NEGATIVE
//     — a reversal. That is real accounting, so it is allowed rather than clamped away.
//
// RECOGNITION POSTS NO LEDGER LINE. Revenue recognition is not a cash movement: PRD §5.3's
// invariant 10 is that `billed ≠ recognized ≠ received`, three separate figures for one period.
// So nothing here writes to `accounting_ledger` — and RV8.7 asserts the ledger is untouched.

'use strict';

const db = require('../db/db');
const q = require('../db/queries');
const cbs = require('./cbs-service');

const METHODS = ['milestone', 'poc', 'time_based', 'on_billing'];

// What each method means, in the words the screen shows. Kept next to the code so the page's
// explanation and the arithmetic cannot drift apart.
const METHOD_LABELS = {
  milestone: {
    name: 'Milestone (approved certificate)',
    basis: 'the percentage on ACCEPTED BAST certificates',
    note: 'Revenue is recognised when a certificate is approved — not when it is submitted.',
  },
  poc: {
    name: 'Percentage of completion (BAST)',
    basis: 'the client-accepted (BAST) percentage',
    note: 'Follows the CLIENT\u2019s acceptance, never our internal progress ticks.',
  },
  time_based: {
    name: 'Time-based (straight line)',
    basis: 'the share of the contract window elapsed',
    note: 'Spreads the contract evenly from the start date to the end date.',
  },
  on_billing: {
    name: 'On billing (as invoiced)',
    basis: 'what has actually been invoiced',
    note: 'Recognises exactly what has been billed, nothing more.',
  },
};

class RevenueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RevenueError';
    this.status = status;
  }
}

const monthOf = (v) => (v == null ? null : String(v).slice(0, 7));
const isValidMonth = (m) => /^\d{4}-\d{2}$/.test(String(m || ''));

function project(projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!p) throw new RevenueError('That project does not exist.', 404);
  return p;
}

// ---- the basis for each method ------------------------------------------------------------

// The INTERNAL percentage earned to date: cumulative EV over the whole approved budget (BAC).
//
// NOT re-derived here. `v_evm_period.ev_cum` is the view's own cumulative earned value — the same
// figure SPI and CPI are built on — and re-implementing the SUM(wbs_progress × budget) arithmetic
// in this file would create a second implementation that could drift from the view with nothing to
// catch it. The house rule for this module is to read the figure where it is produced.
//
// Carrying forward is CORRECT here, unlike the 8.4/8.7 trap: this figure answers "earned to date
// as at month M", and a quiet month genuinely has the previous total. (The trap those parts hit was
// asking "when was the last MEASUREMENT", which carrying forward answers wrongly.)
function internalPct(projectId, month) {
  const bac = cbs.baselineTotal(projectId) || 0;
  if (!bac) return { pct: null, reason: 'There is no approved cost baseline, so no internal percentage can be computed.', bac: 0 };
  const row = db.prepare(`SELECT ev_cum FROM v_evm_period
      WHERE project_id = ? AND period_month <= ? ORDER BY period_month DESC LIMIT 1`)
    .get(projectId, month);
  const evCum = row ? Number(row.ev_cum) || 0 : 0;
  return { pct: Math.min(100, Math.round((evCum / bac) * 10000) / 100), evCum, bac };
}

// The CLIENT-accepted percentage: the sum of ACCEPTED certificates' own percentages, as at `month`.
//
// `status = 'accepted'` is the test, not "a certificate exists" — a submitted or draft certificate
// is not acceptance, and PRD §5.3 says the milestone method recognizes on an APPROVED certificate.
//
// A certificate with no `accepted_date` is included once it is accepted: the status is the fact,
// the date is only used to place it in a month. Excluding undated acceptances would silently drop
// real revenue, which is the worse error.
function bastPct(projectId, month) {
  const row = db.prepare(`SELECT COALESCE(SUM(percentage_progress), 0) AS pct, COUNT(*) AS n
      FROM acceptance_register
      WHERE project_id = ? AND status = 'accepted'
        AND (accepted_date IS NULL OR accepted_date = '' OR substr(accepted_date, 1, 7) <= ?)`)
    .get(projectId, month);
  const raw = Number(row.pct) || 0;
  // A percentage above 100 cannot be recognized as more than the contract, so it is capped — and
  // the cap is REPORTED rather than applied silently, because it means the register holds
  // overlapping certificates and a human needs to look.
  const capped = raw > 100;
  return {
    pct: capped ? 100 : Math.round(raw * 100) / 100,
    rawPct: raw,
    certificates: row.n,
    capped,
    // The internal figure, carried alongside ONLY so the screen can show the gap between them.
    // It is never used as the basis for this method.
    internalForComparison: null,
  };
}

// Straight line over the contract window, inclusive of both end months.
function timeBasedPct(p, month) {
  const start = monthOf(p.start_date);
  const end = monthOf(p.end_date);
  if (!start || !end) {
    return { pct: null, reason: 'This project has no contract start and end date, so a straight-line percentage cannot be computed.' };
  }
  const toIndex = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return y * 12 + (mo - 1);
  };
  const i0 = toIndex(start);
  const i1 = toIndex(end);
  const iM = toIndex(month);
  const totalMonths = i1 - i0 + 1;
  if (totalMonths <= 0) {
    return { pct: null, reason: 'The contract end date is before its start date.', start, end };
  }
  const elapsed = Math.max(0, Math.min(totalMonths, iM - i0 + 1));
  return {
    pct: Math.round((elapsed / totalMonths) * 10000) / 100,
    elapsed, totalMonths, start, end,
    // Stated on the screen: nothing is recognized before the window opens, and the whole contract
    // is recognized once it closes.
    beforeStart: iM < i0,
    afterEnd: iM > i1,
  };
}

// What has actually been INVOICED, cumulative, as at `month`. Read from the receivable register
// (the same source the aging screen uses) so the figure on this page and the figure on that one
// cannot disagree about what was billed.
function billedTo(projectId, month) {
  const row = db.prepare(`SELECT COALESCE(SUM(billed_amount), 0) AS s
      FROM v_receivable WHERE project_id = ? AND period_month <= ?`).get(projectId, month);
  return Number(row.s) || 0;
}

// What has actually been RECEIVED, cumulative, as at `month` (invariant 10's third figure).
function receivedTo(projectId, month) {
  const row = db.prepare(`SELECT COALESCE(SUM(paid_amount), 0) AS s
      FROM v_receivable WHERE project_id = ? AND period_month <= ?`).get(projectId, month);
  return Number(row.s) || 0;
}

// ---- the method dispatch ------------------------------------------------------------------

/**
 * The cumulative target for a month: the percentage in force, and the rupiah it implies.
 * Returns { pct, amount, detail, blocked? } — `pct: null` with a `reason` means the method is
 * configured but has nothing to work from, which the screen renders as a stated empty state.
 */
function target(projectId, method, month) {
  const p = project(projectId);
  const contract = Number(p.contract_amount) || 0;
  if (!contract) {
    return { pct: null, amount: null, reason: 'This project has no contract value, so there is nothing to recognise against.' };
  }

  switch (method) {
    case 'poc': {
      const b = bastPct(projectId, month);
      const internal = internalPct(projectId, month);
      b.internalForComparison = internal.pct;
      if (!b.certificates) {
        return {
          pct: 0, amount: 0, detail: b,
          reason: 'No BAST certificate has been accepted yet, so the client has accepted 0% and '
            + 'nothing is recognised under this method.',
        };
      }
      return { pct: b.pct, amount: Math.round((b.pct / 100) * contract), detail: b };
    }

    case 'milestone': {
      // The same acceptance register, but the method's meaning is the step function: revenue
      // arrives when a certificate is APPROVED. Both use `status = 'accepted'`, which is why they
      // share `bastPct` rather than each reading the register their own way.
      const b = bastPct(projectId, month);
      if (!b.certificates) {
        return {
          pct: 0, amount: 0, detail: b,
          reason: 'No certificate has been approved yet. A submitted certificate does not count — '
            + 'revenue is recognised on approval.',
        };
      }
      return { pct: b.pct, amount: Math.round((b.pct / 100) * contract), detail: b };
    }

    case 'time_based': {
      const t = timeBasedPct(p, month);
      if (t.pct === null) return { pct: null, amount: null, reason: t.reason, detail: t };
      return {
        pct: t.pct, amount: Math.round((t.pct / 100) * contract), detail: t,
        reason: t.beforeStart ? 'The contract window has not started yet, so 0% is recognised.'
          : null,
      };
    }

    case 'on_billing': {
      const billed = billedTo(projectId, month);
      const pct = contract ? Math.round((billed / contract) * 10000) / 100 : 0;
      return {
        pct, amount: billed, detail: { billed, pct, contract },
        reason: billed ? null : 'Nothing has been invoiced yet, so nothing is recognised under this method.',
      };
    }

    default:
      throw new RevenueError(`"${method}" is not one of the four revenue methods.`, 400);
  }
}

// ---- the register -------------------------------------------------------------------------

const rowsFor = (projectId) => db.prepare(`SELECT * FROM revenue_recognized
    WHERE project_id = ? ORDER BY period_month`).all(projectId);

/**
 * The recognition register for a project, with the three figures invariant 10 keeps apart:
 * billed, recognised and received — for each month, cumulative.
 */
function register(projectId) {
  const p = project(projectId);
  const rows = rowsFor(p.id).map((r) => ({
    ...r,
    billedTo: billedTo(p.id, r.period_month),
    receivedTo: receivedTo(p.id, r.period_month),
  }));
  const contract = Number(p.contract_amount) || 0;
  const last = rows[rows.length - 1];
  return {
    project: p,
    method: p.revenue_method,
    methodLabel: p.revenue_method ? METHOD_LABELS[p.revenue_method] : null,
    rows,
    contract,
    // Headline figures, cumulative to the last month recognised.
    recognizedTo: last ? Number(last.cumulative) || 0 : 0,
    billedTo: last ? last.billedTo : 0,
    receivedTo: last ? last.receivedTo : 0,
    pctRecognized: contract && last ? Math.round(((Number(last.cumulative) || 0) / contract) * 10000) / 100 : 0,
  };
}

/**
 * What was recognised as at the month BEFORE `month` — the running total to subtract from this
 * month's cumulative target.
 *
 * THE LATEST ROW'S CUMULATIVE, NOT THE SUM OF THE COLUMN. This was wrong in the first draft and a
 * test caught it: summing `cumulative` double-counts, because each row already carries the running
 * total. On a straight-line project it produced Jan 1,000,000 / Feb 1,000,000 / **Mar 0** (prior
 * summed to 3,000,000 against March's own cumulative of 3,000,000) and then went negative. The
 * correct figure is the cumulative of the most recent row before this month — the position we are
 * moving from — and 0 when there is none.
 */
function priorCumulative(projectId, month) {
  const row = db.prepare(`SELECT cumulative FROM revenue_recognized
      WHERE project_id = ? AND period_month < ?
      ORDER BY period_month DESC LIMIT 1`).get(projectId, month);
  return row ? Number(row.cumulative) || 0 : 0;
}

/**
 * What each method WOULD recognize for a month, without writing anything. Shown on the screen so
 * the reader can see the four answers side by side and understand why the configured one is the
 * one in force — and so the difference between POC and the internal percentage is visible rather
 * than asserted.
 */
function preview(projectId, month) {
  const p = project(projectId);
  const monthIn = isValidMonth(month) ? month : null;
  const before = monthIn ? priorCumulative(p.id, monthIn) : 0;

  const out = {};
  for (const m of METHODS) {
    const t = target(p.id, m, monthIn || monthOf(new Date().toISOString()));
    out[m] = {
      method: m,
      label: METHOD_LABELS[m],
      pct: t.pct,
      cumulativeAmount: t.amount,
      // The delta this method would post for the month, given what is already recognised.
      periodAmount: t.amount === null ? null : t.amount - Number(before),
      reason: t.reason || null,
      detail: t.detail,
    };
  }
  return {
    project: p, month: monthIn, methods: out,
    configured: p.revenue_method,
    internalPct: internalPct(p.id, monthIn || monthOf(new Date().toISOString())).pct,
  };
}

/**
 * Recognize one month.
 *
 * `revenue_recognized` has UNIQUE (project_id, period_month), so a second recognition for the same
 * month is either an UPSERT or a REFUSAL. The plan requires the choice to be deliberate and
 * recorded, not a raw SQL constraint error shown to a user. THE CHOICE: **upsert**, because a
 * corrected certificate or a late-approved one must be able to change a month that has already
 * been recognized — and a refusal would leave the register permanently wrong with no way to fix it
 * short of a manual DB edit. The upsert is audited with the before and after, so nothing changes
 * silently.
 */
function recognize({ projectId, month, actorId }) {
  const p = project(projectId);
  if (!isValidMonth(month)) throw new RevenueError('A recognition period is required, as YYYY-MM.', 400);

  const method = p.revenue_method;
  if (!method) {
    // The measured first state. No default: guessing which method a project uses would post
    // revenue under a rule nobody chose.
    throw new RevenueError('This project has no revenue method configured, so nothing can be recognised. Set one first.', 400);
  }

  // A frozen month must not change. Same rule progress reporting follows (MP7.7): once a period is
  // closed, the figures in it are what was reported.
  //
  // Read from `frozen_periods`, which is PER PROJECT and keyed (project_id, period_month) — there
  // is no `periods` table in this schema. And no trigger enforces it on `revenue_recognized`
  // (migration 011's triggers cover `accounting_ledger` and `lpb_statements` only), so this check
  // is the only thing standing between a closed month and a rewritten revenue figure.
  const frozen = db.prepare('SELECT * FROM frozen_periods WHERE project_id = ? AND period_month = ?')
    .get(p.id, month);
  if (frozen) {
    throw new RevenueError(`${month} is closed, so its revenue cannot be changed.`, 400);
  }

  const t = target(p.id, method, month);
  if (t.pct === null) {
    throw new RevenueError(t.reason || 'This month cannot be recognised under the configured method.', 400);
  }

  // The running total we are moving from — the LATEST prior row's cumulative, never the sum of
  // the column. See `priorCumulative` for why summing it is wrong.
  const prior = priorCumulative(p.id, month);
  const cumulative = t.amount;
  const amount = cumulative - prior;

  const existing = db.prepare('SELECT * FROM revenue_recognized WHERE project_id = ? AND period_month = ?')
    .get(p.id, month);

  // The certificate that carried the basis, when the method used the register — so the row points
  // at the evidence, not just the number.
  const acceptanceId = (method === 'poc' || method === 'milestone')
    ? (db.prepare(`SELECT id FROM acceptance_register WHERE project_id = ? AND status = 'accepted'
        ORDER BY COALESCE(accepted_date, '') DESC, id DESC LIMIT 1`).get(p.id) || {}).id || null
    : null;

  if (existing) {
    db.prepare(`UPDATE revenue_recognized SET method = ?, basis_pct = ?, amount = ?,
        cumulative = ?, acceptance_id = ?, note = ?, created_by = ? WHERE id = ?`)
      .run(method, t.pct, amount, cumulative, acceptanceId, t.reason || null, actorId, existing.id);
  } else {
    db.prepare(`INSERT INTO revenue_recognized (project_id, period_month, method, basis_pct,
        amount, cumulative, acceptance_id, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.id, month, method, t.pct, amount, cumulative, acceptanceId, t.reason || null, actorId);
  }

  q.audit('revenue_recognized', p.id, existing ? 'update' : 'create', actorId,
    existing ? { period_month: month, amount: existing.amount, cumulative: existing.cumulative, basis_pct: existing.basis_pct } : null,
    { period_month: month, method, basis_pct: t.pct, amount, cumulative, acceptance_id: acceptanceId });

  return {
    month, method, basisPct: t.pct, amount, cumulative,
    updated: !!existing, reason: t.reason || null, detail: t.detail,
  };
}

/** Configure which method a project recognizes revenue under. Audited — this is a policy change. */
function setMethod({ projectId, method, actorId }) {
  const p = project(projectId);
  if (!METHODS.includes(method)) {
    throw new RevenueError(`"${method}" is not one of the four revenue methods.`, 400);
  }
  const before = p.revenue_method;
  if (before === method) return { changed: false, method };
  db.prepare('UPDATE projects SET revenue_method = ? WHERE id = ?').run(method, p.id);
  q.audit('projects', p.id, 'update', actorId,
    { revenue_method: before }, { revenue_method: method });
  return { changed: true, from: before, method };
}

module.exports = {
  RevenueError, METHODS, METHOD_LABELS,
  register, preview, recognize, setMethod,
  target, internalPct, bastPct, timeBasedPct, billedTo, receivedTo, priorCumulative,
};
