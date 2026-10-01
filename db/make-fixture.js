#!/usr/bin/env node
// Regenerate the import fixture: `db/fixture-ledger-export.tsv`.
//
// WHY THIS FILE EXISTS
// The fixture has to look like a REAL export — tab-separated, ragged rows, Excel
// serial dates, commas inside descriptions — or it stops being a regression test
// for the defects it was written to catch (see test/fixture.test.js).
//
// Its FIRST version was the genuine article: a real Excel export from a real
// construction project, complete with real vendor names, real employee names and
// real payment amounts. That is not a fixture, that is a data leak — and it was
// committed, so it lived in git history too. This generator replaces the CONTENT
// while preserving the SHAPE, so every FX assertion keeps its meaning:
//
//   * 26 rows, 14 columns, same ragged per-row widths (trailing empty cells dropped)
//   * the same transaction groups, including the deliberately UNBALANCED single-leg
//     group that documents the unimplemented §8.4 rule
//   * Excel serial dates (45200 = 2023-10-01) on all rows, date_adjustment on 13
//   * a comma inside a description, on a row wide enough to prove commas don't split
//   * the three legacy Type values: Payable / Expense / Dropping
//
// The output is deterministic: no randomness, no clock. Regenerate with:
//   node db/make-fixture.js
// `npm run fixture` is the same thing. Re-run it after any change to the shape.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'fixture-ledger-export.tsv');

const HEADERS = ['id', 'transaction_id', 'date', 'account code', 'debit', 'credit', 'amount',
  'project_code', 'description', 'cashflow_code', 'Type', 'reference_no', 'sub_rbs_code',
  'date_adjustment'];

// Synthetic project. Kept out of seed-master.js on purpose — the fixture test seeds
// its own masters, because lookup misses are row errors by design.
const PROJECT = 'SYN-24-001';

// Synthetic chart-of-accounts codes. Shape matters: FX1.1 asserts column 3 matches
// /^\d{6,}[A-Z_]*$/, so the `_BPC` bank suffix has to stay.
const A = {
  expense: '510100001',
  vatPrepaid: '110100002',
  payable: '210100003',
  bank: '110100004_BPC',
  advance: '111700005',
  prepaidBpjs: '111300006',
  bankOps: '110100007_BPC',
  taxPayable: '210500008',
};

// Synthetic transaction accounts (column 12) and cashflow categories (column 9).
const T = { ret: 'TX01', retP: 'TX01P', ops: 'TX02', advance: 'TX03P' };
const C = { ops: 'C1', other: 'C2' };

// Descriptions mimic the real vocabulary (Indonesian construction site paperwork)
// with invented parties. Several carry a COMMA — that is the FX1.2 trap, and it must
// land on a wide row so "commas don't split" is actually exercised.
const D = {
  vendor1: 'PT SUMBER MATERIAL - INV 030(2024)',
  travelA: 'Perjalanan dinas: Petugas A, Site Utama 02 sd 05 Okt 2024',
  travelB: 'Perjalanan dinas: Petugas B, Site Utama 02 sd 05 Okt 2024',
  travelC: 'Perjalanan dinas: Petugas C, Site Utama 02 sd 05 Okt 2024',
  travelD: 'Perjalanan dinas: Petugas D, Site Utama 11 sd 15 Okt 2024',
  travelE: 'Perjalanan dinas: Petugas B, Site Utama 6 sd 8 Okt 2024',
  dropping: 'Dropping dana operasional bulan Okt 2024 - Site Utama',
  bpjs: 'BPJS Ketenagakerjaan Site Utama Okt 2024',
  vendor2: 'PT SUMBER MATERIAL - INV 031(2024)',
  tickets: 'PT SUMBER MATERIAL - INV 030(2024) - PEMBELIAN TIKET PER Periode (25 SEP - 1 OKT 2024)',
  tax: 'PPh PT SUMBER MATERIAL - INV 030(2024)',
  salary: 'Gaji Bulan Okt 2024 - STAF LAPANGAN SITE UTAMA',
};

