// Master data — the reference lists every other screen reads (module 6, task 6.5).
//
// WHY THIS IS DATA-DRIVEN
// There are nine datasets here and they are all "a list of rows with a code and a
// name". Nine hand-written services would be nine copies of the same validation,
// and the copies would drift — exactly the failure the audit found on the checker
// path. So there is ONE registry (`DATASETS`) and ONE code path. A dataset is
// declared, not implemented.
//
// THE HONEST BOUNDARY: this is NOT a schema editor. Only the columns listed in a
// dataset's `fields` can be touched. SQL is built from the registry, never from
// request input, so a crafted form cannot reach a column (or a table) that is not
// declared here.
//
// THE TWO RULES THAT MAKE MASTER DATA DIFFERENT FROM ORDINARY CRUD
//
//   1. STRUCTURE IS ADMIN-APPROVED. PRD §8 ("Ask first") puts WBS and RBS menu
//      changes behind admin approval, so those two datasets carry a stricter
//      capability than the rest. A cost bucket can be re-pointed by Finance; the
//      shape of WBS/RBS cannot.
//
//   2. `transaction_accounts` (CBS) IS WHAT `v_cbs_actual` GROUPS BY. So nothing
//      here is ever DELETED. A delete would strip the tag from historic ledger
//      lines and silently re-bucket the cost report; renaming a code is a label
//      change only (grouping is by id, not by code), and deactivating keeps the
//      row selectable-for-reading but out of new pickers.
//      `references()` exists so the screen can SHOW the blast radius instead of
//      letting someone discover it in a report.
'use strict';

const db = require('../db/db');
const q = require('../db/queries');

// ---------------------------------------------------------------------------
// The registry.
//
// field kinds:
//   text    — free text
//   select  — one of `options` (enforced by a CHECK constraint in the schema)
//   lookup  — a value from another master table (translated for display)
//   flag    — 0/1 checkbox
// `hidden` is offered because the import resolver uses it to keep legacy codes
// out of pickers without deactivating them.
// ---------------------------------------------------------------------------

// Shared option lists, so the two screens that use them cannot disagree.
const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];
const NORMAL_SIDES = ['debit', 'credit'];
const DIRECTIONS = ['in', 'out'];

