/**
 * Document-First Ingestion Service
 * Phase 1: Evidence → Structure → Canonical Memory transformation
 *
 * This service handles the new document-backed ingestion path where:
 * 1. Raw uploads become SourceArtifacts (evidence layer)
 * 2. Parsing creates KnowledgeDocuments and KnowledgeSegments (structure layer)
 * 3. Selective promotion creates canonical Memories (memory layer)
 *
 * Feature-flagged to run parallel to existing chunk-memory path.
 */

import crypto from 'crypto';

export class DocumentFirstIngestionService {
  constructor({ db, smartIngestRouter, memoryGraphEngine, doclingAdapter, embeddingService, entityExtractor = null, topicStateWriter = null, logger = console }) {
    this.db = db;
    this.smartIngestRouter = smartIngestRouter;
    this.memoryGraphEngine = memoryGraphEngine;
    this.doclingAdapter = doclingAdapter;
    this.embeddingService = embeddingService;
    this.entityExtractor = entityExtractor;
    this.topicStateWriter = topicStateWriter;
    this.logger = logger;
  }

  /** Fire-and-forget entity extraction over segments (P1 #9) */
  _extractEntitiesAsync({ segments, userId, orgId, documentId }) {
    if (!this.entityExtractor || process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return;
    (async () => {
      for (const segment of segments) {
        try {
          await this.entityExtractor.extractFromSegment({ segment, userId, orgId, documentId });
        } catch (err) {
          this.logger.warn(`[entity-extractor] segment ${segment.id} failed: ${err.message}`);
        }
      }
    })().catch(err => this.logger.warn(`[entity-extractor] batch failed: ${err.message}`));
  }

  /**
   * Ingest KB document upload into document-backed structure
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.filename
   * @param {Buffer} params.fileBuffer
   * @param {string} params.contentType
   * @param {Object} params.metadata
   * @returns {Promise<{documentId, segmentCount, candidateCount, promotedCount}>}
   */
  async ingestKnowledgeDocument({ userId, orgId, filename, fileBuffer, contentType, metadata = {} }) {
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Step 1: Store raw source artifact
    const sourceArtifact = await this.db.sourceArtifact.upsert({
      where: {
        userId_orgId_checksum_sourcePlatform: {
          userId,
          orgId,
          checksum,
          sourcePlatform: 'knowledge_upload'
        }
      },
      create: {
        userId,
        orgId,
        artifactType: 'upload',
        sourcePlatform: 'knowledge_upload',
        sourceId: filename,
        contentType,
        sizeBytes: BigInt(fileBuffer.length),
        checksum,
        storageLocation: `kb/${userId}/${checksum}/${filename}`,
        payload: { filename, uploadedAt: new Date().toISOString() },
        metadata
      },
      update: {}
    });

    // Step 2: Parse document with Docling
    const parseResult = await this._parseDocument(fileBuffer, contentType, filename);

    // Step 3: Create knowledge document
    // sourceId scoped per checksum so identical re-uploads dedupe via source_artifact
    // (checksum upsert above), while different content with same filename creates
    // a new document row.
    const knowledgeDoc = await this.db.knowledgeDocument.upsert({
      where: {
        userId_orgId_sourcePlatform_sourceId: {
          userId,
          orgId,
          sourcePlatform: 'knowledge_upload',
          sourceId: `${filename}#${checksum.slice(0, 12)}`,
        }
      },
      create: {
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: 'file',
        title: filename,
        sourcePlatform: 'knowledge_upload',
        sourceId: `${filename}#${checksum.slice(0, 12)}`,
        documentDate: new Date(),
        wordCount: parseResult.wordCount,
        parseStatus: parseResult.success ? 'parsed' : 'failed',
        parseEngine: parseResult.engine,
        parseMetadata: parseResult.metadata || {},
        structureExtracted: parseResult.success,
        tags: metadata.tags || []
      },
      update: {}
    });

    // Step 4: Create segments from parsed structure (idempotent — re-uploads
    // of identical content reuse existing segments)
    let segments = await this.db.knowledgeSegment.findMany({
      where: { documentId: knowledgeDoc.id },
      orderBy: { segmentIndex: 'asc' },
    });
    if (!segments.length) {
      segments = await this._createSegments({
        documentId: knowledgeDoc.id,
        userId,
        orgId,
        parseResult
      });
      // Step 5: Embed segments (only on first-time creation)
      await this._embedSegments(segments);
    }

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: knowledgeDoc.id });
    // Step 6: Promote candidate memories
    const promoted = await this._promoteMemories({
      documentId: knowledgeDoc.id,
      segments,
      userId,
      orgId,
      metadata
    });

    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id)
    };
  }

  /**
   * Ingest enterprise document with schema extraction
   */
  async ingestEnterpriseDocument({ userId, orgId, filename, fileBuffer, contentType, schema, metadata = {} }) {
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Step 1: Store raw artifact
    const sourceArtifact = await this.db.sourceArtifact.upsert({
      where: {
        userId_orgId_checksum_sourcePlatform: {
          userId,
          orgId,
          checksum,
          sourcePlatform: 'enterprise_upload'
        }
      },
      create: {
        userId,
        orgId,
        artifactType: 'upload',
        sourcePlatform: 'enterprise_upload',
        sourceId: filename,
        contentType,
        sizeBytes: BigInt(fileBuffer.length),
        checksum,
        storageLocation: `enterprise/${userId}/${checksum}/${filename}`,
        payload: { filename, schema, uploadedAt: new Date().toISOString() },
        metadata
      },
      update: {}
    });

    // Step 2: Parse with Docling
    const parseResult = await this._parseDocument(fileBuffer, contentType, filename);

    // Step 3: Create parent knowledge document
    const parentDoc = await this.db.knowledgeDocument.create({
      data: {
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: schema?.documentType || 'enterprise_document',
        title: schema?.title || filename,
        sourcePlatform: 'enterprise_upload',
        sourceId: filename,
        documentDate: new Date(),
        wordCount: parseResult.wordCount,
        parseStatus: parseResult.success ? 'parsed' : 'failed',
        parseEngine: parseResult.engine,
        parseMetadata: { ...parseResult.metadata, schema },
        structureExtracted: parseResult.success,
        tags: metadata.tags || []
      }
    });

    // Step 4: Create schema-aware segments
    const segments = await this._createEnterpriseSegments({
      documentId: parentDoc.id,
      userId,
      orgId,
      schema,
      parseResult
    });

    // Step 5: Embed segments
    await this._embedSegments(segments);

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: parentDoc.id });
    // Step 6: Promote canonical memories (more selective for enterprise)
    const promoted = await this._promoteMemories({
      documentId: parentDoc.id,
      segments,
      userId,
      orgId,
      metadata,
      promotionStrategy: 'enterprise_selective'
    });

    return {
      documentId: parentDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id)
    };
  }

  /**
   * Ingest a connector record (Slack message, Notion page, GitHub issue, etc.)
   * Text already extracted by adapter — no Docling needed. Creates
   * source_artifact + knowledge_document + 1+ knowledge_segments + memories
   * with full evidence-layer provenance.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.providerKey - slack | notion | github | linear | jira | confluence
   * @param {string} params.sourceId - provider's own ID (channel-ts, page_id, issue_id, ...)
   * @param {string} params.title
   * @param {string} params.content - full text body
   * @param {string} [params.sourceUrl]
   * @param {Date} [params.documentDate]
   * @param {Object} [params.metadata]
   */
  async ingestConnectorRecord({ userId, orgId, providerKey, sourceId, title, content, sourceUrl = null, documentDate = null, metadata = {} }) {
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return { skipped: true, reason: 'empty_content' };
    }
    const checksum = crypto.createHash('sha256').update(`${providerKey}:${sourceId}:${content}`).digest('hex');

    // Step 1: source artifact (immutable evidence)
    const sourceArtifact = await this.db.sourceArtifact.upsert({
      where: {
        userId_orgId_checksum_sourcePlatform: {
          userId, orgId, checksum, sourcePlatform: providerKey,
        },
      },
      create: {
        userId, orgId,
        artifactType: 'connector_record',
        sourcePlatform: providerKey,
        sourceId,
        contentType: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength(content, 'utf8')),
        checksum,
        storageLocation: `connector/${providerKey}/${userId}/${sourceId}`,
        payload: { title, content, sourceUrl, ...metadata },
        metadata,
      },
      update: {},
    });

    // Step 2: knowledge_document
    const knowledgeDoc = await this.db.knowledgeDocument.create({
      data: {
        userId, orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: 'connector_record',
        title: title || `${providerKey}:${sourceId}`,
        sourcePlatform: providerKey,
        sourceId,
        sourceUrl,
        documentDate: documentDate || new Date(),
        wordCount: content.split(/\s+/).filter(Boolean).length,
        parseStatus: 'parsed',
        parseEngine: 'connector-native',
        parseMetadata: {},
        structureExtracted: true,
        tags: metadata.tags || [],
      },
    });

    // Step 3: single segment (whole record body) — adapter could split later
    const segment = await this.db.knowledgeSegment.create({
      data: {
        userId, orgId,
        documentId: knowledgeDoc.id,
        segmentType: 'chunk',
        segmentIndex: 0,
        content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        startPage: null, endPage: null,
        metadata: { providerKey, sourceId },
      },
    });
    const segments = [segment];

    // Step 4: embed segment
    await this._embedSegments(segments);

    this._extractEntitiesAsync({ segments, userId, orgId, documentId: knowledgeDoc.id });
    // Step 5: promote memories
    const promoted = await this._promoteMemories({
      documentId: knowledgeDoc.id,
      segments,
      userId, orgId,
      metadata,
      promotionStrategy: `connector_${providerKey}`,
    });

    return {
      documentId: knowledgeDoc.id,
      segmentCount: segments.length,
      candidateCount: promoted.candidates.length,
      promotedCount: promoted.memories.length,
      promotedMemoryIds: promoted.memories.map(m => m.id).filter(Boolean),
    };
  }

  /**
   * Parse document with Docling (or fallback parsers)
   * @private
   */
  async _parseDocument(fileBuffer, contentType, filename) {
    try {
      if (this.doclingAdapter && process.env.DOCLING_URL) {
        const doclingResult = await this.doclingAdapter.parseBuffer(fileBuffer, {
          filename,
          contentType
        });

        if (doclingResult && !doclingResult.error) {
          return {
            success: true,
            engine: 'docling',
            text: doclingResult.text,
            markdown: doclingResult.markdown,
            structure: doclingResult.json,
            tables: doclingResult.tables || [],
            pages: doclingResult.pages || [],
            wordCount: (doclingResult.text || '').split(/\s+/).length,
            metadata: {
              confidence: doclingResult.confidence,
              pages: doclingResult.pages?.length,
              hybridChunks: Array.isArray(doclingResult.hybridChunks) ? doclingResult.hybridChunks : [],
              chunkerError: doclingResult.chunkerError || null,
            }
          };
        }
      }

      // Fallback to existing parsers
      return {
        success: true,
        engine: 'fallback',
        text: fileBuffer.toString('utf-8'),
        wordCount: fileBuffer.toString('utf-8').split(/\s+/).length,
        metadata: {}
      };
    } catch (error) {
      console.error('[DocumentFirstIngestion] Parse failed:', error);
      return {
        success: false,
        engine: 'none',
        error: error.message,
        wordCount: 0,
        metadata: {}
      };
    }
  }

  /**
   * Create knowledge segments from parse result.
   * Preferred path: Docling hybrid chunker (structure-aware: respects
   * headings, paragraphs, tables). Fallback: sliding window.
   * @private
   */
  async _createSegments({ documentId, userId, orgId, parseResult }) {
    if (!parseResult.success || !parseResult.text) {
      return [];
    }
    // Try structure-aware chunks first (provided by parseResult.metadata.hybridChunks)
    const hybridChunks = parseResult?.metadata?.hybridChunks;
    console.log(`[segments] hybridChunks=${Array.isArray(hybridChunks) ? hybridChunks.length : 'none'} for doc ${documentId}`);
    if (Array.isArray(hybridChunks) && hybridChunks.length > 0) {
      const segments = [];
      let segmentIndex = 0;
      let previousSegmentId = null;
      for (const hc of hybridChunks) {
        const text = String(hc.text || '').trim();
        if (text.length < 20) continue;
        const contentHash = crypto.createHash('sha256').update(text).digest('hex');
        const heading = Array.isArray(hc.headings) && hc.headings.length
          ? hc.headings.join(' › ').slice(0, 500) : null;
        try {
          const segment = await this.db.knowledgeSegment.create({
            data: {
              documentId, userId, orgId,
              segmentType: 'structured',
              content: text,
              contentHash,
              segmentIndex,
              previousSegmentId,
              depth: Array.isArray(hc.headings) ? hc.headings.length : 0,
              startOffset: null, endOffset: null,
              wordCount: text.split(/\s+/).length,
              metadata: { heading, page: hc.page || null, source: 'docling_hybrid' },
            },
          });
          segments.push(segment);
          previousSegmentId = segment.id;
          segmentIndex++;
        } catch (err) {
          console.warn(`[segments] hybrid chunk insert failed: ${err.message}`);
        }
      }
      if (segments.length) return segments;
    }

    // Fallback: sliding window chunking
    const segments = [];
    const text = parseResult.text;
    const chunkSize = 1000;
    const overlap = 200;

    let segmentIndex = 0;
    let previousSegmentId = null;

    for (let i = 0; i < text.length; i += (chunkSize - overlap)) {
      const chunk = text.slice(i, i + chunkSize);
      if (chunk.trim().length === 0) continue;

      const contentHash = crypto.createHash('sha256').update(chunk).digest('hex');

      const segment = await this.db.knowledgeSegment.create({
        data: {
          documentId,
          userId,
          orgId,
          segmentType: 'chunk',
          content: chunk,
          contentHash,
          segmentIndex,
          previousSegmentId,
          depth: 0,
          startOffset: i,
          endOffset: Math.min(i + chunkSize, text.length),
          wordCount: chunk.split(/\s+/).length,
          metadata: {}
        }
      });

      segments.push(segment);
      previousSegmentId = segment.id;
      segmentIndex++;
    }

    return segments;
  }

  /**
   * Create enterprise schema-aware segments
   * @private
   */
  async _createEnterpriseSegments({ documentId, userId, orgId, schema, parseResult }) {
    // For now, use same chunking as KB
    // Future: use schema.fields to create structured segments
    return this._createSegments({ documentId, userId, orgId, parseResult });
  }

  /**
   * Embed segments into evidence vector collection
   * @private
   */
  async _embedSegments(segments) {
    if (!this.embeddingService) return;

    const collectionName = process.env.EVIDENCE_QDRANT_COLLECTION || 'hivemind_evidence';

    for (const segment of segments) {
      try {
        const embedding = await this.embeddingService.embed(segment.content);

        // Store in Qdrant evidence collection (separate from memory collection)
        await this.embeddingService.storeVector({
          collectionName,
          id: segment.id,
          vector: embedding,
          payload: {
            segment_id: segment.id,
            document_id: segment.documentId,
            user_id: segment.userId,
            org_id: segment.orgId,
            segment_type: segment.segmentType,
            content_preview: segment.content.slice(0, 200)
          }
        });

        await this.db.knowledgeSegment.update({
          where: { id: segment.id },
          data: { vectorStored: true }
        });
      } catch (error) {
        console.error(`[DocumentFirstIngestion] Failed to embed segment ${segment.id}:`, error);
      }
    }
  }

  /**
   * Promote candidate memories from segments
   * Selective: only segments that represent reusable organizational truths
   * @private
   */
  async _promoteMemories({ documentId, segments, userId, orgId, metadata, promotionStrategy = 'kb_default' }) {
    const candidates = [];
    const memories = [];

    // Strategy: promote only first and last segments as memories for now
    // Future: use LLM to identify candidate memories, fact extraction, entity-centric promotion
    const promotableSegments = [segments[0], segments[segments.length - 1]].filter(Boolean);

    for (const segment of promotableSegments) {
      candidates.push({
        segmentId: segment.id,
        content: segment.content,
        reason: 'boundary_segment'
      });

      try {
        // Route through SmartIngestRouter for deterministic edges
        const payload = {
          userId,
          orgId,
          user_id: userId,
          org_id: orgId,
          scope: Array.isArray(metadata.project_ids) && metadata.project_ids.length > 0
            ? 'project'
            : metadata.primary_team_id ? 'team' : undefined,
          primary_team_id: metadata.primary_team_id || null,
          project_ids: Array.isArray(metadata.project_ids) ? metadata.project_ids : [],
          content: segment.content,
          title: segment.metadata?.heading
            ? String(segment.metadata.heading).slice(0, 200)
            : `Extracted from ${documentId.slice(0, 8)}`,
          source_type: 'knowledge_segment',
          source_metadata: {
            segment_id: segment.id,
            document_id: documentId,
            heading: segment.metadata?.heading || null,
            page: segment.metadata?.page || null,
          },
          tags: [
            ...(metadata.tags || []),
            'promoted-from-segment',
            ...(segment.metadata?.heading
              ? [`heading:${String(segment.metadata.heading).toLowerCase().replace(/\s+/g, '-').slice(0, 50)}`]
              : []),
            ...(segment.metadata?.page ? [`page:${segment.metadata.page}`] : []),
          ],
          skip_fact_extraction: false, // Enable fact extraction for promoted memories
          documentDate: new Date(),
          metadata: {
            ...(metadata || {}),
            project_id: Array.isArray(metadata.project_ids) && metadata.project_ids.length === 1
              ? metadata.project_ids[0]
              : metadata.project_id || null,
          }
        };

        const routedPayloads = await this.smartIngestRouter.route(payload);

        for (const routed of routedPayloads) {
          const result = await this.memoryGraphEngine.ingestMemory(routed);
          // graph-engine returns { memoryId, operation, ... }
          // operation = 'skipped_*' means memory NOT persisted to DB -> FK would fail
          const memoryId = result?.memoryId || result?.id || null;
          const persisted = memoryId && !(result?.operation || '').startsWith('skipped');
          if (!persisted) {
            memories.push(result);
            continue;
          }
          // Defense-in-depth: verify row actually exists before FK insert
          const exists = await this.db.memory.findUnique({ where: { id: memoryId }, select: { id: true } });
          if (!exists) {
            memories.push(result);
            continue;
          }
          memories.push({ ...result, id: memoryId });

          // Link memory to evidence
          await this.db.memoryEvidenceLink.create({
            data: {
              memoryId,
              segmentId: segment.id,
              documentId,
              linkType: 'supports',
              confidence: 0.9,
              excerpt: segment.content.slice(0, 500)
            }
          });

          // Record derivation
          await this.db.memoryDerivation.create({
            data: {
              memoryId,
              derivationMethod: 'promoted_from_segment',
              derivationAgent: 'document_first_ingestion_v1',
              confidence: 0.8,
              metadata: {
                segment_id: segment.id,
                document_id: documentId,
                promotion_strategy: promotionStrategy
              }
            }
          });

          // P1 #12 — entity-aware memory linking
          // Mirror segment's entity_mentions onto the promoted memory so
          // memory recall can filter/rank by entity.
          this._linkEntitiesToMemoryAsync({
            memoryId, segmentId: segment.id, orgId, documentId, memoryContent: segment.content,
          });
        }
      } catch (error) {
        console.error(`[DocumentFirstIngestion] Failed to promote segment ${segment.id}:`, error);
      }
    }

    return { candidates, memories };
  }

  /** Fire-and-forget: copy segment's entity mentions onto memory + update topic state. */
  _linkEntitiesToMemoryAsync({ memoryId, segmentId, orgId, documentId, memoryContent }) {
    if (process.env.ENABLE_ENTITY_EXTRACTION !== 'true') return;
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const segMentions = await this.db.entityMention.findMany({
          where: { segmentId },
          select: { entityId: true, mentionText: true, confidence: true, context: true },
        });
        if (!segMentions.length) return;
        await this.db.entityMention.createMany({
          data: segMentions.map(m => ({
            entityId: m.entityId,
            memoryId,
            mentionText: m.mentionText,
            confidence: m.confidence,
            context: m.context,
          })),
          skipDuplicates: true,
        });

        // Auto-tag the memory with entity tags for fast filtered recall
        try {
          const entityIds = [...new Set(segMentions.map(m => m.entityId))];
          const entitiesForTags = await this.db.entity.findMany({
            where: { id: { in: entityIds } },
            select: { canonicalName: true, entityType: true },
          });
          const newTags = entitiesForTags
            .map(e => `${e.entityType}:${e.canonicalName.toLowerCase().replace(/\s+/g, '-').slice(0, 80)}`)
            .slice(0, 25);
          if (newTags.length) {
            const existing = await this.db.memory.findUnique({
              where: { id: memoryId },
              select: { tags: true },
            });
            if (existing) {
              const merged = Array.from(new Set([...(existing.tags || []), ...newTags])).slice(0, 80);
              await this.db.memory.update({
                where: { id: memoryId },
                data: { tags: merged },
              });
            }
          }
        } catch (tagErr) {
          this.logger.warn?.(`[entity-memory-tags] ${memoryId}: ${tagErr.message}`);
        }

        // P1 #11 — update rolling topic state per linked entity
        if (this.topicStateWriter && process.env.ENABLE_TOPIC_STATE === 'true') {
          for (const m of segMentions) {
            this.topicStateWriter.recordMemoryForEntity({
              orgId,
              entityId: m.entityId,
              memoryId,
              documentId,
              memoryContent,
            }).catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn(`[entity-memory-link] memory ${memoryId} failed: ${err.message}`);
      }
    })();
  }
}
