// CSV/TSV parser for the TS-04 ledger import. No dependencies — hand-rolled
// quote-aware parser for the real-world Indonesian Excel export.
//
// Handles: BOM strip, CRLF/LF, quoted cells with embedded delimiters/newlines,
// delimiter auto-detection (`,` / `;` / TAB — id-ID Excel defaults to `;`, and a
// Excel "Save as text" export is TAB-separated), NUL-byte rejection, size cap,
// spreadsheet-formula-cell detection (§3.7), Indonesian amount normalization
// (1.750.000 / 1,750,000 / 1750000 → 1750000), and date normalization
// (YYYY-MM-DD / DD/MM/YYYY / Excel serial → ISO).

'use strict';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// --- delimiter detection ----------------------------------------------------

// Count a candidate delimiter on the header line, ignoring quoted spans.
// Quote-awareness matters: a header cell like "amount, net" must not make `,`
// look richer than it is.
function countUnquoted(line, delim) {
  let n = 0, inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === delim) n++;
  }
  return n;
}

// Pick the delimiter by counting candidates on the first (header) line.
//
// WHY THE HEADER AND NOT THE WHOLE FILE: descriptions routinely contain commas
// ("Perjalanan dinas: Petugas A, Site Utama 02 sd 05 Oktober 2023") and semicolons, so scoring
// the data would let prose outvote the real structure. The header is column names.
//
// WHY NOT "either `,` or `;` everywhere" (the previous behaviour): a TAB-separated
// export then has no delimiter present at all — the entire row lands in one cell
// and every field reads as missing. And a `;`-separated file whose description
// happens to contain a comma would be split down the middle of a text field.
//
// Ties and all-zero fall back to TAB → `,` → `;` (a single-column file ends up
// with one cell either way, which is the honest result).
function detectDelimiter(text) {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const counts = [
    ['\t', countUnquoted(firstLine, '\t')],
    [',', countUnquoted(firstLine, ',')],
    [';', countUnquoted(firstLine, ';')],
  ];
  let best = ',';
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

// Drop the file boundary (BOM, leading blank lines, trailing whitespace) WITHOUT
// touching indentation inside the data. A blanket trim() would also eat the
// leading whitespace of the first field of a TAB export, which then reads as an
// empty header cell.
function trimBoundary(text) {
  let t = text.replace(/^\uFEFF/, '');
  while (/^[ \t]*\r?\n/.test(t)) t = t.replace(/^[ \t]*\r?\n/, ''); // leading blank lines
  return t.replace(/\s+$/, '');
}

// --- parsing ---------------------------------------------------------------

// Split one physical line into cells on `delim`, honoring double-quoted fields
// (a `""` inside a quoted field is an escaped quote). Returns array of cells, or
// null when the line ends inside an unclosed quote.
function parseLine(line, delim = ',') {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      cells.push(cur); cur = '';
    } else cur += ch;
  }
  if (inQuotes) return null; // unterminated quote — caller treats as error
  cells.push(cur);
  return cells;
}

// Split the whole text into rows honoring quoted multi-line cells.
// Quotes are kept VERBATIM (including the closing one) — parseLine does the
// unquoting. Dropping the closing quote here left an odd number of quotes on
// the line, which made parseLine treat the rest of the row as one cell.
function splitRows(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '""'; i++; }   // escaped quote
        else { inQuotes = false; cur += ch; }            // closing quote — keep it
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
      cur += ch;
    } else if (ch === '\n') {
      rows.push(cur); cur = '';
    } else if (ch === '\r') {
      // swallow CR (CRLF) — keep LF as the row separator
    } else cur += ch;
  }
  if (cur.length > 0 || rows.length === 0) rows.push(cur);
  if (inQuotes) throw new Error('unterminated quoted field');
  return rows;
}

// --- public API --------------------------------------------------------------

