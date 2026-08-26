/**
 * RecallRouter — Memory-First Sequential Retrieval (v3.1)
 *
 * Single entry point for every recall call across HIVEMIND:
 *   Talk-to-HIVE · MCP · ChatGPT connector · CLI · extensions · employees
 *
 * Pipeline (deterministic, no LLM in router):
 *
 *   HOP 1  memories                always
 *   HOP 2  evidence segments       event-driven from HOP 1 tags / sparseness
 *   HOP 3  live workspace          event-driven from HOP 1 source platforms
 *
 *   merge w/ Reciprocal Rank Fusion + lineage edges
 *
 * Memory layer's TAGS are the routing oracle. We do not classify the user's
 * query with regex / ruleset — we let the corpus tell us what to do next.
 *
 * Invariants the router relies on (enforced at ingest):
 *   - Every doc-derived memory carries `filename:<name>` + `doc-hash:<sha>` tags.
 *   - Every memory has `source_metadata.source_platform` set.
 *   - Cognition-loop canonicals propagate substantive source tags.
 */

import { recallPersistedMemories, crossClusterEntityBoost, normalizeQueryTemporalTokens } from './persisted-retrieval.js';
import { ClusterIndex } from './cluster-index.js';
// Two-reranker contract: this `rerank` is the OPT-IN CROSS-ENCODER pass (external model,
// gated RERANK_ENABLED) on the agent path. The ALGORITHMIC ResultReranker (search/result-reranker.js)
// is the always-on, no-network ordering reranker used on delivery (and behind RECALL_TIERED_VIEW).
import { rerank } from './reranker.js';
import { ResultReranker } from '../search/result-reranker.js';
import { buildEvidencePacket } from './recall-packet.js';
import { isDurableKbPromotionAdmitted } from './durable-content.js';
import { isMemoryInDateRange, selectEventRangeCandidates } from './temporal-range.js';
import { getRetrievalConfig, logTaskOutcome } from './retrieval-config.js';
import { orgIsRemote, amrKbDocs, amrMemRelationshipsBatch, memoryBackend } from '../vector/mneme/driver.js';
import { scopedMemoryWhere } from './prisma-graph-store.js';
import { dedupeMemoriesById } from './recall-dedup.js';
import { filterMemoriesByDocumentIds } from './recall-source-filter.js';
import { initialMemoryCrossRerank } from './recall-rerank-policy.js';
import { runWithStageDeadline } from '../runtime/stage-deadline.js';
import { isRemoteMemoryUnavailableError } from '../vector/mneme/remote-backend.js';
import { prepareUnifiedRecallCandidates } from './recall-evidence-dedup.js';
import { filterEvidenceByMetadata } from '../knowledge/evidence-retrieval.js';

// Same algorithmic term-overlap reranker the DIRECT path (recallPersistedMemories)
// ends with. Applied as the agent path's final ordering step so chat and Tara
// agree on memory order (the router's RRF+MMR re-pass scrambles the upstream
// tiered order — the PHASE-B TODO). Default ON; RECALL_TIERED_VIEW=false to opt out.
const ROUTER_TIERED_VIEW = process.env.RECALL_TIERED_VIEW !== 'false';
let _routerReranker = null;

// ── Constants ───────────────────────────────────────────────────────────────

const HOP1_DEFAULT_LIMIT       = 12;
// Retrieval DEPTH for the evidence lane, decoupled from how many we DELIVER.
// HOP2_* below are deliver counts. Depth feeds the cross-encoder (RERANK_POOL=150),
// which then narrows. Measured: small-detail answerability 3/5 -> 5/5 purely from
// depth 6 -> 150; the reranker chose a segment over a memory 5/5 unprompted.
const EVIDENCE_DEPTH           = Number(process.env.EVIDENCE_DEPTH || 150);
// WIDE hand-off from the evidence lane into the single delivery-point cross-encoder.
// Not user-visible: deliverHybrid narrows to HOP2_DOC_LIMIT after ranking.
const EVIDENCE_DELIVER         = Number(process.env.EVIDENCE_DELIVER || 40);
// The wide hand-off is only SAFE when the delivery-point cross-encoder is on to narrow
// it. With RECALL_HYBRID_DELIVERY_ALWAYS_ON off, 40 unranked evidence rows would reach the answer
// instead of 8 — a regression. So the widening is inert unless V2 will actually fire.
const evidenceDeliverFor = () => EVIDENCE_DELIVER;   // deliverHybrid always narrows it
const HOP2_DOC_LIMIT           = 8;
const HOP2_UNFILTERED_LIMIT    = 6;
const HOP3_LIVE_LIMIT          = 5;
// Deliver-narrow: retrieve stays wide (HOP1 fetches up to 50, RRF/MMR-ranked),
// but only the top-N ranked memories go to the answer model. 1024 bge-m3 +
// algorithmic rerank shows a clean relevance cliff after ~5 (junk/redundancy
// beyond). Progressive consumers reveal five at a time, while recall itself
// retains the top 15 so a later page never requires another search.
const RECALL_DELIVER_LIMIT     = Number(process.env.RECALL_DELIVER_LIMIT || 15);
const MAX_TEMPORAL_RANGE_MS    = 366 * 24 * 60 * 60 * 1000;

function normalizedIso(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function shouldUseTagAnchoredRecall({ callerTags = false, isRecentish = false, inferredTags = null, validAtDate = null } = {}) {
  const hasInferredTags = Array.isArray(inferredTags) && inferredTags.length > 0;
  return callerTags
    || (isRecentish && hasInferredTags)
    || (!!validAtDate && (callerTags || hasInferredTags));
}

function boundedString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeSourceLabel(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function normalizeMemoryTypes(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').trim().toLocaleLowerCase())
    .filter(Boolean))].slice(0, 12);
}

const RELATIONSHIP_TYPES = new Set([
  'updates', 'extends', 'derives', 'contradicts', 'supports', 'references',
  'mentions', 'partof', 'causes', 'requires', 'blocks', 'relatedto',
]);

function normalizeRelationshipTypes(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').replace(/[\s_-]+/g, '').toLocaleLowerCase())
    .filter((value) => RELATIONSHIP_TYPES.has(value)))].slice(0, 12);
}

function normalizeEntityFilterMode(value, hasEntities = false) {
  const normalized = String(value || '').toLocaleLowerCase();
  if (['must', 'should', 'off'].includes(normalized)) return normalized;
  return hasEntities ? 'must' : 'off';
}

function memoryMatchesTags(memory, tags = []) {
  const wanted = [...new Set((tags || []).map((tag) => normalizeSourceLabel(tag)).filter(Boolean))];
  if (!wanted.length) return true;
  const stored = memory?.memory || {};
  const available = new Set([...(memory?.tags || []), ...(stored?.tags || [])]
    .map((tag) => normalizeSourceLabel(tag)).filter(Boolean));
  return wanted.every((tag) => available.has(tag));
}

export function filterMemoriesByEntities(memories = [], entities = [], { mode = 'must' } = {}) {
  const wanted = [...new Set((entities || []).map((entity) => normalizeSourceLabel(entity)).filter(Boolean))];
  if (!wanted.length || mode === 'off' || mode === 'should') return [...memories];
  return memories.filter((memory) => {
    const stored = memory?.memory || {};
    const tags = [...(memory?.tags || stored?.tags || [])].map((tag) => normalizeSourceLabel(tag));
    const metadata = memory?.source_metadata || memory?.sourceMetadata || stored?.source_metadata || {};
    const metadataEntities = [
      ...(Array.isArray(metadata.entities) ? metadata.entities : []),
      ...(Array.isArray(memory?.entities) ? memory.entities : []),
      memory?.claimSubject, memory?.claim_subject,
    ].map(normalizeSourceLabel).filter(Boolean);
    const searchable = [memory?.title, stored?.title, memory?.content, stored?.content]
      .map((value) => typeof value === 'string' ? value : '')
      .join(' ').normalize('NFKC').toLocaleLowerCase();
    const matches = wanted.map((entity) => tags.includes(`entity:${entity}`)
      || metadataEntities.some((candidate) => candidate === entity
        || candidate.includes(entity) || entity.includes(candidate))
      // Compatibility for rows ingested before canonical entity metadata.
      || searchable.includes(entity));
    return mode === 'any' ? matches.some(Boolean) : matches.every(Boolean);
  });
}

function memoryMatchesSourceContract(memory, { title = null, kind = null } = {}) {
  const wantedTitle = normalizeSourceLabel(title);
  const wantedKind = normalizeSourceLabel(kind);
  const tags = Array.isArray(memory?.tags) ? memory.tags.map((tag) => String(tag)) : [];
  const sourceMetadata = memory?.source_metadata || memory?.sourceMetadata || {};
  const titles = [memory?.title, sourceMetadata.filename, sourceMetadata.file_name, sourceMetadata.document_title]
    .map(normalizeSourceLabel).filter(Boolean);
  const filenames = tags.filter((tag) => tag.startsWith('filename:'))
    .map((tag) => normalizeSourceLabel(tag.slice('filename:'.length)));
  const titleMatches = !wantedTitle || [...titles, ...filenames].some((candidate) =>
    candidate === wantedTitle || candidate.includes(wantedTitle) || wantedTitle.includes(candidate));
  const kindMatches = !wantedKind || tags.includes(`kind:${wantedKind}`)
    || normalizeSourceLabel(sourceMetadata.kind) === wantedKind
    || normalizeSourceLabel(sourceMetadata.source_kind) === wantedKind;
  return titleMatches && kindMatches;
}

