/**
 * Contextual embedding input — what a chunk should look like TO THE EMBEDDER, as opposed to what
 * it looks like to a reader.
 *
 * WHY
 *   Evidence segments were embedded as raw `content`. A chunk reading "94 Prozent" therefore
 *   became a vector for a bare number, with nothing tying it to the document or the section it
 *   came from — so it could only ever be retrieved by a query that happened to mention the same
 *   bare number. The document title and heading path were already stored on every segment; they
 *   simply never reached the embedder.
 *
 *   This is not a new idea in this codebase: the MEMORY path has embedded
 *   `${docTitle} — ${heading}\n${fact}` for a while (see the `ctxInput` sites in
 *   document-first-ingestion). Segments were the half that never got it. This module is that same
 *   convention, extracted so both halves share one definition instead of two drifting copies.
 *
 * WHAT IT IS NOT
 *   The prefix is for the VECTOR ONLY. Stored `content` is untouched: it is what the Evidence tab
 *   renders, what a citation quotes, and what the lexical lane matches. Prefixing stored content
 *   would put a synthetic header inside every quote the user sees and inside every lexical match.
 *
 * PURE + DEPENDENCY-FREE on purpose, so the rule is unit-testable without a parser, a database or
 * a native binding — the recurring lesson that a rule trapped behind heavy imports never gets a test.
 *
 * @module src/knowledge/contextual-embed-input
 */

/** Longest prefix we will prepend. Guards against a pathological heading path eating the window. */
const MAX_PREFIX_CHARS = 200;

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/**
 * Build the string to embed for one chunk.
 *
 * @param {object} ctx
 * @param {string} [ctx.documentTitle] e.g. "Q3 Pitch Deck"
 * @param {string} [ctx.headingPath]   e.g. "Unit Economics › Pricing"
 * @param {string} [ctx.heading]       fallback when no full path is known
 * @param {string} text                the chunk's own text
 * @returns {string} `[Title › Heading]\n<text>` — or the bare text when there is no context
 */
export function contextualEmbedInput(ctx = {}, text = '') {
  const body = typeof text === 'string' ? text : '';
  const title = clean(ctx.documentTitle);
  // heading_path already encodes the ancestry; fall back to the leaf heading when it is absent.
  const path = clean(ctx.headingPath) || clean(ctx.heading);

  const parts = [title, path].filter(Boolean);
  if (!parts.length) return body; // nothing to anchor to — embed the text unchanged

  let prefix = parts.join(' › ');
  if (prefix.length > MAX_PREFIX_CHARS) prefix = `${prefix.slice(0, MAX_PREFIX_CHARS - 1)}…`;
  // Bracketed and newline-separated so the embedder reads it as an anchor rather than as the
  // chunk's opening sentence.
  return `[${prefix}]\n${body}`;
}

/** Convenience: pull the context straight off a segment record's metadata. */
export function contextualEmbedInputForSegment(segment = {}) {
  const m = segment.metadata || {};
  return contextualEmbedInput(
    { documentTitle: m.document_title, headingPath: m.heading_path, heading: m.heading },
    segment.content || '',
  );
}

export default contextualEmbedInput;