// Parse CSV text → { headers, rows } where rows are arrays of raw strings.
// Throws descriptive errors for: NUL bytes, size cap, empty file, unterminated
// quotes, ragged rows (header/row width mismatch is caller's job).
function parse(text, { maxBytes = MAX_BYTES } = {}) {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`file too large (max ${maxBytes} bytes)`);
  }
  if (text.includes('\0')) throw new Error('binary content not allowed (NUL byte)');

  text = trimBoundary(text);
  if (text.length === 0) throw new Error('file is empty');

  // One delimiter for the whole file, chosen from the header. Mixed delimiters
  // within a file are not a thing an export produces.
  const delim = detectDelimiter(text);

  const rows = splitRows(text);
  const header = parseLine(rows[0], delim);
  if (!header) throw new Error('header row has an unterminated quoted field');
  // A single-cell header on a multi-line file means we guessed the wrong
  // delimiter — say so instead of reporting every column as missing downstream.
  if (header.length === 1 && rows.length > 1 && rows[1].includes(delim === '\t' ? ',' : '\t')) {
    throw new Error('could not detect the column delimiter (expected comma, semicolon or tab)');
  }
  if (header.length === 0) throw new Error('empty header row');

  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (line.trim() === '') continue; // blank lines are noise
    const cells = parseLine(line, delim);
    if (!cells) throw new Error(`row ${i + 1}: unterminated quoted field`);
    data.push(cells);
  }

  return { headers: header, rows: data, delimiter: delim };
}

// --- cell normalization (shared by mapper + tests) ---------------------------

// Indonesian money → integer rupiah. Accepts 1.750.000 / 1,750,000 / 1750000 /
// 1.750.000,50 / "1.750.000,50". Returns integer (rounded to whole rupiah) or
// null when not a number.
function toIntegerRupiah(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s/g, '');
  if (s === '') return null;
  if (/^[=+\-@]/.test(s)) return null; // formula cell — never evaluate
  if (!/^[+-]?[\d.,]+$/.test(s)) return null;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Indonesian: dots = thousands, comma = decimal
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    s = s.replace(/,/g, ''); // "1,750,000" = thousands → 1750000
  } else if (hasDot) {
    const parts = s.split('.');
    const last = parts[parts.length - 1];
    if (last.length === 3 && parts.length > 1) {
      s = s.replace(/\./g, ''); // "1.750.000" = thousands
    }
    // else "1.5" → 1.5 decimal, handled below
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

// Excel serial date (1900 date system) → ISO 'YYYY-MM-DD'. Excel's system has a
// deliberate off-by-one: it treats 1900 as a leap year, so serial 60 is the
// non-existent 1900-02-29. The usual anchor (1899-12-30) absorbs that error for
// every date after 1900-03-01, which is every date this app will ever see.
//
// WHY THIS EXISTS: the real-ledger fixture carries Excel serials (`45200`), which
// is what Excel writes when a date column has no display format — "Save as text"
// gives the raw number, not the pretty date. Without this the entire canonical
// fixture fails to import.
function excelSerialToIso(n) {
  // 1..60000 ≈ 1900-01-01 … 2064-03-27. Lower bound 1 keeps a cheap guard against
  // treating small integers (a quantity of 61) as dates; the mapper only applies
  // this to date columns, but the bound documents the intent.
  if (!Number.isInteger(n) || n < 1 || n > 60000) return null;
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Date → ISO 'YYYY-MM-DD'. Accepts YYYY-MM-DD / YYYY/MM/DD / DD/MM/YYYY /
// DD-MM-YYYY / an Excel serial number. Returns string or null.
function toIsoDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [_, y, mo, d] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const m2 = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m2) {
    const [_, d, mo, y] = m2;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // Excel serial — only when the cell has no date shape at all.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const iso = excelSerialToIso(Math.floor(Number(s)));
    if (iso) return iso;
  }
  return null;
}

module.exports = { parse, splitRows, parseLine, toIntegerRupiah, toIsoDate, detectDelimiter, excelSerialToIso, MAX_BYTES };
