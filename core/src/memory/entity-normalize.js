/**
 * Entity-tag canonicalization — deterministic, no DB, no fuzzy, no false-merge.
 *
 * This is the MECHANICAL layer only. Semantic canonicalization (cross-lingual
 * concept names, singular vs plural, abbreviation vs full term) is done by the
 * entity-extraction LLM via strict prompt instructions — NOT here. Encoding
 * those merges as a curated dictionary would be domain-/tenant-specific
 * hardcoding that never generalizes (HVAC pairs are useless to a law firm or a
 * hospital). The LLM has the world knowledge to pick a canonical name for any
 * domain; this layer only collapses the surface-form noise the LLM cannot be
 * relied on to make byte-identical: case, unicode dash, underscore↔space,
 * whitespace, and legal-entity suffix. It deliberately does NOT do
 * fuzzy/Jaccard/embedding merging (those false-merge SKUs `_7_kW` vs `_10_kW`,
 * homonyms — see the entity/cluster red-team).
 *
 * Pure + deterministic so it can be applied symmetrically at WRITE (ingest),
 * QUERY (recall entity match), and BACKFILL — the only way the stored tag and
 * the query-extracted entity land on the same canonical string.
 */

// Legal-entity suffixes stripped so "Solvis GmbH" ≡ "Solvis". Universal
// company-naming convention (not domain-specific), and reinforces the LLM's
// own suffix-stripping. \b-anchored so it never matches inside a word ("coca"
// keeps its "co"). Trailing dot optional.
const LEGAL_SUFFIX_RE = /\b(gmbh|ag|kg|inc|llc|ltd|corp|corporation|company|co|sa|sas|srl|bv|nv|pte|plc|group|holding|holdings|ev)\b\.?/gi;

// All unicode dash/hyphen variants → ASCII hyphen (fixes "‑" vs "-").
const DASH_RE = /[‐-―−﹘﹣－]/g;

/**
 * Canonicalize a raw entity NAME (no `entity:` prefix) to a stable slug.
 * Returns null for empty/garbage input.
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeEntity(raw) {
  if (raw == null) return null;
  let s = String(raw)
    .normalize('NFKC')        // unicode compatibility fold (ﬁ→fi, full-width, etc.)
    .replace(DASH_RE, '-')    // unify dash variants BEFORE casing
    .replace(/_/g, ' ')       // tag codec: underscore-join → space
    .toLowerCase()
    .trim();

  // Strip legal suffix unless it would empty the name (e.g. an entity literally
  // named "Group" stays "group").
  const stripped = s.replace(LEGAL_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
  if (stripped.length >= 2) s = stripped;

  // Slugify: any run of non-(letter|number) → single hyphen. Keeps unicode
  // letters (umlauts) so German names survive; trims leading/trailing hyphens.
  s = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  if (!s) return null;

  return s;
}

/**
 * Canonicalize a full `entity:<Name>` tag. Non-entity tags pass through
 * unchanged. Returns the original tag if normalization yields nothing.
 * @param {string} tag
 * @returns {string}
 */
export function normalizeEntityTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('entity:')) return tag;
  const n = normalizeEntity(tag.slice('entity:'.length));
  return n ? `entity:${n}` : tag;
}

/**
 * Canonicalize + dedupe an array of tags: every `entity:` tag is normalized,
 * the rest pass through, and the result is de-duplicated preserving order.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function normalizeTagsArray(tags) {
  if (!Array.isArray(tags)) return tags;
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const nt = normalizeEntityTag(t);
    if (seen.has(nt)) continue;
    seen.add(nt);
    out.push(nt);
  }
  return out;
}
