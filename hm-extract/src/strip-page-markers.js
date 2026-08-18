/**
 * Ported VERBATIM from core/src/knowledge/document-first-ingestion.js.
 * See chunker.js's header for why this is a port, not a reimplementation.
 *
 * Split page markers out of parser markdown, into a position map.
 *
 * Page markers are METADATA and must never reach the chunker. Two things
 * break when they stay inline:
 *   1. chunkText() chunks them as CONTENT, so `<!-- page 7 -->` lands inside
 *      a segment's text and gets embedded and shown as evidence.
 *   2. Segments resolve their offset by locating a 60-char prefix in the
 *      source (indexOf). A prefix straddling a marker no longer matches, so
 *      the segment gets startOffset=null and can never be cited to a page.
 *
 * Returns the text with markers removed plus their positions IN THE CLEANED
 * STRING, so the page map and the segment offsets share one coordinate
 * system. Handles both emitters: Docling's `<!-- page N -->` (kept here for
 * completeness even though hm-extract's own parser is anydoc, not docling —
 * anydoc emits no page markers at all, per HM_EXTRACT_PLAN.md §11, so this
 * regex will simply never match on anydoc output; kept because a caller may
 * still pipe fast-pdf/docling output through this same service in future)
 * and fast-pdf's `-- N of M --`.
 *
 * @param {string} raw
 * @returns {{ text: string, marks: Array<{at:number, page:number}> }}
 */
export function stripPageMarkers(raw) {
  const input = String(raw || '');
  if (!input) return { text: '', marks: [] };
  // One alternation, one pass — two passes would invalidate the first pass's offsets.
  const RE = /[ \t]*\n?<!--\s*page\s+(\d+)\s*-->[ \t]*\n?|[ \t]*\n?--\s*(\d+)\s+of\s+\d+\s*--[ \t]*\n?/gi;
  let out = '';
  let last = 0;
  const marks = [];
  for (const m of input.matchAll(RE)) {
    const page = Number(m[1] ?? m[2]);
    out += input.slice(last, m.index);
    // NEVER GLUE TWO WORDS TOGETHER. The pattern deliberately absorbs the
    // newline on each side of the marker so a stripped marker leaves no
    // blank line — but on `alpha\n-- 1 of 3 --\nbeta` that removes BOTH
    // newlines and yields "alphabeta", corrupting the text and every
    // embedding derived from it. Re-insert a single separator only when the
    // join would otherwise be word-to-word.
    const prevCh = out.slice(-1);
    const nextCh = input[m.index + m[0].length] || '';
    if (prevCh && nextCh && !/\s/.test(prevCh) && !/\s/.test(nextCh)) out += '\n';
    if (Number.isFinite(page) && page > 0) marks.push({ at: out.length, page });
    last = m.index + m[0].length;
  }
  if (!marks.length) return { text: input, marks: [] };
  out += input.slice(last);
  return { text: out, marks };
}
