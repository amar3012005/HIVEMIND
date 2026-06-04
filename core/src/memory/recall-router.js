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

import { recallPersistedMemories, crossClusterEntityBoost } from './persisted-retrieval.js';
import { ClusterIndex } from './cluster-index.js';
import { rerank } from './reranker.js';

// ── Constants ───────────────────────────────────────────────────────────────

const HOP1_DEFAULT_LIMIT       = 12;
const HOP2_DOC_LIMIT           = 8;
const HOP2_UNFILTERED_LIMIT    = 6;
const HOP3_LIVE_LIMIT          = 5;
// Deliver-narrow: retrieve stays wide (HOP1 fetches up to 50, RRF/MMR-ranked),
// but only the top-N ranked memories go to the answer model. 1024 bge-m3 +
// algorithmic rerank shows a clean relevance cliff after ~5 (junk/redundancy
// beyond), so default 5. Env-tunable (no redeploy to widen for summarize).
const RECALL_DELIVER_LIMIT     = Number(process.env.RECALL_DELIVER_LIMIT || 5);

const HOP1_TIMEOUT_MS          = 4000;
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
  let hasValidAt = !!(options.valid_at && !Number.isNaN(new Date(options.valid_at).getTime()));
  // Inline date detection — pulls "as of May 13", "before March 2025",
  // "on 2026-04-10", "in October" out of the query when caller didn't
  // pass valid_at explicitly. Planner often misses these.
  if (!hasValidAt && /\b(as of|before|prior to|on|in|by|until)\b/.test(ql)) {
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

  // Bi-temporal `valid_at` filter: snap recall to a past moment so the
  // agent sees only memories whose document_date <= valid_at AND that
  // were already known by then (created_at <= valid_at). recallPersisted
  // honors a date_range param keyed on created_at; we also rely on the
  // tag-anchored override below to apply document_date filter for the
  // connector path. Anything else uses created_at as the bi-temporal
  // baseline.
  const validAtDate = options.valid_at && !Number.isNaN(new Date(options.valid_at).getTime())
    ? new Date(options.valid_at)
    : null;
  // Fast-path: if we already know we'll use the tag-anchored override,
  // skip the expensive FTS+vector recall — it adds ~1.5s and we'd discard
  // its output anyway. HOP1_TIMEOUT_MS=1500 was eating these calls.
  // Triggers when: (a) caller explicitly passes tags (intentional filter),
  // (b) recency cue + connector keyword, (c) valid_at + connector keyword.
  const callerTags = Array.isArray(options.tags) && options.tags.length > 0;
  const willOverride = callerTags || (isRecentish && inferredTags) || (validAtDate && (options.tags || inferredTags));
  // Caller-provided date_range takes priority over derived valid_at end-
  // cap. Used for today/yesterday/this-week shortcuts where we need a
  // hard start+end window, not just an upper bound.
  const explicitDateRange = options.date_range && typeof options.date_range === 'object'
    ? options.date_range
    : null;
  const recallArgs = {
    query_context: query,
    user_id: ctx.userId,
    org_id: ctx.orgId,
    max_memories: Math.min(options.limit || HOP1_DEFAULT_LIMIT, 50),
    tags: options.tags || inferredTags || undefined,
    source_type: options.source_type,
    access_context: scopedAccessCtx,
    ...(ctx.projectId ? { project_id: ctx.projectId, project_ids: [ctx.projectId] } : {}),
    ...(explicitDateRange
      ? { date_range: explicitDateRange }
      : validAtDate ? { date_range: { end: validAtDate.toISOString() } } : {}),
  };
  const result = willOverride
    ? { memories: [] }
    : await recallPersistedMemories(store, recallArgs);

  // Tag-anchored recency override. When the query carries a recency cue
  // (last/latest/recent/today/…) AND we inferred a connector tag, FTS-
  // ranked code-mention memories drown out the actual recent channel
  // messages. Override with a direct tag fetch ordered by document_date
  // desc so the freshest tagged memory always wins.
  //
  // Also fires as a hard fallback when FTS returned 0 hits.
  const effectiveTags = options.tags || inferredTags;
  let mems = result.memories || [];
  const recencyOverride = isRecentish && inferredTags && store.client?.memory;
  // Time-travel override: when valid_at is set and we have tags (caller-
  // supplied or inferred), also drop into the direct-fetch path so the
  // document_date <= valid_at filter applies AND we order by date.
  const timeTravelOverride = validAtDate && Array.isArray(effectiveTags) && effectiveTags.length > 0 && store.client?.memory;
  const callerTagOverride = callerTags && store.client?.memory;
  if ((recencyOverride || timeTravelOverride || callerTagOverride || (mems.length === 0 && Array.isArray(effectiveTags) && effectiveTags.length > 0)) && store.client?.memory) {
    try {
      const orFilters = [];
      if (ctx.orgId) orFilters.push({ orgId: ctx.orgId });
      if (ctx.userId) orFilters.push({ userId: ctx.userId });
      const tagOnly = await store.client.memory.findMany({
        where: {
          deletedAt: null,
          // valid_at queries need superseded versions too — show what was
          // current at that past moment (isLatest at valid_at, not now).
          ...(validAtDate ? {} : { isLatest: true }),
          tags: { hasSome: effectiveTags },
          ...(orFilters.length === 1 ? orFilters[0] : orFilters.length > 1 ? { OR: orFilters } : {}),
          // Time-travel: filter by EVENT TIME (document_date) only —
          // that's what users mean by "as of May 13" (msgs sent by then),
          // not "memories known by then". Bi-temporal createdAt filter
          // was excluding memories ingested today but sent earlier.
          ...(validAtDate ? {
            OR: [
              { documentDate: { lte: validAtDate } },
              {
                AND: [
                  { documentDate: null },
                  { createdAt: { lte: validAtDate } },
                ],
              },
            ],
          } : {}),
        },
        orderBy: [{ documentDate: 'desc' }, { createdAt: 'desc' }],
        take: Math.min((options.limit || HOP1_DEFAULT_LIMIT) * 4, 50),
        select: {
          id: true, title: true, content: true, memoryType: true, tags: true,
          createdAt: true, documentDate: true, importanceScore: true, sourceMetadata: true,
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
      const candText = `${cand.title || ''} ${(cand.content || '').slice(0, 200)}`;
      let maxSim = 0;
      for (const p of picked) {
        const pText = `${p.title || ''} ${(p.content || '').slice(0, 200)}`;
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

    const traceLatency = {};
    const startedAt = Date.now();

    // ── HOP 1 ─────────────────────────────────────────────────────────────
    const t1 = Date.now();
    let memories = await withTimeout(
      hop1Memory({ store: this.store, query, options, ctx }),
      HOP1_TIMEOUT_MS,
      [],
    );
    // Project-scope fallback: if user has a project active but recall came
    // back empty, the relevant memories may live outside that project (e.g.
    // personal-scope or org-wide). Retry once without projectId so chat
    // doesn't hallucinate "I don't have any notes" when memories exist.
    let projectFallbackFired = false;
    if (memories.length === 0 && ctx.projectId) {
      const ctxBroad = { ...ctx, projectId: null };
      memories = await withTimeout(
        hop1Memory({ store: this.store, query, options, ctx: ctxBroad }),
        HOP1_TIMEOUT_MS,
        [],
      );
      projectFallbackFired = memories.length > 0;
      if (projectFallbackFired) {
        console.log(`[recall-router] project-scope empty (${ctx.projectId}) → broad recall found ${memories.length} memories`);
      }
    }
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
    let rankedMemories = reciprocalRankFusionMemories(memories, inspection);

    // Move 3: cross-cluster shared-entity boost (after RRF, before slice)
    // Fire in try/catch — never block recall on boost failure.
    if (this.clusterIndex && ctx.orgId) {
      try {
        rankedMemories = await crossClusterEntityBoost(rankedMemories, {
          clusterIndex:   this.clusterIndex,
          organizationId: ctx.orgId,
        });
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

    rankedMemories = applyScoreFloor(rankedMemories, 0.40);
    rankedMemories = applyMMRDiversity(rankedMemories, 0.70);
    rankedMemories = collapseClusterDuplicates(rankedMemories);

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
    const evidenceWithLineage = (hop2.items || []).map((e) => ({
      ...e,
      linked_memory_id: memoryByDocId.get(e.documentId) || null,
    }));

    const tiersFired = ['memory'];
    if (hop2.items.length > 0) tiersFired.push(`evidence-${hop2.reason}`);
    if (hop3.items.length > 0) tiersFired.push('live');

    // Stage 4 / P1: optional cross-encoder rerank of the wide ranked pool →
    // deliver top-N. No-op (returns first N) unless RERANK_ENABLED + endpoint.
    const deliverMemories = await rerank(query, rankedMemories, { topN: RECALL_DELIVER_LIMIT });

    return {
      memories: deliverMemories.map((m) => ({
        id: m.id,
        title: m.title,
        content: typeof m.content === 'string' ? m.content.slice(0, 400) : '',
        memory_type: m.memory_type,
        tags: m.tags,
        score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
        created_at: m.created_at,
        valid_at: m.valid_at,
        // Cognition layer signals — agent uses these to prefer synthesis-
        // tier rows. Pass through when present; null/undefined harmless.
        ...(m.source_metadata?.source_type
          ? { source_metadata: { source_type: m.source_metadata.source_type } }
          : {}),
        ...(m.synthesis_confidence != null   ? { synthesis_confidence:   m.synthesis_confidence }   : {}),
        ...(m.synthesis_revision   != null   ? { synthesis_revision:     m.synthesis_revision }     : {}),
        ...(m.synthesis_cluster_hash         ? { synthesis_cluster_hash: m.synthesis_cluster_hash } : {}),
        ...(Array.isArray(m.synthesis_evidence_ids) && m.synthesis_evidence_ids.length
          ? { synthesis_evidence_ids: m.synthesis_evidence_ids }
          : {}),
        // Expose cross-cluster boost metadata when present (Move 3)
        ...(m._cross_cluster_boost != null ? {
          _cross_cluster_boost:   Number(m._cross_cluster_boost.toFixed(3)),
          _cross_cluster_overlap: m._cross_cluster_overlap || 0,
        } : {}),
        // Phase B tier surfaced for hydration tap + UI ("hot"/"thin"/"live")
        ...(typeof m.tier === 'number' ? { tier: m.tier } : {}),
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
