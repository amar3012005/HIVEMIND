const EventEmitter = require('events');
const { STAGES } = require('./constants');
const { extractBySourceType } = require('./extractors');
const { chunkTextDocument, splitConversationTurns, tokenizeApprox } = require('./chunkers/text-chunker');
const { chunkCodeAST } = require('./chunkers/ast-chunker');
const { embedChunks } = require('./embedder');
const { indexEmbeddedChunks } = require('./indexer');
const { IngestionAuditLogger } = require('./audit-logger');

// Minimal bounded LRU+TTL cache for same-process idempotency dedup.
// BullMQ jobId already handles cross-process dedup; this is only a
// within-process retry guard, so a short TTL is intentionally safe.
// Max 500 entries, 1-hour TTL. Oldest entry evicted on overflow.
class BoundedTtlCache {
  constructor({ max = 500, ttlMs = 60 * 60 * 1000 } = {}) {
    this._max = max;
    this._ttlMs = ttlMs;
    // Insertion-order map: key → { value, expiresAt }
    this._map = new Map();
  }

  _isExpired(entry) {
    return Date.now() > entry.expiresAt;
  }

  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    // Evict expired entries lazily, then evict oldest if still over cap.
    if (this._map.has(key)) {
      this._map.delete(key); // remove so re-insertion refreshes order
    }
    if (this._map.size >= this._max) {
      // Map iterates insertion order — first key is oldest.
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    this._map.set(key, { value, expiresAt: Date.now() + this._ttlMs });
  }
}

function toChunkObjects(chunks, pageNumber = 1) {
  return chunks.map((chunk, index) => {
    if (typeof chunk === 'string') {
      return {
        chunk_index: index,
        content: chunk,
        token_count: tokenizeApprox(chunk).length,
        metadata: { page_number: pageNumber },
      };
    }

    return {
      chunk_index: chunk.chunk_index ?? index,
      content: chunk.content,
      token_count: chunk.token_count ?? tokenizeApprox(chunk.content).length,
      scope_chain: chunk.scope_chain,
      metadata: {
        page_number: pageNumber,
        ...(chunk.metadata || {}),
      },
    };
  });
}

// Structure-aware split. When the extractor (Docling or any structural
// parser) returns pre-computed chunks with headings, use those as the
// primary unit — the chunker then only enforces a token cap per chunk,
// preserving heading hierarchy. Yields hierarchical retrieval wins
// without re-implementing structural detection.
function chunkFromStructuralChunks(structuralChunks) {
  const out = [];
  let idx = 0;
  for (const sc of structuralChunks) {
    const content = String(sc.text || sc.content || '').trim();
    if (!content) continue;
    const tokens = tokenizeApprox(content);
    if (tokens.length === 0) continue;
    // If single section fits inside the embedder ceiling (≈ 512 tokens),
    // keep it whole — preserves heading context.
    const STRUCT_CAP = 512;
    if (tokens.length <= STRUCT_CAP) {
      out.push({
        chunk_index: idx++,
        content,
        token_count: tokens.length,
        metadata: {
          chunk_strategy: 'docling-hybrid',
          page_number: sc.page || sc.page_number || 1,
          headings: Array.isArray(sc.headings) ? sc.headings : [],
          structural_unit: true,
        },
      });
      continue;
    }
    // Section too long — fall back to sliding-window WITHIN this section,
    // keep the heading attached to each sub-chunk.
    const subChunks = chunkTextDocument({ content, title: (sc.headings || []).join(' / ') });
    for (const sub of subChunks) {
      out.push({
        chunk_index: idx++,
        content: sub.content,
        token_count: sub.token_count,
        metadata: {
          ...(sub.metadata || {}),
          chunk_strategy: 'docling-hybrid-sliced',
          page_number: sc.page || sc.page_number || 1,
          headings: Array.isArray(sc.headings) ? sc.headings : [],
          structural_unit: false,
        },
      });
    }
  }
  return out;
}