const DATASETS = {
  coa: {
    key: 'coa', table: 'chart_of_accounts',
    label: 'Chart of accounts', short: 'COA',
    purpose: 'The ledger accounts. An import line resolves to one of these.',
    keyCol: 'code', keyLabel: 'Account code',
    structure: false,
    fields: [
      { name: 'code', label: 'Account code', kind: 'text', required: true, max: 32,
        help: 'The account string the ledger export uses. Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'category', label: 'Category', kind: 'text' },
      { name: 'subcategory', label: 'Subcategory', kind: 'text' },
      { name: 'account_type', label: 'Type', kind: 'select', options: ACCOUNT_TYPES },
      { name: 'normal_side', label: 'Normal side', kind: 'select', options: NORMAL_SIDES },
      { name: 'hidden', label: 'Hidden from pickers', kind: 'flag' },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['code', 'name', 'category', 'account_type', 'normal_side', 'active'],
  },

  cashflow: {
    key: 'cashflow', table: 'cashflow_categories',
    label: 'Cashflow categories', short: 'Cashflow',
    purpose: 'How cash movements are classified on the cashflow statement.',
    keyCol: 'code', keyLabel: 'Code',
    structure: false,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'category', label: 'Category', kind: 'text' },
      // The schema carries BOTH `direction` and the legacy `inflow_outflow`, each
      // with its own CHECK. One form field writes both, so the two can never
      // disagree — a disagreement would be invisible until a report used the other.
      { name: 'direction', label: 'Direction', kind: 'select', options: DIRECTIONS,
        mirror: 'inflow_outflow' },
      { name: 'hidden', label: 'Hidden from pickers', kind: 'flag' },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['code', 'name', 'category', 'direction', 'active'],
  },

  costcat: {
    key: 'costcat', table: 'cost_categories',
    label: 'Cost categories', short: 'Cost cat.',
    purpose: 'The five behaviour flags decide how a cost is treated in every report.',
    keyCol: 'code', keyLabel: 'Code',
    structure: false,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'category', label: 'Category', kind: 'text' },
      { name: 'is_receivable', label: 'Receivable', kind: 'flag' },
      { name: 'is_payable', label: 'Payable', kind: 'flag' },
      { name: 'is_cash_in', label: 'Cash in', kind: 'flag' },
      { name: 'is_cash_out', label: 'Cash out', kind: 'flag' },
      { name: 'is_retainage', label: 'Retainage', kind: 'flag' },
      { name: 'hidden', label: 'Hidden from pickers', kind: 'flag' },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['code', 'name', 'is_receivable', 'is_payable', 'is_cash_in', 'is_cash_out', 'is_retainage', 'active'],
  },

  rescat: {
    key: 'rescat', table: 'resource_categories',
    label: 'Resource categories', short: 'Resource cat.',
    purpose: 'The top level of the RBS. RBS codes hang off these.',
    keyCol: 'code', keyLabel: 'Code',
    structure: true,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
    ],
    list: ['code', 'name', 'active'],
  },

  wbs: {
    key: 'wbs', table: 'wbs_code',
    label: 'WBS codes', short: 'WBS',
    purpose: 'The org-wide work-breakdown code list a project tree is built from.',
    keyCol: 'code', keyLabel: 'Code',
    // PRD §8 "Ask first": the shape of WBS is an admin decision.
    structure: true,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'parent_code', label: 'Parent', kind: 'lookup',
        lookup: { table: 'wbs_code', value: 'code', label: 'name' }, allowBlank: true,
        help: 'Leave blank for a top-level code.' },
    ],
    list: ['code', 'name', 'parent_code', 'active'],
  },

  rbs: {
    key: 'rbs', table: 'rbs_code',
    label: 'RBS codes', short: 'RBS',
    purpose: 'The resource breakdown: what a cost is spent on (labour, plant, …).',
    keyCol: 'code', keyLabel: 'Code',
    structure: true,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, max: 32, help: 'Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'resource_category_id', label: 'Resource category', kind: 'lookup',
        lookup: { table: 'resource_categories', value: 'id', label: 'name' }, allowBlank: true,
        help: 'A resource category must exist first.' },
    ],
    list: ['code', 'name', 'resource_category_id', 'active'],
  },

  cbs: {
    key: 'cbs', table: 'transaction_accounts',
    label: 'CBS / transaction accounts', short: 'CBS',
    purpose: 'The cost buckets the Cost Controller tags ledger lines with. '
      + 'This is what the cost report groups by, so rows are never deleted.',
    keyCol: 'code', keyLabel: 'Account code',
    structure: false,
    fields: [
      { name: 'code', label: 'Account code', kind: 'text', required: true, max: 32,
        help: 'The legacy sub-RBS code. Set once.' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'default_wbs_code', label: 'Default WBS', kind: 'lookup',
        lookup: { table: 'wbs_code', value: 'code', label: 'name' }, allowBlank: true,
        help: 'A suggestion when tagging, not a rule.' },
      { name: 'default_rbs_code', label: 'Default RBS', kind: 'lookup',
        lookup: { table: 'rbs_code', value: 'code', label: 'name' }, allowBlank: true,
        help: 'A suggestion when tagging, not a rule.' },
      { name: 'cost_category_id', label: 'Cost category', kind: 'lookup',
        lookup: { table: 'cost_categories', value: 'id', label: 'name' }, allowBlank: true },
      { name: 'cashflow_category_id', label: 'Cashflow category', kind: 'lookup',
        lookup: { table: 'cashflow_categories', value: 'id', label: 'name' }, allowBlank: true },
      { name: 'chart_of_account_id', label: 'Chart of accounts', kind: 'lookup',
        lookup: { table: 'chart_of_accounts', value: 'id', label: 'name' }, allowBlank: true },
      { name: 'hidden', label: 'Hidden from pickers', kind: 'flag' },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['code', 'name', 'cost_category_id', 'default_wbs_code', 'default_rbs_code', 'active'],
  },

  // These two are NOT like the others: no code column and no active flag, so
  // there is nothing to deactivate and a rename applies everywhere at once. The
  // screen says so out loud rather than pretending they behave the same.
  industry: {
    key: 'industry', table: 'industry_types',
    label: 'Industry types', short: 'Industry',
    purpose: 'Used on the client and project forms. No code and no active flag — '
      + 'renaming applies everywhere immediately.',
    keyCol: 'name', keyLabel: 'Name',
    noActive: true, keyEditable: true, structure: false,
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, max: 120 },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['name', 'description'],
  },

  projecttype: {
    key: 'projecttype', table: 'project_types',
    label: 'Project types', short: 'Project type',
    purpose: 'Used on the project form. No code and no active flag — '
      + 'renaming applies everywhere immediately.',
    keyCol: 'name', keyLabel: 'Name',
    noActive: true, keyEditable: true, structure: false,
    fields: [
      { name: 'name', label: 'Name', kind: 'text', required: true, max: 120 },
      { name: 'description', label: 'Description', kind: 'text' },
    ],
    list: ['name', 'description'],
  },
};

