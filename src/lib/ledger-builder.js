// Type → line_role / in_cost_basis mapping — hand-derived from the schema doc
// in 001_initial.sql (lines ~448-460). UI keeps the legacy vocabulary (Type);
// the derived fields are what the cost-basis views read.
const TYPES = {
  Income:     { line_role: 'receivable', in_cost_basis: 0, default_side: 'credit' },
  Expense:    { line_role: 'expense',    in_cost_basis: 1, default_side: 'debit' },
  Receivable: { line_role: 'receivable', in_cost_basis: 0, default_side: 'credit' },
  Payable:    { line_role: 'expense',    in_cost_basis: 1, default_side: 'debit' },
  LPB:        { line_role: 'expense',    in_cost_basis: 0, default_side: 'debit' },
  Dropping:   { line_role: 'dropping',   in_cost_basis: 0, default_side: 'debit' },
};

// A valid ledger insert per the schema + triggers:
//   * debit XOR credit (one side only, the other 0), both whole non-negative rupiah,
//     amount = debit - credit, amount ≠ 0
//   * type is from the enum (or NULL); type picks line_role + in_cost_basis
//   * source = 'manual' (import path is a separate feature)
//   * date is the posted date (today, overridable)
//   * tags are the Cost Controller's job — new manual lines start UNtagged
function buildInsert({ projectId, type, date, documentNo, description,
                       side, amount, retainageAmount, paidAmount }) {
  if (!['debit', 'credit'].includes(side)) throw new Error('side must be debit or credit');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive whole rupiah');
  const debit = side === 'debit' ? amount : 0;
  const credit = side === 'credit' ? amount : 0;
  const meta = TYPES[type] || { line_role: 'other', in_cost_basis: 0, default_side: 'debit' };
  return {
    project_id: projectId,
    transaction_id: null,
    document_no: documentNo || null,
    reference_no: null,
    account_code: null,
    partner_type: null, partner_id: null,
    date: date || new Date().toISOString().slice(0, 10),
    effective_date: null,
    type: type || null,
    line_role: meta.line_role,
    in_cost_basis: meta.in_cost_basis,
    cost_category_id: null,
    chart_of_account_id: null, cashflow_category_id: null,
    transaction_account_id: null,
    wbs_node_id: null,
    amount: debit - credit,
    debit, credit,
    retainage_amount: Number.isInteger(retainageAmount) && retainageAmount > 0 ? retainageAmount : 0,
    paid_amount: Number.isInteger(paidAmount) && paidAmount > 0 ? paidAmount : 0,
    currency: 'IDR',
    description: description || null,
    source: 'manual',
    import_batch_id: null,
    cash_advance_id: null,
    cost_checked: 0,
    cost_checked_by: null,
    cost_checked_at: null,
    reverses_ledger_id: null,   // ordinary lines reverse nothing
  };
}

module.exports = { TYPES, buildInsert };