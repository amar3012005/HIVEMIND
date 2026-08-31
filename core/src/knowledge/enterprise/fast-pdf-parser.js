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
 * Detect a PDF text layer that exists in quantity but is not usable prose.
 *
 * OCR-backed archive PDFs often expose each glyph as a separate positioned
 * token ("Ar t D ir e c t or"). Character count and words such as "Director"
 * elsewhere make the old image-heavy test pass, but lexical retrieval,
 * headings, entities and embeddings are then built from corrupted text. Keep
 * this language-neutral over Latin-script tokens and report the measurements so
 * routing decisions are observable and testable.
 */
export function assessTextLayerQuality(text) {
  const source = String(text || '');
  const tokens = source.match(/\p{L}+/gu) || [];
  const latin = tokens.filter((token) => /[A-Za-z]/.test(token));
  const count = latin.length;
  const shortRatio = count ? latin.filter((token) => token.length <= 2).length / count : 0;
  const singleRatio = count ? latin.filter((token) => token.length === 1).length / count : 0;
  const averageTokenLength = count
    ? latin.reduce((sum, token) => sum + token.length, 0) / count
    : 0;
  const corrupt = count >= 200
    && shortRatio >= Number(process.env.KB_PDF_CORRUPT_SHORT_TOKEN_RATIO || 0.55)
    && singleRatio >= Number(process.env.KB_PDF_CORRUPT_SINGLE_TOKEN_RATIO || 0.32)
    && averageTokenLength <= Number(process.env.KB_PDF_CORRUPT_AVG_TOKEN_LENGTH || 3.6);
  return { corrupt, tokenCount: count, shortRatio, singleRatio, averageTokenLength };
}

/**
 * Classify whether a PDF has usable native text without confusing brevity with
 * absence. A one-page invoice, certificate, title sheet, or short note can have
 * fewer than 300 characters and still possess a perfectly valid text layer.
 * Raster pages are discovered separately with pdfimages and selectively sent
 * to vision; document-wide vision is reserved for PDFs with no usable text.
 */
export function classifyPdfTextLayer(text, pages = 0) {
  const source = String(text || '').trim();
  const meaningfulTokens = source.match(/[\p{L}\p{N}]{3,}/gu) || [];
  const hasUsableTextLayer = source.length >= 8 && meaningfulTokens.length >= 1;
  const pageCount = Math.max(1, Number(pages) || 1);
  const avgPerPage = source.length / pageCount;
  return {
    hasUsableTextLayer,
    isImageHeavy: !hasUsableTextLayer,
    avgPerPage,
  };
}

/**
 * Split one page near paragraph/sentence/word boundaries with bounded overlap.
 * Stored offsets remain deterministic, while neither the chunk end nor the next
 * chunk start can bisect a word. Page and heading metadata are added by the
 * caller because this helper deliberately owns text boundaries only.
 */
export function chunkTextAtSemanticBoundaries(text, target = 1500, overlap = 200) {
  const source = String(text || '').trim();
  if (!source) return [];
  const size = Math.max(200, Number(target) || 1500);
  const shared = Math.max(0, Math.min(size - 50, Number(overlap) || 0));
  if (source.length <= size) return [source];
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + size);
    if (end < source.length) {
      const floor = start + Math.floor(size * 0.65);
      const window = source.slice(floor, end);
      const candidates = [
        [...window.matchAll(/\n\s*\n/gu)].at(-1),
        [...window.matchAll(/(?<=[.!?。！？])\s+/gu)].at(-1),
        [...window.matchAll(/\n/gu)].at(-1),
        [...window.matchAll(/\s+/gu)].at(-1),
      ];
      const boundary = candidates.find(Boolean);
      if (boundary) end = floor + boundary.index + boundary[0].length;
    }
    const piece = source.slice(start, end).trim();
    if (piece.length >= 50) chunks.push(piece);
    if (end >= source.length) break;
    let next = Math.max(start + 1, end - shared);
    while (next < end && next > 0 && /\p{L}|\p{N}/u.test(source[next - 1])
      && /\p{L}|\p{N}/u.test(source[next])) next += 1;
    start = Math.min(end, next);
  }
  return chunks;
}

/**
 * @param {string} filePath
 * @returns {Promise<{text: string, pages: number, isImageHeavy: boolean, error: string|null}>}
 */
export async function fastPdfExtract(filePath) {
  const PDFParse = await loadPdfParse();
  if (!PDFParse) return { text: '', pages: 0, hasUsableTextLayer: false, isImageHeavy: true, error: 'pdf-parse not available' };
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
    const classification = classifyPdfTextLayer(text, pages);
    const { avgPerPage, hasUsableTextLayer, isImageHeavy } = classification;
    const textQuality = assessTextLayerQuality(text);
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
      && hasUsableTextLayer
      && pages >= Number(process.env.KB_FIGURE_RICH_MIN_PAGES || 4)
      && avgPerPage < Number(process.env.KB_FIGURE_RICH_CHARS_PER_PAGE || 900);
    return {
      text, pages, isImageHeavy, isFigureRich, isTextLayerCorrupt: textQuality.corrupt,
      hasUsableTextLayer,
      textQuality, avgPerPage, error: null,
    };
  } catch (err) {
    return { text: '', pages: 0, hasUsableTextLayer: false, isImageHeavy: true, error: err.message };
  }
}

/**
 * Split pdf-parse's flat text into page blocks without dropping the text before
 * the first emitted page marker.
 *
 * pdf-parse does not consistently emit `-- 1 of N --` at byte zero. A common
 * shape is:
 *
 *   <all page-one text>\n-- 2 of 2 --\n<page-two text>
 *
 * The previous upload adapter iterated only the marker captures, so the
 * preamble (the whole first page in this shape) vanished from hybrid chunks.
 * The document still reported the full parser character count, which made the
 * partial ingest look healthy. Preserve that preamble as the page immediately
 * preceding the first marker, and merge duplicate page blocks defensively.
 */
export function splitFastPdfPageBlocks(text) {
  const source = String(text || '');
  if (!source.trim()) return [];
  const parts = source.split(/\n?-- (\d+) of \d+ --\n?/);
  const blocks = [];
  const firstMarkedPage = Number(parts[1]);
  const preamble = String(parts[0] || '').trim();
  if (preamble.length >= 20) {
    blocks.push({
      page: Number.isFinite(firstMarkedPage) && firstMarkedPage > 1
        ? firstMarkedPage - 1
        : 1,
      text: preamble,
    });
  }
  for (let i = 1; i < parts.length; i += 2) {
    const page = Number(parts[i]);
    const pageText = String(parts[i + 1] || '').trim();
    if (!Number.isFinite(page) || page <= 0 || pageText.length < 20) continue;
    const previous = blocks.at(-1);
    if (previous?.page === page) previous.text = `${previous.text}\n${pageText}`.trim();
    else blocks.push({ page, text: pageText });
  }
  if (!blocks.length) return [{ page: 1, text: source.trim() }];
  return blocks;
}