function chunkBySource(sourceType, extracted) {
  // Structural chunks short-circuit: when extractor surfaces Docling hybrid
  // output (or any heading-aware splitter) we use those directly. This
  // bypasses sliding-window for the common-case "well-structured doc" and
  // dramatically improves recall@5 per the 2026 hierarchical-chunking
  // benchmark (84-89% vs 71-74% for flat fixed-size).
  if (Array.isArray(extracted?.structural_chunks) && extracted.structural_chunks.length > 0) {
    return chunkFromStructuralChunks(extracted.structural_chunks);
  }

  if (sourceType === 'conversation') {
    const chunks = splitConversationTurns(extracted).map((chunk, index) => ({
      chunk_index: index,
      content: chunk.content,
      token_count: tokenizeApprox(chunk.content).length,
      metadata: {
        ...chunk.metadata,
        page_number: 1,
        chunk_strategy: 'conversation-turn',
      },
    }));

    return chunks;
  }

  if (sourceType === 'code') {
    return toChunkObjects(chunkCodeAST(extracted.content), 1);
  }

  if (sourceType === 'pdf') {
    // Merge all pages into a single text body before chunking so sliding
    // windows span page boundaries. Cross-page sentences and references
    // (e.g. a clause on page 3 citing a heading on page 2) retain context.
    // Page numbers are still recoverable per chunk by mapping cumulative
    // character offsets back to each page's range.
    const pages = Array.isArray(extracted.pages) ? extracted.pages : [];
    if (pages.length === 0) {
      return toChunkObjects(chunkTextDocument(extracted), 1);
    }

    // Build merged content + page-word-ranges in the SAME token space the
    // chunker uses (split on /\s+/). This lets us map each chunk's
    // token_start (returned by chunkTokens) directly to a page number,
    // avoiding fragile char-offset heuristics.
    const PAGE_SEPARATOR = '\n\n';
    const pageWordRanges = [];
    let wordCursor = 0;
    const mergedParts = [];
    for (const page of pages) {
      const content = String(page.content || '');
      const wordCount = tokenizeApprox(content).length;
      pageWordRanges.push({
        page_number: page.page_number,
        word_start: wordCursor,
        word_end: wordCursor + wordCount,
      });
      wordCursor += wordCount;
      mergedParts.push(content);
    }
    const mergedContent = mergedParts.join(PAGE_SEPARATOR);

    const mergedChunks = chunkTextDocument({ ...extracted, content: mergedContent });

    const chunksWithPages = mergedChunks.map((chunk, idx) => {
      const tokenStart = chunk.metadata?.token_start ?? null;
      const range = tokenStart != null
        ? (pageWordRanges.find((r) => tokenStart >= r.word_start && tokenStart < r.word_end) || pageWordRanges[0])
        : pageWordRanges[0];
      return {
        chunk_index: idx,
        content: chunk.content,
        token_count: chunk.token_count,
        metadata: {
          ...(chunk.metadata || {}),
          page_number: range.page_number,
          merged_from_pages: pages.length,
        },
      };
    });

    return chunksWithPages;
  }

  return toChunkObjects(chunkTextDocument(extracted), 1);
}

class IngestionPipelineOrchestrator {
  constructor(deps = {}) {
    this.eventBus = deps.eventBus || new EventEmitter();
    this.auditLogger = deps.auditLogger || new IngestionAuditLogger();
    this.vectorStore = deps.vectorStore;
    this.memoryWriter = deps.memoryWriter;
    this.relationshipClassifier = deps.relationshipClassifier;
    this.summaryModel = deps.summaryModel;
    this.completedByIdempotency = new BoundedTtlCache({ max: 500, ttlMs: 60 * 60 * 1000 });
  }

  async transition(job, stage, context = {}) {
    const transition = {
      stage,
      at: new Date().toISOString(),
      ...context,
    };

    if (!job.data.stage_transitions) {
      job.data.stage_transitions = [];
    }

    job.data.stage_transitions.push(transition);
    job.data.stage = stage;
    if (typeof job.updateProgress === 'function') {
      await job.updateProgress({ stage });
    }

    this.eventBus.emit('ingestion.stage', {
      jobId: job.id,
      stage,
      user_id: job.data.user_id,
      org_id: job.data.org_id,
    });
  }

