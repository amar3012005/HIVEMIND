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

import { recallPersistedMemories } from './persisted-retrieval.js';

// ── Constants ───────────────────────────────────────────────────────────────

const HOP1_DEFAULT_LIMIT       = 12;
const HOP2_DOC_LIMIT           = 8;
const HOP2_UNFILTERED_LIMIT    = 6;
const HOP3_LIVE_LIMIT          = 5;

const HOP1_TIMEOUT_MS          = 1500;
const HOP2_TIMEOUT_MS          = 1500;
const HOP3_TIMEOUT_MS          = 4000;

const SPARSE_MEMORY_COUNT      = 2;     // <2 hits ⇒ sparse
const SPARSE_TOP_SCORE         = 0.5;   // top hit below this ⇒ sparse

const RRF_K                    = 60;    // standard RRF constant
const ANCHOR_BOOST             = 0.30;  // additive boost when memory tagged w/ doc anchor

const WORKSPACE_PLATFORMS = new Set([
  'gmail', 'google_drive', 'google_calendar', 'google_docs', 'google_sheets',
]);

// ── Utility: with-timeout wrapper ───────────────────────────────────────────

function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    promise
      .then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(fallback); } });
  });
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
  const CONNECTOR_KW = ['slack', 'notion', 'gmail', 'github', 'linear', 'jira', 'confluence'];
  const matchedConnector = CONNECTOR_KW.find(k => ql.includes(k));
  const isRecentish = /\b(last|latest|recent|today|yesterday|just|now)\b/.test(ql);
  const inferredTags = matchedConnector && isRecentish ? [matchedConnector] : null;

  const recallArgs = {
    query_context: query,
    user_id: ctx.userId,
    org_id: ctx.orgId,
    max_memories: Math.min(options.limit || HOP1_DEFAULT_LIMIT, 50),
    tags: options.tags || inferredTags || undefined,
    source_type: options.source_type,
    access_context: scopedAccessCtx,
    ...(ctx.projectId ? { project_id: ctx.projectId, project_ids: [ctx.projectId] } : {}),
    ...(options.valid_at && !Number.isNaN(new Date(options.valid_at).getTime())
      ? { bitemporal: { valid_at: new Date(options.valid_at) } }
      : {}),
  };
  const result = await recallPersistedMemories(store, recallArgs);

  // Tag-anchored fallback. If FTS returned nothing AND the caller (or
  // shortcut) supplied tags, fetch directly by tag ordered by document_date
  // desc. Handles "what was the last slack msg about" where FTS fails the
  // `@@ to_tsquery` AND-match against memories that don't contain words
  // like "last" or "msg" verbatim.
  const effectiveTags = options.tags || inferredTags;
  let mems = result.memories || [];
  if (mems.length === 0 && Array.isArray(effectiveTags) && effectiveTags.length > 0 && store.client?.memory) {
    try {
      const orFilters = [];
      if (ctx.orgId) orFilters.push({ orgId: ctx.orgId });
      if (ctx.userId) orFilters.push({ userId: ctx.userId });
      const tagOnly = await store.client.memory.findMany({
        where: {
          deletedAt: null,
          isLatest: true,
          tags: { hasSome: effectiveTags },
          ...(orFilters.length === 1 ? orFilters[0] : orFilters.length > 1 ? { OR: orFilters } : {}),
        },
        orderBy: [{ documentDate: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(options.limit || HOP1_DEFAULT_LIMIT, 50),
        select: {
          id: true, title: true, content: true, memoryType: true, tags: true,
          createdAt: true, documentDate: true, importanceScore: true, sourceMetadata: true,
        },
      });
      mems = tagOnly.map(m => ({
        id: m.id,
        title: m.title,
        content: m.content,
        memory_type: m.memoryType,
        tags: m.tags || [],
        score: Number(m.importanceScore) || 0.5,
        created_at: m.createdAt,
        valid_at: m.documentDate || m.createdAt,
        source_metadata: m.sourceMetadata || null,
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

async function resolveDocIdsFromFilenames({ prisma, filenames, userId, orgId }) {
  if (!prisma?.knowledgeDocument || !filenames.length) return [];
  try {
    const rows = await prisma.knowledgeDocument.findMany({
      where: {
        orgId,
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

// ── Hop 2 — Evidence segments ──────────────────────────────────────────────

export async function hop2Evidence({ evidenceService, query, ctx, inspection, prisma }) {
  if (!evidenceService) return { items: [], reason: null };

  // Case A: hop-1 memories carry doc anchors → doc-filtered search.
  let docIds = [...inspection.docIds];
  if (docIds.length === 0 && inspection.filenames.length > 0) {
    docIds = await resolveDocIdsFromFilenames({
      prisma, filenames: inspection.filenames, userId: ctx.userId, orgId: ctx.orgId,
    });
  }

  if (docIds.length > 0) {
    const items = await evidenceService.retrieveEvidence({
      query, userId: ctx.userId, orgId: ctx.orgId,
      documentIds: docIds,
      limit: HOP2_DOC_LIMIT,
    });
    return { items, reason: 'doc-anchored', docIds };
  }

  // Case B: sparse hop-1 → broad evidence sweep as rescue.
  if (inspection.sparse) {
    const items = await evidenceService.retrieveEvidence({
      query, userId: ctx.userId, orgId: ctx.orgId,
      limit: HOP2_UNFILTERED_LIMIT,
    });
    return { items, reason: 'sparse-rescue' };
  }

  // Case C: hop-1 covered it. No hop-2.
  return { items: [], reason: null };
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
      return { ...m, _rank_score: base + tagMatchBoost };
    })
    .sort((a, b) => b._rank_score - a._rank_score);
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
}) {
  const startedAt = Date.now();
  const inspection = inspectMemories(memories || []);

  const [hop2, hop3] = await Promise.all([
    withTimeout(
      hop2Evidence({ evidenceService, query, ctx, inspection, prisma }),
      HOP2_TIMEOUT_MS,
      { items: [], reason: 'timeout' },
    ),
    !includeLive
      ? Promise.resolve({ items: [], reason: 'disabled' })
      : withTimeout(
          hop3Live({ prisma, query, ctx, inspection }),
          HOP3_TIMEOUT_MS,
          { items: [], reason: 'timeout' },
        ),
  ]);

  return {
    evidence: hop2.items,
    live:     hop3.items,
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
      latency_ms:        { enhance: Date.now() - startedAt },
    },
  };
}

// ── Public entry ───────────────────────────────────────────────────────────

export class RecallRouter {
  constructor({ persistentMemoryStore, evidenceRetrieval, prisma }) {
    this.store     = persistentMemoryStore;
    this.evidence  = evidenceRetrieval;
    this.prisma    = prisma;
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

    const traceLatency = {};
    const startedAt = Date.now();

    // ── HOP 1 ─────────────────────────────────────────────────────────────
    const t1 = Date.now();
    const memories = await withTimeout(
      hop1Memory({ store: this.store, query, options, ctx }),
      HOP1_TIMEOUT_MS,
      [],
    );
    traceLatency.memory = Date.now() - t1;

    const inspection = inspectMemories(memories);

    // ── HOP 2 + HOP 3 (parallel, both keyed on inspection) ────────────────
    const t2Start = Date.now();
    const [hop2, hop3] = await Promise.all([
      withTimeout(
        hop2Evidence({
          evidenceService: this.evidence, query, ctx, inspection, prisma: this.prisma,
        }),
        HOP2_TIMEOUT_MS,
        { items: [], reason: 'timeout' },
      ),
      options.include_live === false
        ? Promise.resolve({ items: [], reason: 'disabled' })
        : withTimeout(
            hop3Live({ prisma: this.prisma, query, ctx, inspection }),
            HOP3_TIMEOUT_MS,
            { items: [], reason: 'timeout' },
          ),
    ]);
    traceLatency.evidence = Date.now() - t2Start;
    traceLatency.live     = Date.now() - t2Start;

    // ── MERGE ─────────────────────────────────────────────────────────────
    const rankedMemories = reciprocalRankFusionMemories(memories, inspection);

    // Lineage: link evidence segments back to memories when source_metadata
    // points at the same document.
    const memoryByDocId = new Map();
    for (const m of rankedMemories) {
      const docId = m.source_metadata?.document_id;
      if (docId && !memoryByDocId.has(docId)) memoryByDocId.set(docId, m.id);
    }
    const evidenceWithLineage = (hop2.items || []).map((e) => ({
      ...e,
      linked_memory_id: memoryByDocId.get(e.documentId) || null,
    }));

    const tiersFired = ['memory'];
    if (hop2.items.length > 0) tiersFired.push(`evidence-${hop2.reason}`);
    if (hop3.items.length > 0) tiersFired.push('live');

    return {
      memories: rankedMemories.slice(0, 15).map((m) => ({
        id: m.id,
        title: m.title,
        content: typeof m.content === 'string' ? m.content.slice(0, 400) : '',
        memory_type: m.memory_type,
        tags: m.tags,
        score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
        created_at: m.created_at,
        valid_at: m.valid_at,
      })),
      evidence: evidenceWithLineage.slice(0, HOP2_DOC_LIMIT).map((e) => ({
        segment_id:       e.segmentId,
        document_id:      e.documentId,
        document_title:   e.document?.title || null,
        content:          (e.content || '').slice(0, 600),
        snippet:          e.snippet,
        score:            typeof e.score === 'number' ? Number(e.score.toFixed(3)) : null,
        page:             e.metadata?.startPage || null,
        linked_memory_id: e.linked_memory_id,
      })),
      live: hop3.items,
      trace: {
        hop1_count:      memories.length,
        sparse:          inspection.sparse,
        top_score:       Number(inspection.topScore.toFixed(3)),
        anchors: {
          filenames:  inspection.filenames,
          doc_hashes: inspection.docHashes,
          doc_ids:    inspection.docIds,
          platforms:  inspection.platforms,
        },
        evidence_trigger: hop2.reason,
        live_trigger:     hop3.reason,
        tiers_fired:      tiersFired,
        latency_ms:       { ...traceLatency, total: Date.now() - startedAt },
      },
    };
  }
}
