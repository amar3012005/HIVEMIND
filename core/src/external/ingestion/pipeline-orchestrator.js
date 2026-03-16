const EventEmitter = require('events');
const { STAGES } = require('./constants');
const { extractBySourceType } = require('./extractors');
const { chunkTextDocument, splitConversationTurns, tokenizeApprox } = require('./chunkers/text-chunker');
const { chunkCodeAST } = require('./chunkers/ast-chunker');
const { embedChunks } = require('./embedder');
const { indexEmbeddedChunks } = require('./indexer');
const { IngestionAuditLogger } = require('./audit-logger');

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

function chunkBySource(sourceType, extracted) {
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
    const chunks = [];
    for (const page of extracted.pages || []) {
      const pageChunks = chunkTextDocument({
        ...extracted,
        content: page.content,
      });
      chunks.push(...toChunkObjects(pageChunks, page.page_number));
    }
    return chunks;
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
    this.completedByIdempotency = new Map();
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

    if (this.completedByIdempotency.has(idempotencyKey)) {
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

    this.completedByIdempotency.set(idempotencyKey, result);
    job.result = result;

    return result;
  }
}

module.exports = {
  IngestionPipelineOrchestrator,
  chunkBySource,
};
