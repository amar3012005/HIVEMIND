/**
 * Excel Parser (XLSX / XLS)
 *
 * Two-step upload flow:
 *   1. parseExcelSheets(buffer) — detect sheets + preview for LLM
 *   2. parseSheet(buffer, sheetName) — full parse of a selected sheet
 *   3. groupRows(rows, headers, groupSize) — chunk rows for ingestion
 *
 * @module knowledge/enterprise/excel-parser
 */

import XLSX from 'xlsx';

// ── Helpers ─────────────────────────────────────────────

/**
 * Convert an Excel serial date number to an ISO date string.
 * Excel epoch: 1900-01-01 (with the Lotus 1-2-3 leap year bug at serial 60).
 */
function excelDateToISO(serial) {
  if (typeof serial !== 'number' || isNaN(serial)) return serial;
  // Only convert values that look like date serials (> 0, < 2958466 which is 9999-12-31)
  if (serial <= 0 || serial > 2958466) return serial;
  const utcDays = Math.floor(serial) - 25569; // 25569 = days between 1900-01-01 and 1970-01-01
  const utcMs = utcDays * 86400 * 1000;
  const fractionalDay = serial - Math.floor(serial);
  const msInDay = Math.round(fractionalDay * 86400 * 1000);
  const d = new Date(utcMs + msInDay);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Format a cell value to a string, handling dates and nulls.
 */
function formatCellValue(value, cell) {
  if (value == null) return '';
  // If xlsx decoded it as a Date object already
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // If the cell has a date format code, convert the serial
  if (cell && cell.t === 'd') return excelDateToISO(value);
  return String(value);
}

/**
 * Read workbook from buffer with standard options.
 */
function readWorkbook(buffer) {
  return XLSX.read(buffer, {
    type: 'buffer',
    cellDates: true,   // parse dates as JS Date objects
    cellNF: true,       // keep number format strings
    cellStyles: false,  // skip styles for speed
  });
}

/**
 * Get sheet data as array-of-arrays (raw) with cell objects.
 */
function sheetToAOA(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
}

/**
 * Format rows as a readable text table (tab-separated).
 */
function rowsToText(headers, dataRows) {
  const lines = [headers.join('\t')];
  for (const row of dataRows) {
    const vals = headers.map(h => {
      const v = row[h];
      return v == null ? '' : String(v);
    });
    lines.push(vals.join('\t'));
  }
  return lines.join('\n');
}

// ── Exports ─────────────────────────────────────────────

/**
 * Detect step: list all sheets with row counts, headers, and a preview.
 *
 * @param {Buffer} buffer - XLSX/XLS file buffer
 * @returns {Array<Object>} sheet info objects
 */
export function parseExcelSheets(buffer) {
  const wb = readWorkbook(buffer);
  const results = [];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const aoa = sheetToAOA(sheet);

    if (aoa.length === 0) {
      results.push({ name, row_count: 0, column_count: 0, headers: [], preview: '', empty: true });
      continue;
    }

    const headers = aoa[0].map(v => (v == null ? '' : String(v)));
    const columnCount = headers.length;
    const dataRows = aoa.slice(1);
    const rowCount = dataRows.length;

    // Build preview from first 5 data rows
    const previewLines = [headers.join(' | ')];
    const previewSlice = dataRows.slice(0, 5);
    for (const row of previewSlice) {
      previewLines.push(row.map(v => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        return String(v);
      }).join(' | '));
    }

    results.push({
      name,
      row_count: rowCount,
      column_count: columnCount,
      headers,
      preview: previewLines.join('\n'),
      empty: rowCount === 0,
    });
  }

  return results;
}

/**
 * Ingest step: fully parse a specific sheet.
 *
 * @param {Buffer} buffer - XLSX/XLS file buffer
 * @param {string} sheetName - name of the sheet to parse
 * @returns {Object} parsed sheet data with rows, headers, and raw_text
 */
export function parseSheet(buffer, sheetName) {
  const wb = readWorkbook(buffer);
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in workbook`);

  // Get headers from first row
  const aoa = sheetToAOA(sheet);
  if (aoa.length === 0) {
    return { name: sheetName, headers: [], rows: [], row_count: 0, column_count: 0, raw_text: '' };
  }

  const headers = aoa[0].map(v => (v == null ? '' : String(v)));

  // Parse as objects keyed by header
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Normalize date values in rows
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (row[key] instanceof Date) {
        row[key] = row[key].toISOString().slice(0, 10);
      }
    }
  }

  const rawText = rowsToText(headers, rows);

  return {
    name: sheetName,
    headers,
    rows,
    row_count: rows.length,
    column_count: headers.length,
    raw_text: rawText,
  };
}

/**
 * Chunk rows into groups for memory ingestion.
 *
 * @param {Array<Object>} rows - row objects from parseSheet
 * @param {Array<string>} headers - column headers
 * @param {number} [groupSize=30] - rows per group
 * @returns {Array<Object>} chunked groups
 */
export function groupRows(rows, headers, groupSize = 30) {
  const groups = [];
  const headerLine = `Headers: ${headers.join(' | ')}`;

  for (let i = 0; i < rows.length; i += groupSize) {
    const slice = rows.slice(i, i + groupSize);
    const lines = [headerLine];

    for (let j = 0; j < slice.length; j++) {
      const rowNum = i + j + 1;
      const vals = headers.map(h => {
        const v = slice[j][h];
        return v == null ? '' : String(v);
      });
      lines.push(`Row ${rowNum}: ${vals.join(' | ')}`);
    }

    groups.push({
      start_row: i,
      end_row: i + slice.length - 1,
      row_count: slice.length,
      content: lines.join('\n'),
      rows: slice,
    });
  }

  return groups;
}
