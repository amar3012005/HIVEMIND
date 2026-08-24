/**
 * Evidence Retrieval Service
 * Phase 1: Separate evidence/citation retrieval from canonical memory recall
 *
 * Provides dual retrieval modes:
 * - Memory mode: canonical organizational truths (current default)
 * - Evidence mode: supporting documents and segments for grounding/citations
 * - Hybrid mode: blends both with ranked results
 */

import { resolveCollectionForOrg, PER_TENANT } from '../vector/container-router.js';
import { orgIsRemote, amrKbDocs, amrKbRecall, amrKbLexicalRemote, amrKbHydrate, amrMemoryEvidence } from '../vector/mneme/driver.js';
import { evidenceTitle } from './provenance-metadata.js';

export function fuseRemoteEvidenceHits(vectorHits = [], lexicalHits = [], { rankConstant = 60 } = {}) {
  const byId = new Map();
  const add = (hit, lane, rank) => {
    const id = hit?.segment_id || hit?.segmentId || hit?.id;
    if (!id) return;
    const current = byId.get(id) || { ...hit, segment_id: id, _rrf: 0 };
    current._rrf += 1 / (rankConstant + rank);
    if (lane === 'semantic') {
      current._semantic = true;
      current.semantic_score = Number(hit.score) || 0;
    } else {
      current._lexical = true;
      current.lexical_score = Number(hit.score) || 0;
    }
    byId.set(id, current);
  };
  vectorHits.forEach((hit, index) => add(hit, 'semantic', index + 1));
  lexicalHits.forEach((hit, index) => add(hit, 'lexical', index + 1));
  const maxFusion = 2 / (rankConstant + 1);
  return [...byId.values()].map(({ _rrf, ...hit }) => ({
    ...hit,
    score: Number((_rrf / maxFusion).toFixed(6)),
    fusion_score: Number((_rrf / maxFusion).toFixed(6)),
  })).sort((left, right) => right.score - left.score);
}

export function buildLexicalPhrases(tokens = [], { max = 18 } = {}) {
  const normalized = tokens.map((token) => String(token || '').trim()).filter(Boolean);
  const phrases = [];
  // Trigrams first: they are far less likely to saturate a bounded database
  // candidate window than generic single tokens. Bigrams provide recall when
  // punctuation or segmentation splits a longer phrase. This is language- and
  // domain-independent; it depends only on the user's token order.
  for (const width of [3, 2]) {
    for (let index = 0; index + width <= normalized.length; index += 1) {
      const phrase = normalized.slice(index, index + width).join(' ');
      if (phrase.replace(/\s/g, '').length >= 8) phrases.push(phrase);
      if (phrases.length >= max) return [...new Set(phrases)];
    }
  }
  return [...new Set(phrases)];
}

export function matchSourceDocuments(documents = [], { documentId = null, title = null, limit = 3 } = {}) {
  const wantedId = String(documentId || '').trim();
  const wantedTitle = String(title || '').trim().toLocaleLowerCase();
  return documents
    .filter((document) => {
      const id = String(document.id || document.document_id || '').trim();
      if (wantedId) return id === wantedId;
      if (!wantedTitle) return false;
      const candidates = [document.title, document.filename, document.sourceId, document.source_id]
        .filter(Boolean)
        .map((value) => String(value).normalize('NFKC').toLocaleLowerCase());
      return candidates.some((value) => value.includes(wantedTitle));
    })
    .slice(0, Math.max(1, Math.min(Number(limit) || 3, 10)))
    .map((document) => ({
      ...document,
      id: document.id || document.document_id,
      title: document.title || document.filename || null,
    }));
}

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function timestamp(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedValues(values = []) {
  return new Set(values.flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase())
    .filter(Boolean));
}

export function evidenceMetadata(row = {}) {
  const document = row.document || {};
  const segmentMeta = objectValue(row.metadata);
  const documentMeta = objectValue(document.parseMetadata || document.parse_metadata);
  const eventTime = segmentMeta.event_time || segmentMeta.eventTime
    || documentMeta.event_time || documentMeta.eventTime
    || document.documentDate || document.document_date || null;
  const validFrom = segmentMeta.valid_from || segmentMeta.validFrom
    || documentMeta.valid_from || documentMeta.validFrom || eventTime;
  const validTo = segmentMeta.valid_to || segmentMeta.validTo
    || documentMeta.valid_to || documentMeta.validTo || null;
  const knownAt = segmentMeta.known_at || segmentMeta.knownAt
    || documentMeta.known_at || documentMeta.knownAt
    || row.createdAt || row.created_at || document.createdAt || document.created_at || null;
  const tags = Array.isArray(document.tags) ? document.tags : [];
  const sourceKinds = normalizedValues([
    document.documentType, document.document_type,
    document.sourcePlatform, document.source_platform,
    documentMeta.source_kind, documentMeta.sourceKind, documentMeta.kind,
    ...tags.filter((tag) => /^(source-kind|source_kind|document-type|document_type|kind):/i.test(String(tag)))
      .map((tag) => String(tag).split(':').slice(1).join(':')),
  ]);
  const memoryTypes = normalizedValues([
    row.segmentType, row.segment_type,
    segmentMeta.segmentType, segmentMeta.segment_type,
    segmentMeta.memory_types, segmentMeta.memoryTypes,
    segmentMeta.memory_type, segmentMeta.memoryType, segmentMeta.claim_type, segmentMeta.claimType,
    documentMeta.memory_type, documentMeta.memoryType,
    ...tags.filter((tag) => /^(memory-type|memory_type|claim-type|claim_type):/i.test(String(tag)))
      .map((tag) => String(tag).split(':').slice(1).join(':')),
    ...(row.memoryLinks || []).map((link) => link?.memory?.memoryType || link?.memory?.memory_type),
  ]);
  const entities = normalizedValues([
    segmentMeta.entities, segmentMeta.entity_names, segmentMeta.entityNames,
    documentMeta.entities, documentMeta.entity_names, documentMeta.entityNames,
    ...(row.entityMentions || []).flatMap((mention) => [
      mention?.mentionText, mention?.mention_text,
      mention?.entity?.canonicalName, mention?.entity?.canonical_name,
      mention?.entity?.aliases,
    ]),
    ...tags.filter((tag) => /^entity:/i.test(String(tag)))
      .map((tag) => String(tag).split(':').slice(1).join(':')),
  ]);
  return { eventTime, validFrom, validTo, knownAt, sourceKinds, memoryTypes, entities };
}

