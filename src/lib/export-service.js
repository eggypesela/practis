// Report exports — PDF + XLSX (module 8 part 8.11; PRD §5.4, TECH-SPEC TS-06, TS-18).
//
// WHY THIS FILE EXISTS
// PRD §5.4: "Exports: PDF + Excel report pack, light theme (dark app / light print — Q20c)." Q8 makes
// them a v1 deliverable, and TS-06 says reports "export to PDF and XLSX". Part 8.10 built the Project
// Update Report; this part makes it LEAVABLE — something the accountant or the client can be handed.
//
// TS-18 names the libraries: "pdfmake for PDF + exceljs for XLSX (user, 2026-09-24). Pure-JS,
// deterministic frozen output, small image; no headless browser." So neither generator here is
// hand-rolled and neither needs a browser — which matters on a 2 GB, swap-less box.
//
// THE TWO RULES THAT MATTER
//
// 1. THE EXPORT REPRODUCES THE STORED REPORT. It does NOT recompute anything. If the export
//    re-derived the figures, the PDF handed to a client could differ from the report that was
//    approved — and nothing on the document would say so. So the numbers come from the
//    `project_reports` row, and only the WHOLE document is stamped by the report's STATUS: a `draft`
//    is watermarked DRAFT (it is not a record yet) and a frozen/reviewed one carries who approved it.
//    (This is deliberately NOT "draft exports live figures": that would make the download disagree
//    with the screen the reader just looked at, and would mean the export is not a function of one
//    thing. The screen already warns a stale draft should be regenerated first.)
//
// 2. EVERY TEXT CELL PASSES THE FORMULA-INJECTION GUARD. TS-204: "CSV/Excel export prevents formula
//    injection: cells beginning `=`, `+`, `-`, `@` prefixed safely for spreadsheet readers." A
//    certificate number or a BCR title is USER-SUPPLIED TEXT; if it began with `=` it must land in
//    someone's spreadsheet as text, never as a live formula. `src/lib/csv.js` refuses such cells on
//    the way IN; this is the mirror of that rule on the way OUT, and it is the specific behaviour
//    TECH-SPEC §558's test list names ("exported formula-injection guard").
//
// ONE MODEL, TWO RENDERERS. `model()` builds the document once as plain data; `toPdf` and `toXlsx`
// both render THAT. Two independent builders would be free to drift, and the whole point of a "report
// pack" is that the PDF and the spreadsheet say the same thing.

'use strict';

const path = require('path');
const pdfmake = require('pdfmake');
const ExcelJS = require('exceljs');
const q = require('../db/queries');

// ---------------------------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------------------------

class ExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ExportError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// pdfmake configuration (module-level, because pdfmake 0.3.x is a SINGLETON)
// ---------------------------------------------------------------------------------------------
//
// 0.3.x is a single shared instance with a promise-based output API. Two traps, both hit while
// building this:
//
//   * `createPdf(dd).getBuffer()` returns a PROMISE and takes NO callback. Passing a callback — the
//     0.2.x style — is silently ignored: no error, no output, nothing. The first probe "proved" that
//     locking pdfmake down broke PDF generation when the real problem was this API change.
//   * Server-side use warns unless both access policies are set. We set them explicitly: external
//     URLs are DENIED outright, and local file reads are confined to the pdfmake fonts directory.
//     The report contains only our own strings, so nothing should ever need to fetch anything.
//
// The fonts ship inside the package, so no font file is added to the repo and no network access is
// needed at export time — which is what "pure-JS, deterministic frozen output" buys.

const FONTS_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pdfmake', 'fonts');

pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => String(p).startsWith(FONTS_DIR));
pdfmake.addFonts({
  Roboto: {
    normal: path.join(FONTS_DIR, 'Roboto', 'Roboto-Regular.ttf'),
    bold: path.join(FONTS_DIR, 'Roboto', 'Roboto-Medium.ttf'),
    italics: path.join(FONTS_DIR, 'Roboto', 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONTS_DIR, 'Roboto', 'Roboto-MediumItalic.ttf'),
  },
});

// ---------------------------------------------------------------------------------------------
// Formatting — shared by both renderers so the two cannot disagree about a number
// ---------------------------------------------------------------------------------------------

const money = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-US'));
const ratio = (n) => (n === null || n === undefined ? '' : Number(n).toFixed(2));
const pct = (n) => (n === null || n === undefined ? ''
  : `${Number(n) > 0 ? '+' : ''}${Number(n)}%`);

// The formula-injection guard. Only TEXT is touched: a number stays a number (a real -1234 must
// remain numeric, not become the string "'-1234"). A string beginning with a formula lead-in gets an
// apostrophe, which every spreadsheet reader treats as "this is text". OWASP also lists TAB and CR
// as lead-ins, so they are covered too.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
function safeText(v) {
  if (typeof v !== 'string') return v;
  return FORMULA_LEAD.test(v) ? `'${v}` : v;
}

