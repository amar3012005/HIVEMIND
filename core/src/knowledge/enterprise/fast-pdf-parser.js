/**
 * Fast PDF text extraction via pdf-parse (no OCR, no layout).
 *
 * Returns extracted text in <2s for text-native PDFs of any size.
 * Use as Tier 1 parser before falling back to Docling/Vision.
 */

import fs from 'fs';

let _pdfParse = null;
async function loadPdfParse() {
  if (!_pdfParse) {
    try {
      const mod = await import('pdf-parse');
      _pdfParse = mod.default || mod;
    } catch {
      _pdfParse = false;
    }
  }
  return _pdfParse;
}

/**
 * @param {string} filePath
 * @returns {Promise<{text: string, pages: number, isImageHeavy: boolean, error: string|null}>}
 */
export async function fastPdfExtract(filePath) {
  const pdfParse = await loadPdfParse();
  if (!pdfParse) return { text: '', pages: 0, isImageHeavy: true, error: 'pdf-parse not available' };
  try {
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf, { max: 0 });
    const text = (data.text || '').trim();
    const pages = data.numpages || 0;
    // Heuristic: if avg chars/page < 150, treat as image-heavy → trigger OCR
    const avgPerPage = pages > 0 ? text.length / pages : 0;
    const isImageHeavy = avgPerPage < 150;
    return { text, pages, isImageHeavy, error: null };
  } catch (err) {
    return { text: '', pages: 0, isImageHeavy: true, error: err.message };
  }
}