  async process(job) {
    const startedAt = Date.now();
    const idempotencyKey = job.data.idempotency_key || job.data.request_id;

    if (idempotencyKey && this.completedByIdempotency.has(idempotencyKey)) {
      return this.completedByIdempotency.get(idempotencyKey);
    }

    await this.transition(job, STAGES.EXTRACTING);
    const extracted = await extractBySourceType(job.data);

    await this.transition(job, STAGES.CHUNKING);
    const chunks = chunkBySource(job.data.source_type, extracted);

    await this.transition(job, STAGES.EMBEDDING);
    const embedded = await embedChunks(chunks, {
      documentTitle: extracted.title,
      sourceType: job.data.source_type,
    }, {
      summaryModel: this.summaryModel,
    });

    await this.transition(job, STAGES.INDEXING);
    const indexing = await indexEmbeddedChunks(embedded, {
      request_id: job.data.request_id,
      user_id: job.data.user_id,
      org_id: job.data.org_id,
      project: job.data.project || null,
      title: job.data.title || extracted.title || null,
      memory_type: job.data.memory_type || null,
      tags: job.data.tags || [],
      source_type: job.data.source_type,
      source_platform: job.data.source_platform || job.data.source_type,
      source_id: job.data.source_id || extracted.metadata?.filepath || job.data.url || job.data.request_id,
      source_url: job.data.source_url || job.data.url || null,
      source_session_id: job.data.source_session_id || null,
      source_message_id: job.data.source_message_id || null,
      relationship: job.data.relationship || null,
      document_date: job.data.document_date || null,
      event_dates: job.data.event_dates || [],
      language: extracted.language,
      filepath: extracted.metadata?.filepath || job.data.filepath || null,
      metadata: extracted.metadata || {},
    }, {
      vectorStore: this.vectorStore,
      memoryWriter: this.memoryWriter,
      relationshipClassifier: this.relationshipClassifier,
    });

    // PageIndex: Auto-classify memories to nodes after indexing
    if (this.pageindexHook && indexing.memory_ids && indexing.memory_ids.length > 0) {
      for (let i = 0; i < indexing.memory_ids.length; i++) {
        const memoryId = indexing.memory_ids[i];
        const chunk = embedded[i];
        if (chunk && chunk.embedding) {
          const memoryForClassification = {
            id: memoryId,
            userId: job.data.user_id,
            orgId: job.data.org_id,
            content: chunk.content,
            title: job.data.title || extracted.title,
            tags: job.data.tags || [],
            embedding: chunk.embedding,
            embeddingModel: chunk.embedding_model,
          };
          this.pageindexHook.onMemoryIngested(memoryForClassification).catch(err => {
            this.logger.warn('[pipeline] PageIndex classification failed:', err.message);
          });
        }
      }
    }

    await this.transition(job, STAGES.DONE);

    const durationMs = Date.now() - startedAt;
    const result = {
      job_id: String(job.id),
      request_id: job.data.request_id,
      user_id: job.data.user_id,
      org_id: job.data.org_id,
      source_type: job.data.source_type,
      status: STAGES.DONE,
      duration_ms: durationMs,
      chunks_created: embedded.length,
      edges_created: indexing.edges_created,
      collection_name: indexing.collection_name,
      memory_ids: indexing.memory_ids || [],
      stage_transitions: job.data.stage_transitions,
    };

    await this.auditLogger.log(result);

    this.eventBus.emit('memory.ingested', {
      ...result,
      event: 'memory.ingested',
    });

    if (idempotencyKey) {
      this.completedByIdempotency.set(idempotencyKey, result);
    }
    job.result = result;

    return result;
  }
}

module.exports = {
  IngestionPipelineOrchestrator,
  chunkBySource,
};