function sourceMemoryTimestamp(memory) {
  const metadata = memory?.source_metadata || memory?.sourceMetadata || {};
  const candidates = [metadata.event_time, metadata.eventTime, memory?.event_time, memory?.eventTime,
    memory?.document_date, memory?.created_at, memory?.createdAt];
  for (const value of candidates) {
    const ts = new Date(value || '').getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

async function resolveSourceMemoryAnchors(store, ctx, { title = null, kind = null, selector = null } = {}, timeoutMs = 2500) {
  if (!store?.listMemories || (!title && !kind)) return [];
  const tags = [];
  // A title may live in source_metadata/document_title without a filename tag,
  // especially on historical promotions. Do not pre-filter the storage query
  // by an optional denormalized tag and thereby hide an otherwise exact source
  // anchor. Authorization is still applied by listMemories; the exact source
  // contract is enforced client-side below.
  if (kind && !title) tags.push(`kind:${kind}`);
  const listed = await withTimeout(store.listMemories({
    user_id: ctx.userId,
    org_id: ctx.orgId,
    // Source references are authorization-scoped, not silently bound to the
    // UI's active project. A caller asking for a named/recent upload expects
    // an authorized personal or organization source to remain findable.
    project: undefined,
    ...(tags.length ? { tags } : {}),
    is_latest: true,
    limit: title ? 500 : (selector ? 100 : 20),
    access_context: ctx.accessContext,
  }), timeoutMs, { memories: [] });
  const matches = (listed?.memories || []).filter((memory) => memoryMatchesSourceContract(memory, { title, kind }));
  if (selector === 'latest' || selector === 'earliest') {
    matches.sort((a, b) => selector === 'latest'
      ? sourceMemoryTimestamp(b) - sourceMemoryTimestamp(a)
      : sourceMemoryTimestamp(a) - sourceMemoryTimestamp(b));
    return matches.slice(0, 1);
  }
  return matches;
}

function entityQueryForms(query) {
  if (!query) return [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const words = [];
  for (const part of segmenter.segment(String(query))) {
    const word = part.isWordLike ? part.segment.trim() : '';
    if (word.length >= 2) words.push(word);
  }
  const forms = new Set();
  for (const word of words) {
    forms.add(word);
    forms.add(word.toLocaleLowerCase());
    if (/^[\p{L}\p{N}]{2,6}$/u.test(word)) forms.add(word.toLocaleUpperCase());
  }
  for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const slice = words.slice(start, start + size);
      forms.add(slice.join(' '));
      // ALSO the space-collapsed form. Users type product names split by a space
      // ("Solvis pia", "Solvis Max") but the canonical entity is one token
      // ("SolvisPia", "SolvisMax"). Without this, entity resolution matched only
      // the generic parent ("SOLVIS") and recall returned the company blurb
      // instead of the product — the phrasing-sensitive-answer bug. Match is
      // case-insensitive downstream, so the concatenation resolves regardless of
      // the user's casing.
      if (size <= 3) forms.add(slice.join(''));
    }
  }
  return [...forms].slice(0, 48);
}

export async function resolveCanonicalEntities({ prisma, orgId, query } = {}) {
  const candidates = entityQueryForms(query);
  if (!prisma?.entity || !orgId || !candidates.length) return [];
  const entities = await prisma.entity.findMany({
    where: {
      orgId,
      isActive: true,
      OR: [
        ...candidates.map((name) => ({ canonicalName: { equals: name, mode: 'insensitive' } })),
        { aliases: { hasSome: candidates } },
      ],
    },
    orderBy: [{ mentionCount: 'desc' }, { lastSeenAt: 'desc' }],
    select: { canonicalName: true },
    take: 8,
  });
  return [...new Set(entities.map((entity) => entity.canonicalName).filter(Boolean))];
}

export function canonicalEntityLexicalQuery(entities = []) {
  const canonical = [...new Set((Array.isArray(entities) ? entities : [])
    .map((entity) => String(entity || '').trim())
    .filter(Boolean))].slice(0, 12);
  return canonical.length ? canonical.join(' ') : null;
}

async function resolveImplicitSource({ evidence, query, ctx, timeoutMs, requireFilename = false }) {
  if (!evidence?.resolveSourceFromQuery || !query) return null;
  const resolved = await withTimeout(
    evidence.resolveSourceFromQuery({
      query,
      userId: ctx.userId,
      orgId: ctx.orgId,
      projectId: ctx.projectId || null,
      deadlineAt: Date.now() + timeoutMs,
    }),
    timeoutMs,
    null,
  );
  const source = Array.isArray(resolved) ? resolved[0] : resolved;
  if (!source) return null;
  if (requireFilename && source._sourceMatch !== 'filename') return null;
  const documentId = source.document_id || source.documentId || source.id || null;
  const title = source.title || source.document_title || source.documentTitle || null;
  return documentId || title ? { document_id: documentId, title } : null;
}

export function requireFilenameForImplicitSource(options = {}) {
  return options.structured_intent === true && options.allow_semantic_source_recovery !== true;
}

function normalizeTemporalRange(value) {
  if (!value || typeof value !== 'object') return null;
  const start = normalizedIso(value.start);
  const end = normalizedIso(value.end);
  if (!start && !end) return null;
  const boundedEnd = end || new Date(new Date(start).getTime() + MAX_TEMPORAL_RANGE_MS).toISOString();
  const boundedStart = start || new Date(new Date(boundedEnd).getTime() - MAX_TEMPORAL_RANGE_MS).toISOString();
  if (new Date(boundedStart) > new Date(boundedEnd)) return null;
  if (new Date(boundedEnd) - new Date(boundedStart) > MAX_TEMPORAL_RANGE_MS) {
    return {
      start: new Date(new Date(boundedEnd).getTime() - MAX_TEMPORAL_RANGE_MS).toISOString(),
      end: boundedEnd,
      clamped: true,
    };
  }
  return { start: boundedStart, end: boundedEnd, clamped: false };
}

// Server-owned normalization for the additive recall contract. `quick` is the
// documented low-latency public mode and shares the same parallel hybrid plan
// as `fact`; old auto/custom modes retain the compatibility branch.
// This keeps HTTP and MCP callers on the same public endpoint while preventing
// callers from bypassing bounded retrieval with arbitrary plan fields.
export function resolveRecallPlan(input = {}) {
  const requested = typeof input.mode === 'string' ? input.mode.toLowerCase() : 'auto';
  const explicit = requested === 'quick' || requested === 'fact' || requested === 'explain' || requested === 'full';
  const fullAllowed = requested !== 'full' || input.explicit_mode === true;
  // Compound-query auto-routing: a multi-part question ("X and Y", multiple
  // '?', "compare/across/both", several clauses) needs graph/source evidence,
  // not a single fact pass. Escalate AUTO (non-explicit) compound queries
  // straight to explain — starting in fact mode then escalating burned most of
  // the deadline before reaching explain (observed: chat compound answers
  // dropped a delivered fact + falsely marked a source uncovered).
  const _q = String(input.query_context || input.query || input.context || '');
  const _compound = input.structured_intent !== true && _q.length > 40 && (
    (_q.match(/\?/g) || []).length > 1
    || /\b(and|plus|as well as|both|compare|across|versus|vs\.?|along with|together with)\b/i.test(_q)
    || (_q.match(/[.;]/g) || []).length >= 2
  );
  const mode = requested === 'full' && !fullAllowed
    ? 'explain'
    : requested === 'quick' ? 'fact'
      : explicit ? requested
      : (_compound && process.env.RECALL_COMPOUND_EXPLAIN !== 'false') ? 'explain'
        : 'fact';
  const operation = input.operation === 'timeline' ? 'timeline' : 'recall';
  const structuredSource = input.source && typeof input.source === 'object' ? input.source : {};
  const structuredTime = input.time && typeof input.time === 'object' ? input.time : {};
  // Explicit flat arguments are the established public contract and win over
  // inferred/structured values during the additive migration.
  const sourceDocumentId = boundedString(input.source_document_id || structuredSource.document_id, 128);
  const sourceTitle = boundedString(input.source_title || structuredSource.title, 512);
  const sourceKind = boundedString(input.source_kind || structuredSource.kind, 64);
  // Accept the compact planner vocabulary as well as the established flat
  // public fields.  Planner revisions have emitted each of these spellings in
  // production (`selector`, `mode`, and `semantics`); silently treating one as
  // ordinary recall makes a "latest" answer relevance-ordered instead of
  // time-ordered.
  const temporalSelectorValue = String(
    input.temporal_selector
      || input.temporal_intent
      || structuredTime.kind
      || structuredTime.selector
      || structuredTime.mode
      || structuredTime.semantics
      || '',
  ).toLowerCase();
  const temporalSelector = ['latest', 'earliest'].includes(temporalSelectorValue)
    ? temporalSelectorValue
    : null;
  const temporalAxisValue = String(input.temporal_axis || structuredTime.axis || '');
  const temporalAxis = ['known_time', 'event_time', 'valid_time'].includes(temporalAxisValue)
    ? temporalAxisValue
    : null;
  const memoryTypes = normalizeMemoryTypes(input.memory_types, input.memory_type);
  const inputEntities = Array.isArray(input.entities)
    ? input.entities
    : (Array.isArray(input.named_entities) ? input.named_entities : []);
  const entities = [...new Set(inputEntities.map((entity) => boundedString(entity, 256)).filter(Boolean))].slice(0, 12);
  const relationshipInput = input.relationships && typeof input.relationships === 'object'
    ? input.relationships : {};
  const relationshipTypes = normalizeRelationshipTypes(
    input.relationship_types, input.relationship_type, relationshipInput.types, relationshipInput.type,
  );
  const relationshipDirectionValue = String(input.relationship_direction || relationshipInput.direction || 'any').toLocaleLowerCase();
  const relationshipDirection = ['any', 'incoming', 'outgoing'].includes(relationshipDirectionValue)
    ? relationshipDirectionValue : 'any';
  const scopeFilter = boundedString(input.scope_filter || input.scope, 32);
  const targetMemoryId = boundedString(input.target_memory_id || input.memory_id, 128);
  const entityFilterMode = normalizeEntityFilterMode(input.entity_filter_mode, entities.length > 0);
  const asOf = structuredTime.as_of;
  const validAt = normalizedIso(
    input.valid_at
      || structuredTime.valid_at
      || (asOf && temporalAxis !== 'known_time' ? asOf : null),
  );
  const knownAt = normalizedIso(
    input.known_at
      || structuredTime.known_at
      || (asOf && temporalAxis === 'known_time' ? asOf : null),
  );
  const range = normalizeTemporalRange(
    input.date_range
      || structuredTime.range
      || ((structuredTime.semantics === 'range' || structuredTime.mode === 'range')
        ? structuredTime : null),
  );
  const temporal = knownAt
    ? 'known_at'
    : validAt
      ? 'valid_at'
      : range
        ? 'range'
        : temporalSelector
          ? temporalSelector
          : input.temporal === 'known_at'
          ? 'known_at'
          : 'current';
  const budget = mode === 'full' ? 24_000 : mode === 'explain' ? 8_000 : 2_000;

  return {
    mode,
    requested_mode: requested,
    legacy: !explicit,
    operation,
    mode_downgraded: requested === 'full' && !fullAllowed ? 'full_requires_explicit_caller' : null,
    temporal,
    source: {
      requested: !!(sourceDocumentId || sourceTitle || sourceKind),
      document_id: sourceDocumentId,
      title: sourceTitle,
      kind: sourceKind,
    },
    time: {
      mode: temporal,
      axis: temporalAxis,
      valid_at: validAt,
      known_at: knownAt,
      range,
      selector: temporalSelector,
    },
    memory_types: memoryTypes,
    entities,
    entity_filter_mode: entityFilterMode,
    scope_filter: ['personal', 'project', 'team', 'organization'].includes(scopeFilter)
      ? scopeFilter : null,
    target_memory_id: operation === 'timeline' ? targetMemoryId : null,
    relationships: {
      requested: relationshipTypes.length > 0,
      types: relationshipTypes,
      direction: relationshipDirection,
    },
    max_graph_hops: mode === 'fact' ? 0 : 1,
    max_memories: operation === 'timeline'
      ? Math.min(Math.max(Number(input.limit) || 20, 1), 50)
      : Math.min(Math.max(Number(input.limit) || 15, 1), 50),
    context_budget: budget,
    // Evidence is a PARALLEL LANE in its own Qdrant collection — not an expensive
    // serial hop-2, which is what "fact is fast-only" was written for. So `fact` must
    // include it: a price, a part number, a kW rating IS a fact question, and it is
    // answered from verbatim segments. Measured on org 1380251c — 0 of 485 memories
    // held the 5 small facts under test; all 5 were in knowledge_segments. Routing
    // fact-lookup to the one mode that refuses to read source text is why those
    // questions returned "nothing directly answers your question" while the answer sat
    // in a segment. Only an explicit memory-only request opts out.
    expand_evidence: !explicit ? requested !== 'memory' : true,
    include_live: explicit && mode === 'fact'
      ? false
      : (!explicit ? input.include_live !== false : input.include_live === true),
    // These are end-to-end retrieval budgets. A full request degrades to the
    // completed explain-grade packet at the deadline; it never extends chat.
    latency_budget_ms: mode === 'fact' ? 1_500 : 3_000,
  };
}

// Event-time ranking boost: when the query carries a temporal token
// (today/yesterday/last week/ISO date/month-name), multiplicatively lift
// candidates whose `ts:YYYY-MM-DD` / `time:*` tags fall in the window.
// Gated, off by default — flip per-org via env after shadow A/B.
const EVENT_TIME_RANKING_BOOST = String(process.env.EVENT_TIME_RANKING_BOOST || 'false') === 'true';
const EVENT_TIME_BOOST_ALPHA   = Number(process.env.EVENT_TIME_BOOST_ALPHA || 0.30);
const EVENT_TIME_TOPK          = Number(process.env.EVENT_TIME_TOPK || 3);

const _MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function _monthWindowTags(query, nowMs) {
  if (!query) return [];
  const q = query.toLowerCase();
  const tags = new Set();
  for (let mi = 0; mi < 12; mi++) {
    const name = _MONTHS[mi];
    if (!new RegExp(`\\b${name}\\b`).test(q)) continue;
    const yMatch = q.match(new RegExp(`${name}\\s+(\\d{4})`));
    const year = yMatch ? Number(yMatch[1]) : new Date(nowMs).getUTCFullYear();
    let startDay = 1, endDay = 31;
    if (/\bearly\b/.test(q)) { startDay = 1;  endDay = 10; }
    else if (/\bmid(?:-|\s)?\b/.test(q)) { startDay = 11; endDay = 20; }
    else if (/\b(late|end of)\b/.test(q)) { startDay = 21; endDay = 31; }
    for (let d = startDay; d <= endDay; d++) {
      const ms = Date.UTC(year, mi, d);
      if (Number.isFinite(ms) && new Date(ms).getUTCMonth() === mi) {
        const iso = new Date(ms).toISOString().slice(0, 10);
        tags.add(`ts:${iso}`);
        tags.add(`time:${iso}`);
      }
    }
  }
  return Array.from(tags);
}

function applyEventTimeBoost(memories, query) {
  if (!EVENT_TIME_RANKING_BOOST || !memories?.length || !query) return memories;
  const now = Date.now();
  const window = new Set([
    ...normalizeQueryTemporalTokens(query, now),
    ..._monthWindowTags(query, now),
  ]);
  if (window.size === 0) return memories;
  let boosted = 0;
  const out = memories.map((m) => {
    const hit = (m.tags || []).some((t) => window.has(t));
    if (!hit) return m;
    boosted++;
    const base = Number(m._rank_score) || Number(m.score) || 0;
    return { ...m, _rank_score: base * (1 + EVENT_TIME_BOOST_ALPHA), _event_time_boosted: true };
  }).sort((a, b) => (Number(b._rank_score) || 0) - (Number(a._rank_score) || 0));
  if (boosted > 0) {
    console.log(`[recall-router] event-time-boost: window=${window.size} tags, boosted=${boosted}/${memories.length}`);
  }
  return out;
}

// ── V5 D5: type-aware recall (flag-gated, default off) ──────────────────────
// When the multilingual planner signals the question asks for a specific KIND of
// memory (answer_type -> options.boost_memory_type), we (1) add a type-scoped
// retrieval LANE so a type-matching memory is guaranteed to be a candidate even
// when the base lexical/vector/entity lanes miss it (root cause of the residual
// "what did we decide" gap: entity-hop0 matched 0 entities, so the decision was
// never generated), and (2) soft-boost matching rows. Language-neutral (the type
// comes from the planner, not keywords) and tenant-safe (the lane anchors on the
// caller's already-resolved canonical entities via memoryEntityLink and hydrates
// through store.getMemories, which applies the same visibility rules).
const TYPE_AWARE_RECALL = (process.env.V5_TYPE_AWARE_RECALL || 'false').toLowerCase() === 'true';
const MEMORY_TYPE_BOOST_ALPHA = Number(process.env.MEMORY_TYPE_BOOST_ALPHA || 0.6);
const EVENT_RANGE_CANDIDATE_LIMIT = Math.max(15, Math.min(120, Number(process.env.RECALL_EVENT_RANGE_CANDIDATE_LIMIT || 60)));
function applyMemoryTypeBoost(memories, boostType) {
  if (!boostType || !memories?.length) return memories;
  const bt = String(boostType).toLowerCase();
  let boosted = 0;
  const out = memories.map((m) => {
    const mt = String(m.memory_type || m.memoryType || '').toLowerCase();
    if (mt !== bt) return m;
    boosted++;
    const base = Number(m._rank_score) || Number(m.score) || 0;
    return { ...m, _rank_score: base * (1 + MEMORY_TYPE_BOOST_ALPHA), score: (Number(m.score)||0) * (1 + MEMORY_TYPE_BOOST_ALPHA), _memory_type_boosted: true };
  }).sort((a, b) => (Number(b._rank_score) || Number(b.score) || 0) - (Number(a._rank_score) || Number(a.score) || 0));
  if (boosted > 0) console.log(`[recall-router] memory-type-boost: type=${bt}, boosted=${boosted}/${memories.length}`);
  return out;
}

// Type-scoped candidate lane. Returns hydrated memories of `boostType` linked to
// any of `entityNames` in this org, bounded. Tenant-safe: memoryEntityLink is
// org-scoped via the entity ids, and hydration goes through store.getMemories.
async function fetchTypeScopedCandidates({ prisma, store, orgId, boostType, entityNames }) {
  try {
    if (!prisma?.canonicalEntity?.findMany || !prisma?.memoryEntityLink?.findMany || !store?.getMemories) return [];
    const names = (entityNames || []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 12);
    if (!names.length) return [];
    const norm = names.map((n) => n.toLowerCase());
    const ents = await prisma.canonicalEntity.findMany({
      where: { organizationId: orgId, OR: [
        { canonicalName: { in: names, mode: 'insensitive' } },
        { normalizedName: { in: norm } },
      ] },
      select: { id: true }, take: 24,
    }).catch(() => []);
    if (!ents.length) return [];
    const links = await prisma.memoryEntityLink.findMany({
      where: { entityId: { in: ents.map((e) => e.id) } },
      select: { memoryId: true }, take: 60,
    }).catch(() => []);
    const ids = [...new Set(links.map((l) => l.memoryId))];
    if (!ids.length) return [];
    const memMap = await store.getMemories(ids).catch(() => new Map());
    const bt = String(boostType).toLowerCase();
    const out = [];
    for (const id of ids) {
      const m = memMap.get ? memMap.get(id) : null;
      if (!m) continue;
      const mt = String(m.memory_type || m.memoryType || '').toLowerCase();
      if (mt !== bt) continue;
      if (m.org_id && m.org_id !== orgId) continue; // cross-org safety net
      out.push({ ...m, memory_type: m.memory_type || m.memoryType, score: Number(m.score) || 0.55, _type_scoped_lane: true });
      if (out.length >= 8) break;
    }
    return out;
  } catch { return []; }
}

const HOP1_TIMEOUT_MS          = 4000;
const HOP2_TIMEOUT_MS          = 1500;
const HOP3_TIMEOUT_MS          = 4000;

const SPARSE_MEMORY_COUNT      = 2;     // <2 hits ⇒ sparse
const SPARSE_TOP_SCORE         = 0.5;   // top hit below this ⇒ sparse

const RRF_K                    = 60;    // standard RRF constant
const ANCHOR_BOOST             = 0.30;  // additive boost when memory tagged w/ doc anchor
// Dreams-first: synthesis memories (the cognitive layer's dreams — canonical /
// bridge / principle) are the distilled, cross-source view, so a matching dream
// should outrank its raw inputs in recall. The lift is MULTIPLICATIVE on the
// dream's OWN rrf base (NOT a flat additive bonus): a flat +0.5 is ~30x the
// entire base spread of 1/(RRF_K+rank), so it floated EVERY retrieved dream above
// ALL raw memories — at scale (many dreams) recall degenerated to "dreams only".
// Multiplying keeps the lift proportional to the dream's own relevance, so a
// weakly-relevant dream cannot leapfrog a strongly-relevant raw memory. A hard
// quota (MAX_DREAMS_IN_TOPN) then guarantees raw evidence still appears in the
// delivered set. Default on.
const DREAM_FIRST_ENABLED      = process.env.RECALL_DREAMS_FIRST !== 'false';
const DREAM_RANK_MULT          = Number(process.env.RECALL_DREAM_MULT || 1.6);
const MAX_DREAMS_IN_TOPN       = Number(process.env.RECALL_MAX_DREAMS_IN_TOPN || 2);
const KB_DURABLE_MIN_IMPORTANCE = Number(process.env.KB_UNIFIED_MIN_IMPORTANCE || 0.65);

export function recallMemoryRowId(memory = {}) {
  return memory.id || memory.memory?.id || null;
}

function recallDisplayText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  if (Array.isArray(value)) {
    const item = value.find((entry) => typeof entry === 'string' && entry.trim());
    return item || fallback;
  }
  if (typeof value === 'object') {
    for (const key of ['title', 'name', 'label', 'text', 'value', 'en']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key];
    }
    return fallback;
  }
  return String(value);
}

export function serializeRecallMemory(m, { includeFullContent = false } = {}) {
  const stored = m.memory || {};
  const content = typeof m.content === 'string' ? m.content : (typeof stored.content === 'string' ? stored.content : '');
  return {
    id: recallMemoryRowId(m),
    // Recall is a public contract. Legacy/remote stores may carry a JSON title
    // (localized object, array, or provider envelope); never let that shape
    // escape into chat/UI code that correctly expects a scalar title.
    title: recallDisplayText(m.title, recallDisplayText(stored.title, 'Memory')),
    content: includeFullContent ? content : content.slice(0, 400),
    memory_type: m.memory_type || stored.memory_type,
    tags: m.tags || stored.tags,
    score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
    created_at: m.created_at || m.createdAt || stored.created_at || stored.createdAt || null,
    event_time: m.event_time || m.eventTime || stored.event_time || stored.eventTime || null,
    valid_at: m.valid_at || m.validAt || stored.valid_at || stored.validAt || null,
    valid_from: m.valid_from || m.validFrom || stored.valid_from || stored.validFrom || null,
    valid_to: m.valid_to || m.validTo || stored.valid_to || stored.validTo || null,
    known_at: m.known_at || m.knownAt || stored.known_at || stored.knownAt || m.created_at || m.createdAt || null,
    ...(m.source_metadata?.source_type
      ? { source_metadata: { source_type: m.source_metadata.source_type } }
      : {}),
    ...(m.synthesis_confidence != null ? { synthesis_confidence: m.synthesis_confidence } : {}),
    ...(m.synthesis_revision != null ? { synthesis_revision: m.synthesis_revision } : {}),
    ...(m.synthesis_cluster_hash ? { synthesis_cluster_hash: m.synthesis_cluster_hash } : {}),
    ...(Array.isArray(m.synthesis_evidence_ids) && m.synthesis_evidence_ids.length
      ? { synthesis_evidence_ids: m.synthesis_evidence_ids }
      : {}),
    ...(m._cross_cluster_boost != null ? {
      _cross_cluster_boost: Number(m._cross_cluster_boost.toFixed(3)),
      _cross_cluster_overlap: m._cross_cluster_overlap || 0,
    } : {}),
    ...(typeof m.tier === 'number' ? { tier: m.tier } : {}),
  };
}

