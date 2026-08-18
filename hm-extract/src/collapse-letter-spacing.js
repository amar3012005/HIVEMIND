/**
 * Ported VERBATIM from core/src/knowledge/enterprise/docling-adapter.js.
 * See chunker.js's header for why this is a port, not a reimplementation.
 *
 * Collapse letter-spacing artifacts from designed/branded PDFs.
 *
 * Some PDFs carry a text layer with per-character tracking, so a title like
 * "GEMEINWOHL-BILANZ" extracts as "G E M E I N W O H L - B I L A N Z". We
 * collapse any run of >=5 single word-characters each separated by
 * whitespace back into a word. The single-char constraint means normal
 * prose ("I am a x") is never touched — only true letter-spacing runs match.
 */
export function collapseLetterSpacing(s) {
  if (!s || typeof s !== 'string') return s;
  let out = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  out = out.replace(/(?<=^|\s)[^\W\d_](?:\s+[^\W\d_]){4,}(?=\s|$)/gu, (run) => run.replace(/\s+/g, ''));
  return out;
}
