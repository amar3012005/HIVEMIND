/**
 * Evidence Retrieval Service
 * Phase 1: Separate evidence/citation retrieval from canonical memory recall
 *
 * Provides dual retrieval modes:
 * - Memory mode: canonical organizational truths (current default)
 * - Evidence mode: supporting documents and segments for grounding/citations
 * - Hybrid mode: blends both with ranked results
 */

import { resolveCollection, PER_TENANT } from '../vector/container-router.js';

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
      ? resolveCollection({ orgId })
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
      
      const results = vectorResults
        .map(vr => {
          const segment = segmentMap.get(vr.payload.segment_id);
          if (!segment) return null;

          return {
            type: 'evidence_segment',
            segmentId: segment.id,
            documentId: segment.documentId,
            content: segment.content,
            snippet: this._extractSnippet(segment.content, query),
            score: vr.score,
            document: segment.document,
            metadata: {
              segmentType: segment.segmentType,
              segmentIndex: segment.segmentIndex,
              wordCount: segment.wordCount,
              startPage: segment.startPage,
              endPage: segment.endPage
            }
          };
        })
        .filter(Boolean)
        .slice(0, limit);

      return results;
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
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    const index = contentLower.indexOf(queryLower);

    if (index === -1) {
      return content.slice(0, contextLength) + '...';
    }

    const start = Math.max(0, index - contextLength / 2);
    const end = Math.min(content.length, index + query.length + contextLength / 2);

    let snippet = content.slice(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';

    return snippet;
  }
}