export function serializeRecallEvidence(e = {}) {
  return {
    segment_id:       e.segmentId || e.segment_id || e.id || null,
    document_id:      e.documentId || e.document_id || null,
    document_title:   e.document?.title || e.document_title || null,
    content:          String(e.content || '').slice(0, 600),
    snippet:          e.snippet,
    score:            typeof e.score === 'number' ? Number(e.score.toFixed(3)) : null,
    page:             e.metadata?.startPage || e.page || null,
    linked_memory_id: e.linked_memory_id,
    source_kind:      e.document?.documentType || e.document?.sourcePlatform || e.source_kind || null,
    memory_type:      e.metadata?.memory_type || e.memory_type || null,
    event_time:       e.metadata?.event_time || e.event_time || e.document?.documentDate || null,
    valid_from:       e.metadata?.valid_from || e.valid_from || null,
    valid_to:         e.metadata?.valid_to || e.valid_to || null,
    known_at:         e.metadata?.known_at || e.known_at || e.document?.createdAt || null,
  };
}

function recallItemTime(item = {}) {
  const stored = item.memory || {};
  const raw = item.event_time || item.eventTime || stored.event_time || stored.eventTime
    || item.valid_from || item.validFrom || stored.valid_from || stored.validFrom
    || item.valid_at || item.validAt || stored.valid_at || stored.validAt
    || item.metadata?.event_time || item.metadata?.valid_from
    || item.document?.documentDate
    || item.known_at || item.knownAt || item.metadata?.known_at
    || item.created_at || item.createdAt || stored.created_at || stored.createdAt;
  const parsed = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function recallItemTimeForAxis(item = {}, axis = 'known_time') {
  const stored = item.memory || {};
  const metadata = item.metadata || {};
  const candidates = axis === 'event_time'
    ? [item.event_time, item.eventTime, stored.event_time, stored.eventTime,
      metadata.event_time, item.document?.documentDate, item.document_date]
    : axis === 'valid_time'
      ? [item.valid_from, item.validFrom, stored.valid_from, stored.validFrom,
        item.valid_at, item.validAt, metadata.valid_from, item.document?.documentDate]
      : [item.known_at, item.knownAt, stored.known_at, stored.knownAt,
        metadata.known_at, item.created_at, item.createdAt,
        stored.created_at, stored.createdAt, item.document?.createdAt];
  for (const raw of candidates) {
    const parsed = raw ? new Date(raw).getTime() : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

export function orderTemporalCandidates(rows = [], {
  selector = null,
  axis = 'known_time',
  unwrap = (row) => row,
  id = (row) => row?.id || row?.segmentId || row?.segment_id || '',
} = {}) {
  if (!['latest', 'earliest'].includes(selector)) return [...rows];
  const direction = selector === 'latest' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftRow = unwrap(left); const rightRow = unwrap(right);
    const temporal = direction * (recallItemTimeForAxis(leftRow, axis) - recallItemTimeForAxis(rightRow, axis));
    if (temporal) return temporal;
    const relevance = (Number(rightRow?.score) || 0) - (Number(leftRow?.score) || 0);
    return relevance || String(id(leftRow)).localeCompare(String(id(rightRow)));
  });
}

// Legacy KB promotions can receive a strong retrieval score even when their
// ingestion importance was below today's durable-memory admission threshold.
// Keep those rows out of normal memory recall without hiding source evidence,
// summaries, or syntheses used for explicit source reconstruction.
export function filterLowSaliencePromotedMemories(memories, minImportance = KB_DURABLE_MIN_IMPORTANCE) {
  return memories.filter((memory) => isDurableKbPromotionAdmitted(memory, minImportance));
}

export function mergePromotionImportance(memories, rows) {
  const byId = new Map((rows || []).map((row) => [row.id, row.importanceScore]));
  return memories.map((memory) => byId.has(memory.id)
    ? { ...memory, importance_score: byId.get(memory.id) }
    : memory);
}

const WORKSPACE_PLATFORMS = new Set([
  'gmail', 'google_drive', 'google_calendar', 'google_docs', 'google_sheets',
]);

// Live data is expensive and may be broader than the source evidence already
// selected for an answer. It is therefore a bounded expansion only: an
// explicit live intent, or a retrieved connector/source anchor, plus surface
// policy. No query-language heuristic decides this across languages.
export function isLiveExpansionEligible({ includeLive, inspection, liveIntent = false, surfacePolicyAllowsLive = true }) {
  if (!includeLive || !surfacePolicyAllowsLive) return false;
  return liveIntent
    || inspection?.docIds?.length > 0
    || inspection?.platforms?.some((platform) => WORKSPACE_PLATFORMS.has(platform));
}

// ── Utility: with-timeout wrapper ───────────────────────────────────────────

async function withTimeout(taskOrPromise, ms, fallback, label = 'recall-router-stage') {
  try {
    return await runWithStageDeadline(
      () => typeof taskOrPromise === 'function' ? taskOrPromise() : taskOrPromise,
      { timeoutMs: ms, fallback, label },
    );
  } catch (error) {
    if (isRemoteMemoryUnavailableError(error)) throw error;
    return typeof fallback === 'function' ? fallback(error) : fallback;
  }
}

// ── RECALL_HYBRID_DELIVERY_ALWAYS_ON — one relevance authority over memories + evidence ──
// The inventory proved the old tail computed ~20 boosts + RRF + MMR then threw
// them away (ResultReranker overwrote .score, RRF wrote a dead _rank_score).
// V2 replaces that churn with a single coherent stage: RRF-fuse the two ranked
// lists (rank-only → memory & evidence become COMPARABLE, the fix for "only
// memories reach top-5"), cross-encoder rerank the unified window (the relevance
// authority, wide 0-1 scale), then apply a SMALL set of SURVIVING amplitude
// boosts (>1) that actually matter for right-context — recency/event-time
// (temporal), working-set (chat continuity), synthesis-canonical — minus
// correctness penalties (superseded/contradicted). Comparable unified scores are
// written back so the agent's synthesis picks across memory+evidence fairly.
// Flag-gated (default OFF). Backend-agnostic: operates on candidates, so it
// works identically for central Qdrant/PG and for `.amr` (dense + agent-PG lexical).
const V2_RRF_K = 60;
// The parked A/B ran with a 24 pool while evidence arrived capped at 8 — it never saw
// depth, which is the variable that moved small-detail answerability 3/5 -> 5/5.
const V2_POOL  = Number(process.env.RECALL_UNIFIED_POOL || 150);

export async function deliverHybrid({ query, memories = [], evidence = [], deliverN, evidenceN, budgetMs }) {
  // THE recall pipeline. Two lanes retrieved in parallel, fused into ONE pool, ranked by
  // ONE cross-encoder pass, split back out. No RRF, no amplitude boosts, no flag.
  //
  // Replaces deliverHybrid, parked after an A/B showed "no rank win". Three measured
  // reasons it lost: its pool capped at 24 while evidence arrived capped at 8, so it
  // never saw depth — the variable that moves small-detail answerability 3/5 -> 5/5;
  // its boosts (pinned x2.0 / synthesis x1.3 / event-time x1.4) read fields present only
  // on MEMORY rows, so every evidence row scored x1; and those boosts MULTIPLIED the
  // cross-encoder score, overwriting a real (query,passage) judgement with heuristics.
  //
  // Verified: 0 of 485 memories held the 5 small facts under test (prices, part numbers,
  // a kW rating, a surname); all 5 were in segments; one rerank over memories u segments
  // answered 5/5, choosing a segment over a memory 5/5 unprompted.
  //
  // Ordering is the cross-encoder's alone. The only non-relevance signal kept is
  // supersession, and it FILTERS rather than reweights — truth, not a guess.
  const pool = [
    ...memories.map((m) => {
      // Structured claim identity was extracted during ingestion at no chat-time
      // cost. Expose it to the ONE unified reranker as a compact prefix so exact
      // product/category/date/role questions can match the durable claim shape,
      // while the full source passage remains available in the evidence lane.
      const metadataClaim = m.metadata?.claim || {};
      const qualifiers = m.claimQualifiers || m.claim_qualifiers || metadataClaim.qualifiers || {};
      const subject = m.claimSubject || m.claim_subject || metadataClaim.subject?.name || '';
      const predicate = m.claimPredicate || m.claim_predicate || metadataClaim.predicate || '';
      const object = qualifiers && typeof qualifiers === 'object' ? (qualifiers.object || '') : '';
      const claimPrefix = [subject, predicate, object].filter(Boolean).join(' | ');
      const content = typeof m.content === 'string' ? m.content : '';
      return {
        _row: m, _kind: 'memory', _title: m.title || '',
        _content: claimPrefix ? `[CLAIM ${claimPrefix}] ${content}` : content,
      };
    }),
    ...evidence.map((e) => ({ _row: e, _kind: 'evidence', _title: e.document?.title || e.document_title || '', _content: e.content || e.snippet || '' })),
  ].filter((c) => c._content || c._title);
  if (pool.length <= 1) return null;

  // Deduplicate identical EVIDENCE passages, never an entire source segment merely
  // because one atomic memory was promoted from the same document. A document-level
  // lineage marker does not mean content equivalence: the segment may carry qualifiers,
  // neighbouring facts, tables, or the exact phrase the user asked for which the atomic
  // memory deliberately omits. The shared reranker is the relevance authority over both
  // layers and can retain either or both when they contribute distinct context.
  const deduped = prepareUnifiedRecallCandidates(pool);

  let ordered = deduped;
  let usedCrossEncoder = false;
  // TWO NESTED TIMEOUTS, AND THE OUTER ONE WAS SHORTER THAN THE INNER CALL.
  // rerank() runs with its own RERANK_TIMEOUT_MS (default 2500) plus one retry, but this
  // wrapper capped it at `Math.min(Math.max(budgetMs || 0, 1200), 3000)` — a floor of
  // 1200ms. Measured against the live endpoint: a COLD rerank is ~1207ms (warm ~200ms).
  // So on any request that arrived with little budget left, the outer timeout pre-empted a
  // perfectly healthy reranker.
  //
  // And it did so INVISIBLY: withTimeout's third argument is a fallback VALUE, so a timeout
  // RESOLVES TO null rather than throwing — the catch below never ran, the reranker's own
  // "[reranker] degraded" warn never ran either (its promise was still in flight), and the
  // only symptom was `DEGRADED: no cross-encoder` with no stated cause. That is what made
  // recall look non-deterministic: 3 degradations in 40 minutes and a canary flapping
  // 4/5 -> 5/5 on the one cross-lingual question, with nothing in the log to explain it.
  //
  // A retrieval budget is a latency target, never permission to omit the only
  // stage that makes memory and evidence scores comparable. In particular,
  // returning a mixed pool unranked can place an unrelated source ahead of a
  // directly relevant memory and make synthesis assert a false absence.
  //
  // Give the primary fast reranker a small, explicit grace window once the
  // retrieval lanes have completed. The request-level deadline remains in
  // force through currentStageSignal(), and provider failure still follows the
  // configured fallback chain. This avoids an exhausted *internal* fact-mode
  // budget silently changing answer correctness.
  const _rrBudget = Math.max(0, Number(budgetMs) || 0);
  const _rrStart = Date.now();
  const rr = await rerank(
    query,
    deduped.map((c) => ({ title: c._title, content: c._content, _u: c })),
    { topN: deduped.length },
  ).catch(() => null);
  const rerankMeta = rr?.rerank_meta || null;
  if (rerankMeta?.status !== 'served' || !Array.isArray(rr) || !rr.some((x) => x.rerank_score != null)) {
    // Provider failure must not turn an otherwise authorized recall into a
    // 5xx. Scores from the two lanes are incomparable, so preserve each lane's
    // internal order and interleave them deterministically instead of sorting
    // their raw magnitudes together.
    const memoryLane = deduped.filter((candidate) => candidate._kind === 'memory');
    const evidenceLane = deduped.filter((candidate) => candidate._kind === 'evidence');
    ordered = [];
    for (let index = 0; index < Math.max(memoryLane.length, evidenceLane.length); index += 1) {
      if (memoryLane[index]) ordered.push(memoryLane[index]);
      if (evidenceLane[index]) ordered.push(evidenceLane[index]);
    }
  } else {
    ordered = rr.map((x) => {
      const score = Number(x.rerank_score);
      return { ...x._u, _rerankScore: Number.isFinite(score) ? score : null };
    });
    usedCrossEncoder = true;
  }

  // FALLBACK MUST NOT COMPARE LANES BY SCORE. Lexical evidence scores are synthetic
  // (0.55-0.95), vector scores are real cosine (often <0.15), and memory scores come
  // from an entirely different pipeline — they are incomparable magnitudes. Sorting the
  // union by `score` therefore lets whichever lane happens to use the larger scale win
  // outright. That is exactly what buried the German `E3DC Zähler` row behind keyword
  // hits on the one question that needed semantics. When the cross-encoder is
  // unavailable, INTERLEAVE the lanes instead so neither can dominate, and say so.
  const outMem = []; const outEv = []; const rankedCandidates = [];
  for (const c of ordered) {
    const x = c._row || {};
    if (x.is_latest === false || x.supersedes_id) continue;   // superseded: truth filter
    const rank = rankedCandidates.length + 1;
    if (c._kind === 'evidence') {
      outEv.push(x);
      rankedCandidates.push({ kind: 'evidence', segment_id: x.segmentId || x.segment_id || x.id, rank, score: c._rerankScore ?? null });
    } else {
      outMem.push(x);
      const memoryId = recallMemoryRowId(x);
      if (!memoryId) continue;
      rankedCandidates.push({ kind: 'memory', memory_id: memoryId, rank, score: c._rerankScore ?? null });
    }
  }
  // The cross-encoder may score a wide pool, but the canonical retained result
  // is one mixed top-15 — not 15 memories plus 15 evidence rows. Chat then
  // reveals five or fifteen from this same order without another retrieval.
  const retainedCandidates = rankedCandidates.slice(0, 15);
  const retainedMemoryIds = new Set(retainedCandidates.filter((c) => c.kind === 'memory').map((c) => c.memory_id));
  const retainedEvidenceIds = new Set(retainedCandidates.filter((c) => c.kind === 'evidence').map((c) => c.segment_id));
  if (process.env.HM_RECALL_VERBOSE === '1') console.log(`[recall-hybrid] pool=${pool.length} deduped=${deduped.length} mem_in=${memories.length} ev_in=${evidence.length} -> retained=${retainedCandidates.length}`);
  return {
    // Keep backing rows for every retained mixed candidate. The progressive
    // view still exposes only ranks 1-5 initially, but can now reveal the true
    // ranks 6-15 even when one lane dominates the unified ordering.
    memories: outMem.filter((row) => retainedMemoryIds.has(recallMemoryRowId(row))),
    evidence: outEv.filter((row) => retainedEvidenceIds.has(row.segmentId || row.segment_id || row.id)),
    // Preserve the cross-encoder's one authoritative mixed order. Consumers
    // may progressively reveal this list without another retrieval/rerank.
    ranked_candidates: retainedCandidates,
    ranking_mode: usedCrossEncoder ? 'cross_encoder' : 'provider_failure_interleave',
    rerank_passes: usedCrossEncoder ? 1 : 0,
    rerank_ms: Date.now() - _rrStart,
    rerank: rerankMeta,
  };
}

// ── Hop 1 — Memory layer ────────────────────────────────────────────────────

async function hop1Memory({ store, query, options, ctx }) {
  const scopedAccessCtx = ctx.projectId
    ? { ...(ctx.accessContext || {}), projectIds: [ctx.projectId] }
    : ctx.accessContext;

  // Connector-keyword shortcut. Natural-language queries like "what was
  // the last slack msg about" tokenize into noise (what/was/the/last/…)
  // and the high-IDF "slack" term gets swamped. When the query clearly
  // names a connector AND has a recency cue (last/latest/recent), bias
  // the recall to tag=<connector> + ordered by created_at desc instead
  // of pure FTS.
  const ql = String(query || '').toLowerCase();
  const allowLanguageHeuristics = options.structured_intent !== true;
  const CONNECTOR_KW = ['slack', 'notion', 'gmail', 'github', 'linear', 'jira', 'confluence'];
  const matchedConnector = allowLanguageHeuristics ? CONNECTOR_KW.find(k => ql.includes(k)) : null;
  const isRecentish = allowLanguageHeuristics && /\b(last|latest|recent|today|yesterday|just|now)\b/.test(ql);
  let hasValidAt = !!(options.valid_at && !Number.isNaN(new Date(options.valid_at).getTime()));
  // Inline date detection — pulls "as of May 13", "before March 2025",
  // "on 2026-04-10", "in October" out of the query when caller didn't
  // pass valid_at explicitly. Planner often misses these.
  if (allowLanguageHeuristics && !hasValidAt && /\b(as of|before|prior to|on|in|by|until)\b/.test(ql)) {
    const MONTH = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11, january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
    const now = new Date();
    const year = now.getUTCFullYear();
    // ISO-style: 2026-05-13
    let m = ql.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    let derivedDate = null;
    if (m) derivedDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59));
    if (!derivedDate) {
      // "May 13" / "May 13 2026" / "13 May"
      m = ql.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
      if (m && MONTH[m[1]] !== undefined) {
        derivedDate = new Date(Date.UTC(+(m[3] || year), MONTH[m[1]], +m[2], 23, 59, 59));
      }
    }
    if (!derivedDate) {
      m = ql.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)(?:[,\s]+(\d{4}))?/);
      if (m && MONTH[m[2]] !== undefined) {
        derivedDate = new Date(Date.UTC(+(m[3] || year), MONTH[m[2]], +m[1], 23, 59, 59));
      }
    }
    if (derivedDate && !Number.isNaN(derivedDate.getTime())) {
      options = { ...options, valid_at: derivedDate.toISOString() };
      hasValidAt = true;
    }
  }
  // Infer tag when (a) recency cue + connector keyword OR (b) caller
  // supplies valid_at + connector keyword (time-travel queries don't
  // always carry the word "last").
  const inferredTags = matchedConnector && (isRecentish || hasValidAt) ? [matchedConnector] : null;

  // Bi-temporal controls are independent: valid_at constrains the effective
  // interval, while known_at constrains when HIVEMIND learned the record.
  const validAtDate = options.valid_at && !Number.isNaN(new Date(options.valid_at).getTime())
    ? new Date(options.valid_at)
    : null;
  const knownAtDate = options.known_at && !Number.isNaN(new Date(options.known_at).getTime())
    ? new Date(options.known_at)
    : null;
  const snapshotValidAtDate = validAtDate;
  // Fast-path: if we already know we'll use the tag-anchored override,
  // skip the expensive FTS+vector recall — it adds ~1.5s and we'd discard
  // its output anyway. HOP1_TIMEOUT_MS=1500 was eating these calls.
  // Triggers when: (a) caller explicitly passes tags (intentional filter),
  // (b) recency cue + connector keyword, (c) valid_at + connector keyword.
  const callerTags = Array.isArray(options.tags) && options.tags.length > 0;
  const willOverride = shouldUseTagAnchoredRecall({ callerTags, isRecentish, inferredTags, validAtDate });
  // Caller-provided date_range takes priority over derived valid_at end-
  // cap. Used for today/yesterday/this-week shortcuts where we need a
  // hard start+end window, not just an upper bound.
  const explicitDateRange = options.date_range && typeof options.date_range === 'object'
    ? options.date_range
    : null;
  const recallArgs = {
    query_context: query,
    query_vector: options.query_vector || null,
    user_id: ctx.userId,
    org_id: ctx.orgId,
    max_memories: Math.min(options.limit || HOP1_DEFAULT_LIMIT, 50),
    tags: options.tags || inferredTags || undefined,
    source_type: options.source_type,
    access_context: scopedAccessCtx,
    ...(ctx.projectId ? { project_id: ctx.projectId, project_ids: [ctx.projectId] } : {}),
    ...(explicitDateRange
      ? { date_range: explicitDateRange }
      : {}),
    ...(options.valid_at ? { valid_at: options.valid_at } : {}),
    ...(options.known_at ? { known_at: options.known_at } : {}),
    include_superseded: options.include_superseded === true,
    exact_source: !!(options.source_document_id || options.source_title),
    canonical_entities: options.canonical_entities || [],
    alternate_lexical_query: options.alternate_lexical_query || null,
    scope_filter: options.scope_filter || null,
    structured_intent: options.structured_intent === true,
    semantic_recovery: options.semantic_recovery === true,
    // The progressive planner has already produced the semantic query and
    // explicit time/entity controls. Avoid spawning additive remote vector
    // variants that compete for the same tenant transport budget.
    query_expansion: options.structured_intent === true ? false : null,
    entity_filter_mode: options.entity_filter_mode || null,
    temporal_filter_mode: options.structured_intent === true ? 'off' : null,
    // The final delivery boundary runs one cross-encoder over the combined
    // memory + evidence pool (or applies chronological ordering for timeline).
    // A memory-only pass here was paid twice and then discarded.
    cross_rerank: initialMemoryCrossRerank({
      laterAuthoritativeOrdering: true,
      requested: options.semantic_recovery === true ? true : null,
    }),
    // RecallRouter builds its own evidence packet and never consumes the
    // legacy injectionText. Avoid waiting for observation/profile assembly on
    // this path. Fact/quick also has no graph hop, so relationship expansion
    // cannot affect its candidate set or final unified cross-encoder order.
    include_injection_context: false,
    // Chat already has its one selected, citation-bearing unified delivery
    // window.  Do not hydrate secondary source rows merely to build rich
    // synthesis cards that the chat path never renders.
    include_synthesis_evidence: false,
    graph_expansion_depth: options.mode === 'fact' ? 0 : 2,
    trace_stages: options.trace_stages === true,
    timing: options.timing || null,
  };
  // PHASE-B TODO: surface spine from recallPersistedMemories result when TIERED_VIEW lands on router path
  const result = willOverride
    ? { memories: [] }
    : await recallPersistedMemories(store, recallArgs);
  if (options.timing && result?.timing_breakdown) {
    options.timing.pipeline = result.timing_breakdown;
  }

  // Tag-anchored recency override. When the query carries a recency cue
  // (last/latest/recent/today/…) AND we inferred a connector tag, FTS-
  // ranked code-mention memories drown out the actual recent channel
  // messages. Override with a direct tag fetch ordered by document_date
  // desc so the freshest tagged memory always wins.
  //
  // Also fires as a hard fallback when FTS returned 0 hits.
  const effectiveTags = options.tags || inferredTags;
  let mems = result.memories || [];
  const missingPromotionImportance = mems.filter((memory) => {
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    return tags.includes('distilled-from-kb')
      && !Number.isFinite(Number(memory.importance_score ?? memory.importanceScore));
  });
  if (missingPromotionImportance.length && store.client?.memory?.findMany) {
    try {
      const importanceRows = await store.client.memory.findMany({
        where: { id: { in: missingPromotionImportance.map((memory) => memory.id) } },
        select: { id: true, importanceScore: true },
      });
      mems = mergePromotionImportance(mems, importanceRows);
    } catch (error) {
      console.warn('[recall-router] promotion importance hydration failed:', error.message);
    }
  }
  const recencyOverride = isRecentish && inferredTags && store.client?.memory;
  // Time-travel override: when valid_at is set and we have tags (caller-
  // supplied or inferred), also drop into the direct-fetch path so the
  // document_date <= valid_at filter applies AND we order by date.
  const timeTravelOverride = (validAtDate || knownAtDate) && Array.isArray(effectiveTags) && effectiveTags.length > 0 && store.client?.memory;
  const callerTagOverride = callerTags && store.client?.memory;
  if ((recencyOverride || timeTravelOverride || callerTagOverride || (mems.length === 0 && Array.isArray(effectiveTags) && effectiveTags.length > 0)) && store.client?.memory) {
    try {
      const accessWhere = scopedMemoryWhere({
        user_id: ctx.userId,
        org_id: ctx.orgId,
        project: options.project || undefined,
        access_context: scopedAccessCtx,
      });
      const tagOnly = await store.client.memory.findMany({
        where: {
          ...accessWhere,
          deletedAt: null,
          // valid_at queries need superseded versions too — show what was
          // current at that past moment (isLatest at valid_at, not now).
          ...(validAtDate || knownAtDate ? {} : { isLatest: true }),
          tags: { hasSome: effectiveTags },
          // Time-travel: filter by EVENT TIME (document_date) only —
          // that's what users mean by "as of May 13" (msgs sent by then),
          // not "memories known by then". Bi-temporal createdAt filter
          // was excluding memories ingested today but sent earlier.
          ...(snapshotValidAtDate ? {
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: snapshotValidAtDate } }] },
              { OR: [{ validTo: null }, { validTo: { gt: snapshotValidAtDate } }] },
            ],
          } : {}),
          ...(knownAtDate ? { createdAt: { lte: knownAtDate } } : {}),
        },
        orderBy: [{ documentDate: 'desc' }, { createdAt: 'desc' }],
        take: Math.min((options.limit || HOP1_DEFAULT_LIMIT) * 4, 50),
        select: {
          id: true, title: true, content: true, memoryType: true, tags: true, isLatest: true,
          createdAt: true, documentDate: true, validFrom: true, validTo: true,
          importanceScore: true, sourceMetadata: true,
        },
      });
      // Connector-specific quality filter. A memory tagged "slack" that
      // doesn't carry "channel:*" is almost certainly a code-mention or
      // synthesis row referencing Slack — not an actual channel message.
      // Same shape per provider: notion needs `page:`, gmail needs
      // `from:` or `thread:`. Filter only fires when the connector emits
      // its specific marker tag at ingest.
      const REAL_MEMORY_MARKERS = {
        slack: t => t.startsWith('channel:'),
        notion: t => t.startsWith('page:') || t.startsWith('database:'),
        gmail: t => t.startsWith('from:') || t.startsWith('thread:'),
        github: t => t.startsWith('repo:') || t.startsWith('issue:') || t.startsWith('pr:'),
        linear: t => t.startsWith('team:') || t.startsWith('issue:'),
      };
      const marker = REAL_MEMORY_MARKERS[matchedConnector];
      const ranked = marker
        ? tagOnly.filter(m => (m.tags || []).some(marker))
        : tagOnly;
      const finalSet = (ranked.length === 0 ? tagOnly : ranked)
        .slice(0, Math.min(options.limit || HOP1_DEFAULT_LIMIT, 50));
      mems = finalSet.map(m => ({
        id: m.id,
        title: m.title,
        content: m.content,
        memory_type: m.memoryType,
        tags: m.tags || [],
        score: Number(m.importanceScore) || 0.5,
        created_at: m.createdAt,
        valid_at: m.validFrom || m.documentDate || m.createdAt,
        valid_from: m.validFrom || null,
        valid_to: m.validTo || null,
        is_latest: m.isLatest,
        source_metadata: m.sourceMetadata || null,
        importance_score: m.importanceScore,
        _searchMethod: 'tag_fallback',
      }));
    } catch (err) {
      console.warn('[recall-router] tag fallback failed:', err.message);
    }
    return mems;
  }

  return mems.map((m) => ({
    id: m.id,
    title: m.title,
    content: m.content,
    memory_type: m.memory_type,
    tags: m.tags || [],
    score: m.score,
    created_at: m.created_at,
    valid_at: m.valid_at || m.document_date,
    source_metadata: m.source_metadata || null,
    importance_score: m.importance_score ?? m.importanceScore,
    // Pass synthesis cluster hash through so cross-cluster boost can fire (Move 3)
    ...(m.synthesis_cluster_hash ? { synthesis_cluster_hash: m.synthesis_cluster_hash } : {}),
    ...(m.synthesisClusterHash   ? { synthesisClusterHash:   m.synthesisClusterHash   } : {}),
    // Cognition layer fields — needed by tool-registry insight expansion
    // + agent answerStep synthesis-tier rendering.
    ...(m.synthesis_confidence != null    ? { synthesis_confidence:   m.synthesis_confidence }   : {}),
    ...(m.synthesisConfidence  != null    ? { synthesis_confidence:   m.synthesisConfidence }    : {}),
    ...(m.synthesis_revision   != null    ? { synthesis_revision:     m.synthesis_revision }     : {}),
    ...(m.synthesisRevision    != null    ? { synthesis_revision:     m.synthesisRevision }      : {}),
    ...(Array.isArray(m.synthesis_evidence_ids) && m.synthesis_evidence_ids.length
        ? { synthesis_evidence_ids: m.synthesis_evidence_ids } : {}),
    ...(Array.isArray(m.synthesisEvidenceIds) && m.synthesisEvidenceIds.length
        ? { synthesis_evidence_ids: m.synthesisEvidenceIds } : {}),
  }));
}

