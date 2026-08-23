// ── Hop-0 canonical-entity recall lane ──────────────────────────────────────
// Bounded DETERMINISTIC entity lookup that runs BEFORE/alongside semantic
// retrieval: match the query against the org's entity registry (indexed
// PostgreSQL metadata, no LLM call), then surface the memories linked to the
// matched entities as ADDITIVE recall candidates. Acronyms and short entity
// queries ("CSI", "Solvis Lea", a surname) find the canonical entity
// immediately, and cross-source memories become candidates through the entity
// link even when their wording is semantically distant from the query.
//
// Registry reality (verified in production):
//   • `Entity` (entities table) is the POPULATED registry — memories link to
//     it via `entity:<slug>` tags written at ingestion (normalizeEntity slugs).
//   • `CanonicalEntity` + `MemoryEntityLink` is the cross-system registry the
//     Salesforce/connector path writes. It is queried here too (same caps,
//     same scoring) so it plugs in the moment it has rows — but the lane never
//     depends on it existing.
//
// Contract (mirrors the temporal SHOULD lane):
//   • ADDITIVE only — never hard-filters the general recall lanes.
//   • Entity match BOOSTS relevance, never overrides it: semantic + lexical
//     relevance still decide final order downstream.
//   • Fail-open to [] on deadline or any storage error; never delays recall.
//
// Hard caps: 8 query tokens · 12 matched entities · 10 memories per canonical
// link · 40 total candidates · ~125 ms deadline.

import { normalizeEntity } from './entity-normalize.js';
import { orgIsRemote, amrFindByTags } from '../vector/mneme/driver.js';

export const HOP0_MAX_QUERY_TOKENS = 8;
export const HOP0_MAX_ENTITIES = 12;
export const HOP0_MAX_LINKS_PER_ENTITY = 10;
export const HOP0_MAX_CANDIDATES = 40;
export const HOP0_DEFAULT_DEADLINE_MS = 125;

// Deterministic match-quality scores (see plan: entity match boosts, capped).
const SCORE_EXACT = 1.0;   // exact canonical name (or full-query slug match)
const SCORE_ALIAS = 0.9;   // exact alias
const SCORE_TOKEN = 0.75;  // whole-token overlap
const SCORE_PREFIX = 0.55; // prefix match (query token ≥3 chars)
const SCORE_PARTIAL = 0.3; // bounded substring fallback (query token ≥5 chars)

const _segmenter = (() => {
  try { return new Intl.Segmenter(undefined, { granularity: 'word' }); }
  catch { return null; }
})();

/** Tokenize a query into normalized word tokens (language-agnostic). */
export function hop0QueryTokens(query = '') {
  const raw = String(query || '');
  let words = [];
  if (_segmenter) {
    for (const seg of _segmenter.segment(raw)) {
      if (seg.isWordLike) words.push(seg.segment);
    }
  } else {
    words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  const out = [];
  const seen = new Set();
  for (const w of words) {
    const t = w.normalize('NFKC').toLowerCase().trim();
    // Tokens under 3 chars are never matched loosely (would hit "AI"/"IT"/"AM"
    // against hundreds of entities); they still participate via the full-query
    // and n-gram slug comparisons below.
    if (t.length < 3 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= HOP0_MAX_QUERY_TOKENS) break;
  }
  return out;
}

// Build bounded exact-tag anchors for sovereign/.amr tenants whose entity
// registry is not mirrored centrally yet. The complete set is submitted to the
// tenant tag index in one request; this does not fan out retrieval per word.
// Capitalized spans are preferred, with Unicode n-grams covering lowercase
// input. Non-entities simply miss the exact tag index and add no candidates.
export function remoteQueryEntityRegistry(query = '') {
  const raw = String(query || '');
  const words = [];
  if (_segmenter) {
    for (const seg of _segmenter.segment(raw)) {
      if (!seg.isWordLike) continue;
      const value = seg.segment.normalize('NFKC').trim();
      if (value.length >= 3) words.push(value);
      if (words.length >= HOP0_MAX_QUERY_TOKENS) break;
    }
  } else {
    words.push(...raw.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3).slice(0, HOP0_MAX_QUERY_TOKENS));
  }
  if (!words.length) return [];

  const capitalized = words.filter((word) => /^\p{Lu}/u.test(word));
  const basis = capitalized.length ? capitalized : words;
  const phrases = [];
  for (let size = Math.min(4, basis.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= basis.length; start += 1) {
      phrases.push(basis.slice(start, start + size).join(' '));
    }
  }

  const seen = new Set();
  const registry = [];
  for (const phrase of phrases) {
    const slug = normalizeEntity(phrase);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    registry.push({
      id: `tenant-tag:${slug}`,
      name: phrase,
      slug,
      matchScore: SCORE_TOKEN,
      matchedTokens: hop0QueryTokens(phrase),
    });
    if (registry.length >= 24) break;
  }
  return registry;
}