export function filterEvidenceByMetadata(rows = [], {
  sourceKind = null,
  temporalSelector = null,
  time = null,
  memoryTypes = [],
  entities = [],
} = {}) {
  const wantedKind = String(sourceKind || '').normalize('NFKC').trim().toLocaleLowerCase();
  const wantedTypes = normalizedValues(memoryTypes);
  const wantedEntities = normalizedValues(entities);
  const rangeStart = timestamp(time?.range?.start || time?.range?.from);
  const rangeEnd = timestamp(time?.range?.end || time?.range?.to);
  const validAt = timestamp(time?.valid_at);
  const knownAt = timestamp(time?.known_at);

  let filtered = rows.filter((row) => {
    const meta = evidenceMetadata(row);
    if (wantedKind && ![...meta.sourceKinds].some((kind) => kind === wantedKind
      || kind.startsWith(`${wantedKind}/`))) return false;
    if (wantedTypes.size && ![...wantedTypes].some((type) => meta.memoryTypes.has(type))) return false;
    if (wantedEntities.size) {
      const searchable = `${row.content || row.snippet || ''} ${row.document?.title || ''}`
        .normalize('NFKC').toLocaleLowerCase();
      const matched = [...wantedEntities].every((entity) => meta.entities.has(entity)
        || [...meta.entities].some((candidate) => candidate.includes(entity) || entity.includes(candidate))
        // Historical rows may pre-date entity metadata. Content matching is a
        // deterministic compatibility fallback, never a source of scope widening.
        || searchable.includes(entity));
      if (!matched) return false;
    }
    if (rangeStart != null || rangeEnd != null) {
      const event = timestamp(meta.eventTime);
      if (event == null || (rangeStart != null && event < rangeStart) || (rangeEnd != null && event > rangeEnd)) return false;
    }
    if (validAt != null) {
      const from = timestamp(meta.validFrom);
      const to = timestamp(meta.validTo);
      if (from == null || from > validAt || (to != null && validAt >= to)) return false;
    }
    if (knownAt != null) {
      const known = timestamp(meta.knownAt);
      if (known == null || known > knownAt) return false;
    }
    return true;
  });

  if (['latest', 'earliest'].includes(temporalSelector) && filtered.length) {
    const byDocument = new Map();
    for (const row of filtered) {
      const documentId = row.documentId || row.document_id || row.document?.id;
      if (!documentId) continue;
      const meta = evidenceMetadata(row);
      const order = timestamp(meta.eventTime) ?? timestamp(meta.knownAt);
      const current = byDocument.get(documentId);
      if (!current || (order != null && (current.order == null
        || (temporalSelector === 'latest' ? order > current.order : order < current.order)))) {
        byDocument.set(documentId, { order });
      }
    }
    const ordered = [...byDocument.entries()].filter(([, value]) => value.order != null)
      .sort((left, right) => temporalSelector === 'latest'
        ? right[1].order - left[1].order
        : left[1].order - right[1].order);
    if (!ordered.length) return [];
    const selectedDocumentId = ordered[0][0];
    filtered = filtered.filter((row) => (row.documentId || row.document_id || row.document?.id) === selectedDocumentId);
  }
  return filtered;
}

/**
 * Which SCOPE TIER does a document belong to, for display?
 *
 * `_accessibleDocumentWhere` below decides who MAY see a document. This answers the
 * separate question the chat needs: which tier did this answer come FROM, so the UI can
 * render "(memory found in <scope>)". Chat used to report scopes for the memory lane
 * only, so an answer built purely from uploaded documents — exactly what a KB question
 * hits — showed no provenance chip at all, even though the document carries the tag.
 *
 * Reuses the tag forms `_accessibleDocumentWhere` already matches, including the
 * `scope-key:org:<uuid>` / legacy `scope-key:organization` pair. The upload writer emits
 * exactly ONE scopeKey per document (scopeType is single-valued in
 * upload-authorization.js), so this checks narrow→wide and takes the first match rather
 * than trying to merge tiers.
 *
 * Untagged ⇒ 'personal'. That is not a guess: untagged documents are owner-only in
 * `_accessibleDocumentWhere`'s bare `{ userId }` arm, so personal is what they ARE.
 */
export function documentScopeFromTags(tags, { orgId } = {}) {
  const t = Array.isArray(tags) ? tags : [];
  if (!t.length) return { scope: 'personal', projectId: null };
  const find = (prefix) => t.find((x) => typeof x === 'string' && x.startsWith(prefix));
  if (find('scope-key:personal:')) return { scope: 'personal', projectId: null };
  const proj = find('scope-key:project:');
  if (proj) return { scope: 'project', projectId: proj.slice('scope-key:project:'.length) || null };
  if (find('scope-key:team:')) return { scope: 'team', projectId: null };
  if (t.includes(`scope-key:org:${orgId}`) || t.includes('scope-key:organization')) {
    return { scope: 'organization', projectId: null };
  }
  // Carries tags, but none of them a scope-key — same owner-only reality as untagged.
  return { scope: 'personal', projectId: null };
}

export class EvidenceRetrievalService {
  constructor({ db, qdrantClient }) {
    this.db = db;
    this.qdrantClient = qdrantClient;
  }

