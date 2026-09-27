// Adds a handful of demo ledger lines for project PRJ-2026 so the ledger screen
// shows real data. Respects the DB triggers: whole-rupiah integers, ONE side
// only (debit XOR credit), amount = debit - credit, never 0.
// Usage: node src/db/seed-demo.js
const db = require('./db');

const LINES = [
  // [date, doc_no, description, type, line_role, debit, credit, wbs?, cbs?]
  ['2026-03-20', 'CASHIN-0114', 'Client progress payment — milestone 4', 'Income', 'receivable', 0, 300_000_000],
  ['2026-03-18', 'INV-0224', 'Progress billing invoice — milestone 4', 'Receivable', 'receivable', 0, 400_000_000],
  ['2026-03-15', 'PO-0897', 'Cement supply — 400 bags', 'Payable', 'payable', 90_000_000, 0],
  ['2026-03-14', 'SAL-0012', 'Site payroll — March week 2', 'Expense', 'expense', 85_000_000, 0],
  ['2026-03-12', 'RET-0044', 'Retainage 10% — milestone 4', 'Receivable', 'receivable', 0, 40_000_000],
  ['2026-03-10', 'CASHOUT-0208', 'Payment run — PO-0897 partial', 'Dropping', 'funding', 30_000_000, 0],
];

function main() {
  const project = db.prepare('SELECT id FROM projects WHERE code = ?').get('PRJ-2026');
  if (!project) { console.error('project PRJ-2026 missing — run seed.js first'); process.exit(1); }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM accounting_ledger WHERE project_id = ?').get(project.id).n;
  if (existing > 0) {
    console.log(`${existing} ledger lines already present, skipping`);
    db.close();
    return;
  }

  const ins = db.prepare(`
    INSERT INTO accounting_ledger
      (project_id, date, document_no, description, type, line_role, in_cost_basis,
       debit, credit, amount, source, cost_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0)`);

  const tx = db.transaction((rows) => {
    for (const [date, doc, desc, type, role, debit, credit] of rows) {
      const inCost = (role === 'expense' || role === 'payable') ? 1 : 0;
      ins.run(project.id, date, doc, desc, type, role, inCost, debit, credit, debit - credit);
    }
  });
  tx(LINES);
  console.log(`inserted ${LINES.length} demo ledger lines for PRJ-2026`);
  db.close();
}

if (require.main === module) main();