// Which tables point at a master row, so the screen can show the blast radius of
// deactivating one instead of letting someone find out from a report. Kept as a
// literal (not derived) so that ADDING a foreign key without declaring it here
// fails the reference test rather than passing quietly.
const REFERENCES = {
  chart_of_accounts: [
    { table: 'accounting_ledger', col: 'chart_of_account_id' },
    { table: 'transaction_accounts', col: 'chart_of_account_id' },
  ],
  cashflow_categories: [
    { table: 'accounting_ledger', col: 'cashflow_category_id' },
    { table: 'transaction_accounts', col: 'cashflow_category_id' },
  ],
  cost_categories: [
    { table: 'accounting_ledger', col: 'cost_category_id' },
    { table: 'transaction_accounts', col: 'cost_category_id' },
  ],
  resource_categories: [
    { table: 'rbs_code', col: 'resource_category_id' },
  ],
  wbs_code: [
    { table: 'wbs_code', col: 'parent_code', textJoin: true },
    { table: 'transaction_accounts', col: 'default_wbs_code', textJoin: true },
  ],
  rbs_code: [
    { table: 'rbs_load', col: 'rbs_code', textJoin: true },
    { table: 'transaction_accounts', col: 'default_rbs_code', textJoin: true },
  ],
  transaction_accounts: [
    { table: 'accounting_ledger', col: 'transaction_account_id' },
    { table: 'cbs_plan', col: 'transaction_account_id' },
    { table: 'lpb_statements', col: 'transaction_account_id' },
    { table: 'procurement_register', col: 'transaction_account_id' },
    { table: 'rbs_load', col: 'transaction_account_id' },
  ],
  industry_types: [],
  project_types: [],
};

// ---------------------------------------------------------------------------
// Registry access
// ---------------------------------------------------------------------------

const keys = () => Object.keys(DATASETS);
const get = (key) => DATASETS[String(key || '')] || null;
const hasActive = (ds) => !ds.noActive;
const isStructure = (ds) => !!ds.structure;

function fieldOf(ds, name) {
  return ds.fields.find((f) => f.name === name) || null;
}

