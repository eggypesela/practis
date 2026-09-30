// Ledger correction service — the immutable-ledger correction path.
//
// A posted line can never be edited or deleted (the ledger's own triggers abort
// both). The book-keeping way to fix one is a REVERSING entry that negates it,
// optionally followed by a CORRECTING entry that carries the right values.
//
// This module builds those two rows and is the only place that may set
// reverses_ledger_id. The DB enforces the same rules independently:
//   trg_ledger_reversal_link_immutable  the link never moves once set
//   trg_ledger_reversal_must_negate     a reversal must actually negate
//   idx_ledger_one_reversal             a line is reversed at most once
//
// A reversal copies the original's classification (type, line_role,
// in_cost_basis, cost basis tags, project, currency) and swaps the sides, so the
// pair nets to zero in every view and the audit trail reads as one story.

'use strict';

const db = require('../db/db');

// Reverse one side of a line: debit 5,000,000 becomes credit 5,000,000.
function buildReversal(original, { date, description, actorId }) {
  if (!original) throw new Error('original line not found');
  if (original.amount === 0) throw new Error('a zero line needs no reversal');

  return {
    project_id: original.project_id,
    transaction_id: null,
    document_no: original.document_no,
    reference_no: original.reference_no,
    account_code: original.account_code,
    partner_type: original.partner_type,
    partner_id: original.partner_id,
    date: date || new Date().toISOString().slice(0, 10),
    effective_date: null,
    type: original.type,
    line_role: original.line_role,
    in_cost_basis: original.in_cost_basis,
    // Tags are carried over so the reversal lands in the same cost bucket as the
    // line it cancels — otherwise the CBS actuals would not net to zero.
    cost_category_id: original.cost_category_id,
    chart_of_account_id: original.chart_of_account_id,
    cashflow_category_id: original.cashflow_category_id,
    transaction_account_id: original.transaction_account_id,
    wbs_node_id: original.wbs_node_id,
    amount: -original.amount,
    debit: original.credit,
    credit: original.debit,
    retainage_amount: 0,
    paid_amount: 0,
    currency: original.currency,
    description: description || `Reversal of line #${original.id}`,
    source: 'manual',
    import_batch_id: null,
    cash_advance_id: null,
    // A reversal is not new outstanding work: it arrives already checked, so it
    // does not reappear in the tagging queue demanding a second decision.
    cost_checked: 1,
    cost_checked_by: actorId ?? null,
    cost_checked_at: new Date().toISOString(),
    reverses_ledger_id: original.id,
  };
}

// True when this line already has a reversal pointing at it.
function isReversed(lineId) {
  return !!db.prepare(
    `SELECT 1 FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(lineId);
}

// Everything the correction screen needs about one line.
function lineForCorrection(lineId) {
  const line = db.prepare(`
    SELECT l.*, p.name AS project_name, u.email AS created_by_email
    FROM accounting_ledger l
    LEFT JOIN projects p ON p.id = l.project_id
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = ?`).get(lineId);
  if (!line) return null;

  const reversal = db.prepare(`
    SELECT id, date, amount, description, created_at
    FROM accounting_ledger WHERE reverses_ledger_id = ?`).get(lineId);

  const reverses = line.reverses_ledger_id ? db.prepare(`
    SELECT id, date, amount, description FROM accounting_ledger WHERE id = ?`)
    .get(line.reverses_ledger_id) : null;

  return { line, reversal: reversal || null, reverses: reverses || null };
}

module.exports = { buildReversal, isReversed, lineForCorrection };
