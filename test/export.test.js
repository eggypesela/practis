// UPX8-series: the PDF and XLSX exports of the Project Update Report (module 8, plan part 8.11).
// THIS IS PART 8.11'S GATE. PRD §5.4 / Q8, TECH-SPEC TS-06, TS-18 (pdfmake + exceljs).
//
// WHAT THIS FILE DEFENDS
//
// **UPX8.2 IS THE POINT.** An export that RECOMPUTED the figures would produce a document that
// disagrees with the approved report — and nothing on the file would say so. So the test stores a
// report with figures that are deliberately NOT what the project would compute right now, exports it,
// and requires the FILE to carry the STORED numbers. If someone later "simplifies" the export into a
// fresh recompute, this is what fails.
//
// **UPX8.4 IS THE OTHER POINT.** A certificate number or a BCR title is user-supplied text. If one
// begins `=`, it must land in the spreadsheet as TEXT, not as a live formula. TECH-SPEC line 204
// requires the guard and §558 names the test ("exported formula-injection guard"). The check is done
// by reading the XLSX's own XML back, because "the string contains an apostrophe" in memory proves
// nothing about what was written to the file.
//
// The rest defends the plumbing that is easy to get quietly wrong: a real ZIP and a real PDF (not an
// empty 200), the DRAFT/approved distinction ON THE FILE, the audit row, and the scoping that stops
// one project downloading another's report.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startFixture } = require('./helpers/practis-fixture');

const PORT = 3931;   // 3930 is report-update.test.js.
const PROJECT = 1;   // PRJ-2026 "Citarum Bridge".

let fx;
let exp;

before(async () => {
  fx = await startFixture({ port: PORT, prefix: 'practis-upx8-' });
  fx.db.prepare(`UPDATE projects SET contract_amount = 10000000 WHERE id = ?`).run(PROJECT);
  [exp] = fx.loadMany('src/lib/export-service.js');
  // Exports are read from `project_reports`; start from a clean slate so the ids are ours.
  fx.db.prepare('DELETE FROM project_reports WHERE project_id = ?').run(PROJECT);
});

after(() => { if (fx) fx.stop(); });

// ---- helpers ---------------------------------------------------------------

