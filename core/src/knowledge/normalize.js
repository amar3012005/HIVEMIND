/**
 * normalize.js — THE ONE SEAM every format passes through.
 *
 * Contract:
 *   normalize(buffer, { mime, filename }) -> { markdown, text, meta, tier }
 *
 *   markdown  string with '#' headings and '|' tables, or NULL. Never flat text pretending to be
 *             markdown — ingestion prefers `.markdown`, so aliasing made flat tiers claim structure
 *             they did not have and the chunker's '#' detection silently found nothing.
 *   text      the plain extraction. Always present on success.
 *   tier      which implementation answered, so "which path ran?" is answerable from the row.
 *   meta      per-tier extras (pages, tables, wordCount, binary_ratio on failure).
 *
 * WHY THIS EXISTS. Format knowledge was in two places: server.js's FORMAT_PROFILES/tier chain for
 * uploads, and document-chunker.parseFile for /api/enterprise/upload/detect. Consequences measured
 * in production:
 *   - the same PPTX ingested once as 270 segments and once as 13
 *   - docx / pptx / html at 0% markdown headings while .md sat at 100%
 *   - a DOCX heading fix landed in parseFile, a path uploads never take, and did nothing
 * One seam makes a format one implementation plus one fixture, and makes it impossible to ship a
 * format that silently emits no structure.
 *
 * NOT a parser. Every tier here delegates to the extractor that already exists (docling, groq-vision,
 * fast-pdf, mammoth, SheetJS, whisper). This file only guarantees the CONTRACT.
 */

// ── binary sniff ─────────────────────────────────────────────────────────────────────────────────
// Ratio of NULs and C0 controls (excluding tab/newline/CR) plus U+FFFD. A ZIP or PDF container runs
// far above the threshold; UTF-8 prose is zero. Deliberately not a mime check — the failure this
// stops was a .pptx whose bytes were stringified regardless of its declared mime.
export function binaryRatio(text) {
  const s = String(text || '');
  if (!s.length) return 0;
  let bad = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xFFFD) bad += 1;
  }
  return bad / s.length;
}

export function looksBinary(text, threshold = Number(process.env.KB_BINARY_RATIO_THRESHOLD || 0.02)) {
  return binaryRatio(text) > threshold;
}

// REJECT above the threshold, SANITISE below it. Measured after purging the corrupt documents: 10
// segments still carried control bytes — one at 34.6% (genuine garbage, which the threshold now
// rejects) and the rest at 0.1-2.5%, which is stray C0 noise inside otherwise-good docling text.
// Throwing away good text over a few bytes would be as wrong as indexing binary, so low-ratio input
// is cleaned instead of refused. Tab/newline/CR are preserved — they carry the structure the chunker
// reads.
export function sanitizeText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\uFFFD/g, '');
}

export function hasMarkdownHeading(text) {
  return /(^|\n)#{1,6}\s/.test(String(text || ''));
}

/** markdown or null — never flat text dressed as markdown. */
export function asMarkdown(text) {
  return hasMarkdownHeading(text) ? String(text) : null;
}

// ── HTML -> markdown ─────────────────────────────────────────────────────────────────────────────
// Shared by the DOCX tier (mammoth.convertToHtml) and the HTML tier, so both gain '#' headings from
// one implementation instead of two.
export function htmlToMarkdown(html) {
  return String(html || '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const extOf = (filename) => String(filename || '').toLowerCase().split('.').pop() || '';

/**
 * The seam. Delegates to the existing extractor for the format and enforces the contract.
 * Never throws for an unparseable input — returns { ok: false, error } so the caller can record
 * parse_status:'failed' instead of indexing garbage.
 */
export async function normalize(buffer, { mime = '', filename = '' } = {}) {
  const ext = extOf(filename);
  const fail = (tier, error, meta = {}) => ({ ok: false, tier, markdown: null, text: '', meta: { ...meta, error }, error });

  if (!buffer || !buffer.length) return fail('none', 'empty file');

  // DOCX — convertToHtml preserves Word's Heading 1/2/3 styles; extractRawText discards them BY
  // DESIGN, which is why docx sat at 0% markdown headings corpus-wide.
  if (ext === 'docx' || mime.includes('wordprocessingml')) {
    try {
      const mod = await import('mammoth');
      const mammoth = mod.default || mod;
      const html = await mammoth.convertToHtml({ buffer });
      const md = htmlToMarkdown(html?.value || '');
      if (md) return { ok: true, tier: 'mammoth-markdown', markdown: asMarkdown(sanitizeText(md)), text: sanitizeText(md), meta: {} };
    } catch (e) {
      // Fall through to raw text rather than failing the upload, but SAY headings are gone.
      console.warn(`[normalize] docx convertToHtml failed (${e.message}) — headings lost for ${filename}`);
    }
    try {
      const mod = await import('mammoth');
      const mammoth = mod.default || mod;
      const raw = await mammoth.extractRawText({ buffer });
      const text = String(raw?.value || '');
      if (!text.trim()) return fail('mammoth', 'docx produced no text');
      return { ok: true, tier: 'mammoth-raw', markdown: null, text: sanitizeText(text), meta: { headings_lost: true } };
    } catch (e) {
      return fail('mammoth', `docx unreadable: ${e.message}`);
    }
  }

  // HTML — same converter as DOCX, so <h1>-<h6> become '#' instead of being stripped to prose.
  if (ext === 'html' || ext === 'htm' || mime.includes('text/html')) {
    const md = htmlToMarkdown(buffer.toString('utf-8'));
    if (!md.trim()) return fail('html', 'html produced no text');
    return { ok: true, tier: 'html-markdown', markdown: asMarkdown(sanitizeText(md)), text: sanitizeText(md), meta: {} };
  }

  // Text-ish. Markdown only when it actually carries headings.
  if (['md', 'markdown', 'txt', 'text', 'csv', 'json', 'log'].includes(ext) || mime.startsWith('text/')) {
    const text = buffer.toString('utf-8');
    if (looksBinary(text)) {
      return fail('text', `declared ${ext || mime} but ${Math.round(100 * binaryRatio(text))}% of bytes are non-text`,
        { binary_ratio: binaryRatio(text) });
    }
    const clean = sanitizeText(text);
    return { ok: true, tier: ext === 'md' || ext === 'markdown' ? 'markdown-native' : 'plain-text',
      markdown: asMarkdown(clean), text: clean, meta: {} };
  }

  // Anything else (pdf, pptx, xlsx, odt, rtf, epub, images) belongs to the upload tier chain —
  // docling for office formats, vision for scans/figure-rich PDFs, fast-pdf for text PDFs. This seam
  // does NOT re-implement them; it refuses to guess, which is the behaviour whose absence let a ZIP
  // container be stringified into 636 indexed segments.
  const text = buffer.toString('utf-8');
  if (looksBinary(text)) {
    return fail('unparsed', `no parser for ${ext || mime || 'this file'} and the bytes are `
      + `${Math.round(100 * binaryRatio(text))}% non-text (binary container). Nothing indexed. `
      + `Office formats need docling (DOCLING_URL); PDFs route to vision or fast-pdf.`,
      { binary_ratio: binaryRatio(text) });
  }
  const clean = sanitizeText(text);
  return { ok: true, tier: 'plain-text', markdown: asMarkdown(clean), text: clean, meta: {} };
}

export default normalize;