// [id, transaction_id, excelSerial, account, debit, credit, description,
//  cashflow, Type, reference_no, sub_rbs_code, date_adjustment]
//
// `amount` (debit - credit) and `project_code` are NOT written here — they are
// spliced in by fullRow() below. The real export carries both, and duplicating
// `amount` by hand in 26 rows is how a fixture silently drifts from the invariant
// §8.4 asserts (amount = debit - credit, one side only).
//
// Trailing '' entries are dropped on write, which is what makes the rows ragged.
const ROWS = [
  // A vendor invoice: expense + recoverable VAT, settled against payables.
  [1801, '2024010110', 45200, A.expense, 18000000, 0, D.vendor1, '', 'Payable', '030(2024)', T.retP, 45214],
  [1802, '2024010110', 45200, A.vatPrepaid, 55000, 0, D.vendor1],
  [1803, '2024010110', 45200, A.payable, 0, 18055000, D.vendor1],

  // Site travel, three separate claim documents, each a cost + bank pair.
  [1804, 'SAL-24-10-0004', 45202, A.expense, 1250000, 0, D.travelA, '', 'Expense', '', T.ret, 45214],
  [1805, 'SAL-24-10-0004', 45202, A.bank, 0, 1250000, D.travelA, C.ops],
  [1806, 'SAL-24-10-0005', 45202, A.expense, 1250000, 0, D.travelB, '', 'Expense', '', T.ret, 45214],
  [1807, 'SAL-24-10-0005', 45202, A.bank, 0, 1250000, D.travelB, C.ops],
  [1808, 'SAL-24-10-0006', 45202, A.expense, 2750000, 0, D.travelC, '', 'Expense', '', T.ret, 45214],
  [1809, 'SAL-24-10-0006', 45202, A.bank, 0, 2750000, D.travelC, C.ops],
  [1810, 'SAL-24-10-0017', 45211, A.expense, 1800000, 0, D.travelD, '', 'Expense', '', T.ret, 45214],
  [1811, 'SAL-24-10-0017', 45211, A.bank, 0, 1800000, D.travelD, C.ops],

  // A cash advance (legacy "Dropping"): NOT cost basis, so in_cost_basis 0.
  [1812, 'ADV-24-10-0025', 45212, A.advance, 64000000, 0, D.dropping],
  [1813, 'ADV-24-10-0025', 45212, A.bank, 0, 64000000, D.dropping, C.other, 'Dropping',
    'REF/1000/ME/SYN/10/24', T.advance, 45214],

  // Employer contributions — a non-trade counterparty, same shape as above.
  [1814, 'BPJ-24-10-0002', 45212, A.prepaidBpjs, 2450000, 0, D.bpjs, '', 'Expense', '', T.ops, 45214],
  [1815, 'BPJ-24-10-0002', 45212, A.bankOps, 0, 2450000, D.bpjs, C.other],

  [1816, 'SAL-24-10-0032', 45217, A.expense, 950000, 0, D.travelE, '', 'Expense', '', T.ret, 45214],
  [1817, 'SAL-24-10-0032', 45217, A.bank, 0, 950000, D.travelE, C.ops],

  // A second vendor invoice, same shape as the first, different period.
  [1818, '2024010118', 45219, A.expense, 1600000, 0, D.vendor2, '', 'Payable', '031(2024)', T.retP, 45214],
  [1819, '2024010118', 45219, A.vatPrepaid, 4000, 0, D.vendor2],
  [1820, '2024010118', 45219, A.payable, 0, 1604000, D.vendor2],

  // The first vendor again, this time split across four legs (cost, VAT, withholding, bank).
  [1821, 'SAL-24-10-0037', 45223, A.payable, 18000000, 0, D.tickets, '', 'Expense', '030(2024)', T.ret, 45214],
  [1822, 'SAL-24-10-0037', 45223, A.payable, 55000, 0, D.tax],
  [1823, 'SAL-24-10-0037', 45223, A.taxPayable, 0, 15000, D.tax, '', 'Payable', '030(2024)', T.retP, 45214],
  [1824, 'SAL-24-10-0037', 45223, A.bank, 0, 55000, D.tax, C.other],
  [1825, 'SAL-24-10-0037', 45223, A.bank, 0, 17985000, D.tickets, C.other, 'Payable', '030(2024)', T.retP, 45214],

  // DELIBERATELY UNBALANCED: a lone payroll debit with no credit leg. Kept because it
  // is the worked example of §8.4 ("every imported group balances or is quarantined")
  // being unimplemented — the importer accepts it without comment. Do not "fix" the
  // fixture: the gap is real and this row is its regression evidence.
  [1826, 'SAL-24-10-0038', 45224, A.prepaidBpjs, 14200000, 0, D.salary, '', 'Expense', '', T.ops, 45214],
];

// Splice the two derived columns into their real positions, so the writer can never
// disagree with the ledger invariant: amount = debit - credit (credits negative),
// and every row carries the project code.
function fullRow(r) {
  const [id, tx, serial, account, debit, credit, ...rest] = r;
  const amount = debit - credit;
  if (debit !== 0 && credit !== 0) throw new Error(`row ${id}: one side only`);
  return [id, tx, serial, account, debit, credit, amount, PROJECT, ...rest];
}

const cells = (r) => {
  const out = r.map((v) => String(v ?? ''));
  while (out.length && out[out.length - 1] === '') out.pop();  // trailing empties dropped
  return out;
};

const body = ROWS.map((r) => cells(fullRow(r)).join('\t'));

const text = [HEADERS.join('\t'), ...body].join('\n') + '\n';

// Sanity: never emit fewer than 5 cells (FX1.1's lower bound).
body.forEach((line, i) => {
  const n = line.split('\t').length;
  if (n < 5 || n > 14) throw new Error(`row ${i + 1} has ${n} cells; expected 5..14`);
});

fs.writeFileSync(OUT, text, 'utf8');
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${ROWS.length} rows, `
  + `${HEADERS.length} columns, ${Buffer.byteLength(text)} bytes`);