// ── Hop 1 inspection — read tags to decide what to do next ─────────────────
//
// Exported so other call sites (like /api/recall's HTTP endpoint) can reuse
// the same memory-first triggering logic without duplicating the regex-free
// classifier. Pass any memory array, get back the anchors + sparseness flag.

export function inspectMemories(memories) {
  const filenames  = new Set();
  const docHashes  = new Set();
  const docIds     = new Set();
  const platforms  = new Set();
  let topScore     = 0;

  for (const m of memories) {
    if (typeof m.score === 'number' && m.score > topScore) topScore = m.score;
    for (const t of (m.tags || [])) {
      if (typeof t !== 'string') continue;
      if (t.startsWith('filename:')) filenames.add(t.slice('filename:'.length));
      else if (t.startsWith('doc-hash:')) docHashes.add(t.slice('doc-hash:'.length));
    }
    const sm = m.source_metadata || {};
    if (sm.document_id) docIds.add(sm.document_id);
    if (sm.source_platform) platforms.add(sm.source_platform);
  }

  const sparse = memories.length < SPARSE_MEMORY_COUNT
    || (memories.length > 0 && topScore < SPARSE_TOP_SCORE);

  return {
    filenames:   [...filenames],
    docHashes:   [...docHashes],
    docIds:      [...docIds],
    platforms:   [...platforms],
    sparse,
    topScore,
    count: memories.length,
  };
}

// ── Resolve filename → document_id via Postgres (rare path) ─────────────────
// Most of the time hop-1 memories already carry source_metadata.document_id.
// Only used when a memory has `filename:` tag without a resolved document_id
// (legacy data pre-`aebf344`).

