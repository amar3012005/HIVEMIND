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
    // Image-heavy if avg <150 chars/page AND total <2000 chars (allows long single-page text PDFs)
    const isImageHeavy = avgPerPage < 150 && text.length < 2000;
    return { text, pages, isImageHeavy, error: null };
  } catch (err) {
    return { text: '', pages: 0, isImageHeavy: true, error: err.message };
  }
}