// The ordered field list for a FORM: the key column is dropped on update when it
// is set-once, because the edit view renders it disabled and a browser does not
// submit a disabled input.
function formFields(ds, { isUpdate = false } = {}) {
  if (!isUpdate) return ds.fields;
  if (ds.keyEditable) return ds.fields;
  return ds.fields.filter((f) => f.name !== ds.keyCol);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Rows plus, for each, the number of other rows pointing at it. The count is a
// separate cheap COUNT per reference; on lists this small that is fine, and it is
// what makes "safe to deactivate?" answerable on the screen.
function rowsFor(ds) {
  const order = ds.keyCol === 'name' ? 'name' : 'code';
  const rows = db.prepare(`SELECT * FROM ${ds.table} ORDER BY ${order}`).all();

  const refs = REFERENCES[ds.table] || [];
  const counts = refs.map((r) => {
    // `textJoin` marks a reference BY VALUE (e.g. default_wbs_code = '1.1')
    // rather than by id; comparing an id column to a code would count nothing.
    const col = r.textJoin ? ds.keyCol : r.col;
    return {
      table: r.table, col: r.col, textJoin: !!r.textJoin,
      stmt: db.prepare(`SELECT COUNT(*) n FROM ${r.table} WHERE ${r.col} = ?`),
      key: col,
    };
  });

  for (const row of rows) {
    row.refs = counts.map((c) => ({ table: c.table, col: c.col, n: c.stmt.get(row[c.key]).n }));
    row.refTotal = row.refs.reduce((a, b) => a + b.n, 0);
    // Lookups are stored as ids/codes; the screen needs the label.
    for (const f of ds.fields) {
      if (f.kind === 'lookup' && row[f.name] != null) {
        row[`${f.name}_label`] = lookupLabel(f.lookup, row[f.name]);
      }
    }
  }
  return rows;
}

function lookupLabel(lookup, value) {
  if (value == null || value === '') return null;
  const row = db.prepare(`SELECT * FROM ${lookup.table} WHERE ${lookup.value} = ?`).get(value);
  return row ? row[lookup.label] : `(missing: ${value})`;
}

// The choices for a `lookup` field, for the select control.
function lookupOptions(field) {
  const l = field.lookup;
  const order = l.value === 'id' ? l.label : l.value;
  return db.prepare(`SELECT ${l.value} AS value, ${l.label} AS label FROM ${l.table} ORDER BY ${order}`).all()
    .map((r) => ({ value: String(r.value), label: r.label }));
}

function rowById(ds, id) {
  const row = db.prepare(`SELECT * FROM ${ds.table} WHERE id = ?`).get(id);
  if (!row) return null;
  for (const f of ds.fields) {
    if (f.kind === 'lookup' && row[f.name] != null) {
      row[`${f.name}_label`] = lookupLabel(f.lookup, row[f.name]);
    }
  }
  return row;
}

function counts() {
  const out = {};
  for (const key of keys()) out[key] = db.prepare(`SELECT COUNT(*) n FROM ${DATASETS[key].table}`).get().n;
  return out;
}

// The table columns for a list screen, as descriptors, so the view never has to
// guess a label or how a value is stored. `active` and `refs` are synthetic: they
// are not registry fields but every list wants them.
function listColumns(ds) {
  const cols = ds.list.map((name) => {
    if (name === 'active') return { name, label: 'Status', kind: 'active' };
    const f = ds.fields.find((x) => x.name === name);
    if (!f) return { name, label: name, kind: 'text' };
    const kind = f.kind === 'lookup' ? 'lookup' : (f.kind === 'flag' ? 'flag' : 'text');
    return { name, label: f.label, kind };
  });
  if (hasActive(ds) && !ds.list.includes('active')) cols.push({ name: 'active', label: 'Status', kind: 'active' });
  if ((REFERENCES[ds.table] || []).length) {
    cols.push({ name: '__refs', label: 'Used by', kind: 'refs' });
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function str(v, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Validate AGAINST THE REGISTRY. Returns a flat row of column values.
function validate(ds, input, { isUpdate = false } = {}) {
  const row = {};

  for (const f of formFields(ds, { isUpdate })) {
    const raw = input[f.name];

    if (f.kind === 'flag') {
      row[f.name] = (raw === '1' || raw === 1 || raw === true || raw === 'on') ? 1 : 0;
      if (f.mirror) row[f.mirror] = row[f.name];
      continue;
    }

    if (f.kind === 'select') {
      const v = str(raw);
      if (v == null) {
        if (f.required) return { ok: false, field: f.name, message: `${f.label} is required.` };
        row[f.name] = null;
        continue;
      }
      if (!f.options.includes(v)) {
        return { ok: false, field: f.name, message: `${f.label} must be one of: ${f.options.join(', ')}.` };
      }
      row[f.name] = v;
      if (f.mirror) row[f.mirror] = v;
      continue;
    }

    if (f.kind === 'lookup') {
      const v = str(raw);
      if (v == null) {
        if (f.required) return { ok: false, field: f.name, message: `${f.label} is required.` };
        row[f.name] = null;
        continue;
      }
      // The value must actually exist in the lookup table — otherwise a crafted
      // post writes a dangling reference that no screen can resolve.
      const found = db.prepare(`SELECT 1 x FROM ${f.lookup.table} WHERE ${f.lookup.value} = ?`).get(v);
      if (!found) {
        return { ok: false, field: f.name, message: `${f.label}: "${v}" is not a known value.` };
      }
      row[f.name] = v;
      continue;
    }

    // text
    const v = str(raw, f.max);
    if (v == null) {
      if (f.required) return { ok: false, field: f.name, message: `${f.label} is required.` };
      row[f.name] = null;
      continue;
    }
    if (f.name === 'email' && !EMAIL_RE.test(v)) {
      return { ok: false, field: f.name, message: `${f.label} must be a valid email address.` };
    }
    row[f.name] = v;
  }

  return { ok: true, row };
}

// Uniqueness on the key column, checked in code so the caller gets a sentence
// instead of a raw SQLITE_CONSTRAINT.
function keyTaken(ds, value, exceptId = null) {
  const hit = db.prepare(`SELECT id FROM ${ds.table} WHERE ${ds.keyCol} = ?`).get(value);
  return hit && (exceptId == null || hit.id !== exceptId);
}

const cols = (obj) => Object.keys(obj);
const placeholders = (obj) => cols(obj).map(() => '?').join(', ');

function createRow(key, input, actorId) {
  const ds = get(key);
  if (!ds) return { ok: false, status: 404, message: 'Unknown master-data list.' };

  const v = validate(ds, input);
  if (!v.ok) return v;

  const keyValue = v.row[ds.keyCol];
  if (!keyValue) return { ok: false, field: ds.keyCol, message: `${ds.keyLabel} is required.` };
  if (keyTaken(ds, keyValue)) {
    return { ok: false, field: ds.keyCol, status: 409, message: `${ds.keyLabel} ${keyValue} is already in use.` };
  }

  const run = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO ${ds.table} (${cols(v.row).join(', ')}) VALUES (${placeholders(v.row)})`
    ).run(...Object.values(v.row));
    const created = rowById(ds, info.lastInsertRowid);
    q.audit(ds.table, info.lastInsertRowid, 'create', actorId, null, created);
    return created;
  });

  return { ok: true, row: run() };
}

function updateRow(key, id, input, actorId) {
  const ds = get(key);
  if (!ds) return { ok: false, status: 404, message: 'Unknown master-data list.' };

  const before = rowById(ds, id);
  if (!before) return { ok: false, status: 404, message: 'That row does not exist.' };

  const v = validate(ds, input, { isUpdate: true });
  if (!v.ok) return v;

  if (ds.keyEditable) {
    const keyValue = v.row[ds.keyCol];
    if (!keyValue) return { ok: false, field: ds.keyCol, message: `${ds.keyLabel} is required.` };
    if (keyTaken(ds, keyValue, id)) {
      return { ok: false, field: ds.keyCol, status: 409, message: `${ds.keyLabel} ${keyValue} is already in use.` };
    }
  }

  if (!cols(v.row).length) return { ok: false, message: 'Nothing to save.' };

  const run = db.transaction(() => {
    db.prepare(`UPDATE ${ds.table} SET ${cols(v.row).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...Object.values(v.row), id);
    const after = rowById(ds, id);
    q.audit(ds.table, id, 'update', actorId, before, after);
    return after;
  });

  return { ok: true, row: run() };
}

// Soft, never a delete. Returns how many rows point at it so the caller can say
// what was affected.
function setActive(key, id, active, actorId) {
  const ds = get(key);
  if (!ds) return { ok: false, status: 404, message: 'Unknown master-data list.' };
  if (!hasActive(ds)) {
    return { ok: false, status: 400, message: `${ds.label} has no active flag — nothing to switch.` };
  }

  const before = rowById(ds, id);
  if (!before) return { ok: false, status: 404, message: 'That row does not exist.' };
  const on = active ? 1 : 0;
  if (before.active === on) return { ok: false, status: 409, message: 'It is already in that state.' };

  const refs = refsFor(ds, before);

  const run = db.transaction(() => {
    db.prepare(`UPDATE ${ds.table} SET active = ? WHERE id = ?`).run(on, id);
    const after = rowById(ds, id);
    q.audit(ds.table, id, on ? 'activate' : 'deactivate', actorId, before, after);
    return after;
  });

  return { ok: true, row: run(), refs };
}

function refsFor(ds, row) {
  const refs = REFERENCES[ds.table] || [];
  return refs.map((r) => {
    const key = r.textJoin ? ds.keyCol : r.col;
    const n = db.prepare(`SELECT COUNT(*) n FROM ${r.table} WHERE ${r.col} = ?`).get(row[key]).n;
    return { table: r.table, col: r.col, n };
  }).filter((r) => r.n > 0);
}

module.exports = {
  DATASETS, REFERENCES,
  keys, get, hasActive, isStructure, fieldOf, formFields,
  rowsFor, rowById, lookupOptions, lookupLabel, counts, listColumns,
  validate, keyTaken, createRow, updateRow, setActive, refsFor,
};
