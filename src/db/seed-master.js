// Master data needed by the tagging queue: cost categories, CBS transaction
// accounts, and the project WBS tree. Idempotent (INSERT OR IGNORE on unique codes).
// Usage: node src/db/seed-master.js
const db = require('./db');
const { MILESTONES } = require('../lib/wbs-defaults');

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

// ===========================================================================
// RBS — A STARTING PROPOSAL, NOT A COMPANY STANDARD (plan task 6.6, decision 6B)
//
// The PRD contains NO company resource standard. Decision 6B says "I propose, the
// owner edits". So this list is deliberately marked as a proposal everywhere it is
// read, and every code below is a plain abbreviation of its own name — none of them
// is dressed up to look like an established standard code, because a resource list
// that is SILENTLY wrong is worse than an empty one: it gets used, and then the
// cost breakdown is wrong in a way nobody questions.
//
// The owner edits this list in Setup → Master data → Resource categories / RBS codes.
// ===========================================================================
const RESOURCE_CATEGORIES = [
  ['LAB', 'Labour'],
  ['PLT', 'Plant & equipment'],
  ['MAT', 'Materials'],
  ['SUB', 'Subcontract'],
  ['OVH', 'Overhead'],
];

// [code, name, resource category code]
const RBS_CODES = [
  // Labour — by trade
  ['L-SIT', 'Site labourer', 'LAB'],
  ['L-CAR', 'Carpenter', 'LAB'],
  ['L-STL', 'Steel fixer', 'LAB'],
  ['L-CON', 'Concreter', 'LAB'],
  ['L-OPE', 'Plant operator', 'LAB'],
  ['L-SUP', 'Supervisor', 'LAB'],
  // Plant & equipment — by type
  ['P-EXC', 'Excavator', 'PLT'],
  ['P-DZR', 'Dozer', 'PLT'],
  ['P-CRN', 'Crane', 'PLT'],
  ['P-MIX', 'Concrete mixer', 'PLT'],
  ['P-GEN', 'Generator', 'PLT'],
  ['P-TRK', 'Truck', 'PLT'],
  // Materials
  ['M-AGG', 'Aggregate', 'MAT'],
  ['M-CEM', 'Cement', 'MAT'],
  ['M-STL', 'Reinforcement steel', 'MAT'],
  ['M-FRM', 'Formwork', 'MAT'],
  ['M-PIP', 'Pipework', 'MAT'],
  // Subcontract
  ['S-EAR', 'Earthworks subcontractor', 'SUB'],
  ['S-PIL', 'Piling subcontractor', 'SUB'],
  ['S-ELC', 'Electrical subcontractor', 'SUB'],
  ['S-MEC', 'Mechanical subcontractor', 'SUB'],
  // Overhead
  ['O-SIT', 'Site overhead', 'OVH'],
  ['O-TMP', 'Temporary facilities', 'OVH'],
  ['O-SAF', 'Safety & PPE', 'OVH'],
];

// Industry / project types — the two lists that were EMPTY, which is why the
// client form said "optional — set up by an Administrator" and had nothing to
// offer. Standard sector names a building contractor actually uses.
const INDUSTRY_TYPES = [
  ['Government / public works', 'Ministries, agencies and state-owned clients.'],
  ['Private developer', 'Property and commercial developers.'],
  ['Oil & gas', 'Upstream and downstream operators and their contractors.'],
  ['Mining', 'Mining operators and their site works.'],
  ['Manufacturing', 'Factories, plants and industrial facilities.'],
  ['Utilities / power', 'Power, water and transmission works.'],
  ['Transport / infrastructure', 'Roads, bridges, ports and rail.'],
];

const PROJECT_TYPES = [
  ['Civil works', 'Earthworks, roads, drainage and site infrastructure.'],
  ['Structural', 'Foundations, frames and load-bearing structures.'],
  ['Buildings', 'Industrial, commercial and institutional buildings.'],
  ['Mechanical & electrical', 'Plant installation, piping, electrical and controls.'],
  ['Marine', 'Jetties, revetments and nearshore works.'],
  ['Maintenance / services', 'Ongoing maintenance and service contracts.'],
];

// The bundled default WBS tree lives above as `WBS` (parents before children).
// The WBS TREE for a project is built from the `wbs_code` MASTER menu, not from
// this list — see src/lib/wbs-defaults.js. This one is only used to build the
// master menu and the demo project below.