// Contiguous word n-grams of the query, as normalizeEntity slugs — lets a
// multi-word canonical name ("Solvis Lea", "Davinci AI") match exactly even
// when embedded in a longer question.
function _queryNgramSlugs(query = '', maxN = 4) {
  const words = String(query || '').split(/[^\p{L}\p{N}&.-]+/u).filter(Boolean);
  const slugs = new Set();
  const full = normalizeEntity(query);
  if (full) slugs.add(full);
  for (let n = 1; n <= Math.min(maxN, words.length); n += 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const slug = normalizeEntity(words.slice(i, i + n).join(' '));
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

/**
 * Deterministically match registry entities against a query.
 * Pure function — safe to unit-test without storage.
 *
 * @param {Array<{id, canonicalName, aliases?, mentionCount?}>} entities
 * @param {string} query
 * @returns {Array<{id, name, matchScore, matchedTokens}>} best-first, ≤12
 */
export function matchEntitiesLexical(entities, query) {
  const tokens = hop0QueryTokens(query);
  const ngramSlugs = _queryNgramSlugs(query);
  if (tokens.length === 0 && ngramSlugs.size === 0) return [];

  const matches = [];
  for (const entity of entities || []) {
    const nameSlug = normalizeEntity(entity?.canonicalName);
    if (!nameSlug) continue;
    const aliasSlugs = (entity.aliases || []).map((a) => normalizeEntity(a)).filter(Boolean);
    const entityTokens = nameSlug.split('-').filter((t) => t.length >= 3);

    let score = 0;
    const matchedTokens = new Set();

    // 1. exact canonical name (query or a contiguous n-gram equals the slug)
    if (ngramSlugs.has(nameSlug)) score = SCORE_EXACT;
    // 2. exact alias
    else if (aliasSlugs.some((a) => ngramSlugs.has(a))) score = SCORE_ALIAS;

    // 3-5. token-level rules (also record coverage for already-matched entities)
    for (const tok of tokens) {
      if (entityTokens.includes(tok)) {
        matchedTokens.add(tok);
        if (score < SCORE_TOKEN) score = SCORE_TOKEN;
      } else if (entityTokens.some((et) => et.startsWith(tok))) {
        matchedTokens.add(tok);
        if (score < SCORE_PREFIX) score = SCORE_PREFIX;
      } else if (tok.length >= 5 && nameSlug.length >= 5 && nameSlug.includes(tok)) {
        // bounded partial fallback — never unrestricted substring matching
        matchedTokens.add(tok);
        if (score < SCORE_PARTIAL) score = SCORE_PARTIAL;
      }
    }

    if (score > 0) {
      matches.push({
        id: entity.id,
        name: entity.canonicalName,
        slug: nameSlug,
        matchScore: score,
        matchedTokens: [...matchedTokens],
        _mentions: Number(entity.mentionCount || 0),
      });
    }
  }

  matches.sort((a, b) => (b.matchScore - a.matchScore) || (b._mentions - a._mentions));
  return matches.slice(0, HOP0_MAX_ENTITIES);
}

function _withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Visibility rules replicated from the vector-lane hydrate block in
// persisted-retrieval.js (guests never see org tier or cross-project
// syntheses; scope must match the caller's access context).
function _memoryEligible(memory, {
  user_id, org_id, access_context, scope_filter, is_latest,
  isMemoryInDateRange, isMemoryInTemporalSnapshot, dateRange, validAt, knownAt,
  excludeMemory,
}) {
  if (!memory) return false;
  if (typeof excludeMemory === 'function' && excludeMemory(memory)) return false;
  if (typeof is_latest === 'boolean' && (memory.is_latest !== false) !== is_latest) return false;
  if (typeof isMemoryInDateRange === 'function' && !isMemoryInDateRange(memory, dateRange)) return false;
  if (typeof isMemoryInTemporalSnapshot === 'function' && !isMemoryInTemporalSnapshot(memory, { validAt, knownAt })) return false;
  if (scope_filter && memory.scope && memory.scope !== scope_filter) return false;
  if (access_context) {
    const isGuest = access_context.orgRole === 'guest';
    const dropCrossProject = isGuest || access_context.crossProject === false;
    if (dropCrossProject && Array.isArray(memory.tags) && memory.tags.includes('scope:cross-project')) return false;
    const ok =
      (memory.scope === 'personal' && memory.user_id === user_id) ||
      (memory.scope === 'organization' && memory.org_id === org_id && !isGuest) ||
      (memory.scope === 'team' && (access_context.teamIds || []).includes(memory.primary_team_id)) ||
      (memory.scope === 'project' && Array.isArray(memory.project_ids) &&
        memory.project_ids.some((pid) => (access_context.projectIds || []).includes(pid)));
    if (!ok) return false;
  }
  return true;
}

/**
 * Hop-0: resolve entity-linked recall candidates for a query.
 *
 * Returns { candidates, matchedEntities, matchedQueryEntityCount, latencyMs }.
 * candidates carry `_entity_lexical: true` + `_entity_match_score` so the
 * scoring stage can apply the bounded boost. NEVER throws; empty on any
 * failure or deadline so ordinary recall is never delayed.
 */
export async function resolveEntityRecallCandidates({
  store,
  query,
  canonicalEntities = [],
  org_id,
  user_id,
  access_context = null,
  scope_filter = null,
  dateRange = null,
  validAt = null,
  knownAt = null,
  is_latest,
  deadlineMs = HOP0_DEFAULT_DEADLINE_MS,
  excludeMemory = null,
  isMemoryInDateRange = null,
  isMemoryInTemporalSnapshot = null,
} = {}) {
  const t0 = Date.now();
  const empty = { candidates: [], matchedEntities: [], matchedQueryEntityCount: 0, latencyMs: 0, cutoff: false };
  const client = store?.client;
  if (!client || !org_id || (!query && !canonicalEntities.length)) return empty;

  const work = (async () => {
    const hasPlannedEntities = Array.isArray(canonicalEntities) && canonicalEntities.some((entity) => String(entity || '').trim());
    const skipCentralRegistry = orgIsRemote(org_id) && hasPlannedEntities;
    // 1. Registry fetch — org-scoped, indexed, bounded. Both registries in
    //    parallel; each fails independently to [].
    const [entityRows, canonicalRows] = await Promise.all([
      !skipCentralRegistry && client.entity?.findMany
        ? client.entity.findMany({
            where: { orgId: org_id, isActive: true },
            select: { id: true, canonicalName: true, aliases: true, mentionCount: true },
            orderBy: { mentionCount: 'desc' },
            take: 400,
          }).catch(() => [])
        : [],
      !skipCentralRegistry && client.canonicalEntity?.findMany
        ? client.canonicalEntity.findMany({
            where: { organizationId: org_id },
            select: { id: true, canonicalName: true, aliases: true },
            take: 200,
          }).catch(() => [])
        : [],
    ]);

    // A structured planner has already resolved these entity names. Treat them
    // as authoritative tag anchors instead of requiring a second copy in the
    // central registry. This matters for remote .amr tenants: their memory and
    // `entity:<slug>` tags live in the box, while the central entity registry
    // may legitimately have no corresponding row yet.
    const plannedRegistry = [...new Set((canonicalEntities || [])
      .map((name) => String(name || '').trim()).filter(Boolean))]
      .slice(0, HOP0_MAX_ENTITIES)
      .map((name, index) => ({
        id: `planned:${normalizeEntity(name) || index}`,
        name,
        slug: normalizeEntity(name),
        matchScore: SCORE_EXACT,
        matchedTokens: hop0QueryTokens(name),
      }))
      .filter((entity) => entity.slug);
    // Remote tenant tags are an additive authority, not a fallback for the
    // central registry. A weak central match (for example a generic company
    // entity) must not suppress an exact tenant-local person/product tag.
    const tenantTagRegistry = orgIsRemote(org_id)
      ? remoteQueryEntityRegistry(query)
      : [];
    const tagRegistry = [
      ...plannedRegistry,
      ...tenantTagRegistry,
      ...matchEntitiesLexical(entityRows, query),
    ].filter((entity, index, rows) => rows.findIndex((row) => row.slug === entity.slug) === index);
    const linkRegistry = matchEntitiesLexical(canonicalRows, query);
    if (!tagRegistry.length && !linkRegistry.length) return empty;

    // 2. Entity → memory ids.
    //    a) tag path (populated registry): memories carry entity:<slug> tags.
    //    b) link path (cross-system registry): MemoryEntityLink rows.
    const tagVariants = [...new Set(tagRegistry.map((m) => `entity:${m.slug}`))];
    const [tagIdRows, linkRows] = await Promise.all([
      // TAG PATH. For an `.amr`/BYOD org this asked the CENTRAL memories table, which
      // holds none of their rows — so the tag half of hop-0 returned nothing for them
      // while the link half (memory_entity_links, central) kept working. Silent, as
      // usual: a lane that finds less, not one that errors. The shard carries the
      // `entity:<slug>` tags (amrUpdateTags resyncs them after deferred entity
      // linking), so route the scan there instead.
      (tagVariants.length && orgIsRemote(org_id))
        ? (amrFindByTags(org_id, tagVariants, HOP0_MAX_CANDIDATES, is_latest !== false) || Promise.resolve([]))
            .then((ids) => (Array.isArray(ids) ? ids.map((id) => ({ id })) : []))
            .catch(() => [])
        : (tagVariants.length && client.memory?.findMany)
        ? client.memory.findMany({
            where: {
              orgId: org_id,
              deletedAt: null,
              ...(is_latest === false ? {} : { isLatest: true }),
              tags: { hasSome: tagVariants },
            },
            select: { id: true },
            orderBy: { createdAt: 'desc' },
            take: HOP0_MAX_CANDIDATES,
          }).catch(() => [])
        : [],
      (linkRegistry.length && client.memoryEntityLink?.findMany)
        ? client.memoryEntityLink.findMany({
            where: { entityId: { in: linkRegistry.map((m) => m.id) } },
            select: { memoryId: true, entityId: true },
            orderBy: { createdAt: 'desc' },
            take: HOP0_MAX_ENTITIES * HOP0_MAX_LINKS_PER_ENTITY,
          }).catch(() => [])
        : [],
    ]);

    // Cap link rows per entity, then merge id sets (tag hits first — they are
    // org-verified by the WHERE above; links re-verify org at hydrate).
    const perEntity = new Map();
    const linkIds = [];
    for (const row of linkRows) {
      const n = perEntity.get(row.entityId) || 0;
      if (n >= HOP0_MAX_LINKS_PER_ENTITY) continue;
      perEntity.set(row.entityId, n + 1);
      linkIds.push(row.memoryId);
    }
    const ids = [...new Set([...tagIdRows.map((r) => r.id), ...linkIds])].slice(0, HOP0_MAX_CANDIDATES);
    if (!ids.length) return empty;

    // 3. Hydrate through the store (handles remote/BYOD orgs, soft-deletes,
    //    bi-temporal filters) and apply the same visibility rules as the
    //    vector lane.
    const memById = store.getMemories
      ? await store.getMemories(ids, { valid_at: validAt, known_at: knownAt })
      : new Map();

    const allMatched = [...tagRegistry, ...linkRegistry];
    const bestScore = allMatched.length ? Math.max(...allMatched.map((m) => m.matchScore)) : 0;
    const matchedIds = allMatched.map((m) => m.id);
    const matchedNames = [...new Set(allMatched.map((m) => m.name))];
    const coveredTokens = new Set(allMatched.flatMap((m) => m.matchedTokens || []));

    const candidates = [];
    for (const id of ids) {
      const memory = memById.get(id);
      if (!_memoryEligible(memory, {
        user_id, org_id, access_context, scope_filter, is_latest,
        isMemoryInDateRange, isMemoryInTemporalSnapshot, dateRange, validAt, knownAt,
        excludeMemory,
      })) continue;
      // Cross-org safety net: a linked memory from another org must never leak.
      if (memory.org_id && memory.org_id !== org_id) continue;
      candidates.push({
        memory,
        score: 0,
        similarityScore: 0,
        vectorScore: 0,
        _entity_lexical: true,
        _entity_match_score: bestScore,
        _matched_entity_ids: matchedIds,
        _matched_entity_names: matchedNames,
      });
      if (candidates.length >= HOP0_MAX_CANDIDATES) break;
    }

    return {
      candidates,
      matchedEntities: allMatched.map(({ id, name, matchScore }) => ({ id, name, matchScore })),
      matchedQueryEntityCount: coveredTokens.size,
      latencyMs: Date.now() - t0,
      cutoff: false,
    };
  })().catch(() => empty);

  // A remote planned-entity hit requires two bounded reads (tag ids, then
  // hydration). Give that authoritative lane enough time to complete instead
  // of applying the central-registry 125 ms budget to a network round trip.
  const effectiveDeadlineMs = orgIsRemote(org_id) && canonicalEntities.length
    ? Math.max(500, deadlineMs)
    : Math.max(25, deadlineMs);
  const result = await _withDeadline(work, effectiveDeadlineMs, { ...empty, cutoff: true });
  result.latencyMs = result.latencyMs || (Date.now() - t0);
  return result;
}
