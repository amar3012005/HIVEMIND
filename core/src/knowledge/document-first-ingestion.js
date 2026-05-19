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
  constructor({ db, smartIngestRouter, memoryGraphEngine, doclingAdapter, embeddingService }) {
    this.db = db;
    this.smartIngestRouter = smartIngestRouter;
    this.memoryGraphEngine = memoryGraphEngine;
    this.doclingAdapter = doclingAdapter;
    this.embeddingService = embeddingService;
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
    const knowledgeDoc = await this.db.knowledgeDocument.create({
      data: {
        userId,
        orgId,
        sourceArtifactId: sourceArtifact.id,
        documentType: 'file',
        title: filename,
        sourcePlatform: 'knowledge_upload',
        sourceId: filename,
        documentDate: new Date(),
        wordCount: parseResult.wordCount,
        parseStatus: parseResult.success ? 'parsed' : 'failed',
        parseEngine: parseResult.engine,
        parseMetadata: parseResult.metadata || {},
        structureExtracted: parseResult.success,
        tags: metadata.tags || []
      }
    });

    // Step 4: Create segments from parsed structure
    const segments = await this._createSegments({
      documentId: knowledgeDoc.id,
      userId,
      orgId,
      parseResult
    });

    // Step 5: Embed segments
    await this._embedSegments(segments);

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
              pages: doclingResult.pages?.length
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
   * Create knowledge segments from parse result
   * @private
   */
  async _createSegments({ documentId, userId, orgId, parseResult }) {
    if (!parseResult.success || !parseResult.text) {
      return [];
    }

    const segments = [];
    const text = parseResult.text;
    const chunkSize = 1000;
    const overlap = 200;

    let segmentIndex = 0;
    let previousSegmentId = null;

    // Simple chunking with overlap
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
          content: segment.content,
          title: `Extracted from ${documentId.slice(0, 8)}`,
          source_type: 'knowledge_segment',
          source_metadata: {
            segment_id: segment.id,
            document_id: documentId
          },
          tags: [...(metadata.tags || []), 'promoted-from-segment'],
          skip_fact_extraction: false, // Enable fact extraction for promoted memories
          documentDate: new Date()
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
        }
      } catch (error) {
        console.error(`[DocumentFirstIngestion] Failed to promote segment ${segment.id}:`, error);
      }
    }

    return { candidates, memories };
  }
}