function main() {
  // The DEMO project is OPTIONAL. It used to be a hard requirement — the script
  // exited if `PRJ-2026` was missing — which meant that on a real install (whose
  // project is not a demo one) NONE of the master data was seeded at all, including
  // the lists that have nothing to do with a project. Master data is company-wide;
  // only the demo project's WBS tree and milestones are project-specific.
  const project = db.prepare('SELECT id FROM projects WHERE code = ?').get('PRJ-2026');
  if (!project) {
    console.log('note: demo project PRJ-2026 not present — seeding company-wide master data only');
  }

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

  // The demo project's own WBS tree and milestones are the ONLY project-scoped
  // parts of this script — everything above is company-wide.
  if (project) {
    const insWbs = db.prepare(`
      INSERT OR IGNORE INTO wbs_nodes (project_id, wbs_code, name, parent_id, is_control_account, sort_order)
      VALUES (?, ?, ?, (SELECT id FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?), ?, ?)`);
    let order = 0;
    for (const [parent, code, name, ctrl] of WBS) {
      insWbs.run(project.id, code, name, project.id, parent, ctrl, order);
      order += 10;
    }
  }

  // Resource categories, then RBS codes (the RBS links by category code).
  const insResCat = db.prepare('INSERT OR IGNORE INTO resource_categories (code, name) VALUES (?, ?)');
  for (const [code, name] of RESOURCE_CATEGORIES) insResCat.run(code, name);

  const insRbs = db.prepare(`INSERT OR IGNORE INTO rbs_code (code, name, resource_category_id)
    VALUES (?, ?, (SELECT id FROM resource_categories WHERE code = ?))`);
  for (const [code, name, cat] of RBS_CODES) insRbs.run(code, name, cat);

  // Industry and project types — were EMPTY, so the client and project forms had
  // nothing to offer and silently relied on "optional".
  const insIndustry = db.prepare('INSERT OR IGNORE INTO industry_types (name, description) VALUES (?, ?)');
  for (const [name, desc] of INDUSTRY_TYPES) insIndustry.run(name, desc);
  const insPtype = db.prepare('INSERT OR IGNORE INTO project_types (name, description) VALUES (?, ?)');
  for (const [name, desc] of PROJECT_TYPES) insPtype.run(name, desc);

  // Default milestones on the demo project's WBS lines (PRD §5.1, decision 7A:
  // equal 25% weights). New projects get the same set at registration
  // (src/lib/wbs-defaults.js); this covers the seeded project only.
  if (project) {
    const insMilestone = db.prepare(`
      INSERT OR IGNORE INTO progress_milestones (wbs_node_id, seq, name, pct_weight)
      SELECT id, ?, ?, ? FROM wbs_nodes WHERE project_id = ? AND wbs_code = ?`);
    for (const m of MILESTONES) {
      for (const row of WBS) insMilestone.run(m.seq, m.name, m.pct_weight, project.id, row[1]);
    }
  }

  const counts = {
    cost_categories: db.prepare('SELECT COUNT(*) n FROM cost_categories').get().n,
    chart_of_accounts: db.prepare('SELECT COUNT(*) n FROM chart_of_accounts').get().n,
    cashflow_categories: db.prepare('SELECT COUNT(*) n FROM cashflow_categories').get().n,
    transaction_accounts: db.prepare('SELECT COUNT(*) n FROM transaction_accounts').get().n,
    resource_categories: db.prepare('SELECT COUNT(*) n FROM resource_categories').get().n,
    rbs_code: db.prepare('SELECT COUNT(*) n FROM rbs_code').get().n,
    industry_types: db.prepare('SELECT COUNT(*) n FROM industry_types').get().n,
    project_types: db.prepare('SELECT COUNT(*) n FROM project_types').get().n,
    progress_milestones: db.prepare('SELECT COUNT(*) n FROM progress_milestones').get().n,
    // Only meaningful when the demo project exists; 0 does not mean the WBS master
    // menu is empty, so report that separately to avoid a misleading zero.
    wbs_master_codes: db.prepare('SELECT COUNT(*) n FROM wbs_code').get().n,
    demo_project_nodes: project
      ? db.prepare('SELECT COUNT(*) n FROM wbs_nodes WHERE project_id = ?').get(project.id).n
      : null,
  };
  console.log('master data:', JSON.stringify(counts));
  db.close();
}

if (require.main === module) main();