// A filename that is safe on every OS: the project code and the month are the only variables.
const safePart = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// ---------------------------------------------------------------------------------------------
// The document model — plain data, built once, rendered twice
// ---------------------------------------------------------------------------------------------

const STATUS_LABEL = { draft: 'DRAFT', reviewed: 'REVIEWED', frozen: 'FROZEN' };

/**
 * Build the export model for a stored report.
 *
 * @param {object} report  the `project_reports` row (the record being exported)
 * @param {object} project the owning project
 * @returns {{meta, figures, exceptions, notChecked, baseline, notes}}
 */
function model(report, project) {
  // `payload_json` holds the compiled body 8.10 stored: it is the ONLY place the exception list and
  // the baseline comparison survive, because `project_reports` has no columns for them. A stored
  // report whose payload is unreadable is still exportable — it just says so, rather than throwing
  // and leaving the reader with no document at all.
  let body = null;
  try {
    body = report.payload_json ? JSON.parse(report.payload_json) : null;
  } catch (e) {
    body = null;
  }

  const meta = {
    project: project.name,
    code: project.code,
    month: report.period_month,
    status: report.status,
    statusLabel: STATUS_LABEL[report.status] || String(report.status).toUpperCase(),
    isDraft: report.status === 'draft',
    // Who approved it and when — present only on a report that actually was approved.
    approvedBy: report.approved_at ? String(report.approved_at).slice(0, 10) : null,
    frozenAt: report.frozen_at ? String(report.frozen_at).slice(0, 10) : null,
    contract: money(project.contract_amount),
    generatedAt: report.generated_at ? String(report.generated_at).slice(0, 19) : null,
    payloadReadable: !!body,
  };

  // THE FIVE FIGURES. Facts only — no verdict, no advice, no "you should". The reader draws the
  // conclusion; the document states what was measured.
  const figures = [
    ['Schedule performance index (SPI)', ratio(report.spi),
      'Earned value ÷ planned value, cumulative'],
    ['Cost performance index (CPI)', ratio(report.cpi),
      'Earned value ÷ actual cost, cumulative'],
    ['Receivable', money(report.receivable_amount),
      'What the client still owes, from the aging list'],
    ['Revenue recognised', money(report.revenue_recognized),
      'Cumulative, under the project\u2019s revenue method'],
    ['Payable', money(report.payable_amount),
      'What the project owes, from the ledger'],
  ];

  // Additional stored facts, clearly separated from the five above so the headline figures stay
  // readable. Cost variance is a stored column and a plain fact; it is a different convention from
  // CV (positive here means OVER budget), so it is labelled rather than left to the reader.
  const extraFacts = [
    ['Cost variance', pct(report.cost_variance_pct), '(actual − earned) ÷ earned; positive = over budget'],
    ['Revenue method', body && body.method ? String(body.method) : 'not set', 'How revenue is recognised'],
    ['Position measured', body && body.measured_month ? String(body.measured_month) : 'not measured',
      body && body.evm_stale ? 'No measurement in this month; the latest earlier one is quoted'
        : 'The month the performance figures are drawn from'],
  ];

  const exceptions = (body && body.exceptions && Array.isArray(body.exceptions.raised))
    ? body.exceptions.raised.map((e) => safeText(String(e.text || e.kind)))
    : [];

  // Alerts that could NOT be evaluated are named, never omitted: an absent line reads as "no problem".
  const notChecked = (body && body.exceptions && Array.isArray(body.exceptions.notEvaluated))
    ? body.exceptions.notEvaluated.map((e) => safeText(`${String(e.kind).replace(/_/g, ' ')} — ${e.reason}`))
    : [];

  const bc = (body && body.baseline_changes) ? body.baseline_changes : null;
  const baseline = {
    note: bc && bc.note ? safeText(String(bc.note)) : 'No baseline comparison is recorded on this report.',
    total: bc ? money(bc.totalImpact) : '',
    rows: (bc && Array.isArray(bc.rows)) ? bc.rows.map((r) => ([
      safeText(String(r.bcr_no || `#${r.id}`)),
      safeText(String(r.change_type || '').replace(/_/g, ' ')),
      safeText(String(r.title || '')),
      money(r.impact_cost),
      safeText(String(r.effective_period || '')),
    ])) : [],
  };

  const notes = [
    'Figures are the stored report, not a recalculation: this document reproduces the report as it '
    + 'was compiled.',
    meta.isDraft
      ? 'DRAFT — this report has not been approved, so it is not a record of the period.'
      : 'The period is closed for this month; backdated entries to it are refused.',
  ];

  return { meta, figures, extraFacts, exceptions, notChecked, baseline, notes };
}

