/**
 * Authoritative page/unit count for a document, used by BOTH the pre-admit quota
 * check and the durable kbPages settle so the two can never disagree.
 *
 * WHY THIS EXISTS
 * Before this, `_estimatePages()` returned 1 for anything that was not a PDF, and
 * the durable meter settled from `result.pages`, which for OOXML fell through to
 * "count of DISTINCT pages actually segmented". Measured on a real 15-slide deck:
 *   reality 15 slides · pre-admit estimate 1 · billed 5
 * A 15-slide deck therefore consumed 5 pages of quota, and the pre-admit kbPages
 * limit was unenforceable for every PPTX/DOCX/XLSX — only PDFs were counted truly.
 *
 * OOXML files are ZIP containers, so the real unit count is a cheap directory
 * read — no parse, no render, no LLM:
 *   pptx -> ppt/slides/slideN.xml           (exact: one entry per slide)
 *   xlsx -> xl/worksheets/sheetN.xml        (exact: one entry per sheet)
 *   docx -> docProps/app.xml <Pages>        (only if the writing app recorded it)
 *
 * DOCX IS DELIBERATELY ALLOWED TO RETURN NULL. A .docx has no page count of its
 * own — pagination is a rendering result, not a stored property — so unless Word
 * left a <Pages> value in app.xml there is nothing true to report. Returning a
 * guess here would bill a number nobody can verify, which is the defect this file
 * exists to remove. Callers treat null as "unknown" and fall back to their own
 * evidence, exactly as they did before.
 */

import path from 'path';

const OOXML = new Set(['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']);

function extOf(filename) {
  return String(path.extname(String(filename || '')) || '').replace('.', '').toLowerCase();
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<number|null>} exact count, or null when it cannot be known
 */
export async function countPages(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const ext = extOf(filename);

  if (ext === 'pdf') {
    try {
      const { PDFParse } = await import('pdf-parse');
      const info = await new PDFParse({ data: buffer }).getInfo();
      const total = Number(info?.total || info?.pages?.length || 0);
      return Number.isFinite(total) && total > 0 ? total : null;
    } catch { return null; }
  }

  if (!OOXML.has(ext)) return null;
  // Legacy binary formats (.ppt/.doc/.xls) are NOT zips — a JSZip load throws on
  // them. They are refused at KB_EXTENSIONS anyway; bail before pretending.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return null;

  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files);

    if (ext === 'pptx') {
      const n = names.filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f)).length;
      return n > 0 ? n : null;
    }
    if (ext === 'xlsx') {
      const n = names.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(f)).length;
      return n > 0 ? n : null;
    }
    if (ext === 'docx') {
      const app = zip.file('docProps/app.xml');
      if (!app) return null;
      const xml = await app.async('string');
      const m = /<Pages>(\d+)<\/Pages>/i.exec(xml);
      const n = m ? Number(m[1]) : 0;
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}

export default countPages;
