/**
 * Fast PDF text extraction via pdf-parse (no OCR, no layout).
 *
 * Returns extracted text in <2s for text-native PDFs of any size.
 * Use as Tier 1 parser before falling back to Docling/Vision.
 */

import fs from 'fs';

let _PDFParseClass = null;
async function loadPdfParse() {
  if (_PDFParseClass === null) {
    try {
      const mod = await import('pdf-parse');
      // v2 exports { PDFParse } class; v1 exports default function
      _PDFParseClass = mod.PDFParse || mod.default || false;
    } catch {
      _PDFParseClass = false;
    }
  }
  return _PDFParseClass;
}

/**
 * @param {string} filePath
 * @returns {Promise<{text: string, pages: number, isImageHeavy: boolean, error: string|null}>}
 */
export async function fastPdfExtract(filePath) {
  const PDFParse = await loadPdfParse();
  if (!PDFParse) return { text: '', pages: 0, isImageHeavy: true, error: 'pdf-parse not available' };
  try {
    const buf = fs.readFileSync(filePath);
    let text = '';
    let pages = 0;
    // v2 API: new PDFParse({ data }) → .getInfo() + .getText()
    if (typeof PDFParse === 'function' && /^class\s/.test(PDFParse.toString())) {
      const p = new PDFParse({ data: buf });
      try {
        const info = await p.getInfo();
        const t = await p.getText();
        text = (t.text || t.content || '').toString().trim();
        // info.pages can be array (page metadata) — use length; fall back to numPages
        pages = Array.isArray(info.pages) ? info.pages.length : (info.numPages || info.numpages || 0);
      } finally {
        try { await p.destroy?.(); } catch {}
      }
    } else {
      // v1 API: function call
      const data = await PDFParse(buf, { max: 0 });
      text = (data.text || '').trim();
      pages = data.numpages || 0;
    }
    // If pages count is 0 but we have text, infer from page-marker pattern
    if (pages === 0 && text) {
      const pageMatches = text.match(/-- \d+ of (\d+) --/);
      if (pageMatches) pages = Number(pageMatches[1]);
    }
    const avgPerPage = pages > 0 ? text.length / pages : text.length;
    // Image-heavy when:
    //   - avg <300 chars/page (was 150, too strict — header+footer+labels
    //     could exceed 150 even on a scanned page), OR
    //   - text extracted has no alphanumeric word longer than 4 chars
    //     (OCR garbage / glyph-only output), OR
    //   - total text is very small (<2000 chars) AND avg <500 (catches the
    //     long-single-page-text-PDF exception while still flagging short
    //     image-heavy docs).
    const longAlnumWord = /\b[A-Za-z0-9]{5,}\b/.test(text);
    const isImageHeavy = !longAlnumWord
      || avgPerPage < 300
      || (text.length < 2000 && avgPerPage < 500);
    // FIGURE-RICH: carries a real text layer (so NOT image-heavy) but far too
    // little text per page to be prose — the signature of a slide deck or report
    // where charts and diagrams hold much of the meaning.
    //
    // A prose page runs ~2500-3000 chars. A real 54-page strategy deck measured
    // 474. Because it had text it was not image-heavy, so it took the Docling path
    // and every figure was lost — the EV-adoption curve, the market-collapse
    // chart, the product timeline, the partner-split — none of which exist as text
    // anywhere in that file. This was the last capability gap against supermemory,
    // whose chunks for the SAME document carry "Diagram showing energy flow within
    // a home system…".
    //
    // Vision already handles precisely this and is proven on real uploads
    // (branding PDFs, 3-10s each); it was simply unreachable for a deck that
    // happened to carry captions.
    const isFigureRich = !isImageHeavy
      && longAlnumWord
      && pages >= Number(process.env.KB_FIGURE_RICH_MIN_PAGES || 4)
      && avgPerPage < Number(process.env.KB_FIGURE_RICH_CHARS_PER_PAGE || 900);
    return { text, pages, isImageHeavy, isFigureRich, avgPerPage, error: null };
  } catch (err) {
    return { text: '', pages: 0, isImageHeavy: true, error: err.message };
  }
}