// ---------------------------------------------------------------------------------------------
// XLSX renderer (exceljs)
// ---------------------------------------------------------------------------------------------

const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
const TITLE_FONT = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FF111111' } };
const MUTED_FONT = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF555555' } };

async function toXlsx(m) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PRACTIS';
  wb.created = new Date();

  const ws = wb.addWorksheet('Report', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 52 }];

  ws.addRow(['Project update report']).font = TITLE_FONT;
  ws.addRow([`${m.meta.project} (${m.meta.code})`]).font = { bold: true };
  // Status is a FACT here and is stated plainly. A draft says so on its own line so a printed sheet
  // cannot be mistaken for an approved one.
  ws.addRow([`Period ${m.meta.month}`, '', `${m.meta.statusLabel}`
    + (m.meta.isDraft ? ' — not approved' : '')
    + (m.meta.approvedBy ? ` · approved ${m.meta.approvedBy}` : '')]);
  ws.addRow(['Contract value (IDR)', m.meta.contract]);
  ws.addRow([]);

  const head = (cells) => {
    const r = ws.addRow(cells);
    r.font = { bold: true };
    r.eachCell((c) => { c.fill = HEAD_FILL; });
    return r;
  };

  head(['Figure', 'Value', 'What it is']);
  for (const [label, value, note] of m.figures) ws.addRow([safeText(label), safeText(value), safeText(note)]);
  ws.addRow([]);

  head(['Other figures', 'Value', 'What it is']);
  for (const [label, value, note] of m.extraFacts) ws.addRow([safeText(label), safeText(value), safeText(note)]);
  ws.addRow([]);

  ws.addRow(['Exceptions this period']).font = { bold: true };
  if (!m.exceptions.length) {
    ws.addRow(['Nothing from the alert list fired for this project.']);
  } else {
    for (const e of m.exceptions) ws.addRow([safeText(e)]);
  }
  for (const n of m.notChecked) ws.addRow([safeText(`Not checked: ${n}`)]).font = MUTED_FONT;
  ws.addRow([]);

  ws.addRow(['Baseline — what changed']).font = { bold: true };
  ws.addRow([safeText(m.baseline.note)]);
  if (m.baseline.rows.length) {
    head(['Reference', 'Change', 'Title', 'Cost impact', 'Effective']);
    for (const r of m.baseline.rows) {
      ws.addRow([safeText(r[0]), safeText(r[1]), safeText(r[2]), safeText(r[3]), safeText(r[4])]);
    }
    ws.addRow(['Total impact', '', '', m.baseline.total]);
  }
  ws.addRow([]);
  for (const n of m.notes) ws.addRow([safeText(n)]).font = MUTED_FONT;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------------------------
// PDF renderer (pdfmake) — light print theme (Q20c: dark app, light print)
// ---------------------------------------------------------------------------------------------

const GREY = '#555555';
const RULE = '#BBBBBB';

