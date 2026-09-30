// TS-04 ledger import mapper: legacy c_accounting_ledger CSV → our
// accounting_ledger rows. Pure functions, no DB side effects — the router
// persists batches; this module decides WHAT a valid row looks like.
//
// Sign convention (Decision B, user-confirmed):
//   legacy debit>0 AND credit=0 → our debit  = abs(amount)
//   legacy credit>0 AND debit=0 → our credit = abs(amount)
//   both non-zero OR both zero  → quarantine row ("check sign")
//
// Revenue type (Decision B): legacy 'Revenue' stays 'Revenue' in our enum
// (added by migration 003). line_role='receivable', in_cost_basis=0.
//
// Lookup resolution: legacy codes → our IDs via the lookup masters
// (chart_of_accounts / cashflow_categories / transaction_accounts / projects),
// all keyed by their own `code`. Unresolvable → row error, not silent skip.

'use strict';

const { toIntegerRupiah, toIsoDate } = require('./csv');

// legacy type → (our type, line_role, in_cost_basis)
const TYPE_MAP = {
  Payable:     { type: 'Payable',     line_role: 'payable',  in_cost_basis: 1 },
  Receivable:  { type: 'Receivable',  line_role: 'receivable', in_cost_basis: 0 },
  LPB:         { type: 'LPB',         line_role: 'expense',  in_cost_basis: 0 },
  Dropping:    { type: 'Dropping',    line_role: 'dropping', in_cost_basis: 0 },
  Expense:     { type: 'Expense',     line_role: 'expense',  in_cost_basis: 1 },
  Income:      { type: 'Income',      line_role: 'receivable', in_cost_basis: 0 },
  Revenue:     { type: 'Revenue',     line_role: 'receivable', in_cost_basis: 0 },
};

// Columns present in a legacy c_accounting_ledger export. Header names are
// matched case/space-insensitively; unknown columns are ignored (not an error),
// missing REQUIRED columns are a header-level error.
const REQUIRED = ['transaction_id', 'date', 'account_code', 'debit', 'credit'];
const OPTIONAL = ['project_code', 'description', 'cashflow_code', 'type',
  'reference_no', 'sub_rbs_code', 'date_adjustment', 'amount'];

