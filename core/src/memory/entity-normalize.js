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

// Junk guard — slugs that are NEVER real entities. This is mechanical noise
// removal (universal, not domain-specific): generic descriptors that the LLM
// occasionally over-extracts, plus this codebase's own test/smoke sentinels
// that leaked into entity: tags. Roles/titles and bare geographies are NOT
// listed here on purpose — a hardcoded list of those would false-drop real
// proper names ("Project Berlin"); they are excluded CONTEXTUALLY by the
// extraction-LLM prompt instead. Returning null here drops the tag at the
// write filter (graph-engine) and on every tag re-normalization.
const GENERIC_NON_ENTITY = new Set([
  'the', 'a', 'an', 'it', 'this', 'that', 'they', 'we', 'i', 'you',
  'project', 'the-project', 'team', 'the-team', 'company', 'the-company',
  'organization', 'org', 'meeting', 'document', 'doc', 'file', 'user',
  'assistant', 'system', 'everyone', 'someone', 'anyone', 'thing', 'stuff',
  'data', 'info', 'information', 'details', 'overview', 'summary', 'note',
  // Universal English function / emphasis / status words that leak as fake
  // entities from ALL-CAPS emphasis and prose (e.g. "NOW LIVE", "do NOT",
  // "FOLLOW-UP"). These are never standalone proper-noun entities in any
  // domain; a real name containing one survives as its multi-word slug
  // (e.g. "Washington Post" → "washington-post", not bare "post"). Keeping
  // this to closed-class words + generic status tokens avoids false-drops.
  'not', 'now', 'new', 'old', 'live', 'done', 'follow', 'next', 'prev',
  'yes', 'no', 'ok', 'okay', 'true', 'false', 'none', 'todo', 'tbd', 'na',
  'via', 'per', 'vs', 'aka', 'etc', 'and', 'or', 'but', 'if', 'then',
  'else', 'when', 'where', 'why', 'how', 'what', 'who', 'all', 'any',
  'some', 'more', 'less', 'first', 'last', 'only', 'here', 'there', 'now',
  'status', 'update', 'draft', 'final', 'pending', 'blocked', 'open', 'closed',
  // HTTP verbs — leak from technical text; never entities on their own.
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options',
]);
// Test/smoke sentinels this codebase emits (and that leaked into entity tags).
const TEST_NOISE_RE = /^(ws\d+|embedtest|recallsmoke|routefix\d*|s1probe|s1async|abtest|deploy-smoke|smoketest|smoke-test|kbtest|foo|bar|baz|test|placeholder)(-|$)/i;

function isJunkEntity(slug) {
  if (!slug || slug.length < 2) return true;
  if (GENERIC_NON_ENTITY.has(slug)) return true;
  if (TEST_NOISE_RE.test(slug)) return true;
  return false;
}

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

  // Drop generic descriptors + test/smoke sentinels — never real entities.
  if (isJunkEntity(s)) return null;

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
  // Junk/unnormalizable entity tag → null so the array normalizer drops it
  // (was: keep the original, which let generic/test entity tags survive).
  return n ? `entity:${n}` : null;
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
    if (nt == null) continue;        // dropped junk/unnormalizable entity tag
    if (seen.has(nt)) continue;
    seen.add(nt);
    out.push(nt);
  }
  return canonicalizeEntityAliases(out);
}

/**
 * Within-set alias canonicalization: when a shorter entity's hyphen-words are a
 * strict LEADING prefix of a longer entity's words, drop the shorter (keep the
 * more-specific full form). Handles the common intro-sentence case where one
 * memory names both a partial and a full reference:
 *   entity:amar + entity:amar-sai-gadde      → entity:amar-sai-gadde
 *   entity:uwe  + entity:uwe-berger          → entity:uwe-berger
 *   entity:b-b  + entity:b-b-sinn-für-marken → entity:b-b-sinn-für-marken
 * Deterministic, conservative (strict word-prefix, ≥1 word shorter), no dict, no
 * fuzzy merge. Cross-MEMORY alias resolution (where the two forms live on
 * different rows) is a separate entity-resolution concern, not handled here.
 * @param {string[]} tagList already-normalized tags
 * @returns {string[]}
 */
export function canonicalizeEntityAliases(tagList) {
  if (!Array.isArray(tagList) || tagList.length < 2) return tagList;
  const ents = [];
  const rest = [];
  for (const t of tagList) {
    if (typeof t === 'string' && t.startsWith('entity:')) ents.push(t.slice('entity:'.length));
    else rest.push(t);
  }
  if (ents.length < 2) return tagList;
  const words = (e) => e.split('-').filter(Boolean);
  const isLeadingPrefix = (a, b) => {
    const wa = words(a); const wb = words(b);
    if (wa.length >= wb.length) return false;            // must be strictly shorter
    for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
    return true;
  };
  const dropped = new Set();
  for (const a of ents) {
    if (dropped.has(a)) continue;
    for (const b of ents) {
      if (a === b || dropped.has(b)) continue;
      if (isLeadingPrefix(a, b)) { dropped.add(a); break; } // a is a partial of fuller b → drop a
    }
  }
  const merged = ents.filter((e) => !dropped.has(e)).map((e) => `entity:${e}`);
  return [...rest, ...merged];
}