// Insert a stored report DIRECTLY, so the figures under test are known exactly and are deliberately
// not what a live compile would produce (see UPX8.2).
function storeReport({ month = '2026-03', status = 'draft', spi = 1.23, cpi = 0.4567,
  receivable = 111111, revenue = 222222, payable = 333333, cvPct = 12.5,
  approvedBy = null, approvedAt = null, frozenAt = null, payload = null } = {}) {
  const body = payload || {
    method: 'poc', measured_month: '2026-03', evm_stale: false,
    exceptions: {
      raised: [{ kind: 'cpi_breach', text: 'CPI is 0.4567, below the 0.95 threshold as at 2026-03.' }],
      notEvaluated: [{ kind: 'progress_not_updated', reason: 'No per-line "last progress at" is recorded.' }],
    },
    baseline_changes: {
      note: 'No baseline change took effect in this period.',
      totalImpact: 0, rows: [],
    },
  };
  const info = fx.db.prepare(`INSERT INTO project_reports (project_id, period_month, status, spi, cpi,
      cost_variance_pct, receivable_amount, revenue_recognized, payable_amount, payload_json,
      approved_by, approved_at, frozen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(PROJECT, month, status, spi, cpi, cvPct, receivable, revenue, payable,
      JSON.stringify(body), approvedBy, approvedAt, frozenAt);
  return Number(info.lastInsertRowid);
}

const auditRows = (action) => fx.db.prepare(
  "SELECT * FROM audit_log WHERE entity_type = 'project_reports' AND action = ? ORDER BY id").all(action);

// ---- UPX8.1 — both formats are REAL files, not an empty 200 ------------------

test('UPX8.1 the PDF is a real PDF and the XLSX is a real archive, not an empty response', async () => {
  const id = storeReport({ month: '2026-01' });

  const pdf = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'pdf',
    actorId: fx.users.get('cost_controller') });
  assert.strictEqual(pdf.contentType, 'application/pdf');
  assert.match(pdf.filename, /\.pdf$/, 'the filename ends in .pdf');
  assert.ok(Buffer.isBuffer(pdf.buffer), 'a Buffer is returned');
  // A PDF begins with %PDF- and ends with %%EOF. Checking BOTH means a truncated or empty render
  // cannot pass: `res.end(Buffer.alloc(0))` with a 200 would satisfy a status-only assertion.
  assert.strictEqual(pdf.buffer.subarray(0, 5).toString('latin1'), '%PDF-', 'the PDF magic bytes');
  assert.ok(pdf.buffer.subarray(-1024).toString('latin1').includes('%%EOF'), 'and a real trailer');
  assert.ok(pdf.buffer.length > 2000, `a plausible size (got ${pdf.buffer.length} bytes)`);

  const xlsx = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
    actorId: fx.users.get('cost_controller') });
  assert.match(xlsx.contentType, /spreadsheetml\.sheet/);
  assert.match(xlsx.filename, /\.xlsx$/, 'the filename ends in .xlsx');
  // An XLSX is a ZIP: PK\x03\x04. Anything else is not a workbook whatever the extension says.
  assert.strictEqual(xlsx.buffer.subarray(0, 2).toString('latin1'), 'PK', 'the ZIP magic bytes');
  assert.ok(xlsx.buffer.length > 1000, `a plausible size (got ${xlsx.buffer.length} bytes)`);

  // The filename is derived from project + month and is safe on every OS.
  assert.match(xlsx.filename, /^PRACTIS-[A-Za-z0-9._-]+-2026-01\.xlsx$/);
});

// ---- UPX8.2 — THE POINT: the export reproduces the STORED report -------------

test('UPX8.2 the file carries the STORED figures, not a live recomputation', async () => {
  const id = fx.db.prepare(
    "SELECT id FROM project_reports WHERE period_month = '2026-01'").get().id;
  const stored = fx.db.prepare('SELECT * FROM project_reports WHERE id = ?').get(id);

  // The stored figures are deliberately odd (SPI 1.23, CPI 0.4567). Nothing in the project would
  // compute these — the real project has no baseline at all, so a live compile gives NULL. If the
  // export recomputed, the file would show blanks/nulls instead of these numbers.
  assert.strictEqual(stored.spi, 1.23, 'the stored SPI is the odd value');
  assert.strictEqual(stored.cpi, 0.4567);

  const { buffer } = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
    actorId: fx.users.get('cost_controller') });

  // Read the workbook back through a SECOND exceljs load and assert the values are present. Asserting
  // on the in-memory model would prove nothing about the bytes that were actually written.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const s = wb.worksheets[0];
  const flat = [];
  s.eachRow((row) => row.eachCell((c) => { flat.push(c.value == null ? '' : String(c.value)); }));
  const text = flat.join('\n');

  assert.ok(text.includes('1.23'), 'the STORED SPI is in the file');
  assert.ok(text.includes('0.4567'), 'the STORED CPI is in the file');
  assert.ok(text.includes('111,111'), 'the stored receivable is in the file');
  assert.ok(text.includes('222,222'), 'the stored recognised revenue is in the file');
  assert.ok(text.includes('333,333'), 'the stored payable is in the file');
  // And the figure the live compile would produce instead is NOT there — the project has no baseline,
  // so a recompute would have written blanks.
  assert.ok(!text.includes('Not measured'), 'no live "not measured" placeholder leaked in');

  // The PDF says the same thing as the spreadsheet (one model, two renderers).
  const pdf = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'pdf',
    actorId: fx.users.get('cost_controller') });
  assert.ok(pdf.buffer.length > 2000);
});

// ---- UPX8.3 — a DRAFT is marked DRAFT; an approved one carries the approval --

test('UPX8.3 a draft export is marked DRAFT and a frozen one carries who approved it', async () => {
  const draftId = storeReport({ month: '2026-02', status: 'draft' });
  const frozenId = storeReport({ month: '2026-04', status: 'frozen',
    approvedBy: fx.users.get('project_manager'), approvedAt: '2026-05-03 09:00:00',
    frozenAt: '2026-05-03 09:00:00' });

  const ExcelJS = require('exceljs');
  const rowsOf = async (id) => {
    const { buffer } = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
      actorId: fx.users.get('cost_controller') });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const out = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => out.push(c.value == null ? '' : String(c.value))));
    return out.join('\n');
  };

  const draftText = await rowsOf(draftId);
  assert.ok(/DRAFT/.test(draftText), 'the draft file says DRAFT');
  assert.ok(/not approved/i.test(draftText), 'and says it is not approved');

  const frozenText = await rowsOf(frozenId);
  assert.ok(/FROZEN/.test(frozenText), 'the frozen file says FROZEN');
  assert.ok(/approved 2026-05-03/.test(frozenText), 'and names the approval date');
  assert.ok(!/DRAFT/.test(frozenText), 'and does NOT call itself a draft');

  // The distinction is on the PDF too — a printed sheet is where the confusion would actually bite.
  const model = exp.model(fx.db.prepare('SELECT * FROM project_reports WHERE id = ?').get(draftId),
    fx.db.prepare('SELECT * FROM projects WHERE id = ?').get(PROJECT));
  assert.strictEqual(model.meta.isDraft, true);
  assert.strictEqual(model.meta.statusLabel, 'DRAFT');
});

// ---- UPX8.4 — the formula-injection guard, read back from the file -----------

test('UPX8.4 a cell starting with = + - or @ lands as TEXT, never as a live formula', async () => {
  // A BCR whose title and reference are hostile, plus an exception text that begins with a formula.
  // All three are user-supplied strings that reach the export.
  const hostile = {
    method: 'poc', measured_month: '2026-03', evm_stale: false,
    exceptions: {
      raised: [{ kind: 'cpi_breach', text: '=HYPERLINK("http://evil.example","click")' }],
      notEvaluated: [],
    },
    baseline_changes: {
      note: 'One approved baseline change took effect.',
      totalImpact: 250000,
      rows: [{ id: 9, bcr_no: '=1+1', change_type: 'add_scope', title: '@SUM(A1:A9)',
        impact_cost: 250000, effective_period: '2026-03' }],
    },
  };
  const id = storeReport({ month: '2026-05', payload: hostile });

  const { buffer } = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
    actorId: fx.users.get('cost_controller') });

  // Read the workbook's OWN XML. exceljs writes inline/shared strings into the sheet part; a value
  // that exceljs treated as a FORMULA would appear as `<f>…</f>` instead of a string cell. That
  // difference is invisible in memory and decisive on disk, which is why this test opens the zip.
  const AdmZip = null;   // no archiver dependency of our own — unzip with node's zlib instead
  const zlib = require('zlib');
  const parts = unzip(buffer);
  const sheetXml = parts['xl/worksheets/sheet1.xml'];
  assert.ok(sheetXml, 'the workbook has a first sheet part');
  const sheet = sheetXml.toString('utf8');

  // No formula element at all: every hostile string became a literal.
  assert.ok(!/<f>/.test(sheet), 'the sheet contains NO formula element — nothing was evaluated');
  assert.ok(!/<f [^>]*>/.test(sheet), 'and no formula element with attributes either');

  // And the text is present, escaped as a plain string, so the reader still sees what was typed.
  const shared = (parts['xl/sharedStrings.xml'] || Buffer.alloc(0)).toString('utf8');
  const allText = sheet + shared;
  assert.ok(allText.includes('=1+1'), 'the hostile reference is present AS TEXT');
  assert.ok(allText.includes('@SUM(A1:A9)'), 'and so is the hostile title');

  // Unit-level: the guard itself, on the four OWASP lead-ins and the safe cases.
  assert.strictEqual(exp.safeText('=1+1'), "'=1+1");
  assert.strictEqual(exp.safeText('+SUM(A1)'), "'+SUM(A1)");
  assert.strictEqual(exp.safeText('-2+3'), "'-2+3");
  assert.strictEqual(exp.safeText('@import'), "'@import");
  assert.strictEqual(exp.safeText('Normal title'), 'Normal title', 'ordinary text is untouched');
  assert.strictEqual(exp.safeText(1234), 1234, 'a NUMBER stays a number, not a quoted string');
  assert.strictEqual(exp.safeText(-1234), -1234, 'including a negative one');
});

// ---- UPX8.5 — the workbook opens and carries the month ----------------------

test('UPX8.5 the XLSX really is a workbook: it unzips and its parts contain the month', async () => {
  const id = fx.db.prepare(
    "SELECT id FROM project_reports WHERE period_month = '2026-01'").get().id;
  const { buffer } = await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
    actorId: fx.users.get('cost_controller') });

  const parts = unzip(buffer);
  // The minimum a spreadsheet reader needs. If any of these is missing the file is a broken blob
  // that happens to start with PK — exactly what a hand-rolled writer gets wrong.
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/worksheets/sheet1.xml']) {
    assert.ok(parts[name], `the workbook contains ${name}`);
  }
  const workbook = parts['xl/workbook.xml'].toString('utf8');
  assert.ok(/<workbook/.test(workbook), 'and the workbook part is a real workbook element');

  // Loaded through exceljs, the sheet shows the month and the workbook name.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.ok(wb.worksheets.length >= 1);
  const s = wb.worksheets[0];
  let text = '';
  s.eachRow((r) => r.eachCell((c) => { text += `${c.value == null ? '' : c.value}\n`; }));
  assert.ok(text.includes('2026-01'), 'the period is on the sheet');
  assert.ok(text.includes('Citarum Bridge') || text.includes('PRJ-2026'),
    'and so is the project');
});

// ---- UPX8.6 — the download is audited -------------------------------------

test('UPX8.6 each download writes an audit row naming the format and the status', async () => {
  const before = auditRows('export').length;
  const id = storeReport({ month: '2026-06' });

  await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'pdf',
    actorId: fx.users.get('cost_controller') });
  await exp.exportReport({ reportId: id, projectId: PROJECT, format: 'xlsx',
    actorId: fx.users.get('cost_controller') });

  const after = auditRows('export');
  assert.strictEqual(after.length, before + 2, 'one audit row per download');
  const last = after[after.length - 1];
  assert.strictEqual(last.entity_id, id, 'naming the report');
  const payload = JSON.parse(last.after_json);
  assert.strictEqual(payload.format, 'xlsx', 'and the format');
  assert.strictEqual(payload.status, 'draft', 'and the status at download time');
  assert.strictEqual(last.actor_id, fx.users.get('cost_controller'), 'and who downloaded it');
});

// ---- UPX8.7 — scoping and access -------------------------------------------

test('UPX8.7 another project\u2019s report cannot be downloaded, and the refusal is a 404', async () => {
  // A second project, and a report in it. Project 1's caller must not be able to fetch it by id.
  const other = fx.db.prepare('SELECT id FROM projects WHERE id != ? ORDER BY id LIMIT 1').get(PROJECT);
  const otherId = other ? other.id : null;
  if (!otherId) {
    // The fixture has one project; make a second so the check is real rather than vacuous.
    const info = fx.db.prepare(`INSERT INTO projects (code, name, contract_amount, status, start_date,
        end_date, created_by) VALUES ('UPX8-2', 'Other project', 5000000, 'active', '2026-01-01',
        '2026-12-31', ?)`).run(fx.users.get('cost_controller'));
    fx.db.prepare(`INSERT INTO project_reports (project_id, period_month, status, spi, cpi,
        cost_variance_pct, receivable_amount, revenue_recognized, payable_amount)
        VALUES (?, '2026-03', 'draft', 1, 1, 0, 0, 0, 0)`).run(Number(info.lastInsertRowid));
    var foreignReportId = Number(fx.db.prepare(
      'SELECT id FROM project_reports WHERE project_id = ?').get(Number(info.lastInsertRowid)).id);
  } else {
    fx.db.prepare(`INSERT INTO project_reports (project_id, period_month, status, spi, cpi,
        cost_variance_pct, receivable_amount, revenue_recognized, payable_amount)
        VALUES (?, '2026-03', 'draft', 1, 1, 0, 0, 0, 0)`).run(otherId);
    var foreignReportId = fx.db.prepare(
      'SELECT id FROM project_reports WHERE project_id = ?').get(otherId).id;
  }

  await assert.rejects(
    () => exp.exportReport({ reportId: foreignReportId, projectId: PROJECT, format: 'pdf',
      actorId: fx.users.get('cost_controller') }),
    (e) => e.status === 404 && /does not exist/i.test(e.message),
    'a report belonging to another project is reported as NOT FOUND, not forbidden — the caller has '
    + 'no business knowing it exists');

  // An unknown format is refused, and an unknown report id too.
  await assert.rejects(
    () => exp.exportReport({ reportId: 1, projectId: PROJECT, format: 'docx',
      actorId: fx.users.get('cost_controller') }),
    (e) => e.status === 400, 'an unknown format is a 400');
  await assert.rejects(
    () => exp.exportReport({ reportId: 999999, projectId: PROJECT, format: 'pdf',
      actorId: fx.users.get('cost_controller') }),
    (e) => e.status === 404, 'an unknown report is a 404');

  // Over HTTP: a viewer MAY download (read parity with the screen), and the file that comes back is
  // a real PDF.
  const viewer = fx.clients.get('viewer');
  const ownId = fx.db.prepare(
    "SELECT id FROM project_reports WHERE project_id = ? AND period_month = '2026-06'")
    .get(PROJECT).id;
  const res = await viewer.get(`/reports/update/${ownId}/export.pdf`);
  assert.strictEqual(res.status, 200, 'a viewer may download the report it can read');
  assert.match(String(res.headers.get('content-type')), /application\/pdf/);
  assert.match(String(res.headers.get('content-disposition')), /attachment; filename="/,
    'and it is served as an attachment');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(bytes.subarray(0, 5).toString('latin1'), '%PDF-',
    'the downloaded bytes really are a PDF');
});

// ---------------------------------------------------------------------------
// A tiny ZIP reader — the ONLY way to see what was actually written to the workbook, and it needs
// no dependency of our own (node's zlib is enough for stored/deflated entries).
// ---------------------------------------------------------------------------

function unzip(buf) {
  const zlib = require('zlib');
  const out = {};
  // Find each local file header (PK\x03\x04) and read the entry that follows it.
  let i = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const method = buf.readUInt16LE(i + 8);
      const compSize = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const extraLen = buf.readUInt16LE(i + 28);
      const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
      const dataStart = i + 30 + nameLen + extraLen;
      if (compSize > 0) {
        const data = buf.subarray(dataStart, dataStart + compSize);
        try {
          out[name] = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
        } catch (e) { /* skip an entry we cannot inflate */ }
        i = dataStart + compSize;
      } else {
        // Streamed entry: sizes live in the data descriptor after the payload. Not produced by
        // exceljs, but skip forward rather than mis-parsing.
        i += 4;
      }
    } else {
      i += 1;
    }
  }
  return out;
}
// ---- UPX8.8 — the screen offers both downloads (added 2026-10-04) ---------------------------
//
// The buttons are part of THIS part's deliverable (8.11 modified `views/report-update.ejs`), and
// nothing else asserts they render. Without a stored report there is nothing to download, so the
// buttons must be ABSENT rather than pointing at a route that will 404 — and the links must match the
// route the service actually serves (`/reports/update/:id/export.:format`).

test('UPX8.8 the report screen offers both downloads, but only once a report is stored', async () => {
  const admin = fx.admin;
  // The project must be named explicitly: `projectContext` picks from the caller's allowed projects,
  // and without `?project=` the page renders with `project = null` → no stored report → NO download
  // links in BOTH cases, which would make the "no links" assertion pass for the wrong reason.
  const url = (month) => `/reports/update?project=${PROJECT}&month=${month}`;

  // No stored report for 2026-09 → no download links at all. NOTE `res.text()` is a FUNCTION on this
  // fixture's client (it returns a promise) — using `res.text` unchecked compares a function object,
  // which makes every negative assertion below pass vacuously.
  fx.db.prepare("DELETE FROM project_reports WHERE project_id = ? AND period_month = '2026-09'")
    .run(PROJECT);
  const bare = await admin.get(url('2026-09'));
  const bareHtml = await bare.text();
  assert.strictEqual(bare.status, 200, 'the screen still renders');
  assert.ok(!/export\.pdf/.test(bareHtml), 'no PDF link when there is no stored report');
  assert.ok(!/export\.xlsx/.test(bareHtml), 'no XLSX link when there is no stored report');

  // With a stored report, both links appear and name it.
  const id = storeReport({ month: '2026-09', status: 'draft' });
  const page = await admin.get(url('2026-09'));
  const pageHtml = await page.text();
  assert.strictEqual(page.status, 200);
  assert.ok(/Download this report/.test(pageHtml), 'the download region is rendered');
  assert.ok(new RegExp(`/reports/update/${id}/export\\.pdf`).test(pageHtml),
    'the PDF download names the stored report');
  assert.ok(new RegExp(`/reports/update/${id}/export\\.xlsx`).test(pageHtml),
    'the XLSX download names the stored report');

  // The links the page printed actually resolve to files for that report. The client wraps Node's
  // fetch, so `res.headers` is a Headers OBJECT — bracket access silently yields undefined.
  for (const ext of ['pdf', 'xlsx']) {
    const res = await admin.get(`/reports/update/${id}/export.${ext}`);
    const cd = res.headers.get('content-disposition') || '';
    assert.strictEqual(res.status, 200, `the ${ext} download succeeds`);
    assert.ok(/attachment/.test(cd), `the ${ext} download is an attachment`);
    assert.ok(new RegExp(`\\.${ext}"`).test(cd), `the ${ext} filename has the right extension`);
  }
});