  /**
   * Order a DEPTH-sized pool and hand back a WIDE slice for the delivery-point
   * cross-encoder to arbitrate. Local only — no network.
   *
   * The cross-encoder deliberately does NOT run here. Measured: calling it per-lane
   * cost +902ms on a warm query (77ms -> 979ms) because `rerank` is a remote call
   * that does not cache — and the router already reranks, so a lane-level pass makes
   * TWO remote calls per query. ONE pass at the delivery point over memories ∪
   * segments (deliverUnifiedV2) gets the same accuracy for one call, and is the only
   * place the two lanes can actually be compared against each other.
   *
   * `deliver` is therefore a WIDE hand-off (~40), not the user-visible count; the
   * delivery point narrows to HOP2_DOC_LIMIT after ranking.
   */
  /**
   * Which DOCUMENTS may this caller see? Segments carry no scope of their own —
   * knowledge_segments has only document_id/user_id/org_id — so scope is enforced by
   * joining to the document, where it lives in `tags` as `scope-key:*` (written as
   * scopeKey by knowledge/upload-authorization.js).
   *
   * Replaces a blanket `userId` filter that made a COLLEAGUE'S ORG-SHARED UPLOAD
   * INVISIBLE: an org knowledge base that only ever returned your own documents.
   * Retrieval is now org-wide in Qdrant and authoritatively scoped here, in Postgres,
   * before anything is returned.
   *
   * Untagged documents (verified: 21 of 100 carry no scope-key) fall to OWNER-ONLY via
   * the bare `{ userId }` arm — identical to the previous behaviour, so nothing that
   * used to be visible disappears, and an unknown scope is never published.
   *
   * Mirrors the accessibleDocument shape in agent/tool-registry.js rather than adding a
   * second scope implementation.
   */
  _accessibleDocumentWhere({ userId, orgId, projectId = null, accessContext = null, scopeFilter = null }) {
    const base = { orgId, archivedAt: null };
    const projectTags = (accessContext?.projectIds || []).map((id) => `scope-key:project:${id}`);
    const teamTags = (accessContext?.teamIds || []).map((id) => `scope-key:team:${id}`);
    // THE UPLOAD WRITER EMITS `scope-key:org:<orgId>`, NOT `scope-key:organization`.
    // Verified on a real upload with targetScope=organization, whose tags are
    // {..., scope-key:org:1380251c-f707-4aee-98a4-dd93b63b4a00, ...}. Matching only the
    // bare literal meant every org-shared document fell through to the owner-only branch:
    // a colleague could not see it at all, so org-wide sharing did not work — and under a
    // `personal` lens the NOT-guard below missed the real tag, so the owner saw their own
    // org document labelled personal. Both forms are accepted here, which is exactly what
    // appendDocumentAccess on the .amr agent already does (`scope-key:org:${ORG}` OR the
    // legacy `scope-key:organization`), so central and remote now answer identically.
    const orgTags = [`scope-key:org:${orgId}`, 'scope-key:organization'];

    // An EXPLICIT lens NARROWS — it never widens. Mirrors matchesScopeFilter on the
    // memory side (persisted-retrieval.js), which does an exact scope equality check,
    // so both lanes answer the same question for the same request. Without this an
    // ?scope=personal question kept org documents in the evidence half of the answer.
    if (scopeFilter === 'organization') return { ...base, tags: { hasSome: orgTags } };
    if (scopeFilter === 'project') {
      const tags = projectId ? [`scope-key:project:${projectId}`] : projectTags;
      // No project in scope + a project lens = nothing is in scope. Fail closed rather
      // than silently falling back to everything the caller can see.
      return { ...base, tags: { hasSome: tags.length ? tags : ['scope-key:project:__none__'] } };
    }
    if (scopeFilter === 'team') {
      return { ...base, tags: { hasSome: teamTags.length ? teamTags : ['scope-key:team:__none__'] } };
    }
    if (scopeFilter === 'personal') {
      // Owned by the caller, or explicitly tagged personal to them. Untagged documents
      // are owner-only elsewhere, so they belong here and nowhere else.
      //
      // The owner branch must exclude every NON-personal scope, not just the org one.
      // Excluding orgTags alone let the caller's OWN project documents through: a
      // project document carries `scope-key:project:<id>` and no org tag, so
      // `NOT hasSome(orgTags)` was true and `userId` matched the uploader. Measured
      // live against /api/evidence/search with scope=personal: 8 results, 4 of them
      // project-scoped — the lens returned exactly what it exists to exclude.
      // projectTags/teamTags come from the caller's own accessContext, which is the
      // only set that could leak into their view in the first place.
      const nonPersonalTags = [...orgTags, ...projectTags, ...teamTags];
      return { ...base, OR: [
        { tags: { has: `scope-key:personal:${userId}` } },
        { AND: [{ userId }, { NOT: { tags: { hasSome: nonPersonalTags } } }] },
      ] };
    }
    if (scopeFilter) console.warn(`[EvidenceRetrieval] unknown scopeFilter '${scopeFilter}' — using full accessible set`);

    if (projectId) return { ...base, tags: { has: `scope-key:project:${projectId}` } };
    return {
      ...base,
      OR: [
        { userId },                                              // own uploads + untagged
        { tags: { hasSome: orgTags } },
        { tags: { has: `scope-key:personal:${userId}` } },
        ...(projectTags.length ? [{ tags: { hasSome: projectTags } }] : []),
        ...(teamTags.length ? [{ tags: { hasSome: teamTags } }] : []),
      ],
    };
  }

