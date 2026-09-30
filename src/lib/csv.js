// CSV parser for the TS-04 ledger import. No dependencies — hand-rolled
// quote-aware parser for the real-world Indonesian Excel export.
//
// Handles: BOM strip, CRLF/LF, quoted cells with embedded delimiters/newlines,
// `;` vs `,` delimiter auto-detection (id-ID Excel defaults to `;`),
// NUL-byte rejection, size cap, spreadsheet-formula-cell detection (§3.7),
// Indonesian amount normalization (1.750.000 / 1,750,000 / 1750000 → 1750000),
// and date normalization (YYYY-MM-DD / DD/MM/YYYY → ISO).

'use strict';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// --- parsing ---------------------------------------------------------------

// Split one physical line of CSV text into cells, honoring double-quoted
// fields (a `""` inside a quoted field is an escaped quote). Returns array
// of cells, or null when the line ends inside an unclosed quote.
function parseLine(line) {
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
    } else if (ch === ',' || ch === ';') {
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

  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.trim();

  if (text.length === 0) throw new Error('file is empty');

  const rows = splitRows(text);
  const header = parseLine(rows[0]);
  if (!header) throw new Error('header row has an unterminated quoted field');
  if (header.length === 0) throw new Error('empty header row');

  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    if (line.trim() === '') continue; // blank lines are noise
    const cells = parseLine(line);
    if (!cells) throw new Error(`row ${i + 1}: unterminated quoted field`);
    data.push(cells);
  }

  return { headers: header, rows: data };
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

// Date → ISO 'YYYY-MM-DD'. Accepts YYYY-MM-DD / YYYY/MM/DD / DD/MM/YYYY /
// DD-MM-YYYY. Returns string or null.
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
  return null;
}

module.exports = { parse, splitRows, parseLine, toIntegerRupiah, toIsoDate, MAX_BYTES };
