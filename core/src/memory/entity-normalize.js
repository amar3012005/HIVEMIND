/**
 * Entity-tag canonicalization — deterministic, no DB, no fuzzy, no false-merge.
 *
 * The co-mention LLM writes raw `entity:<Name>` tags with no normalization,
 * producing fragmentation: SOLVIS / Solvis / SOLVIS_GmbH (one company, 3 tags),
 * SolvisControl-3 / SolvisControl‑3 (unicode hyphen) / SolvisControl_3 (one
 * product, 3 tags). This collapses the MECHANICAL duplicate classes only —
 * case, unicode dash, underscore↔space, whitespace, legal suffix (GmbH/Inc/…),
 * and a small curated cross-lingual synonym set. It deliberately does NOT do
 * fuzzy/Jaccard/embedding merging (those false-merge SKUs `_7_kW` vs `_10_kW`,
 * homonyms, company-vs-fruit — see the entity/cluster red-team).
 *
 * Pure + deterministic so it can be applied symmetrically at WRITE (ingest),
 * QUERY (recall entity match), and BACKFILL — the only way the stored tag and
 * the query-extracted entity land on the same canonical string.
 */

// Legal-entity suffixes stripped so "Solvis GmbH" ≡ "Solvis". Mirrors
// EntityResolver.normalizeName. \b-anchored so it never matches inside a word
// ("coca" keeps its "co"). Trailing dot optional.
const LEGAL_SUFFIX_RE = /\b(gmbh|ag|kg|inc|llc|ltd|corp|corporation|company|co|sa|sas|srl|bv|nv|pte|plc|group|holding|holdings|ev)\b\.?/gi;

// All unicode dash/hyphen variants → ASCII hyphen (fixes "‑" vs "-").
const DASH_RE = /[‐-―−﹘﹣－]/g;

// Curated cross-lingual / synonym remaps. SMALL + generic only (DE↔EN concept
// pairs that are unambiguous). NOT org-specific brand/person merges — those are
// left distinct (deterministic-only; semantic merges need human/fuzzy review).
// Keys are POST-slug forms (umlauts preserved by the slugifier).
const SYNONYMS = new Map([
  ['wärmepumpe', 'heat-pump'],
  ['waermepumpe', 'heat-pump'],
  ['warmepumpe', 'heat-pump'],
  ['photovoltaik', 'photovoltaic'],
  ['pelletkessel', 'pellet-boiler'],
  ['pelletofen', 'pellet-stove'],
  ['solarthermie', 'solar-thermal'],
  ['pellets', 'pellet'],
]);

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

  return SYNONYMS.get(s) || s;
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