function tableBlock(header, rows) {
  return {
    table: {
      headerRows: 1,
      widths: ['auto', 'auto', '*'],
      body: [
        header.map((h) => ({ text: h, bold: true, fillColor: '#EFEFEF', fontSize: 9 })),
        ...rows.map((r) => r.map((c) => ({ text: String(c == null ? '' : c), fontSize: 9 }))),
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 2, 0, 8],
  };
}

function toPdfDoc(m) {
  const content = [
    { text: 'Project update report', fontSize: 17, bold: true, color: '#111111' },
    { text: `${m.meta.project} (${m.meta.code})`, fontSize: 11, margin: [0, 2, 0, 0] },
    {
      columns: [
        { text: `Period ${m.meta.month}`, fontSize: 11 },
        {
          text: m.meta.statusLabel + (m.meta.isDraft ? ' — not approved' : '')
            + (m.meta.approvedBy ? ` · approved ${m.meta.approvedBy}` : ''),
          fontSize: 11,
          bold: true,
          alignment: 'right',
          // A draft is marked in red so a printed sheet cannot be mistaken for an approved one.
          color: m.meta.isDraft ? '#B00020' : '#0B6E4F',
        },
      ],
      margin: [0, 2, 0, 6],
    },
    { text: `Contract value (IDR): ${m.meta.contract}`, fontSize: 9, color: GREY, margin: [0, 0, 0, 10] },
  ];

  content.push({ text: 'Figures', fontSize: 12, bold: true, margin: [0, 0, 0, 2] });
  content.push(tableBlock(['Figure', 'Value', 'What it is'], m.figures));

  content.push({ text: 'Other figures', fontSize: 12, bold: true, margin: [0, 0, 0, 2] });
  content.push(tableBlock(['Figure', 'Value', 'What it is'], m.extraFacts));

  content.push({ text: 'Exceptions this period', fontSize: 12, bold: true, margin: [0, 4, 0, 2] });
  content.push({
    ul: m.exceptions.length ? m.exceptions : ['Nothing from the alert list fired for this project.'],
    fontSize: 9,
    margin: [0, 0, 0, 4],
  });
  if (m.notChecked.length) {
    content.push({
      text: `Not checked: ${m.notChecked.join('; ')}.`,
      fontSize: 8,
      color: GREY,
      margin: [0, 0, 0, 8],
    });
  }

  content.push({ text: 'Baseline — what changed', fontSize: 12, bold: true, margin: [0, 4, 0, 2] });
  content.push({ text: m.baseline.note, fontSize: 9, margin: [0, 0, 0, 4] });
  if (m.baseline.rows.length) {
    content.push({
      table: {
        headerRows: 1,
        widths: ['auto', 'auto', '*', 'auto', 'auto'],
        body: [
          ['Reference', 'Change', 'Title', 'Cost impact', 'Effective']
            .map((h) => ({ text: h, bold: true, fillColor: '#EFEFEF', fontSize: 9 })),
          ...m.baseline.rows.map((r) => r.map((c) => ({ text: String(c == null ? '' : c), fontSize: 9 }))),
          [{ text: 'Total impact', bold: true, fontSize: 9 }, '', '', 
            { text: String(m.baseline.total), bold: true, fontSize: 9 }, ''],
        ],
      },
      layout: 'lightHorizontalLines',
    });
  }

  content.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: RULE }],
    margin: [0, 14, 0, 6],
  });
  for (const n of m.notes) content.push({ text: n, fontSize: 8, color: GREY, margin: [0, 0, 0, 2] });
  content.push({
    text: `Generated from PRACTIS${m.meta.generatedAt ? ` · report compiled ${m.meta.generatedAt}` : ''}`,
    fontSize: 7.5,
    color: GREY,
    margin: [0, 4, 0, 0],
  });

  return { content, defaultStyle: { fontSize: 10, color: '#111111' }, pageMargins: [40, 40, 40, 40] };
}

// NOTE the await: pdfmake 0.3.x returns a PROMISE from getBuffer() and a callback argument is
// silently ignored. Calling it the 0.2.x way yields no bytes and no error.
async function toPdf(m) {
  return Buffer.from(await pdfmake.createPdf(toPdfDoc(m)).getBuffer());
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

const FORMATS = {
  pdf: { ext: 'pdf', contentType: 'application/pdf', render: toPdf },
  xlsx: {
    ext: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: toXlsx,
  },
};

/**
 * Render a stored report to a downloadable file.
 *
 * @param {object} args
 * @param {number} args.reportId
 * @param {number} args.projectId  the project the caller is scoped to — the report must belong to it
 * @param {string} args.format     'pdf' | 'xlsx'
 * @param {number} args.actorId    who downloaded it (audited: TECH-SPEC §221, §225)
 * @returns {Promise<{buffer: Buffer, filename: string, contentType: string, model: object}>}
 */
async function exportReport({ reportId, projectId, format, actorId }) {
  const fmt = FORMATS[String(format || '').toLowerCase()];
  if (!fmt) throw new ExportError(`Unknown export format "${format}". Choose pdf or xlsx.`, 400);

  const report = q.projectReportById(Number(reportId));
  if (!report) throw new ExportError('That report does not exist.', 404);

  // SCOPING. The route already resolved the caller's project, but the report id comes from the URL,
  // so it must be checked against it — otherwise anyone signed in could download another project's
  // report by changing the id. A wrong-project id is reported as "not found", not "forbidden": the
  // caller has no business knowing the report exists.
  if (Number(report.project_id) !== Number(projectId)) {
    throw new ExportError('That report does not exist.', 404);
  }

  const project = q.projectById(report.project_id);
  if (!project) throw new ExportError('That report does not exist.', 404);

  const m = model(report, project);
  const buffer = await fmt.render(m);

  // Audited per download. `q.audit(entity, id, action, actorId, before, after)` — the format and the
  // status go in `after` so an export of a DRAFT is distinguishable from one of a frozen record.
  q.audit('project_reports', report.id, 'export', actorId, null,
    { format: fmt.ext, period_month: report.period_month, status: report.status });

  return {
    buffer,
    filename: `PRACTIS-${safePart(project.code)}-${safePart(report.period_month)}.${fmt.ext}`,
    contentType: fmt.contentType,
    model: m,
  };
}

module.exports = { ExportError, exportReport, model, toPdf, toXlsx, safeText, FORMATS };
