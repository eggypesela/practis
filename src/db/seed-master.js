// Master data needed by the tagging queue: cost categories, CBS transaction
// accounts, and the project WBS tree. Idempotent (INSERT OR IGNORE on unique codes).
// Usage: node src/db/seed-master.js
const db = require('./db');

const COST_CATEGORIES = [
  ['MAT', 'Materials'], ['LAB', 'Labour'], ['EQP', 'Plant & equipment'],
  ['SUB', 'Subcontract'], ['OVH', 'Overhead'], ['TAX', 'Taxes & levies'],
];

// Chart of accounts (legacy a_chart_of_accounts). Real production codes are
// 15-char account strings; seed a representative set so import resolution has
// something to hit. Production seeding replaces this with the real export.
const CHART_OF_ACCOUNTS = [
  ['100000000000001', 'Cash & bank', '1. Assets', 'Cash', 'Debit'],
  ['110000000000001', 'Accounts receivable', '1. Assets', 'Receivables', 'Debit'],
  ['200000000000001', 'Accounts payable', '2. Liability', 'Payables', 'Credit'],
  ['400000000000001', 'Revenue - construction', '4. Income', 'Revenue', 'Credit'],
  ['500000000000001', 'Direct cost - materials', '5. Expense', 'Direct cost', 'Debit'],
  ['500000000000002', 'Direct cost - labour', '5. Expense', 'Direct cost', 'Debit'],
  ['500000000000003', 'Direct cost - equipment', '5. Expense', 'Direct cost', 'Debit'],
];

// Cashflow categories (legacy a_cashflow_categories)
const CASHFLOW_CATEGORIES = [
  ['10001', 'Cash in - client payment', '1. Operation', 'Inflow'],
  ['20001', 'Cash out - supplier payment', '1. Operation', 'Outflow'],
  ['30001', 'Cash out - labour', '1. Operation', 'Outflow'],
];

// CBS / transaction accounts (code = legacy sub_rbs_code). These are the tags the
// Cost Controller applies to ledger lines, so each one is a real cost bucket.
const CBS_ACCOUNTS = [
  ['1.1.1', 'Site setup', 'MAT', '1.1'],
  ['1.2.1', 'Temporary facilities', 'OVH', '1.2'],
  ['2.1.1', 'Excavation & earthworks', 'EQP', '2.1'],
  ['2.2.1', 'Piling & foundations', 'SUB', '2.2'],
  ['3.1.1', 'Concrete works', 'MAT', '3.1'],
  ['3.1.2', 'Reinforcement steel', 'MAT', '3.1'],
  ['3.2.1', 'Girder fabrication & erection', 'SUB', '3.2'],
  ['4.1.1', 'Direct labour', 'LAB', '4.1'],
  ['5.1.1', 'Plant & equipment hire', 'EQP', '5.1'],
  ['6.1.1', 'Site overheads', 'OVH', '6.1'],
];

// WBS tree for PRJ-2026 (parent_code, code, name, control account)
const WBS = [
  [null, '1', 'Preparatory works', 1],
  ['1', '1.1', 'Site setup', 1],
  ['1', '1.2', 'Temporary facilities', 0],
  [null, '2', 'Substructure', 1],
  ['2', '2.1', 'Excavation & earthworks', 1],
  ['2', '2.2', 'Piling & foundations', 0],
  [null, '3', 'Superstructure', 1],
  ['3', '3.1', 'Concrete works', 1],
  ['3', '3.2', 'Girder fabrication & erection', 0],
  [null, '4', 'Finishing & handover', 1],
  ['4', '4.1', 'Labour & supervision', 0],
  [null, '5', 'Plant & site services', 1],
  ['5', '5.1', 'Plant & equipment', 0],
  [null, '6', 'Project overheads', 1],
  ['6', '6.1', 'Site overheads', 0],
];

function main() {
  const project = db.prepare('SELECT id FROM projects WHERE code = ?').get('PRJ-2026');
  if (!project) { console.error('project PRJ-2026 missing — run seed.js first'); process.exit(1); }

  // cost categories
  const insCat = db.prepare('INSERT OR IGNORE INTO cost_categories (code, name) VALUES (?, ?)');
  for (const [code, name] of COST_CATEGORIES) insCat.run(code, name);

  // chart of accounts (legacy a_chart_of_accounts)
  const insCoa = db.prepare(`
    INSERT OR IGNORE INTO chart_of_accounts
      (code, name, category, subcategory, account_type, normal_side)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const [code, name, cat, sub, side] of CHART_OF_ACCOUNTS) {
    const acctType = cat.startsWith('1.') ? 'asset' : cat.startsWith('2.') ? 'liability'
      : cat.startsWith('3.') ? 'equity' : cat.startsWith('4.') ? 'income' : 'expense';
    insCoa.run(code, name, cat, sub, acctType, side.toLowerCase());
  }

  // cashflow categories (legacy a_cashflow_categories)
  const insCf = db.prepare(`
    INSERT OR IGNORE INTO cashflow_categories
      (code, name, category, inflow_outflow, direction)
    VALUES (?, ?, ?, ?, ?)`);
  for (const [code, name, cat, io] of CASHFLOW_CATEGORIES) {
    const dir = io.toLowerCase() === 'inflow' ? 'in' : 'out';
    insCf.run(code, name, cat, dir, dir);
  }

  // wbs_code master = the company-standard menu (parents before children).
  const insWbsCode = db.prepare('INSERT OR IGNORE INTO wbs_code (code, name, parent_code) VALUES (?, ?, ?)');
  for (const [parent, code, name] of WBS) insWbsCode.run(code, name, parent);

  // CBS transaction accounts (link cost category by code)
  const insAcct = db.prepare(`
    INSERT OR IGNORE INTO transaction_accounts
      (code, name, cost_category_id, default_wbs_code)
    VALUES (?, ?, (SELECT id FROM cost_categories WHERE code = ?), ?)`);
  for (const [code, name, cat, wbs] of CBS_ACCOUNTS) insAcct.run(code, name, cat, wbs);

  // WBS tree, parents first (list order guarantees it)
  const insWbs = db.prepare(`
    INSERT OR IGNORE INTO wbs_nodes (project_id, wbs_code, name, parent_id, is_control_account, sort_order)
    VALUES (?, ?, ?, (SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?), ?, ?)`);
  let order = 0;
  for (const [parent, code, name, ctrl] of WBS) {
    insWbs.run(project.id, code, name, project.id, parent, ctrl, order);
    order += 10;
  }

  const counts = {
    cost_categories: db.prepare('SELECT COUNT(*) n FROM cost_categories').get().n,
    chart_of_accounts: db.prepare('SELECT COUNT(*) n FROM chart_of_accounts').get().n,
    cashflow_categories: db.prepare('SELECT COUNT(*) n FROM cashflow_categories').get().n,
    transaction_accounts: db.prepare('SELECT COUNT(*) n FROM transaction_accounts').get().n,
    wbs_nodes: db.prepare('SELECT COUNT(*) n FROM wbs_nodes WHERE project_id = ?').get(project.id).n,
  };
  console.log('master data:', JSON.stringify(counts));
  db.close();
}

if (require.main === module) main();