async function resolveDocIdsFromFilenames({ prisma, filenames, userId, orgId, projectId = null }) {
  if (!filenames.length) return [];
  // Remote (self-host): KB docs live on the agent — list them and match filename→title client-side.
  if (orgIsRemote(orgId)) {
    try {
      const out = await amrKbDocs(orgId, { limit: 200, access: { userId, projectId } });
      const docs = out?.documents || [];
      const lows = filenames.map((f) => String(f).toLowerCase());
      return docs
        .filter((d) => {
          const t = String(d.title || d.filename || '').toLowerCase();
          return lows.some((f) => t.includes(f));
        })
        .slice(0, 12)
        .map((d) => d.id || d.document_id)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  if (!prisma?.knowledgeDocument) return [];
  try {
    const rows = await prisma.knowledgeDocument.findMany({
      where: {
        orgId,
        ...(projectId ? { tags: { has: `scope-key:project:${projectId}` } } : {}),
        OR: filenames.map((f) => ({ title: { contains: f, mode: 'insensitive' } })),
      },
      select: { id: true },
      take: 12,
    });
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// All KB documents filed under a project (scope-key tag set at upload). Lets
// hop-2 dig the WHOLE project corpus when hop-1 gave no doc anchors — so a
// buried term in a project doc that hop-1 never surfaced still reaches evidence.
async function resolveProjectDocIds({ prisma, projectId, orgId }) {
  if (!projectId) return [];
  // Remote (self-host): agent kb-docs listing doesn't expose the scope-key project tag —
  // return [] and let the caller's lexical fallback cover it.
  if (orgIsRemote(orgId)) return [];
  if (!prisma?.knowledgeDocument) return [];
  try {
    const rows = await prisma.knowledgeDocument.findMany({
      where: { orgId, tags: { has: `scope-key:project:${projectId}` } },
      select: { id: true },
      take: 50,
    });
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

// ── Hop 2 — Evidence segments ──────────────────────────────────────────────
//
// Escalating "dig deeper" fallback: the deeper we go, the lower-signal the
// source, so evidence ranks BELOW hop-1 memories when handed to the LLM, and
// within evidence retrieveEvidence orders by score (a literal lexical hit can
// outrank a weak vector chunk — that's intentional, it's the stronger signal).
// Scope ladder: hop-1 doc anchors → filenames → the project's whole corpus →
// broad. We ALWAYS dig (no Case-C dead-end): evidence is the ground-truth
// backstop, and hop-1 returning *some* memories doesn't mean it answered the
// query (the competitor footnote case). retrieveEvidence runs vector + the
// lexical fallback, so buried exact terms surface regardless of cosine rank.
export async function hop2Evidence({ evidenceService, query, queryVector = null, ctx, inspection, prisma, filters = {} }) {
  if (!evidenceService) return { items: [], reason: null };

  let docIds = [...inspection.docIds];
  let reason = 'doc-anchored';
  // An explicit project is a hard evidence boundary. Memory anchors may come
  // from the caller's authorized personal/org tiers, but their source documents
  // do not thereby become members of the selected project. Intersect anchors
  // with the project's document inventory; if none remain, search that whole
  // project corpus. This preserves shared memory context without allowing its
  // document lineage to widen evidence retrieval outside the selected project.
  if (ctx.projectId) {
    const projectDocIds = await resolveProjectDocIds({
      prisma, projectId: ctx.projectId, orgId: ctx.orgId,
    });
    if (projectDocIds.length > 0) {
      const allowed = new Set(projectDocIds);
      docIds = docIds.filter((id) => allowed.has(id));
      if (docIds.length === 0) {
        docIds = projectDocIds;
        reason = 'project-corpus';
      }
    } else {
      // A selected CENTRAL project with no documents must not silently widen
      // to every document in the organization. For both remote-agent and local
      // embedded .amr backends, however, central Prisma is not authoritative
      // for the tenant's document inventory. Marking those projects empty here
      // suppresses a healthy shard evidence lane. Let the backend enforce the
      // project boundary during retrieveEvidence instead.
      const inventoryAbsentIsAuthoritative = projectInventoryAbsentIsAuthoritative(memoryBackend(ctx.orgId));
      docIds = inventoryAbsentIsAuthoritative ? [] : docIds;
      reason = inventoryAbsentIsAuthoritative ? 'project-empty' : reason;
    }
  }
  if (docIds.length === 0 && inspection.filenames.length > 0) {
    docIds = await resolveDocIdsFromFilenames({
      prisma, filenames: inspection.filenames, userId: ctx.userId, orgId: ctx.orgId,
      projectId: ctx.projectId || null,
    });
  }
  // Dig wider: no hop-1 anchors but a project is in scope → search the whole
  // project corpus (keeps evidence project-isolated, not org-wide leakage).
  if (docIds.length === 0 && ctx.projectId && reason !== 'project-empty') {
    docIds = await resolveProjectDocIds({ prisma, projectId: ctx.projectId, orgId: ctx.orgId });
    if (docIds.length) reason = 'project-corpus';
  }
  if (reason === 'project-empty') {
    return { items: [], reason, docIds: [] };
  }

  // EVIDENCE IS A LANE, NOT A RESCUE.
  //
  // This used to be a three-way gate: run evidence only when hop-1 produced document
  // anchors, else only when hop-1 was `sparse`, else return nothing. Both arms miss a
  // plain question — no filename and no project means no anchors, and 15 loosely
  // related memories count as "not sparse" — so the lane was never called and the
  // verbatim layer could only ever CONFIRM what memories already found, never SUPPLY
  // what they missed.
  //
  // Measured with the [recall-hybrid] counter: ev_in=0 on all five small-detail
  // questions while the same queries hit 5/5 when the lane was called directly. The
  // facts (a price, a part number, a kW rating, a surname, a meter model) exist in
  // segments and in 0 of 485 memories.
  //
  // Now unconditional and parallel-safe: evidence lives in its own Qdrant collection,
  // so this is max() not sum(). Noise is handled where it belongs — the score floor,
  // and the single cross-encoder in deliverHybrid, which `sparse` was crudely
  // approximating by refusing to look.
  const items = await evidenceService.retrieveEvidence({
    query, userId: ctx.userId, orgId: ctx.orgId,
    queryVector,
    projectId: ctx.projectId || null, accessContext: ctx.accessContext || null,
    scopeFilter: ctx.scopeFilter || ctx.scope_filter || null,
    ...(docIds.length > 0 ? { documentIds: docIds } : {}),
    sourceKind: filters.source_kind || null,
    sourceTitle: filters.source_title || null,
    temporalSelector: filters.temporal_selector || null,
    time: {
      range: filters.date_range || null,
      valid_at: filters.valid_at || null,
      known_at: filters.known_at || null,
      axis: filters.temporal_axis || null,
    },
    memoryTypes: filters.memory_types || [],
    entities: filters.canonical_entities || filters.named_entities || [],
    relationshipMemoryIds: filters.relationship_memory_ids || [],
    relationshipRequired: filters.relationships?.requested === true,
    entityFilterMode: filters.relationships?.requested === true
      ? 'any' : (filters.entity_filter_mode || 'must'),
    temporalInventory: filters.operation === 'timeline',
    depth: EVIDENCE_DEPTH,
    deliver: ['latest', 'earliest'].includes(filters.temporal_selector)
      || filters.operation === 'timeline' ? EVIDENCE_DEPTH : evidenceDeliverFor(),
  });
  return {
    items,
    reason: docIds.length > 0 ? reason : (inspection.sparse ? 'sparse' : 'always-on'),
    ...(docIds.length > 0 ? { docIds } : {}),
  };
}

export function projectInventoryAbsentIsAuthoritative(backend) {
  return backend === 'central';
}

// ── Hop 3 — Live workspace ─────────────────────────────────────────────────

export async function hop3Live({ prisma, query, ctx, inspection }) {
  if (!prisma) return { items: [], reason: null };
  const wantsLive = inspection.platforms.some((p) => WORKSPACE_PLATFORMS.has(p));
  if (!wantsLive) return { items: [], reason: null };

  try {
    const { LiveQueryRouter } = await import('../connectors/providers/google/live-query-router.js');
    const { decryptToken, refreshOAuthToken } = await import('../connectors/framework/connector-store.js');
    const router = new LiveQueryRouter({
      prisma, decryptToken, refreshOAuthToken: refreshOAuthToken || null,
    });
    const services = inspection.platforms.filter((p) => WORKSPACE_PLATFORMS.has(p));
    const fetched = await router.fetch(ctx.userId, query, services);
    const items = (fetched || []).slice(0, HOP3_LIVE_LIMIT).map((item) => ({
      source: item._source,
      tool: item._tool,
      title: item.subject || item.name || item.summary || '(untitled)',
      snippet: typeof item.text === 'string'
        ? item.text.slice(0, 600)
        : (item.snippet || item.summary || '').slice(0, 600),
      from: item.from || null,
      to: item.to || null,
      date: item.date || item.internalDate || item.start || null,
      url: item.url || item.webViewLink || null,
      id: item.id || null,
    }));
    return { items, reason: 'platform-anchored' };
  } catch {
    return { items: [], reason: null };
  }
}

// ── Merge — RRF + anchor boost + lineage ───────────────────────────────────

// ── Quality pruning helpers ────────────────────────────────────────────
//
// applyScoreFloor:    drop tail rows scoring < ratio × top_score.
// applyMMRDiversity:  Maximal Marginal Relevance — penalise picks too
//                     similar to already-selected memories. λ controls
//                     relevance↔diversity tradeoff (0.7 = relevance-leaning).
// collapseClusterDuplicates: when multiple memories share a synthesis
//                     cluster, keep the highest-scoring synth + 1 raw
//                     evidence row. Drops redundancy without losing
//                     provenance.

function applyScoreFloor(memories, ratio = 0.40) {
  if (!Array.isArray(memories) || memories.length === 0) return memories;
  const top = Math.max(...memories.map(m => Number(m.score) || 0));
  if (top <= 0) return memories;
  const floor = top * ratio;
  const kept = memories.filter(m => (Number(m.score) || 0) >= floor);
  // Always keep at least 3 even if all but top are below floor.
  return kept.length >= 3 ? kept : memories.slice(0, 3);
}

function jaccardTokens(a, b) {
  const toks = (s) => new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3),
  );
  const A = toks(a), B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function applyMMRDiversity(memories, lambda = 0.70) {
  if (!Array.isArray(memories) || memories.length <= 3) return memories;
  const remaining = [...memories];
  const picked = [];
  // Seed with highest-score memory.
  remaining.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  picked.push(remaining.shift());
  while (remaining.length > 0 && picked.length < memories.length) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const rel = Number(cand.score) || 0;
      const candText = `${String(cand.title || '')} ${String(cand.content || '').slice(0, 200)}`;
      let maxSim = 0;
      for (const p of picked) {
        const pText = `${String(p.title || '')} ${String(p.content || '').slice(0, 200)}`;
        const sim = jaccardTokens(candText, pText);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]);
  }
  return picked;
}

function collapseClusterDuplicates(memories) {
  if (!Array.isArray(memories) || memories.length <= 2) return memories;
  const seen = new Map(); // cluster_hash → { synth: best synth, raw: best raw }
  const out = [];
  for (const m of memories) {
    const hash = m.synthesisClusterHash || m.synthesis_cluster_hash;
    if (!hash) { out.push(m); continue; }
    const tags = m.tags || [];
    const isSynth = (m.source_metadata?.source_type === 'canonical-fact')
                 || (m.source_metadata?.source_type === 'synthesis-bridge')
                 || tags.includes('synthesis:canonical')
                 || tags.includes('synthesis:bridge');
    const slot = seen.get(hash) || { synth: null, raw: null };
    const score = Number(m.score) || 0;
    if (isSynth) {
      if (!slot.synth || score > (Number(slot.synth.score) || 0)) slot.synth = m;
    } else {
      if (!slot.raw || score > (Number(slot.raw.score) || 0)) slot.raw = m;
    }
    seen.set(hash, slot);
  }
  // Emit: synth (preferred) + raw evidence row (if distinct cluster member).
  const emittedClusters = new Set();
  for (const m of memories) {
    const hash = m.synthesisClusterHash || m.synthesis_cluster_hash;
    if (!hash) { out.push(m); continue; }
    if (emittedClusters.has(hash)) continue;
    emittedClusters.add(hash);
    const slot = seen.get(hash);
    if (slot?.synth) out.push(slot.synth);
    if (slot?.raw && slot.raw !== slot.synth) out.push(slot.raw);
  }
  // Preserve original ordering by re-sorting on score desc.
  return out.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

function reciprocalRankFusionMemories(memories, docAnchors) {
  // memories are already ranked by recallPersistedMemories. We re-score with
  // RRF + anchor boost so a memory that explicitly carries the resolved
  // filename / doc-hash floats above semantically-loose neighbors.
  const filenameSet = new Set(docAnchors.filenames);
  const docHashSet  = new Set(docAnchors.docHashes);

  return memories
    .map((m, rank) => {
      const base = 1 / (RRF_K + rank + 1);
      const tagMatchBoost = (m.tags || []).some((t) =>
        (t.startsWith('filename:') && filenameSet.has(t.slice(9))) ||
        (t.startsWith('doc-hash:') && docHashSet.has(t.slice(9))))
        ? ANCHOR_BOOST
        : 0;
      // Dreams-first: lift synthesis memories (cognitive_layer_role set, or
      // memory_type synthesis, or a synthesis:* tag) so the distilled dream
      // ranks above its raw sources — but PROPORTIONALLY (multiplicative on its
      // own base), never a flat bonus that lets a weak dream beat a strong raw.
      const role = m.cognitive_layer_role || m.cognitiveLayerRole;
      const isDream = !!(
        role ||
        m.memory_type === 'synthesis' || m.memoryType === 'synthesis' ||
        (m.tags || []).some((t) => typeof t === 'string' && t.startsWith('synthesis:'))
      );
      const dreamMult = (DREAM_FIRST_ENABLED && isDream) ? DREAM_RANK_MULT : 1;
      return { ...m, _rank_score: (base + tagMatchBoost) * dreamMult, _is_dream: isDream };
    })
    .sort((a, b) => b._rank_score - a._rank_score);
}

// Cap how many dreams may occupy the delivered top-N so raw source evidence
// always survives. Reorders so the first `topN` items contain ≤ maxDreams
// synthesis memories; excess dreams are deferred just past the boundary
// (still returned, just not crowding the delivered slots). Relative order is
// otherwise preserved. Dreams only backfill the prefix if there isn't enough
// raw to fill topN. No-op when dreams-first is disabled or maxDreams < 0.
export function enforceDreamQuota(ranked, topN, maxDreams = MAX_DREAMS_IN_TOPN) {
  if (!DREAM_FIRST_ENABLED || maxDreams < 0 || !Array.isArray(ranked) || ranked.length <= topN) {
    return ranked;
  }
  const isDream = (m) => m._is_dream
    || !!(m.cognitive_layer_role || m.cognitiveLayerRole)
    || m.memory_type === 'synthesis' || m.memoryType === 'synthesis'
    || (m.tags || []).some((t) => typeof t === 'string' && t.startsWith('synthesis:'));
  const front = [];
  const deferredDreams = [];
  const rest = [];
  let dreamsInFront = 0;
  for (const m of ranked) {
    if (front.length >= topN) { rest.push(m); continue; }
    if (isDream(m) && dreamsInFront >= maxDreams) { deferredDreams.push(m); continue; }
    front.push(m);
    if (isDream(m)) dreamsInFront += 1;
  }
  // Not enough raw to fill the prefix → backfill with the deferred dreams.
  while (front.length < topN && deferredDreams.length) front.push(deferredDreams.shift());
  return [...front, ...deferredDreams, ...rest];
}

// ── Enhance helper for HTTP callers (e.g. /api/recall) that already ran
// hop-1 themselves and want the same hop-2 / hop-3 logic appended. Keeps
// /api/recall's rich enrichment pipeline (bi-temporal, operator boost,
// parent-chunk injection, contradictions, profile, dedupe) intact while
// getting the same memory-first event-driven fan-out as the agent tool.
//
// @param {object}  args
// @param {Array}   args.memories         hop-1 result array (already shaped)
// @param {string}  args.query
// @param {object}  args.ctx              { userId, orgId }
// @param {object}  args.evidenceService
// @param {object}  args.prisma
// @param {boolean} args.includeLive
// @returns {Promise<{ evidence, live, trace }>}
export async function recallEnhance({
  memories, query, ctx, evidenceService, prisma, includeLive = true,
  includeGraph = false, includeAdjacent = false, deadlineMs = null,
  liveIntent = false, surfacePolicyAllowsLive = true, liveQuery = hop3Live,
}) {
  const startedAt = Date.now();
  const inspection = inspectMemories(memories || []);
  const cap = (normal) => deadlineMs ? Math.min(normal, deadlineMs) : normal;

  const liveEligible = isLiveExpansionEligible({ includeLive, inspection, liveIntent, surfacePolicyAllowsLive });
  const [hop2, hop3, graph] = await Promise.all([
    withTimeout(
      hop2Evidence({ evidenceService, query, ctx, inspection, prisma }),
      cap(HOP2_TIMEOUT_MS),
      { items: [], reason: 'timeout' },
    ),
    !liveEligible
        ? Promise.resolve({ items: [], reason: 'disabled' })
        : withTimeout(
          liveQuery({ prisma, query, ctx, inspection }),
          cap(HOP3_TIMEOUT_MS),
          { items: [], reason: 'timeout' },
        ),
    !includeGraph
      ? Promise.resolve({ items: [], reason: 'disabled' })
      : withTimeout(
          loadTypedGraphEvidence({
            prisma,
            memoryIds: (memories || []).map((m) => m.id).filter(Boolean),
            userId: ctx.userId,
            orgId: ctx.orgId,
            accessContext: ctx.accessContext,
          }),
          cap(700),
          { items: [], reason: 'timeout' },
        ),
  ]);

  let evidence = hop2.items;
  let adjacentReason = 'disabled';
  if (includeAdjacent && evidence.length && evidenceService?.hydrateAdjacentEvidence) {
    const elapsed = Date.now() - startedAt;
    const remaining = deadlineMs ? Math.max(1, deadlineMs - elapsed) : 900;
    const adjacent = await withTimeout(
      evidenceService.hydrateAdjacentEvidence({
        anchors: evidence,
        userId: ctx.userId,
        orgId: ctx.orgId,
        perDocument: 3,
        total: 12,
      }),
      Math.min(900, remaining),
      null,
    );
    if (adjacent) {
      evidence = adjacent;
      adjacentReason = 'ordered-window';
    } else {
      adjacentReason = 'timeout';
    }
  }

  return {
    evidence,
    live:     hop3.items,
    graph:    graph.items,
    trace: {
      sparse:            inspection.sparse,
      anchors: {
        filenames:  inspection.filenames,
        doc_hashes: inspection.docHashes,
        doc_ids:    inspection.docIds,
        platforms:  inspection.platforms,
      },
      evidence_trigger:  hop2.reason,
      live_trigger:      hop3.reason,
      live_eligible:     liveEligible,
      graph_trigger:     graph.reason,
      adjacent_trigger:  adjacentReason,
      latency_ms:        { enhance: Date.now() - startedAt },
    },
  };
}

export async function loadTypedGraphEvidence({ prisma, memoryIds, userId, orgId, accessContext = {}, time = {}, relationship = null, limit = 200 }) {
  if (!memoryIds.length || !orgId) return { items: [], reason: null };
  const projectIds = new Set(accessContext?.projectIds || []);
  const teamIds = new Set(accessContext?.teamIds || []);
  const visible = (m) => {
    if (!m) return false;
    if (m.scope === 'personal') return m.userId === userId;
    if (m.scope === 'project') {
      const ids = [m.projectId, ...(m.projectIds || [])].filter(Boolean);
      return ids.some((id) => projectIds.has(id));
    }
    if (m.scope === 'team') return !!m.primaryTeamId && teamIds.has(m.primaryTeamId);
    if (m.scope === 'organization') return accessContext?.orgRole !== 'guest';
    return false;
  };
  const wantedTypes = new Set(normalizeRelationshipTypes(relationship?.types, relationship?.type));
  const direction = ['incoming', 'outgoing'].includes(relationship?.direction)
    ? relationship.direction : 'any';
  const edgeAllowed = (edge, anchorId) => {
    const normalized = String(edge?.type || '').replace(/[\s_-]+/g, '').toLocaleLowerCase();
    if (wantedTypes.size && !wantedTypes.has(normalized)) return false;
    if (direction === 'incoming') return edge?.to_id === anchorId || edge?.target_id === anchorId;
    if (direction === 'outgoing') return edge?.from_id === anchorId || edge?.source_id === anchorId;
    return true;
  };
  // .amr tenants store their relationship graph inside the Memory Box, not in
  // central Prisma.  Use the same typed-edge shape as the managed path, with
  // one bounded batch and caller-side ACL filtering of both edge endpoints.
  if (orgIsRemote(orgId)) {
    const boundedMemoryIds = memoryIds.slice(0, Math.min(Math.max(limit, 1), 200));
    const relationships = await amrMemRelationshipsBatch(orgId, boundedMemoryIds).catch(() => ({}));
    if (relationships === null) return { items: [], reason: 'remote-graph-batch-unavailable' };
    const items = [];
    for (const memoryId of boundedMemoryIds) {
      const result = relationships?.[memoryId];
      if (!result) continue;
      for (const edge of result.out || []) {
        if (direction === 'incoming' || !edgeAllowed({ ...edge, from_id: memoryId }, memoryId)) continue;
        const peer = {
          id: edge.target_id, title: edge.target_title || '(untitled)', content: '',
          userId: edge.target_user_id, scope: edge.target_scope,
          projectId: edge.target_project, projectIds: edge.target_project_ids || [],
          primaryTeamId: edge.target_primary_team_id, isLatest: edge.target_is_latest,
        };
        if (!edge.target_id || !visible(peer)) continue;
        items.push({ type: edge.type, from_id: memoryId, to_id: edge.target_id, confidence: edge.confidence,
          created_at: edge.created_at || null, metadata: edge.metadata || {}, related: [peer] });
      }
      for (const edge of result.in || []) {
        if (direction === 'outgoing' || !edgeAllowed({ ...edge, to_id: memoryId }, memoryId)) continue;
        const peer = {
          id: edge.source_id, title: edge.source_title || '(untitled)', content: '',
          userId: edge.source_user_id, scope: edge.source_scope,
          projectId: edge.source_project, projectIds: edge.source_project_ids || [],
          primaryTeamId: edge.source_primary_team_id, isLatest: edge.source_is_latest,
        };
        if (!edge.source_id || !visible(peer)) continue;
        items.push({ type: edge.type, from_id: edge.source_id, to_id: memoryId, confidence: edge.confidence,
          created_at: edge.created_at || null, metadata: edge.metadata || {}, related: [peer] });
      }
    }
    return { reason: items.length ? 'typed-one-hop-remote' : null, items };
  }
  if (!prisma?.relationship) return { items: [], reason: null };
  const knownAt = normalizedIso(time.known_at);
  const memoryTimeWhere = {
    ...(knownAt ? { createdAt: { lte: new Date(knownAt) } } : {}),
  };
  const rows = await prisma.relationship.findMany({
    where: {
      ...(direction === 'incoming'
        ? { toId: { in: memoryIds } }
        : direction === 'outgoing'
          ? { fromId: { in: memoryIds } }
          : { OR: [{ fromId: { in: memoryIds } }, { toId: { in: memoryIds } }] }),
      ...(wantedTypes.size ? { type: { in: [...wantedTypes].map((type) => ({
        updates: 'Updates', extends: 'Extends', derives: 'Derives', contradicts: 'Contradicts',
        supports: 'Supports', references: 'References', mentions: 'Mentions', partof: 'PartOf',
        causes: 'Causes', requires: 'Requires', blocks: 'Blocks', relatedto: 'RelatedTo',
      }[type])) } } : {}),
      ...(knownAt ? { createdAt: { lte: new Date(knownAt) } } : {}),
      fromMemory: { orgId, deletedAt: null, ...memoryTimeWhere },
      toMemory: { orgId, deletedAt: null, ...memoryTimeWhere },
    },
    select: {
      fromId: true, toId: true, type: true, confidence: true, metadata: true, createdAt: true,
      fromMemory: { select: { id: true, userId: true, title: true, content: true, scope: true, projectId: true, primaryTeamId: true, isLatest: true, validFrom: true, validTo: true, memoryProjects: { select: { projectId: true } } } },
      toMemory: { select: { id: true, userId: true, title: true, content: true, scope: true, projectId: true, primaryTeamId: true, isLatest: true, validFrom: true, validTo: true, memoryProjects: { select: { projectId: true } } } },
    },
    take: Math.min(Math.max(limit, 1), 200),
  });
  const visibleCentral = (m) => visible({
    ...m,
    projectIds: (m.memoryProjects || []).map((p) => p.projectId),
  });
  return {
    reason: rows.length ? 'typed-one-hop' : null,
    items: rows.filter((r) => visibleCentral(r.fromMemory) && visibleCentral(r.toMemory)).map((r) => ({
      type: r.type,
      from_id: r.fromId,
      to_id: r.toId,
      confidence: r.confidence,
      created_at: r.createdAt,
      metadata: r.metadata || {},
      related: [r.fromMemory, r.toMemory]
        .filter((m) => !memoryIds.includes(m.id))
        .map((m) => ({ id: m.id, title: m.title, content: String(m.content || '').slice(0, 400), is_latest: m.isLatest })),
    })),
  };
}

export function filterMemoriesByRelationships(memories = [], edges = [], relationship = {}) {
  const wanted = new Set(normalizeRelationshipTypes(relationship.types, relationship.type));
  if (!wanted.size) return [...memories];
  const direction = ['incoming', 'outgoing'].includes(relationship.direction)
    ? relationship.direction : 'any';
  const eligible = new Set();
  for (const edge of edges || []) {
    const type = String(edge?.type || '').replace(/[\s_-]+/g, '').toLocaleLowerCase();
    if (!wanted.has(type)) continue;
    if (direction !== 'incoming' && edge?.from_id) eligible.add(edge.from_id);
    if (direction !== 'outgoing' && edge?.to_id) eligible.add(edge.to_id);
  }
  return memories.filter((memory) => eligible.has(recallMemoryRowId(memory)));
}


// ── Public entry ───────────────────────────────────────────────────────────

export class RecallRouter {
  constructor({ persistentMemoryStore, evidenceRetrieval, prisma }) {
    this.store        = persistentMemoryStore;
    this.evidence     = evidenceRetrieval;
    this.prisma       = prisma;
    // ClusterIndex injected if prisma available — used for cross-cluster entity boost (Move 3)
    this.clusterIndex = prisma ? new ClusterIndex({ prisma }) : null;
  }

  /**
   * Single recall entry. Returns shaped result + execution trace.
   *
   * @param {string} query    Natural-language query (verbatim from user).
   * @param {object} options  See top-of-file for full schema.
   * @param {object} ctx      { userId, orgId, projectId?, accessContext? }
   * @returns {Promise<{ memories, evidence, live, trace }>}
   */
  async recall(query, options = {}, ctx = {}) {
    if (!this.store) throw new Error('persistentMemoryStore unavailable');
    if (!query || typeof query !== 'string') {
      return { memories: [], evidence: [], live: [], trace: { error: 'empty query' } };
    }
    if (ctx.projectId) {
      const authorizedProjectIds = Array.isArray(ctx.accessContext?.projectIds)
        ? ctx.accessContext.projectIds
        : [];
      if (!authorizedProjectIds.includes(ctx.projectId)) {
        return {
          memories: [], evidence: [], live: [],
          trace: { error: 'project_access_denied', cutoff_reason: 'project_access_denied' },
        };
      }
    }

    const traceLatency = {};
    const startedAt = Date.now();
    const stageTiming = options.trace_stages === true ? {} : null;
    let recallPlan = resolveRecallPlan(options);
    // Chat arrives with a structured planner that is responsible for declaring
    // a source read. Do not turn an entity-only question such as "Solvis" into
    // an arbitrary Solvis-named PDF: that makes a broad answer look
    // source-specific and can hide better product evidence. Legacy /api/recall
    // callers retain metadata-based filename resolution for compatibility.
    const allowImplicitSource = !recallPlan.source.requested;
    const queryVectorPromise = this.evidence?.qdrantClient?.generateEmbedding
      ? this.evidence.qdrantClient.generateEmbedding(query, {
          workload: 'interactive', tenantId: ctx.orgId,
        })
      : Promise.reject(new Error('unified recall embedding service unavailable'));
    const [implicitSource, canonicalEntities, queryVector] = await Promise.all([
      allowImplicitSource ? resolveImplicitSource({
        evidence: this.evidence,
        query,
        ctx,
        timeoutMs: 250,
        // Structured chat may recover a source only from a literal file
        // artifact. Metadata-token matches stay available to legacy recall.
        requireFilename: requireFilenameForImplicitSource(options),
      }) : null,
      withTimeout(
        resolveCanonicalEntities({ prisma: this.prisma, orgId: ctx.orgId, query }),
        250,
        [],
      ),
      queryVectorPromise,
    ]);
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      throw new Error('unified recall query embedding unavailable');
    }
    if (stageTiming) stageTiming.entity_resolution_ms = Date.now() - startedAt;
    if (implicitSource) {
      recallPlan = resolveRecallPlan({
        ...options,
        source: implicitSource,
      });
    }
    const plannedEntities = [
      ...(Array.isArray(recallPlan.entities) ? recallPlan.entities : []),
      ...(Array.isArray(options.named_entities) ? options.named_entities : []),
    ];
    const mergedCanonicalEntities = [...new Set([...plannedEntities, ...canonicalEntities]
      .map((entity) => String(entity || '').trim()).filter(Boolean))].slice(0, 12);
    // Preserve the user's full natural-language question for the semantic lane,
    // while giving the lexical lane the exact tenant-registry entity phrase as
    // an additive query. This is deliberately deterministic: a conversational
    // question such as "What do you know about Kruti?" must have the same
    // entity-candidate floor as the terse query "Kruti", without another
    // embedding or an LLM rewrite. The lexical searches run in parallel and
    // merge by memory id before the single mixed memory/evidence rerank.
    const exactEntityLexicalQuery = canonicalEntityLexicalQuery(mergedCanonicalEntities);
    recallPlan = {
      ...recallPlan,
      entities: mergedCanonicalEntities,
      named_entities: mergedCanonicalEntities,
      entity_filter_mode: normalizeEntityFilterMode(
        options.entity_filter_mode || recallPlan.entity_filter_mode,
        mergedCanonicalEntities.length > 0,
      ),
    };
    const requestedDeliveryLimit = recallPlan.max_memories;
    const temporalInventory = ['latest', 'earliest'].includes(recallPlan.time.selector)
      || recallPlan.operation === 'timeline';
    options = {
      ...options,
      source_document_id: recallPlan.source.document_id,
      source_title: recallPlan.source.title,
      source_kind: recallPlan.source.kind,
      temporal_selector: recallPlan.time.selector,
      temporal_axis: recallPlan.time.axis,
      valid_at: recallPlan.time.valid_at,
      known_at: recallPlan.time.known_at,
      date_range: recallPlan.time.range,
      event_range: Boolean(recallPlan.time.range),
      memory_types: recallPlan.memory_types,
      entity_filter_mode: recallPlan.entity_filter_mode,
      scope_filter: recallPlan.scope_filter,
      relationships: recallPlan.relationships,
      boost_memory_type: options.boost_memory_type || recallPlan.memory_types[0] || null,
      include_superseded: recallPlan.operation === 'timeline'
        || Boolean(recallPlan.time.valid_at)
        || options.include_superseded === true,
      canonical_entities: mergedCanonicalEntities,
      alternate_lexical_query: options.alternate_lexical_query || exactEntityLexicalQuery,
      query_vector: queryVector,
      limit: temporalInventory ? Math.max(50, Number(options.limit) || 0) : options.limit,
    };
    const remainingBudget = () => Math.max(1, recallPlan.latency_budget_ms - (Date.now() - startedAt));
    // THE RERANKER GETS A FLOOR, NOT A SLICE OF SOMEONE ELSE'S BUDGET.
    //
    // Stages draw on one shared latency_budget_ms (1500ms for mode=fact) greedily, in order,
    // and the cross-encoder is LAST — so it was routinely starved: measured skips with 17 /
    // 36 / 47 / 58 / 84ms left, meaning the memory lane delivered ALGORITHMIC order, silently.
    // This hits .amr/byod HARDER than hybrid, because their evidence lanes are a NETWORK hop
    // that burns more of the shared budget first. Equal code, unequal accuracy.
    //
    // MY FIRST ATTEMPT AT THIS WAS WRONG AND BROKE PRODUCTION: I had every upstream stage
    // size against `remaining - 450ms`. Recall went to 0/5 on three consecutive canary runs,
    // because the late RETRIEVAL hops were then handed ~1ms and fetched nothing. Ranking an
    // empty set perfectly is worthless — retrieval must never fund ranking. Rolled back.
    //
    // There is no free option: the reranker can only have time if the request takes longer or
    // retrieval takes less. Retrieval is strictly more important, so the reranker is allowed a
    // bounded OVERRUN instead — it sees at least RERANK_RESERVE_MS even when the budget is
    // spent. Worst case is ~450ms of extra tail latency on requests that already exhausted
    // their budget; nothing upstream is shortened.
    const RERANK_RESERVE_MS = Number(process.env.RERANK_RESERVE_MS || 450);
    let cutoffReason = null;
    let explicitSourceDocuments = [];
    let explicitSourceMemoryAnchors = [];
    let explicitSourceHydration = null;
    let explicitSourceRequested = recallPlan.source.requested;
    // A source class alone (for example "the latest image") has no document
    // title or id. Do not send that broad selector to the document resolver:
    // it may be interpreted as an unconstrained document search. Images and
    // other direct uploads resolve through their scoped memory provenance.
    let explicitDocumentSourceRequested = !!(recallPlan.source.document_id || recallPlan.source.title);
    if (this.evidence?.resolveSourceDocuments && explicitDocumentSourceRequested) {
      const sourceResolution = await withTimeout(
        this.evidence.resolveSourceDocuments({
          userId: ctx.userId,
          orgId: ctx.orgId,
          projectId: ctx.projectId || null,
          accessContext: ctx.accessContext || null,
          scopeFilter: ctx.scopeFilter || ctx.scope_filter || null,
          documentId: options.source_document_id || null,
          title: options.source_title || null,
        }),
        Math.max(750, Math.min(
          Number(process.env.RECALL_SOURCE_RESOLVE_TIMEOUT_MS || 2_000),
          remainingBudget(),
        )),
        { _source_resolution_timeout: true },
        'recall-explicit-source-resolution',
      );
      if (sourceResolution?._source_resolution_timeout) {
        // A metadata lookup timeout is not proof that a named file is absent.
        // Surface an operational failure so chat asks for a retry instead of
        // telling the user to re-upload a document that may already exist.
        throw new Error('explicit source resolution timed out');
      }
      explicitSourceDocuments = Array.isArray(sourceResolution) ? sourceResolution : [];
      // Exact metadata is authoritative. If a human supplied a slightly wrong
      // filename, make one bounded lexical identity pass over the same
      // authorized document inventory. Never fall back to tenant-wide semantic
      // results: a source boundary may only be recovered from a strong,
      // unambiguous title/provenance match.
      if (explicitSourceDocuments.length === 0 && this.evidence?.resolveSourceFromQuery) {
        const sourceHint = String(options.source_title || '').trim();
        const sourceLooksLikeFilename = /\.[a-z0-9]{1,12}$/i.test(sourceHint);
        const fuzzyResolution = await withTimeout(
          this.evidence.resolveSourceFromQuery({
            userId: ctx.userId,
            orgId: ctx.orgId,
            projectId: ctx.projectId || null,
            accessContext: ctx.accessContext || null,
            scopeFilter: ctx.scopeFilter || ctx.scope_filter || null,
            // A human may refer to a document by function ("the pitch deck")
            // rather than its stored filename ("business_sales.pdf"). Use the
            // complete semantic question for that bounded source-resolution
            // pass; preserve literal filename matching when a filename exists.
            query: sourceLooksLikeFilename ? sourceHint : query,
            limit: 1,
          }),
          Math.max(750, Math.min(2_000, remainingBudget())),
          [],
          'recall-fuzzy-source-resolution',
        );
        explicitSourceDocuments = Array.isArray(fuzzyResolution) ? fuzzyResolution : [];
      }
      if (explicitSourceDocuments.length === 1) {
        // Carry the authoritative resolved identity back to chat coverage. The
        // user's misspelled title was only a lookup hint; once it resolves, the
        // canonical document id is the source boundary. Otherwise coverage
        // compares the typo literally, rejects valid evidence, and skips final
        // synthesis even though recall found the correct file.
        recallPlan.source = {
          ...recallPlan.source,
          document_id: explicitSourceDocuments[0].id,
          title: explicitSourceDocuments[0].title || recallPlan.source.title,
          requested: true,
        };
      }
      if (explicitSourceDocuments.length !== 1 && options.allow_semantic_source_recovery === true) {
        recallPlan.source = { document_id: null, title: null, kind: null, requested: false };
        recallPlan.operation = 'recall';
        options.source_document_id = null;
        options.source_title = null;
        options.source_kind = null;
        options.operation = 'recall';
        explicitSourceRequested = false;
        explicitDocumentSourceRequested = false;
      }
      if (explicitSourceDocuments.length && this.evidence?.hydrateSourceDocuments) {
        const fullSource = recallPlan.mode === 'full';
        // Anchor the source windows on the ENTITY, not the raw NL query. The
        // user's message ("What does PL Neuheiten 2025_V2.pdf say about
        // SolvisPia?") is contaminated with the filename and question words:
        // vector-anchoring on it ranks the document title / boilerplate
        // (which lexically echo the filename "Preisliste Produktneuheiten")
        // ABOVE the actual SolvisPia technical passages, so the windows land
        // on the cover page and the answer wrongly reports the entity absent.
        // When the planner extracted named entities, search for those; they
        // are exactly what the user wants located inside the source.
        const hydrationQuery = mergedCanonicalEntities.length
          ? mergedCanonicalEntities.join(' ')
          : query;
        // Start the hydration query NOW (runs concurrently with hop1/hop2), but
        // DO NOT wrap it in withTimeout here: withTimeout's clock starts at
        // creation, and the promise is only awaited far below — after hop1
        // (up to HOP1_TIMEOUT_MS), the project-scope retry, hop2, RRF and the
        // cross-cluster boost. Those consumed the whole budget, so a ~50ms
        // hydration always resolved to {timed_out} and the answer fell back to
        // hop2's document-lead boilerplate. Keep the raw promise; apply a
        // fresh-clock timeout at the await.
        explicitSourceHydration = this.evidence.hydrateSourceDocuments({
          documents: explicitSourceDocuments,
          query: hydrationQuery,
          userId: ctx.userId,
          orgId: ctx.orgId,
          perDocument: fullSource ? 8 : 3,
          total: fullSource ? 16 : 8,
        }).catch((err) => {
          console.warn('[recall-router] explicit source hydration failed:', err.message);
          return { hydration_error: true };
        });
      }
    }
    // A file/image can be recalled before it has evidence segments or a
    // document row: direct image uploads are durable memory records carrying
    // filename:<name> and kind:image provenance. Resolve those records under
    // the same caller scope instead of incorrectly declaring a named image
    // absent just because it is not a document-evidence source.
    if (explicitSourceRequested) {
      explicitSourceMemoryAnchors = await resolveSourceMemoryAnchors(this.store, ctx, {
        title: recallPlan.source.title,
        kind: recallPlan.source.kind,
        selector: recallPlan.time.selector,
      }, 2500);
    }
    // A requested source is an authorization boundary, not a ranking hint.
    // Never replace an unresolved source request with tenant-wide memories.
    if (explicitDocumentSourceRequested && explicitSourceDocuments.length === 0 && explicitSourceMemoryAnchors.length === 0) {
      return {
        memories: [], evidence: [], live: [],
        trace: {
          recall_plan: recallPlan,
          hop1_count: 0,
          sparse: true,
          top_score: 0,
          anchors: { filenames: [], doc_hashes: [], doc_ids: [], platforms: [], explicit_source_documents: [] },
          evidence_trigger: 'source-not-found',
          live_trigger: 'disabled',
          tiers_fired: [],
          cutoff_reason: 'source_not_found',
          latency_ms: { total: Date.now() - startedAt },
        },
      };
    }
    // Source ingestion is immediately recallable. For explicit explain/full,
    // start the tenant-scoped evidence lane alongside memory recall instead of
    // waiting for asynchronous fact promotion to provide an anchor.
    const evidenceStartedAt = Date.now();
    const sourceFirstEvidence = recallPlan.expand_evidence && !recallPlan.relationships?.requested
      ? (explicitDocumentSourceRequested && explicitSourceDocuments.length === 0
        ? Promise.resolve({ items: [], reason: explicitSourceMemoryAnchors.length ? 'memory-source-only' : 'source-not-found', docIds: [] })
        : hop2Evidence({
          evidenceService: this.evidence,
          query,
          queryVector,
          ctx,
          inspection: explicitSourceDocuments.length
            ? { ...inspectMemories([]), docIds: explicitSourceDocuments.map((document) => document.id) }
            : inspectMemories([]),
          prisma: this.prisma,
          filters: options,
        }))
      : null;
    const measuredSourceFirstEvidence = sourceFirstEvidence && stageTiming
      ? sourceFirstEvidence.then((value) => {
          stageTiming.evidence_lane_ms = Date.now() - evidenceStartedAt;
          return value;
        })
      : sourceFirstEvidence;

    // ── HOP 1 ─────────────────────────────────────────────────────────────
    const t1 = Date.now();
    let memories = await hop1Memory({ store: this.store, query, options: {
        ...options,
        trace_stages: options.trace_stages === true,
        timing: stageTiming ? (stageTiming.memory_detail = {}) : null,
      }, ctx });
    // A latest/earliest request is an inventory operation after hard filters,
    // not "the newest item among the semantic top K". Add an authorized,
    // model-free memory inventory lane so a chronologically correct entity or
    // source row cannot be excluded merely because an older row scored higher.
    if (temporalInventory && this.store?.listMemories) {
      try {
        const inventoryArgs = {
          user_id: ctx.userId,
          org_id: ctx.orgId,
          project: ctx.projectId || undefined,
          limit: 5000,
          scope: recallPlan.scope_filter ? `tier:${recallPlan.scope_filter}` : 'authorized',
          access_context: ctx.accessContext,
        };
        const listedSets = await Promise.all([
          withTimeout(this.store.listMemories({ ...inventoryArgs, is_latest: true }),
            Math.min(1800, remainingBudget()), { temporal_inventory_unavailable: true }),
          (recallPlan.operation === 'timeline' || recallPlan.time.selector === 'earliest')
            ? withTimeout(this.store.listMemories({ ...inventoryArgs, is_latest: false }),
              Math.min(1800, remainingBudget()), { temporal_inventory_unavailable: true })
            : Promise.resolve({ memories: [] }),
        ]);
        if (listedSets.some((listed) => listed?.temporal_inventory_unavailable)) {
          const error = new Error('temporal memory inventory unavailable');
          error.code = 'TEMPORAL_INVENTORY_UNAVAILABLE';
          throw error;
        }
        let inventory = filterMemoriesByEntities(
          listedSets.flatMap((listed) => listed?.memories || []),
          recallPlan.entities,
          { mode: recallPlan.relationships?.requested ? 'any' : recallPlan.entity_filter_mode },
        );
        inventory = [...new Map(inventory.map((memory) => [recallMemoryRowId(memory), memory])).values()];
        if (recallPlan.memory_types.length) {
          const wanted = new Set(recallPlan.memory_types);
          inventory = inventory.filter((memory) => wanted.has(String(memory?.memory_type || memory?.memoryType || '').toLocaleLowerCase()));
        }
        if (recallPlan.source.requested) {
          inventory = inventory.filter((memory) => memoryMatchesSourceContract(memory, recallPlan.source));
        }
        if (Array.isArray(options.tags) && options.tags.length) {
          inventory = inventory.filter((memory) => memoryMatchesTags(memory, options.tags));
        }
        if (recallPlan.target_memory_id) {
          const chain = new Set([recallPlan.target_memory_id]);
          let frontier = [recallPlan.target_memory_id];
          for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
            const graph = await loadTypedGraphEvidence({
              prisma: this.prisma, memoryIds: frontier, userId: ctx.userId, orgId: ctx.orgId,
              accessContext: ctx.accessContext || {}, time: recallPlan.time,
              relationship: { types: ['Updates'], direction: 'any' }, limit: 200,
            });
            const next = [];
            for (const edge of graph.items || []) {
              for (const id of [edge.from_id, edge.to_id]) {
                if (id && !chain.has(id)) { chain.add(id); next.push(id); }
              }
            }
            frontier = next;
          }
          inventory = inventory.filter((memory) => chain.has(recallMemoryRowId(memory)));
        }
        const byId = new Map([...memories, ...inventory].map((memory) => [recallMemoryRowId(memory), memory]));
        memories = [...byId.values()];
      } catch (error) {
        if (error?.code === 'TEMPORAL_INVENTORY_UNAVAILABLE') throw error;
        console.warn('[recall-router] temporal memory inventory lane failed:', error.message);
      }
    }
    let eventRangeCount = 0;
    if (options.event_range === true && recallPlan.time.range && this.store?.listMemories) {
      try {
        const explicitScope = options.scope_filter
          ? `tier:${String(options.scope_filter).replace(/^tier:/, '')}`
          : 'authorized';
        const listed = await withTimeout(this.store.listMemories({
          user_id: ctx.userId,
          org_id: ctx.orgId,
          project: ctx.projectId || undefined,
          is_latest: true,
          limit: 500,
          scope: explicitScope,
          access_context: ctx.accessContext,
        }), Math.min(900, remainingBudget()), { memories: [] });
        const boostType = String(options.boost_memory_type || '').toLowerCase();
        const allRanged = (listed?.memories || [])
          .filter((memory) => isMemoryInDateRange(memory, recallPlan.time.range))
          .map((memory) => ({
            ...memory,
            // A structured event-window match is authoritative relevance, but
            // remains below a strong topical semantic hit. Type matches receive
            // a bounded lift for decision/goal/preference queries.
            score: Math.max(
              Number(memory.score) || 0,
              boostType && String(memory.memory_type || '').toLowerCase() === boostType ? 0.70 : 0.45,
            ),
            _event_range_match: true,
          }));
        const ranged = selectEventRangeCandidates(allRanged, boostType, EVENT_RANGE_CANDIDATE_LIMIT);
        eventRangeCount = ranged.length;
        if (ranged.length) {
          const byId = new Map(
            // Put canonical date matches last so they retain the structured
            // event-range marker and score floor when semantic recall returned
            // the same memory with a weaker score.
            [...memories, ...ranged]
              .filter((memory) => memory?.id)
              .map((memory) => [memory.id, memory]),
          );
          memories = [...byId.values()];
        }
      } catch (eventRangeError) {
        console.warn('[recall-router] event-range lane failed:', eventRangeError.message);
      }
    }
    // Project-scope fallback: if user has a project active but recall came
    // back empty, the relevant memories may live outside that project (e.g.
    // personal-scope or org-wide). Retry once without projectId so chat
    // doesn't hallucinate "I don't have any notes" when memories exist.
    // Single capped retry — at 10M an empty-project query re-running a full
    // pool-150 org recall is a 2× scan; gate it (RECALL_PROJECT_FALLBACK=false
    // to disable per deployment) so high-volume tenants can opt out.
    let projectFallbackFired = false;
    const _projectFallbackEnabled = process.env.RECALL_PROJECT_FALLBACK !== 'false';
    if (_projectFallbackEnabled && options.structured_intent !== true && memories.length === 0 && ctx.projectId) {
      // ISOLATION: the broad retry may escape to personal/org/team knowledge,
      // but must NEVER surface ANOTHER project's scoped memories — asking about
      // "Solvis" inside the Singulance project must not answer from the SOLVIS
      // project. projectIds:[] makes every scope='project' memory fail the
      // access check in the retrieval scope filter while personal/org/team
      // memories still pass.
      const ctxBroad = {
        ...ctx,
        projectId: null,
        accessContext: { ...(ctx.accessContext || {}), projectIds: [] },
      };
      memories = await withTimeout(
        hop1Memory({ store: this.store, query, options, ctx: ctxBroad }),
        Math.min(HOP1_TIMEOUT_MS, remainingBudget()),
        [],
      );
      projectFallbackFired = memories.length > 0;
      if (projectFallbackFired) {
        console.log(`[recall-router] project-scope empty (${ctx.projectId}) → broad recall found ${memories.length} memories`);
      }
    }
    if (explicitSourceRequested) {
      const sourceDocumentIds = explicitSourceDocuments.map((document) => document.id);
      const sourceMemoryIds = new Set(explicitSourceMemoryAnchors.map((memory) => memory?.id).filter(Boolean));
      const documentMatched = sourceDocumentIds.length
        ? filterMemoriesByDocumentIds(memories, sourceDocumentIds)
        : [];
      // Direct source-memory anchors are authoritative for a named upload or
      // latest/earliest source request. Keep full content for downstream
      // projection and give the selected source a stable relevance floor.
      const sourceAnchors = explicitSourceMemoryAnchors.map((memory) => ({
        ...memory,
        score: Math.max(Number(memory.score) || 0, 0.99),
        _source_anchor: true,
      }));
      const byId = new Map([...documentMatched, ...sourceAnchors]
        .filter((memory) => memory?.id)
        .map((memory) => [memory.id, memory]));
      memories = [...byId.values()].filter((memory) => sourceMemoryIds.size === 0 || sourceMemoryIds.has(memory.id) || sourceDocumentIds.length > 0);
    }
    traceLatency.memory = Date.now() - t1;

    if (recallPlan.memory_types.length) {
      const requestedTypes = new Set(recallPlan.memory_types);
      memories = memories.filter((memory) => requestedTypes.has(String(
        memory.memory_type || memory.memoryType || memory.memory?.memory_type || '',
      ).toLocaleLowerCase()));
    }

    // Entity predicates are authorization-like retrieval constraints, not
    // ranking hints. Apply the same exact all/any semantics used by evidence
    // metadata before either lane enters unified delivery.
    memories = filterMemoriesByEntities(memories, recallPlan.entities, {
      mode: recallPlan.relationships?.requested ? 'any' : recallPlan.entity_filter_mode,
    });

    let relationshipEdges = [];
    if (recallPlan.relationships?.requested) {
      options.relationship_memory_ids = [];
    }
    if (recallPlan.relationships?.requested && memories.length) {
      const graph = await loadTypedGraphEvidence({
        prisma: this.prisma,
        memoryIds: memories.map(recallMemoryRowId).filter(Boolean),
        userId: ctx.userId,
        orgId: ctx.orgId,
        accessContext: ctx.accessContext || {},
        time: recallPlan.time,
        relationship: recallPlan.relationships,
      });
      relationshipEdges = graph.items || [];
      memories = filterMemoriesByRelationships(memories, relationshipEdges, recallPlan.relationships);
      options.relationship_memory_ids = memories.map(recallMemoryRowId).filter(Boolean);
    }

    const inspection = inspectMemories(memories);

    // ── HOP 2 + HOP 3 (parallel, both keyed on inspection) ────────────────
    const t2Start = Date.now();
    const [hop2, hop3] = await Promise.all([
      !recallPlan.expand_evidence
        ? Promise.resolve({ items: [], reason: 'disabled' })
        : measuredSourceFirstEvidence || hop2Evidence({
          evidenceService: this.evidence, query, queryVector, ctx, inspection, prisma: this.prisma,
          filters: options,
        }),
      !isLiveExpansionEligible({
        includeLive: recallPlan.include_live,
        inspection,
        liveIntent: options.live_intent === true,
        surfacePolicyAllowsLive: options.surface_policy_allows_live !== false,
      })
        ? Promise.resolve({ items: [], reason: 'disabled' })
        : withTimeout(
            hop3Live({ prisma: this.prisma, query, ctx, inspection }),
            Math.min(HOP3_TIMEOUT_MS, remainingBudget()),
            { items: [], reason: 'timeout' },
          ),
    ]);
    traceLatency.evidence = Date.now() - t2Start;
    traceLatency.live     = Date.now() - t2Start;

    // ── MERGE ─────────────────────────────────────────────────────────────
    let rankedMemories = reciprocalRankFusionMemories(memories, inspection);

    // Move 3: cross-cluster shared-entity boost (after RRF, before slice)
    // Fire in try/catch — never block recall on boost failure.
    if (this.clusterIndex && ctx.orgId) {
      try {
        rankedMemories = await withTimeout(
          crossClusterEntityBoost(rankedMemories, {
            clusterIndex:   this.clusterIndex,
            organizationId: ctx.orgId,
          }),
          Math.min(350, remainingBudget()),
          rankedMemories,
        );
      } catch (boostErr) {
        console.warn('[recall-router] cross-cluster boost failed:', boostErr.message);
      }
    } else if (this.clusterIndex && !ctx.orgId) {
      // Surface silent skip — Phase 3 needs orgId to scope cluster_index
      // lookup. Default user / no-org sessions get plain recall without the
      // shared-entity boost; without this warn the regression is invisible.
      console.warn('[recall-router] cross-cluster boost SKIPPED: ctx.orgId missing (recall returned plain RRF, no Phase 3 boost). Pass orgId in ctx to enable.');
    }

    // ── Quality pruning: score-floor + MMR diversity + cluster collapse ──
    // Cheap moves that cut answer-step bloat without a reranker. Drops
    // near-duplicates, kills low-score noise, and collapses redundant
    // synthesis-cluster siblings down to the canonical synth + 1 source.
    // Internal-audit suppression: 'internal-audit' tagged memories
    // (governance reflection rows etc.) are operational noise — they
    // should never crowd user queries. Drop them unless the caller
    // explicitly asked for them via options.tags = ['internal-audit'].
    const callerWantsAudit = Array.isArray(options.tags)
      && options.tags.some((t) => t === 'internal-audit');
    if (!callerWantsAudit) {
      rankedMemories = rankedMemories.filter((m) => !(m.tags || []).includes('internal-audit'));
    }
    rankedMemories = filterLowSaliencePromotedMemories(rankedMemories);

    // V5 D5 (flag-gated): type-aware recall — merge a type-scoped lane so a
    // type-matching memory is a candidate even when base lanes missed it, then
    // soft-boost. Runs BEFORE the floor so merged rows are ranked, not pruned.
    if (TYPE_AWARE_RECALL && options.boost_memory_type) {
      try {
        const extra = await fetchTypeScopedCandidates({
          prisma: this.prisma, store: this.store,
          orgId: ctx.orgId, boostType: options.boost_memory_type,
          entityNames: (recallPlan.entities?.length ? recallPlan.entities : (options.named_entities?.length ? options.named_entities : [])),
        });
        if (extra.length) {
          const seen = new Set(rankedMemories.map((m) => m.id));
          for (const e of extra) if (!seen.has(e.id)) { rankedMemories.push(e); seen.add(e.id); }
          console.log(`[recall-router] type-scoped lane: +${extra.filter((e) => !new Set(rankedMemories.slice(0, rankedMemories.length - extra.length).map((m) => m.id)).has(e.id)).length} type=${options.boost_memory_type} candidates`);
        }
        rankedMemories = applyMemoryTypeBoost(rankedMemories, options.boost_memory_type);
      } catch (e) { console.warn('[recall-router] type-aware recall failed:', e.message); }
    }
    rankedMemories = applyScoreFloor(rankedMemories, 0.40);
    if (options.structured_intent !== true) rankedMemories = applyEventTimeBoost(rankedMemories, query);
    rankedMemories = applyMMRDiversity(rankedMemories, 0.70);
    rankedMemories = collapseClusterDuplicates(rankedMemories);
    // Exact-id dedup BEFORE the top-N slice. RRF/lane-fusion + graph expansion
    // can re-surface the SAME memory under different lane wrappers (id vs
    // memory.id), and collapseClusterDuplicates only merges near-dupes by
    // cluster hash — not identical ids. Without this the delivered top-N is
    // wasted on duplicates (observed: 5 delivered / 3 unique in explain mode).
    // Keep the first (highest-ranked) occurrence.
    rankedMemories = dedupeMemoriesById(rankedMemories);

    // Fire recall-count update asynchronously — don't block response
    if (this.clusterIndex) {
      const clusterHashes = [...new Set(
        rankedMemories
          .map(m => m.synthesisClusterHash || m.synthesis_cluster_hash)
          .filter(Boolean)
      )];
      setImmediate(() => {
        this.clusterIndex.recordRecall({ clusterHashes }).catch(() => {});
      });
    }

    // Lineage: link evidence segments back to memories when source_metadata
    // points at the same document.
    const memoryByDocId = new Map();
    for (const m of rankedMemories) {
      const docId = m.source_metadata?.document_id;
      if (docId && !memoryByDocId.has(docId)) memoryByDocId.set(docId, m.id);
    }
    let selectedEvidence = hop2.items || [];
    if (explicitSourceHydration) {
      // Fresh-clock timeout applied HERE, not at creation. The hydration query
      // has been running concurrently since it was kicked off above; give it a
      // real slice of the remaining budget now (floored so an explicit source
      // read — which IS the answer for explain/full — is never starved to a
      // 0ms wait by earlier hops). Hydration typically completes in ~50ms.
      const fullSource = recallPlan.mode === 'full';
      const hydrationBudget = Math.max(600, Math.min(fullSource ? 2_200 : 1_200, remainingBudget()));
      const hydrated = await withTimeout(explicitSourceHydration, hydrationBudget, { timed_out: true });
      if (Array.isArray(hydrated) && hydrated.length) selectedEvidence = hydrated;
      else if (hydrated?.timed_out || Date.now() - startedAt >= recallPlan.latency_budget_ms) cutoffReason = 'latency_budget';
    }
    let evidenceWithLineage = selectedEvidence.map((e) => ({
      ...e,
      linked_memory_id: memoryByDocId.get(e.documentId) || null,
      _lineage_inferred: !e.linked_memory_id && Boolean(memoryByDocId.get(e.documentId)),
    }));
    if (recallPlan.relationships?.requested) {
      evidenceWithLineage = filterEvidenceByMetadata(evidenceWithLineage, {
        relationshipMemoryIds: options.relationship_memory_ids || [],
        relationshipRequired: true,
      });
    }

    const tiersFired = ['memory'];
    if (hop2.items.length > 0) tiersFired.push(`evidence-${hop2.reason}`);
    if (hop3.items.length > 0) tiersFired.push('live');

    // Phase 2 (B2): deliver-N comes from the per-org RetrievalConfig (the
    // self-evolution action space), falling back to RECALL_DELIVER_LIMIT.
    let deliverN = recallPlan.operation === 'timeline'
      ? Math.min(requestedDeliveryLimit, 50)
      : (options.structured_intent === true
          ? Math.min(Math.max(1, requestedDeliveryLimit), 15)
          : RECALL_DELIVER_LIMIT);
    try {
      const cfg = await withTimeout(getRetrievalConfig(ctx.orgId), Math.min(120, remainingBudget()), null);
      // Per-org delivery tuning is a default, never an override of an explicit
      // caller limit. Chat passes structured_intent and reveals its retained
      // pool progressively; the public recall API can explicitly request the
      // full 10-15 candidate window.
      if (recallPlan.operation !== 'timeline'
          && options.structured_intent !== true
          && !Number.isFinite(Number(options.limit))
          && cfg?.deliver_limit) deliverN = cfg.deliver_limit;
    } catch { /* default */ }

    // Dreams-first quota: guarantee raw source evidence still appears in the
    // delivered set (≤ MAX_DREAMS_IN_TOPN synthesis rows in the top-N), so a
    // dream-heavy org never degenerates to "dreams only" recall.
    rankedMemories = enforceDreamQuota(rankedMemories, deliverN, MAX_DREAMS_IN_TOPN);

    // PATH UNIFICATION (PHASE-B TODO): the router's RRF+MMR re-pass scrambled the
    // upstream tiered order, so chat and Tara diverged. Re-apply the SAME
    // algorithmic term-overlap reranker the direct path ends with, over the wide
    // ranked pool BEFORE the deliver slice → both surfaces agree on order.
    if (ROUTER_TIERED_VIEW && rankedMemories.length > 1) {
      if (!_routerReranker) _routerReranker = new ResultReranker();
      const rq = typeof query === 'string' ? query : String(query);
      rankedMemories = _routerReranker.rerank(rq, rankedMemories.map((m) => ({
        ...m,
        content: m.memory?.content ?? m.content,
        created_at: m.memory?.created_at ?? m.created_at,
      })));
    }

    // Two-reranker contract: this is the OPT-IN CROSS-ENCODER precision pass (external
    // model, gated RERANK_ENABLED) — no-op (returns first N) when disabled.
    // Stage 4 / P1: optional cross-encoder rerank of the wide ranked pool → deliver top-N.
    const rerankBudget = Math.max(remainingBudget(), RERANK_RESERVE_MS);
    // `> 1` means a 2ms budget still fires a rerank that cannot possibly land, and
    // withTimeout's fallback is a VALUE — so the cross-encoder silently vanishes from the
    // memory lane with no log, the same invisible degrade that made deliverHybrid look
    // non-deterministic. The budget here is a real latency contract, so it is NOT extended
    // (unlike deliverHybrid's arbitrary 1200ms floor); it is only made visible, and a
    // budget too small to fit one attempt skips the call instead of wasting it.
    // Gate on the MEASURED warm latency, not on the timeout ceiling. The first version of
    // this gate required min(RERANK_TIMEOUT_MS, 1500)ms and therefore skipped calls with
    // 630ms / 523ms / 350ms left that would have completed comfortably — a warm rerank is
    // ~270ms against the live endpoint (829ms cold). The withTimeout below is still bounded
    // by the remaining budget, so attempting with less than the ceiling risks nothing: a
    // slow call degrades exactly as before, and now says so.
    const _rrMinMem = Number(process.env.RERANK_MIN_BUDGET_MS || 400);
    const _canRerank = rerankBudget >= _rrMinMem;
    if (!_canRerank && rerankBudget > 1) {
      console.warn(`[recall-router] SKIPPING memory-lane cross-encoder: only ${rerankBudget}ms of budget `
        + `left (needs >=${_rrMinMem}ms; warm rerank ~270ms) — delivering algorithmic order. The memory `
        + `lane is NOT cross-encoded for this request. Upstream stages spent the budget: `
        + `latency_budget_ms=${recallPlan.latency_budget_ms} for mode=${recallPlan.mode || 'n/a'}, and one `
        + `hop alone is capped at 2300ms, so the final stage can be starved by construction.`);
    }
    // Non-timeline delivery is authoritatively reranked once below across the
    // unified memory + evidence pool. Do not pay for a memory-only pass whose
    // ordering is immediately discarded.
    let deliverMemories = rankedMemories.slice(0, deliverN);
    deliverMemories = dedupeMemoriesById(deliverMemories).slice(0, deliverN);
    if (remainingBudget() <= 1 && recallPlan.mode !== 'fact') cutoffReason ||= 'latency_budget';

    // RECALL_HYBRID_DELIVERY_ALWAYS_ON: replace the delivered memory/evidence order with one
    // coherent relevance authority (RRF-fuse → cross-encoder → surviving
    // amplitude) over BOTH sources, so evidence competes fairly and boosts
    // survive. Default OFF → byte-identical delivery. Falls back to the existing
    // order on any failure/timeout.
    let finalEvidence = evidenceWithLineage;
    let rankedCandidates = [];
    let hybridRankingMode = 'not_applicable';
    let hybridRerankPasses = 0;
    let hybridRerankMs = 0;
    if (recallPlan.operation === 'timeline') {
      const timelineAxis = recallPlan.time.axis || 'valid_time';
      const mixed = [
        ...rankedMemories.map((row) => ({ kind: 'memory', row })),
        ...evidenceWithLineage.map((row) => ({ kind: 'evidence', row })),
      ].sort((left, right) => {
        const delta = recallItemTimeForAxis(left.row, timelineAxis)
          - recallItemTimeForAxis(right.row, timelineAxis);
        return delta || String(recallMemoryRowId(left.row) || left.row?.segmentId || left.row?.segment_id || '')
          .localeCompare(String(recallMemoryRowId(right.row) || right.row?.segmentId || right.row?.segment_id || ''));
      }).slice(0, requestedDeliveryLimit);
      deliverMemories = mixed.filter((entry) => entry.kind === 'memory').map((entry) => entry.row);
      finalEvidence = mixed.filter((entry) => entry.kind === 'evidence').map((entry) => entry.row);
      rankedCandidates = mixed.map((entry, index) => entry.kind === 'memory'
        ? { kind: 'memory', memory_id: recallMemoryRowId(entry.row), rank: index + 1, score: Number(entry.row?.score) || null }
        : { kind: 'evidence', segment_id: entry.row?.segmentId || entry.row?.segment_id || entry.row?.id, rank: index + 1, score: Number(entry.row?.score) || null });
      hybridRankingMode = `timeline_${timelineAxis}_ascending`;
    } else if (!['latest', 'earliest'].includes(recallPlan.time.selector)) {
      const v2 = await deliverHybrid({
        query,
        memories: rankedMemories,          // wide pre-slice pool (rerank window)
        evidence: evidenceWithLineage,
        deliverN,
        evidenceN: HOP2_DOC_LIMIT,
        budgetMs: remainingBudget(),
        structuredIntent: options.structured_intent === true,
      });
      if (v2 && Array.isArray(v2.memories)) {
        deliverMemories = dedupeMemoriesById(v2.memories);
        finalEvidence = v2.evidence || evidenceWithLineage;
        rankedCandidates = v2.ranked_candidates || [];
        hybridRankingMode = v2.ranking_mode || 'unknown';
        hybridRerankPasses = Number(v2.rerank_passes) || 0;
        hybridRerankMs = Number(v2.rerank_ms) || 0;
      }
    } else {
      // Temporal selectors are time-primary operations. Select from the WIDE,
      // already-filtered memory/evidence inventories before any semantic
      // top-15 truncation. Relevance is only a stable tie-breaker.
      const axis = recallPlan.time.axis || 'known_time';
      const mixed = orderTemporalCandidates([
        ...rankedMemories.map((row) => ({ kind: 'memory', row })),
        ...evidenceWithLineage.map((row) => ({ kind: 'evidence', row })),
      ], {
        selector: recallPlan.time.selector, axis, unwrap: (entry) => entry.row,
        id: (row) => recallMemoryRowId(row) || row?.segmentId || row?.segment_id || row?.id || '',
      });
      const retained = mixed.slice(0, requestedDeliveryLimit);
      deliverMemories = retained.filter((entry) => entry.kind === 'memory').map((entry) => entry.row);
      finalEvidence = retained.filter((entry) => entry.kind === 'evidence').map((entry) => entry.row);
      rankedCandidates = retained.map((entry, index) => entry.kind === 'memory'
        ? { kind: 'memory', memory_id: recallMemoryRowId(entry.row), rank: index + 1, score: Number(entry.row?.score) || null }
        : { kind: 'evidence', segment_id: entry.row?.segmentId || entry.row?.segment_id || entry.row?.id, rank: index + 1, score: Number(entry.row?.score) || null });
      hybridRankingMode = `${recallPlan.time.selector}_${axis}`;
    }

    let timeline = [];
    if (recallPlan.operation === 'timeline') {
      deliverMemories = [...deliverMemories].sort((left, right) => recallItemTime(left) - recallItemTime(right));
      finalEvidence = [...finalEvidence].sort((left, right) => recallItemTime(left) - recallItemTime(right));
      timeline = [
        ...deliverMemories.map((item) => ({ kind: 'memory', time: recallItemTime(item), item: serializeRecallMemory(item, { includeFullContent: options.include_full_memory_content === true }) })),
        ...finalEvidence.map((item) => ({ kind: 'evidence', time: recallItemTime(item), item: serializeRecallEvidence(item) })),
      ].sort((left, right) => left.time - right.time)
        .map(({ time, ...entry }) => ({ ...entry, timestamp: Number.isFinite(time) ? new Date(time).toISOString() : null }));
    }

    // Phase 2 (B3): fire-and-forget TaskOutcome signal for the evolution loop.
    logTaskOutcome({
      orgId: ctx.orgId, userId: ctx.userId, query,
      returnedN: deliverMemories.length,
      topScore: deliverMemories[0]?.score,
    });

    return {
      memories: deliverMemories.map((memory) => serializeRecallMemory(memory, {
        includeFullContent: options.include_full_memory_content === true,
      })),
      evidence: finalEvidence.slice(0, temporalInventory
        ? requestedDeliveryLimit
        : (options.structured_intent === true ? 15 : HOP2_DOC_LIMIT)).map(serializeRecallEvidence),
      ranked_candidates: rankedCandidates,
      relationships: relationshipEdges,
      timeline,
      live: hop3.items,
      trace: {
        recall_plan:     recallPlan,
        embedding_passes: 1,
        retrieval_passes: 1,
        hybrid_ranking_mode: hybridRankingMode,
        rerank_passes: hybridRerankPasses,
        rerank_ms: hybridRerankMs,
        hop1_count:      memories.length,
        event_range_count: eventRangeCount,
        sparse:          inspection.sparse,
        top_score:       Number(inspection.topScore.toFixed(3)),
        anchors: {
          filenames:  inspection.filenames,
          doc_hashes: inspection.docHashes,
          doc_ids:    inspection.docIds,
          platforms:  inspection.platforms,
          explicit_source_documents: explicitSourceDocuments.map((document) => ({
            id: document.id,
            title: document.title || null,
          })),
        },
        evidence_trigger: hop2.reason,
        live_trigger:     hop3.reason,
        tiers_fired:      tiersFired,
        cutoff_reason:    cutoffReason,
        latency_ms:       { ...traceLatency, total: Date.now() - startedAt },
        ...(stageTiming ? { stage_breakdown: {
          ...stageTiming,
          evidence_wait_ms: traceLatency.evidence,
          unified_rerank_ms: hybridRerankMs,
          router_total_ms: Date.now() - startedAt,
        } } : {}),
      },
    };
  }
}

// V5 Phase 8: buildEvidencePacket moved to recall-packet.js (one module owns the
// evidence contract). Re-exported here for backward compatibility.
export { buildEvidencePacket };
