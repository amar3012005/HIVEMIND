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
import { orgIsRemote, amrKbRecall, amrKbHydrate } from '../vector/mneme/driver.js';

export class EvidenceRetrievalService {
  constructor({ db, qdrantClient }) {
    this.db = db;
    this.qdrantClient = qdrantClient;
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
    documentId = null,        // legacy single-doc filter (kept for backwards compat)
    documentIds = null,       // NEW: multi-doc filter — used by RecallRouter for tag-anchored evidence
    scoreThreshold = null,    // override default 0.5; lower for doc-filtered search where we want most chunks
  }) {
    // Per-tenant: evidence lives in the org container (layer=evidence). Legacy:
    // a dedicated hivemind_evidence collection. Must mirror _embedSegments.
    const collectionName = PER_TENANT
      ? await resolveCollectionForOrg(orgId)
      : (process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence');
    const docIdSet = Array.isArray(documentIds) && documentIds.length
      ? [...new Set(documentIds.filter(Boolean))]
      : (documentId ? [documentId] : null);

    // When a doc is selected, lower threshold so we actually return its
    // segments (Qdrant cosine on filename-style queries can score below 0.5).
    const effectiveThreshold = scoreThreshold != null
      ? scoreThreshold
      : (docIdSet ? 0.2 : 0.5);

    try {
      // Remote (self-host) orgs: KB evidence lives on the agent — no central Qdrant or DB access.
      if (orgIsRemote(orgId)) {
        const queryVector = await this.qdrantClient.generateEmbedding(query);
        if (!queryVector) return [];
        // amrKbRecall returns [{segment_id, document_id, content, score}]
        const hits = await amrKbRecall(orgId, queryVector, {
          limit: limit * 2,
          documentId: docIdSet && docIdSet.length === 1 ? docIdSet[0] : undefined,
          scoreThreshold: effectiveThreshold,
        });
        if (!hits || !hits.length) return [];
        const hydrated = await amrKbHydrate(orgId, hits.map((h) => h.segment_id));
        // Build a score lookup from the recall hits.
        const scoreMap = new Map(hits.map((h) => [h.segment_id, h.score]));
        const hydrateMap = new Map((hydrated || []).map((s) => [s.id, s]));
        const remoteResults = hits
          .map((h) => {
            const s = hydrateMap.get(h.segment_id);
            if (!s) return null;
            // Filter by docIdSet when multiple docs requested (agent-side only filtered single-doc).
            if (docIdSet && docIdSet.length > 1 && !docIdSet.includes(s.document_id)) return null;
            const score = scoreMap.get(h.segment_id) ?? h.score;
            return {
              type: 'evidence_segment',
              segmentId: s.id,
              documentId: s.document_id,
              content: s.content,
              snippet: this._extractSnippet(s.content, query),
              score,
              document: { id: s.document_id },
              metadata: {
                segmentType: s.segment_type,
                segmentIndex: s.segment_index,
                wordCount: null,
                startPage: null,
                endPage: null,
              },
            };
          })
          .filter(Boolean);
        return remoteResults.sort((a, b) => b.score - a.score).slice(0, limit);
      }

      // Step 1: Vector search in evidence collection.
      // Multi-doc filter uses Qdrant's `match.any` array, single uses
      // `match.value`. Falls back to no doc filter when docIdSet null.
      const docFilter = (() => {
        if (!docIdSet) return [];
        if (docIdSet.length === 1) return [{ key: 'document_id', match: { value: docIdSet[0] } }];
        return [{ key: 'document_id', match: { any: docIdSet } }];
      })();

      const vectorResults = await this.qdrantClient.searchMemories({
        collectionName,
        query,
        filter: {
          must: [
            { key: 'user_id', match: { value: userId } },
            { key: 'org_id', match: { value: orgId } },
            ...docFilter,
          ]
        },
        limit: limit * 2, // Over-fetch for reranking
        // searchMemories destructures `score_threshold` (snake) — passing
        // camelCase silently dropped the computed threshold (fell back to 0.15).
        score_threshold: effectiveThreshold,
        // Per-tenant: constrain to evidence layer within the shared org container.
        layer: PER_TENANT ? 'evidence' : undefined,
      });

      // Step 2: Hydrate segments from DB
      const segmentIds = vectorResults.map(r => r.payload.segment_id).filter(Boolean);
      
      const segments = await this.db.knowledgeSegment.findMany({
        where: {
          id: { in: segmentIds },
          userId,
          orgId
        },
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
      });

      // Step 3: Merge with vector scores and format
      const segmentMap = new Map(segments.map(s => [s.id, s]));
      
      const fmt = (segment, score, lexical = false) => ({
        type: 'evidence_segment',
        segmentId: segment.id,
        documentId: segment.documentId,
        content: segment.content,
        snippet: this._extractSnippet(segment.content, query),
        score,
        ...(lexical ? { _lexical: true } : {}),
        document: segment.document,
        metadata: {
          segmentType: segment.segmentType,
          segmentIndex: segment.segmentIndex,
          wordCount: segment.wordCount,
          startPage: segment.startPage,
          endPage: segment.endPage,
        },
      });

      const results = vectorResults
        .map(vr => {
          const segment = segmentMap.get(vr.payload.segment_id);
          return segment ? fmt(segment, vr.score) : null;
        })
        .filter(Boolean);
      const haveIds = new Set(results.map(r => r.segmentId));

      // LEXICAL FALLBACK — vector recall scores a segment by its DOMINANT topic,
      // so a literal term buried mid-segment (a proper name / model code in a
      // footnote or dense paragraph — e.g. "1KOMMA5", "Enpal", "§14a") never
      // surfaces when the segment is semantically about something else. When the
      // vector pass is sparse, run an additive keyword pass over the segment text
      // for the query's DISTINCTIVE tokens (capitalized words, codes, numbers —
      // not generic lowercase fillers). Tenant-/language-agnostic: no hardcoded
      // terms. This guarantees exact-string hits the embedding cannot rank.
      // ALWAYS additive (not only when vector is sparse): the buried term lives
      // in a segment whose dominant topic differs, so vector recall happily fills
      // its slots with OTHER segments — the count is fine, the right segment is
      // just missing. Lexical hits merge in, get re-ranked, and slice keeps top-N.
      {
        const lexTokens = [...new Set(
          String(query || '')
            .split(/[^\p{L}\p{N}§°]+/u)
            .map(t => t.trim())
            .filter(t => t.length >= 4 && (/[0-9§°]/.test(t) || /^[A-ZÄÖÜ]/.test(t)))
        )].slice(0, 8);
        if (lexTokens.length) {
          try {
            // Scope the lexical pass to the SAME docs as the vector pass when a
            // doc set is given (HOP2 passes the query's accessible/anchored docs).
            // Going broader leaked cross-doc hits (a competitor named in ANOTHER
            // document surfaced in a project answer). Bounded by userId+orgId
            // always; by docIdSet when the caller scoped to specific docs.
            const lexSegments = await this.db.knowledgeSegment.findMany({
              where: {
                userId,
                orgId,
                ...(docIdSet ? { documentId: { in: docIdSet } } : {}),
                OR: lexTokens.map(t => ({ content: { contains: t, mode: 'insensitive' } })),
              },
              include: {
                document: { select: { id: true, title: true, documentType: true, sourcePlatform: true, sourceUrl: true, documentDate: true } },
              },
              take: limit * 2,
            });
            for (const segment of lexSegments) {
              if (haveIds.has(segment.id)) continue;
              // Score by DISTINCT query-token overlap: a segment containing more
              // of the query's distinctive tokens (e.g. both "1KOMMA5" AND "Enpal")
              // is a stronger literal match → must outrank doc-scoped vector hits
              // and survive the top-N slice. 1 token ≈ 0.6, scaling up to ~0.9.
              const lc = String(segment.content || '').toLowerCase();
              const matches = lexTokens.filter((t) => lc.includes(t.toLowerCase())).length;
              results.push(fmt(segment, Math.min(0.9, 0.55 + 0.13 * matches), true));
              haveIds.add(segment.id);
            }
          } catch (lexErr) {
            console.warn('[EvidenceRetrieval] lexical fallback failed:', lexErr.message);
          }
        }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, limit);
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
  async retrieveHybrid({ query, userId, orgId, memoryLimit = 5, evidenceLimit = 5 }) {
    const [memories, evidence] = await Promise.all([
      this._retrieveCanonicalMemories({ query, userId, orgId, limit: memoryLimit }),
      this.retrieveEvidence({ query, userId, orgId, limit: evidenceLimit })
    ]);

    return {
      memories,
      evidence,
      mode: 'hybrid'
    };
  }

  /** Resolve an explicitly requested source without trusting a model-supplied id. */
  async resolveSourceDocuments({ userId, orgId, documentId = null, title = null, limit = 3 }) {
    if (orgIsRemote(orgId)) return [];
    if (!this.db?.knowledgeDocument || (!documentId && !title)) return [];

    return this.db.knowledgeDocument.findMany({
      where: {
        userId,
        orgId,
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
   * Hydrate ordered raw sections for a named source. This reads the canonical
   * document store; evidence vectors are used only to select relevant anchors.
   */
  async hydrateSourceDocuments({ documents, query, userId, orgId, perDocument = 8, total = 16 }) {
    if (orgIsRemote(orgId) || !this.db?.knowledgeSegment || !documents?.length) return [];
    const documentIds = documents.map((document) => document.id).filter(Boolean);
    const anchors = await this.retrieveEvidence({
      query,
      userId,
      orgId,
      documentIds,
      limit: Math.min(total, Math.max(documentIds.length * 3, 6)),
      scoreThreshold: 0.1,
    });
    const anchorIndexes = new Map();
    for (const anchor of anchors) {
      if (!Number.isInteger(anchor?.metadata?.segmentIndex)) continue;
      const indexes = anchorIndexes.get(anchor.documentId) || [];
      indexes.push(anchor.metadata.segmentIndex);
      anchorIndexes.set(anchor.documentId, indexes);
    }

    const rows = [];
    for (const document of documents) {
      const indexes = anchorIndexes.get(document.id) || [];
      const center = indexes.length ? Math.min(...indexes) : 0;
      const start = Math.max(0, center - 1);
      const segments = await this.db.knowledgeSegment.findMany({
        where: {
          userId,
          orgId,
          documentId: document.id,
          segmentIndex: { gte: start },
        },
        orderBy: { segmentIndex: 'asc' },
        take: Math.max(1, Math.min(perDocument, total - rows.length)),
      });
      const scoreById = new Map(anchors.map((anchor) => [anchor.segmentId, anchor.score]));
      for (const segment of segments) {
        rows.push({
          type: 'evidence_segment',
          segmentId: segment.id,
          documentId: segment.documentId,
          content: segment.content,
          snippet: segment.content,
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
  async getMemoryEvidence(memoryId) {
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
      )].sort((a, b) => b.length - a.length);
      for (const t of tokens) {
        const i = contentLower.indexOf(t.toLowerCase());
        if (i !== -1) { index = i; break; }
      }
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