// Normalize a header cell for matching.
function normHeader(h) {
  return String(h).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// Given a CSV row (array of cells) + header map {normName: index}, extract the
// raw value for a column (trimmed, '' → null).
function rawCell(row, headers, name) {
  const i = headers[normHeader(name)];
  if (i == null) return null;
  const v = row[i];
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Parse legacy amount cell → integer rupiah. `toIntegerRupiah` handles the
// Indonesian thousand/decimal separators; formula cells → null → error.
function parseAmount(raw) {
  if (raw == null) return null;
  return toIntegerRupiah(raw);
}

// Sign classifier (Decision B). Returns { debit, credit, amount } in OUR
// convention, or null when the legacy row is ambiguous (both sides non-zero, or
// both zero).
//
// amount MUST equal debit - credit — that is the ledger's own invariant
// (trg_ledger_money_integrity_insert) and what the manual entry path posts, so a
// credit line carries a NEGATIVE amount. Getting this wrong makes every credit
// row fail at confirm time, after staging already looked clean.
function classifySign(debitRaw, creditRaw) {
  const d = parseAmount(debitRaw);
  const c = parseAmount(creditRaw);
  if (d == null && c == null) return null;          // no amount at all
  const debit = d == null ? 0 : Math.abs(d);
  const credit = c == null ? 0 : Math.abs(c);
  if (debit > 0 && credit > 0) return null;          // ambiguous — quarantine
  if (debit === 0 && credit === 0) return null;      // zero row
  return {
    debit: debit > 0 ? debit : 0,
    credit: credit > 0 ? credit : 0,
    amount: debit - credit,                          // debit row → +, credit row → −
  };
}

// Map one raw CSV row → our ledger insert object, or an error descriptor.
//   lookup: { projectByCode, chartByCode, cashflowByCode, txByCode } — each a
//           function(code) → {id} | undefined, preloaded by the router.
// Returns { ok: true, row } | { ok: false, errors: [string] }.
function mapRow(row, headers, lookup) {
  const errors = [];

  const transactionId = rawCell(row, headers, 'transaction_id');
  const dateRaw = rawCell(row, headers, 'date');
  const accountCode = rawCell(row, headers, 'account_code');
  const debitRaw = rawCell(row, headers, 'debit');
  const creditRaw = rawCell(row, headers, 'credit');
  const projectCode = rawCell(row, headers, 'project_code');
  const description = rawCell(row, headers, 'description');
  const cashflowCode = rawCell(row, headers, 'cashflow_code');
  const typeRaw = rawCell(row, headers, 'type');
  const referenceNo = rawCell(row, headers, 'reference_no');
  const subRbsCode = rawCell(row, headers, 'sub_rbs_code');
  const dateAdjRaw = rawCell(row, headers, 'date_adjustment');

  if (!transactionId) errors.push('missing transaction_id');
  if (!accountCode) errors.push('missing account_code');

  const date = toIsoDate(dateRaw);
  if (!date) errors.push(`bad date '${dateRaw}'`);
  const effectiveDate = toIsoDate(dateAdjRaw) || null;

  const sign = classifySign(debitRaw, creditRaw);
  if (!sign) errors.push(`ambiguous amount (debit='${debitRaw}', credit='${creditRaw}') — check sign`);

  // project resolution
  let projectId = null;
  if (projectCode) {
    const p = lookup.projectByCode(String(projectCode).trim());
    if (p) projectId = p.id;
    else errors.push(`unknown project code '${projectCode}'`);
  }

  // COA resolution
  const coa = accountCode ? lookup.chartByCode(String(accountCode).trim()) : null;
  if (accountCode && !coa) errors.push(`unknown chart_of_accounts code '${accountCode}'`);
  const chartOfAccountId = coa ? coa.id : null;

  // cashflow resolution
  let cashflowCategoryId = null;
  if (cashflowCode) {
    const cf = lookup.cashflowByCode(String(cashflowCode).trim());
    if (cf) cashflowCategoryId = cf.id;
    else errors.push(`unknown cashflow code '${cashflowCode}'`);
  }

  // transaction account (sub_rbs) resolution
  let transactionAccountId = null;
  if (subRbsCode) {
    const ta = lookup.txByCode(String(subRbsCode).trim());
    if (ta) transactionAccountId = ta.id;
    else errors.push(`unknown transaction account '${subRbsCode}'`);
  }

  // type mapping
  let type = null, lineRole = 'other', inCostBasis = 0;
  if (typeRaw) {
    const mapped = TYPE_MAP[String(typeRaw).trim()];
    if (!mapped) errors.push(`unknown type '${typeRaw}'`);
    else { type = mapped.type; lineRole = mapped.line_role; inCostBasis = mapped.in_cost_basis; }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    row: {
      transaction_id: transactionId,
      project_id: projectId,
      document_no: transactionId,            // our dedupe/register key = legacy transaction_id
      reference_no: referenceNo,
      account_code: accountCode,
      date,
      effective_date: effectiveDate,
      type,
      line_role: lineRole,
      in_cost_basis: inCostBasis,
      cost_category_id: null,
      chart_of_account_id: chartOfAccountId,
      cashflow_category_id: cashflowCategoryId,
      transaction_account_id: transactionAccountId,
      wbs_node_id: null,
      amount: sign.amount,
      debit: sign.debit,
      credit: sign.credit,
      retainage_amount: 0,
      paid_amount: 0,
      currency: 'IDR',
      description,
      source: 'import',
      import_batch_id: null,                 // filled by the router on confirm
    },
  };
}

module.exports = { mapRow, TYPE_MAP, REQUIRED, OPTIONAL, normHeader, classifySign };