  _orderAndSlice(candidates, deliver) {
    return candidates
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, deliver);
  }

  /**
   * Retrieve evidence segments (not canonical memories)
   * @param {Object} params
   * @param {string} params.query - search query
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {number} params.limit - max results
   * @param {string} params.documentId - optional: scope to specific document
   * @returns {Promise<Array>} evidence segments with snippets
   */
  async retrieveEvidence({
    query, userId, orgId, limit = 10,
    queryVector = null,
    // DEPTH vs DELIVER. One `limit` used to do BOTH jobs — it sized the Qdrant
    // over-fetch AND the returned slice — so production's limit:6 handed the
    // cross-encoder 12 candidates while RERANK_POOL=150 sat unused. Measured on
    // org 1380251c: pool recall 1->6, 2->11, 0->8 going from depth 5 to 300, and
    // small-detail answerability 3/5 -> 5/5. `limit` remains an alias for both so
    // no existing caller changes behaviour.
    depth = null,
    deliver = null,
    projectId = null,         // scope: pin to one project when the caller has one
    accessContext = null,     // scope: { projectIds, teamIds, orgRole } from the session
    scopeFilter = null,       // scope: an EXPLICIT lens the caller asked for
                              // (personal|project|team|organization). Memories enforce
                              // this via matchesScopeFilter; evidence must too, or a
                              // personal-scoped question answers from org documents.
    documentId = null,        // legacy single-doc filter (kept for backwards compat)
    documentIds = null,       // NEW: multi-doc filter — used by RecallRouter for tag-anchored evidence
    scoreThreshold = null,    // override default 0.5; lower for doc-filtered search where we want most chunks
    sourceKind = null,
    temporalSelector = null,
    time = null,
    memoryTypes = [],
    entities = [],
  }) {
    // Per-tenant: evidence lives in the org container (layer=evidence). Legacy:
    // a dedicated hivemind_evidence collection. Must mirror _embedSegments.
    const collectionName = PER_TENANT
      ? await resolveCollectionForOrg(orgId)
      : (process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence');
    const _depth = Math.max(1, Number(depth ?? limit) || 10);
    const _deliver = Math.max(1, Number(deliver ?? limit) || 10);
    let docIdSet = Array.isArray(documentIds) && documentIds.length
      ? [...new Set(documentIds.filter(Boolean))]
      : (documentId ? [documentId] : null);

    // When a doc is selected, lower threshold so we actually return its
    // segments (Qdrant cosine on filename-style queries can score below 0.5).
    const effectiveThreshold = scoreThreshold != null
      ? scoreThreshold
      : (docIdSet ? 0.2 : Number(process.env.EVIDENCE_SCORE_FLOOR ?? 0.05));

    try {
      // Remote (self-host) orgs: KB evidence lives on the agent — no central Qdrant or DB access.
      if (orgIsRemote(orgId)) {
        const access = { userId, projectId, accessContext, scopeFilter };
        // Documents scope only -- access travels as its own explicit option to both calls
        // below (both bridges now accept it that way), not nested inside this object. It
        // used to be bundled into `filter` for both lanes; that happened to match how
        // kb-lexical's server route read it, but kb-recall's took access as a named opt, so
        // the two calls were relying on two different, undocumented shapes of the same object.
        const filter = {
          documentId: docIdSet && docIdSet.length === 1 ? docIdSet[0] : undefined,
          documentIds: docIdSet && docIdSet.length > 1 ? docIdSet : undefined,
        };
        // Exact terms and embeddings are complementary. Start the lexical lane
        // immediately so a part number still returns when embedding is unavailable.
        const lexicalPromise = amrKbLexicalRemote(orgId, query, { filter, limit: _depth, access });
        const vectorPromise = Promise.resolve(queryVector || this.qdrantClient.generateEmbedding(query))
          .then((resolvedQueryVector) => resolvedQueryVector
            ? amrKbRecall(orgId, resolvedQueryVector, { limit: _depth, ...filter, scoreThreshold: effectiveThreshold, access })
            : []);
        // A Memory Box evidence hop has a 1.5s outer budget. Previously a
        // completed lexical result was discarded whenever cold embedding kept
        // Promise.all pending until that outer deadline. Bound each lane so a
        // slow semantic provider degrades independently instead of erasing an
        // exact/phrase match that is already available.
        const [vectorHits, lexicalHits] = await Promise.all([vectorPromise, lexicalPromise]);
        // null (not []) means the lane FAILED rather than matched nothing — see
        // remote-backend.js. Say which lane is missing, because a half-working remote agent
        // returns plausible answers with a whole retrieval mode silently absent, and that is
        // indistinguishable from a small corpus unless we log it here.
        if (vectorHits === null || lexicalHits === null) {
          console.warn(`[EvidenceRetrieval] REMOTE LANE DOWN org=${orgId}: `
            + `${vectorHits === null ? 'vector ' : ''}${lexicalHits === null ? 'lexical ' : ''}`
            + `unavailable — this answer is built from the remaining lane only, so recall is `
            + `degraded, NOT empty. Check the .amr agent build (is it in sync with byod/?).`);
        }
        const hits = fuseRemoteEvidenceHits(vectorHits || [], lexicalHits || []);
        if (!hits.length) return [];
        const hydrated = await amrKbHydrate(orgId, hits.map((h) => h.segment_id), access);
        // Build a score lookup from the merged vector and lexical hits.
        const hydrateMap = new Map((hydrated || []).map((s) => [s.id, s]));
        const remoteResults = hits
          .map((h) => {
            const s = hydrateMap.get(h.segment_id);
            if (!s) return null;
            // Filter by docIdSet when multiple docs requested (agent-side only filtered single-doc).
            if (docIdSet && docIdSet.length > 1 && !docIdSet.includes(s.document_id)) return null;
            return {
              type: 'evidence_segment',
              segmentId: s.id,
              documentId: s.document_id,
              title: s.metadata?.evidence_title || evidenceTitle(s.title || h.title, s.segment_index),
              citation_id: s.metadata?.citation_id || s.id,
              content: s.content,
              snippet: this._extractSnippet(s.content, query),
              score: h.score,
              fusion_score: h.fusion_score,
              semantic_score: h.semantic_score ?? null,
              lexical_score: h.lexical_score ?? null,
              ...(h._semantic ? { _semantic: true } : {}),
              ...(h._lexical ? { _lexical: true } : {}),
              document: {
                id: s.document_id,
                title: s.title || h.title || null,
                documentType: s.document_type || s.document?.documentType || h.document_type || null,
                sourcePlatform: s.source_platform || s.document?.sourcePlatform || h.source_platform || null,
                documentDate: s.document_date || s.document?.documentDate || h.document_date || null,
                parseMetadata: s.document_metadata || s.document?.parseMetadata || h.document_metadata || null,
                tags: s.document_tags || s.document?.tags || h.document_tags || [],
                createdAt: s.document_created_at || s.document?.createdAt || h.document_created_at || null,
              },
              metadata: {
                ...objectValue(s.metadata),
                segmentType: s.segment_type,
                segmentIndex: s.segment_index,
                wordCount: s.word_count ?? h.word_count ?? null,
                startPage: s.start_page ?? h.start_page ?? null,
                endPage: s.end_page ?? h.end_page ?? null,
                known_at: s.known_at || s.created_at || h.known_at || null,
              },
            };
          })
          .filter(Boolean);
        return this._orderAndSlice(filterEvidenceByMetadata(remoteResults, {
          sourceKind, temporalSelector, time, memoryTypes, entities,
        }), _deliver);
      }

      // Source and temporal constraints are candidate-generation predicates,
      // not post-ranking hints. Resolve the authorized document set first so
      // both the vector and lexical lanes search the same bounded corpus. This
      // query is local metadata lookup only; it adds no embedding or model call.
      if (!docIdSet && (sourceKind || temporalSelector || time?.range || time?.valid_at || time?.known_at)) {
        const documents = await this.db.knowledgeDocument.findMany({
          where: this._accessibleDocumentWhere({ userId, orgId, projectId, accessContext, scopeFilter }),
          select: {
            id: true, title: true, documentType: true, sourcePlatform: true,
            sourceUrl: true, documentDate: true, tags: true, parseMetadata: true,
            createdAt: true, updatedAt: true,
          },
        });
        const selected = filterEvidenceByMetadata(
          documents.map((document) => ({ documentId: document.id, document, metadata: {} })),
          { sourceKind, temporalSelector, time },
        );
        docIdSet = selected.map((row) => row.documentId);
        if (!docIdSet.length) return [];
      }

      // Step 1: Vector search in evidence collection.
      // Multi-doc filter uses Qdrant's `match.any` array, single uses
      // `match.value`. Falls back to no doc filter when docIdSet null.
      const docFilter = (() => {
        if (!docIdSet) return [];
        if (docIdSet.length === 1) return [{ key: 'document_id', match: { value: docIdSet[0] } }];
        return [{ key: 'document_id', match: { any: docIdSet } }];
      })();

      // Compile ONE language-independent lexical lane and start it BEFORE query
      // embedding/Qdrant. The old central path awaited vector search and then
      // issued two sequential lexical queries. A cold embedding could consume
      // RecallRouter's entire evidence deadline before exact Postgres evidence
      // even started. Central and embedded storage now match the remote Memory
      // Box contract: semantic and lexical retrieve wide in parallel, then the
      // shared delivery reranker narrows the combined pool once.
      const allQueryTokens = [...new Set(
        String(query || '').split(/[^\p{L}\p{N}§°]+/u)
          .map((token) => token.trim()).filter((token) => token.length >= 3)
      )];
      const lexicalPhrases = buildLexicalPhrases(allQueryTokens);
      const baseTokens = docIdSet
        ? allQueryTokens
        : allQueryTokens.filter((token) => token.length >= 4
          && (/[0-9§°]/.test(token) || /^\p{Lu}/u.test(token)));
      const collapsedTokens = [];
      if (process.env.HYBRID_LEXICAL_RECALL === 'true') {
        const normalized = allQueryTokens.map((token) => token.toLocaleLowerCase());
        for (let index = 0; index + 1 < normalized.length; index += 1) {
          const joined = normalized[index] + normalized[index + 1];
          if (joined.length >= 6) collapsedTokens.push(joined);
        }
      }
      const lexTokens = [...new Set([...baseTokens, ...collapsedTokens])].slice(0, 16);
      const lexicalWhere = {
        orgId,
        document: docIdSet
          ? { archivedAt: null }
          : this._accessibleDocumentWhere({ userId, orgId, projectId, accessContext, scopeFilter }),
        ...(docIdSet ? { documentId: { in: docIdSet } } : {}),
      };
      const lexicalInclude = {
        document: { select: { id: true, title: true, documentType: true, sourcePlatform: true, sourceUrl: true, documentDate: true, tags: true, parseMetadata: true, createdAt: true, updatedAt: true } },
        entityMentions: { include: { entity: { select: { id: true, canonicalName: true, aliases: true } } } },
        memoryLinks: { include: { memory: { select: { id: true, memoryType: true } } } },
      };
      const lexicalPromise = (lexTokens.length || lexicalPhrases.length)
        ? Promise.all([
          lexicalPhrases.length ? this.db.knowledgeSegment.findMany({
            where: {
              ...lexicalWhere,
              OR: lexicalPhrases.map((phrase) => ({ content: { contains: phrase, mode: 'insensitive' } })),
            },
            include: lexicalInclude,
            take: Math.min(_depth, 100),
          }) : Promise.resolve([]),
          lexTokens.length ? this.db.knowledgeSegment.findMany({
            where: {
              ...lexicalWhere,
              OR: lexTokens.map((token) => ({ content: { contains: token, mode: 'insensitive' } })),
            },
            include: lexicalInclude,
            take: Math.min(docIdSet ? _depth * 2 : _depth, 200),
          }) : Promise.resolve([]),
        ]).then(([precise, broad]) => [...new Map(
          [...precise, ...broad].map((segment) => [segment.id, segment]),
        ).values()]).catch((error) => {
          console.warn('[EvidenceRetrieval] lexical lane failed:', error.message);
          return [];
        })
        : Promise.resolve([]);
      // Entity mentions are a third candidate-generation lane over canonical
      // relational metadata. It runs beside lexical/vector retrieval and does
      // not add an embedding, LLM call, or rerank pass.
      const entityNames = [...normalizedValues(entities)];
      const entityPromise = entityNames.length ? this.db.knowledgeSegment.findMany({
        where: {
          ...lexicalWhere,
          entityMentions: {
            some: {
              entity: {
                orgId,
                isActive: true,
                OR: entityNames.flatMap((name) => [
                  { canonicalName: { equals: name, mode: 'insensitive' } },
                  { canonicalName: { contains: name, mode: 'insensitive' } },
                  { aliases: { has: name } },
                ]),
              },
            },
          },
        },
        include: lexicalInclude,
        take: Math.min(_depth, 150),
      }).catch((error) => {
        console.warn('[EvidenceRetrieval] entity lane failed:', error.message);
        return [];
      }) : Promise.resolve([]);
      const vectorPromise = this.qdrantClient.searchMemories({
        collectionName,
        query,
        vector: queryVector,
        filter: {
          must: [
            // NO user_id here. Scope is enforced authoritatively in the Postgres
            // hydrate below (_accessibleDocumentWhere) — a payload-level user filter
            // could only ever express "mine", which hid org-shared documents.
            { key: 'org_id', match: { value: orgId } },
            ...docFilter,
          ]
        },
        limit: _depth, // retrieval DEPTH — the cross-encoder narrows to `deliver`
        // searchMemories destructures `score_threshold` (snake) — passing
        // camelCase silently dropped the computed threshold (fell back to 0.15).
        score_threshold: effectiveThreshold,
        // Per-tenant: constrain to evidence layer within the shared org container.
        layer: PER_TENANT ? 'evidence' : undefined,
      });
      const [boundedVectorResults, lexicalSegments, entitySegments] = await Promise.all([
        vectorPromise, lexicalPromise, entityPromise,
      ]);
      if (boundedVectorResults === null) {
        console.warn(`[EvidenceRetrieval] CENTRAL VECTOR LANE TIMEOUT org=${orgId}; delivering bounded lexical evidence`);
      }
      if (lexicalSegments === null) {
        console.warn(`[EvidenceRetrieval] CENTRAL LEXICAL LANE TIMEOUT org=${orgId}; delivering bounded semantic evidence`);
      }
      const vectorResults = boundedVectorResults || [];

      // Step 2: Hydrate segments from DB
      const segmentIds = vectorResults.map(r => r.payload.segment_id).filter(Boolean);
      
      const segments = await this.db.knowledgeSegment.findMany({
        where: {
          id: { in: segmentIds },
          orgId,
          // Qdrant is a candidate index, not the authorization authority.
          // Re-apply the caller's document allowlist in canonical Postgres so
          // a stale/malformed payload or unsupported match-any filter cannot
          // hydrate evidence from another project.
          ...(docIdSet ? { documentId: { in: docIdSet } } : {}),
          document: docIdSet
            ? { archivedAt: null }
            : this._accessibleDocumentWhere({ userId, orgId, projectId, accessContext, scopeFilter }),
        },
        include: {
          document: {
            select: {
              id: true,
              title: true,
              documentType: true,
              sourcePlatform: true,
              sourceUrl: true,
              documentDate: true,
              parseMetadata: true,
              createdAt: true,
              updatedAt: true,
              // Scope lives ONLY in tags (segments have no scope column), so without
              // this the delivered evidence could not say which tier answered.
              tags: true
            }
          },
          entityMentions: { include: { entity: { select: { id: true, canonicalName: true, aliases: true } } } },
          memoryLinks: { include: { memory: { select: { id: true, memoryType: true } } } },
        }
      });

      // Step 3: Merge with vector scores and format
      const segmentMap = new Map(segments.map(s => [s.id, s]));
      
      const fmt = (segment, score, lexical = false) => {
        // Derive the tier BEFORE dropping tags: the chip needs the scope, the client does
        // not need the raw tag list (it would grow every citation payload for no gain).
        const { tags: _docTags, ...documentPublic } = segment.document || {};
        const { scope: _scope, projectId: _scopeProjectId } = documentScopeFromTags(_docTags, { orgId });
        return {
        type: 'evidence_segment',
        segmentId: segment.id,
        documentId: segment.documentId,
        title: segment.metadata?.evidence_title
          || evidenceTitle(segment.document?.title, segment.segmentIndex),
        citation_id: segment.metadata?.citation_id || segment.id,
        content: segment.content,
        snippet: this._extractSnippet(segment.content, query),
        score,
        ...(lexical ? { _lexical: true } : {}),
        document: documentPublic,
        // Which tier this evidence came from, so chat can report provenance for
        // upload-answered turns the same way it already does for memories.
        scope: _scope,
        project_id: _scopeProjectId,
        metadata: {
          segmentType: segment.segmentType,
          segmentIndex: segment.segmentIndex,
          wordCount: segment.wordCount,
          startPage: segment.startPage,
          endPage: segment.endPage,
          // heading + heading_path were WRITTEN to knowledge_segments and then dropped
          // HERE — this formatter built a fresh object and never forwarded the segment's
          // own metadata. So the metadata-aware segmentation paid off for pages and
          // segment_type (both forwarded above) and ZERO for headings: a citation could
          // say "page 3" but never "1. Gesellschaftliche Gründe > Lebensqualität".
          // 674 of 3137 segments carry a heading_path today and none of it reached recall.
          heading: segment.metadata?.heading ?? null,
          heading_path: segment.metadata?.heading_path ?? null,
          depth: segment.depth ?? null,
          event_time: segment.metadata?.event_time ?? segment.metadata?.eventTime ?? segment.document?.documentDate ?? null,
          valid_from: segment.metadata?.valid_from ?? segment.metadata?.validFrom ?? null,
          valid_to: segment.metadata?.valid_to ?? segment.metadata?.validTo ?? null,
          known_at: segment.metadata?.known_at ?? segment.metadata?.knownAt ?? segment.createdAt ?? segment.document?.createdAt ?? null,
          memory_type: segment.metadata?.memory_type ?? segment.metadata?.memoryType ?? segment.metadata?.claim_type ?? null,
          entities: [...evidenceMetadata(segment).entities],
          memory_types: [...evidenceMetadata(segment).memoryTypes],
          source_id: segment.metadata?.source_id || segment.documentId,
          source_title: segment.metadata?.source_title || segment.document?.title || null,
          source_kind: segment.metadata?.source_kind || segment.document?.sourcePlatform || 'document',
          uploader_user_id: segment.metadata?.uploader_user_id || segment.userId || null,
          org_id: segment.metadata?.org_id || segment.orgId || null,
        },
        };
      };

      const results = vectorResults
        .map(vr => {
          const segment = segmentMap.get(vr.payload.segment_id);
          return segment ? fmt(segment, vr.score) : null;
        })
        .filter(Boolean);
      const haveIds = new Set(results.map(r => r.segmentId));

      // Merge the completed lexical lane. This is candidate generation, not a
      // second ranking authority; the shared memory+evidence delivery reranker
      // remains the single external relevance pass.
      for (const segment of lexicalSegments || []) {
        const lc = String(segment.content || '').toLocaleLowerCase();
        const matched = lexTokens.filter((token) => lc.includes(token.toLocaleLowerCase()));
        const matchedPhrases = lexicalPhrases.filter((phrase) => lc.includes(phrase.toLocaleLowerCase()));
        const coverage = matched.length / Math.max(1, lexTokens.length);
        const orderedPairs = lexTokens.slice(0, -1).filter((token, index) =>
          lc.includes(`${token.toLocaleLowerCase()} ${lexTokens[index + 1].toLocaleLowerCase()}`)).length;
        const score = Math.min(0.98,
          0.55 + (0.3 * coverage) + (0.08 * orderedPairs) + (0.06 * matchedPhrases.length));
        const existing = haveIds.has(segment.id)
          ? results.find((row) => row.segmentId === segment.id)
          : null;
        if (existing) {
          if (score > (Number(existing.score) || 0)) existing.score = score;
          existing._lexical = true;
        } else {
          results.push(fmt(segment, score, true));
          haveIds.add(segment.id);
        }
      }

      for (const segment of entitySegments || []) {
        const existing = haveIds.has(segment.id)
          ? results.find((row) => row.segmentId === segment.id)
          : null;
        if (existing) existing._entity = true;
        else {
          results.push({ ...fmt(segment, 0.72), _entity: true });
          haveIds.add(segment.id);
        }
      }

      return this._orderAndSlice(filterEvidenceByMetadata(results, {
        sourceKind, temporalSelector, time, memoryTypes, entities,
      }), _deliver);
    } catch (error) {
      console.error('[EvidenceRetrieval] Retrieval failed:', error);
      return [];
    }
  }

  /**
   * Hybrid retrieval: blend canonical memories + evidence
   * @param {Object} params
   * @param {string} params.query
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {number} params.memoryLimit
   * @param {number} params.evidenceLimit
   * @returns {Promise<{memories: Array, evidence: Array}>}
   */
  async retrieveHybrid({
    query, userId, orgId, memoryLimit = 5, evidenceLimit = 5,
    // Scope lens, forwarded to the evidence branch. Without these the hybrid
    // endpoint returned org-wide evidence under a personal/project lens — the
    // exact case retrieveEvidence's own scope handling exists to prevent.
    // The memory branch below is already user_id-filtered in its Qdrant filter,
    // which is narrower than a scope lens; it is left alone here deliberately
    // rather than half-converting a function its own comment calls a placeholder.
    projectId = null, accessContext = null, scopeFilter = null,
  }) {
    const [memories, evidence] = await Promise.all([
      this._retrieveCanonicalMemories({ query, userId, orgId, limit: memoryLimit }),
      this.retrieveEvidence({
        query, userId, orgId, limit: evidenceLimit,
        projectId, accessContext, scopeFilter,
      })
    ]);

    return {
      memories,
      evidence,
      mode: 'hybrid'
    };
  }

  /** Resolve an explicitly requested source without trusting a model-supplied id. */
  async resolveSourceDocuments({ userId, orgId, projectId = null, documentId = null, title = null, limit = 3 }) {
    if (orgIsRemote(orgId)) {
      // The remote list endpoint is the authoritative tenant-scoped document
      // inventory. Validate both inferred and caller-supplied source IDs against
      // it instead of declaring every valid Memory Box source nonexistent.
      // Project tags are not exposed by the current agent list contract, so a
      // project-scoped request remains fail-closed until that contract exists.
      if (projectId) return [];
      const listed = await amrKbDocs(orgId, {
        limit: 200,
        offset: 0,
        access: { userId, projectId },
      });
      return matchSourceDocuments(listed?.documents || [], { documentId, title, limit });
    }
    if (!this.db?.knowledgeDocument || (!documentId && !title)) return [];

    return this.db.knowledgeDocument.findMany({
      where: {
        ...(!projectId ? { userId } : {}),
        orgId,
        archivedAt: null,
        ...(projectId ? { tags: { has: `scope-key:project:${projectId}` } } : {}),
        ...(documentId ? { id: documentId } : {}),
        ...(!documentId && title ? {
          OR: [
            { title: { contains: title, mode: 'insensitive' } },
            { sourceId: { contains: title, mode: 'insensitive' } },
          ],
        } : {}),
      },
      select: {
        id: true,
        title: true,
        documentType: true,
        sourcePlatform: true,
        sourceUrl: true,
        documentDate: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(1, Math.min(limit, 10)),
    });
  }

  /**
   * Resolve a document mentioned in natural-language input before retrieval.
   * This is metadata-only: source eligibility never depends on vector scores or
   * an LLM extracting an English filename.
   */
  async resolveSourceFromQuery({ userId, orgId, projectId = null, query, limit = 1 }) {
    const filenameMatch = String(query || '').normalize('NFKC').match(
      /([^\n"'()[\]{}]{1,220}\.(?:pdf|docx?|xlsx?|pptx?|txt|md|html?|csv|json|png|jpe?g|webp))/i,
    );
    const filename = filenameMatch
      ? filenameMatch[1].trim().replace(/^(?:what\s+(?:exactly\s+)?does|what\s+is\s+in|tell\s+me\s+what|send|share|email|open|read)\s+/i, '')
      : null;
    const sourceMatch = filename ? 'filename' : 'metadata_tokens';
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    const tokens = [...new Set(
      [...segmenter.segment(filename || String(query || '').normalize('NFKC'))]
        .filter((part) => part.isWordLike && part.segment.length >= 3)
        .map((part) => part.segment.toLocaleLowerCase()),
    )].slice(0, 12);
    if (!tokens.length) return [];

    const score = (document) => {
      const haystack = [document.title, document.sourceId, document.filename]
        .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
      const hits = tokens.filter((token) => haystack.includes(token)).length;
      return hits / tokens.length;
    };

    if (orgIsRemote(orgId)) {
      // The remote KB listing does not yet expose enforceable project tags.
      // A requested project must therefore fail closed rather than match an
      // org-wide same-name file.
      if (projectId) return [];
      const listed = await amrKbDocs(orgId, { limit: 200, offset: 0, access: { userId, projectId } });
      return (listed?.documents || [])
        .filter((document) => !document.userId || document.userId === userId)
        .map((document) => ({ ...document, _sourceScore: score(document), _sourceMatch: sourceMatch }))
        .filter((document) => document._sourceScore >= 0.34)
        .sort((a, b) => b._sourceScore - a._sourceScore || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, Math.max(1, Math.min(limit, 3)));
    }

    if (!this.db?.knowledgeDocument) return [];
    const documents = await this.db.knowledgeDocument.findMany({
      where: {
        ...(!projectId ? { userId } : {}),
        orgId,
        archivedAt: null,
        ...(projectId ? { tags: { has: `scope-key:project:${projectId}` } } : {}),
        OR: tokens.flatMap((token) => [
          { title: { contains: token, mode: 'insensitive' } },
          { sourceId: { contains: token, mode: 'insensitive' } },
        ]),
      },
      select: {
        id: true, title: true, sourceId: true, documentType: true,
        sourcePlatform: true, sourceUrl: true, documentDate: true, updatedAt: true,
      },
      take: 30,
    });
    return documents
      .map((document) => ({ ...document, _sourceScore: score(document), _sourceMatch: sourceMatch }))
      .filter((document) => document._sourceScore >= 0.34)
      .sort((a, b) => b._sourceScore - a._sourceScore
        || new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .slice(0, Math.max(1, Math.min(limit, 3)));
  }

  /**
   * Hydrate ordered raw sections for a named source. This reads the canonical
   * document store; evidence vectors are used only to select relevant anchors.
   */
  async hydrateSourceDocuments({ documents, query, userId, orgId, perDocument = 8, total = 16 }) {
    if (orgIsRemote(orgId) || !this.db?.knowledgeSegment || !documents?.length) return [];
    const documentIds = documents.map((document) => document.id).filter(Boolean);
    const anchors = await Promise.race([
      this.retrieveEvidence({
        query,
        userId,
        orgId,
        documentIds,
        limit: Math.min(total, Math.max(documentIds.length * 3, 6)),
        scoreThreshold: 0.1,
      }),
      new Promise((resolve) => setTimeout(() => resolve([]), 450)),
    ]);
    // Group anchors per document, keeping BOTH the segment index and the
    // anchor score. A single query can match relevant passages scattered
    // across a document (e.g. a product named at segment 3 AND segment 47);
    // ranking anchors by score lets each real hit seed its own window instead
    // of collapsing to one contiguous run from the earliest index — which was
    // dropping later passages and letting a lexically-dense but off-topic
    // section (a different product) stand in for the queried one.
    const anchorsByDoc = new Map();
    for (const anchor of anchors) {
      if (!Number.isInteger(anchor?.metadata?.segmentIndex)) continue;
      const list = anchorsByDoc.get(anchor.documentId) || [];
      list.push({ index: anchor.metadata.segmentIndex, score: anchor.score ?? 0 });
      anchorsByDoc.set(anchor.documentId, list);
    }

    // Build a set of segment indexes to fetch for one document: a ±radius
    // window around each of the top-scoring anchors, merged where they
    // overlap, capped at `budget` segments. Falls back to a lead window
    // (0..budget) when the query produced no positional anchors.
    const windowIndexes = (docAnchors, budget, radius = 1) => {
      if (!docAnchors.length) {
        return Array.from({ length: budget }, (_, i) => i);
      }
      const ranked = [...docAnchors].sort((a, b) => b.score - a.score);
      const wanted = new Set();
      for (const { index } of ranked) {
        for (let i = Math.max(0, index - radius); i <= index + radius; i += 1) {
          wanted.add(i);
          if (wanted.size >= budget) break;
        }
        if (wanted.size >= budget) break;
      }
      return [...wanted].sort((a, b) => a - b);
    };

    const rows = [];
    const scoreById = new Map(anchors.map((anchor) => [anchor.segmentId, anchor.score]));
    for (const document of documents) {
      const budget = Math.max(1, Math.min(perDocument, total - rows.length));
      const indexes = windowIndexes(anchorsByDoc.get(document.id) || [], budget);
      const segments = await this.db.knowledgeSegment.findMany({
        where: {
          userId,
          orgId,
          documentId: document.id,
          document: { archivedAt: null },
          segmentIndex: { in: indexes },
        },
        orderBy: { segmentIndex: 'asc' },
        take: budget,
      });
      for (const segment of segments) {
        rows.push({
          type: 'evidence_segment',
          segmentId: segment.id,
          documentId: segment.documentId,
          title: segment.metadata?.evidence_title || evidenceTitle(document.title, segment.segmentIndex),
          citation_id: segment.metadata?.citation_id || segment.id,
          content: segment.content,
          snippet: this._extractSnippet(segment.content, query, 520),
          score: scoreById.get(segment.id) ?? null,
          document,
          metadata: {
            segmentType: segment.segmentType,
            segmentIndex: segment.segmentIndex,
            wordCount: segment.wordCount,
            startPage: segment.startPage,
            endPage: segment.endPage,
          },
        });
        if (rows.length >= total) return rows;
      }
    }
    return rows;
  }

  /**
   * Get evidence for a specific memory (citations/grounding)
   * @param {string} memoryId
   * @returns {Promise<Array>} linked evidence segments
   */
  async getMemoryEvidence(memoryId, orgId = null) {
    // ROUTED. memory_evidence_links is a CENTRAL table; for an .amr/byod org the memory and its
    // provenance live on the agent, so a central query returned [] and the FE's Evidence tab was
    // permanently empty for those tenants. The agent returns the same shape.
    if (orgId && orgIsRemote(orgId)) {
      const remote = await amrMemoryEvidence(orgId, memoryId);
      if (remote === null) {
        console.warn(`[EvidenceRetrieval] memory-evidence lane DOWN for remote org ${orgId} — `
          + `returning empty, which is NOT the same as "no evidence exists".`);
        return [];
      }
      return remote;
    }
    const links = await this.db.memoryEvidenceLink.findMany({
      where: { memoryId },
      include: {
        segment: {
          include: {
            document: {
              select: {
                id: true,
                title: true,
                documentType: true,
                sourcePlatform: true,
                sourceUrl: true,
                documentDate: true
              }
            }
          }
        },
        document: {
          select: {
            id: true,
            title: true,
            documentType: true,
            sourcePlatform: true,
            sourceUrl: true,
            documentDate: true
          }
        }
      },
      orderBy: {
        confidence: 'desc'
      }
    });

    return links.map(link => ({
      type: link.segment ? 'segment' : 'document',
      linkType: link.linkType,
      confidence: link.confidence,
      excerpt: link.excerpt,
      segment: link.segment || null,
      document: link.document || link.segment?.document || null
    }));
  }

  /**
   * Hydrate a bounded, ordered window around matched source segments.
   * This is used only by explicit full recall; matched evidence remains the
   * fallback when a remote store cannot enumerate document order.
   */
  async hydrateAdjacentEvidence({ anchors, userId, orgId, perDocument = 3, total = 12 }) {
    const matched = (anchors || []).filter((item) =>
      item?.documentId && Number.isInteger(item?.metadata?.segmentIndex));
    if (!matched.length || orgIsRemote(orgId)) return matched.slice(0, total);

    const windows = new Map();
    for (const item of matched) {
      if (windows.has(item.documentId)) continue;
      const index = item.metadata.segmentIndex;
      const before = Math.floor((perDocument - 1) / 2);
      windows.set(item.documentId, {
        gte: Math.max(0, index - before),
        lte: index + (perDocument - before - 1),
      });
    }

    const segments = await this.db.knowledgeSegment.findMany({
      where: {
        userId,
        orgId,
        OR: [...windows].map(([documentId, range]) => ({
          documentId,
          segmentIndex: range,
        })),
      },
      include: {
        document: {
          select: {
            id: true,
            title: true,
            documentType: true,
            sourcePlatform: true,
            sourceUrl: true,
            documentDate: true,
          },
        },
      },
      orderBy: [{ documentId: 'asc' }, { segmentIndex: 'asc' }],
      take: total,
    });

    const scoreByDocument = new Map(matched.map((item) => [item.documentId, item.score ?? null]));
    return segments.map((segment) => ({
      type: 'evidence_segment',
      segmentId: segment.id,
      documentId: segment.documentId,
      title: segment.metadata?.evidence_title || evidenceTitle(segment.document?.title, segment.segmentIndex),
      citation_id: segment.metadata?.citation_id || segment.id,
      content: segment.content,
      snippet: segment.content,
      score: scoreByDocument.get(segment.documentId),
      document: segment.document,
      metadata: {
        segmentType: segment.segmentType,
        segmentIndex: segment.segmentIndex,
        wordCount: segment.wordCount,
        startPage: segment.startPage,
        endPage: segment.endPage,
      },
    }));
  }

  /**
   * Get all evidence for a document
   * @param {string} documentId
   * @param {string} userId
   * @param {string} orgId
   * @returns {Promise<{document, segments, linkedMemories}>}
   */
  async getDocumentEvidence({ documentId, userId, orgId }) {
    const document = await this.db.knowledgeDocument.findUnique({
      where: { id: documentId },
      include: {
        segments: {
          orderBy: { segmentIndex: 'asc' }
        },
        memoryLinks: {
          include: {
            memory: {
              select: {
                id: true,
                title: true,
                content: true,
                memoryType: true,
                tags: true,
                createdAt: true
              }
            }
          }
        }
      }
    });

    if (!document || document.userId !== userId || document.orgId !== orgId) {
      return null;
    }

    return {
      document: {
        id: document.id,
        title: document.title,
        documentType: document.documentType,
        sourcePlatform: document.sourcePlatform,
        sourceUrl: document.sourceUrl,
        documentDate: document.documentDate,
        wordCount: document.wordCount,
        tags: document.tags
      },
      segments: document.segments.map(s => ({
        id: s.id,
        segmentType: s.segmentType,
        content: s.content,
        segmentIndex: s.segmentIndex,
        wordCount: s.wordCount,
        startPage: s.startPage,
        endPage: s.endPage
      })),
      linkedMemories: document.memoryLinks.map(link => ({
        linkType: link.linkType,
        confidence: link.confidence,
        memory: link.memory
      }))
    };
  }

  /**
   * Retrieve canonical memories (current memory graph path)
   * @private
   */
  async _retrieveCanonicalMemories({ query, userId, orgId, limit }) {
    // Delegate to existing memory retrieval (persisted-retrieval.js or graph store)
    // This is a placeholder showing the separation of concerns
    const memoryCollectionName = process.env.MEMORY_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION || 'hivemind_memories';

    try {
      const vectorResults = await this.qdrantClient.searchMemories({
        collectionName: memoryCollectionName,
        query,
        filter: {
          must: [
            { key: 'user_id', match: { value: userId } },
            { key: 'org_id', match: { value: orgId } }
          ]
        },
        limit,
        scoreThreshold: 0.5
      });

      const memoryIds = vectorResults.map(r => r.payload.memory_id).filter(Boolean);

      const memories = await this.db.memory.findMany({
        where: {
          id: { in: memoryIds },
          userId,
          orgId,
          deletedAt: null
        },
        select: {
          id: true,
          title: true,
          content: true,
          memoryType: true,
          tags: true,
          sourcePlatform: true,
          documentDate: true,
          createdAt: true,
          isLatest: true
        }
      });

      const memoryMap = new Map(memories.map(m => [m.id, m]));

      return vectorResults
        .map(vr => {
          const memory = memoryMap.get(vr.payload.memory_id);
          if (!memory) return null;
          return {
            type: 'canonical_memory',
            ...memory,
            score: vr.score
          };
        })
        .filter(Boolean);
    } catch (error) {
      console.error('[EvidenceRetrieval] Memory retrieval failed:', error);
      return [];
    }
  }

  /**
   * Extract snippet around query terms
   * @private
   */
  _extractSnippet(content, query, contextLength = 150) {
    const contentLower = content.toLowerCase();
    let index = contentLower.indexOf((query || '').toLowerCase());

    // Full query rarely appears verbatim. Center the snippet on the most
    // DISTINCTIVE query token present (longest match) so a buried matched term
    // (e.g. "1KOMMA5", "Enpal") is shown — not the segment's header prefix,
    // which hid the very evidence the answer model needs.
    if (index === -1) {
      const tokens = [...new Set(
        String(query || '').split(/[^\p{L}\p{N}§°]+/u).map(t => t.trim()).filter(t => t.length >= 3)
      )];
      let best = null;
      for (const token of tokens) {
        const needle = token.toLowerCase();
        let position = contentLower.indexOf(needle);
        while (position !== -1) {
          const start = Math.max(0, position - Math.floor(contextLength / 2));
          const window = contentLower.slice(start, Math.min(content.length, start + contextLength));
          const covered = tokens.reduce((count, item) => count + Number(window.includes(item.toLowerCase())), 0);
          const candidate = { position, covered, tokenLength: token.length };
          if (!best || candidate.covered > best.covered
            || (candidate.covered === best.covered && candidate.tokenLength > best.tokenLength)) best = candidate;
          position = contentLower.indexOf(needle, position + needle.length);
        }
      }
      index = best?.position ?? -1;
    }

    if (index === -1) {
      return content.slice(0, contextLength) + '...';
    }

    const start = Math.max(0, index - Math.floor(contextLength / 2));
    const end = Math.min(content.length, index + Math.floor(contextLength / 2));

    let snippet = content.slice(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
  }
}
