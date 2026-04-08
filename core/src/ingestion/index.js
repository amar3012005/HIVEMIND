const { createIngestionQueue, ingest, validatePayload } = require('./queue');
const { IngestionPipelineOrchestrator } = require('./pipeline-orchestrator');
const { IngestionAuditLogger } = require('./audit-logger');
const { PageIndexIntegration, setupIngestionEventListener } = require('./pageindex-hook');

function createIngestionPipeline(options = {}) {
  const queueSystem = createIngestionQueue(options.queue || {});
  const orchestrator = new IngestionPipelineOrchestrator({
    eventBus: options.eventBus,
    auditLogger: options.auditLogger || new IngestionAuditLogger(),
    vectorStore: options.vectorStore,
    memoryWriter: options.memoryWriter,
    summaryModel: options.summaryModel,
    relationshipClassifier: options.relationshipClassifier,
  });

  // Setup PageIndex integration (auto-classification during ingestion)
  const pageindexHook = new PageIndexIntegration({
    prisma: options.prisma,
    logger: options.logger || console,
  });
  orchestrator.pageindexHook = pageindexHook;
  setupIngestionEventListener(orchestrator.eventBus, pageindexHook);

  if (queueSystem.mode === 'in-memory') {
    queueSystem.queue.process(async (job) => orchestrator.process(job));
  } else {
    const { Worker } = require('bullmq');
    const worker = new Worker(
      options.queue?.queueName || 'hivemind-ingestion',
      async (job) => orchestrator.process(job),
      {
        connection: queueSystem.connection,
        concurrency: options.queue?.concurrency || 4,
      }
    );

    worker.on('failed', async (job, error) => {
      if (job && job.attemptsMade >= 3) {
        await queueSystem.dlq.add('ingest-memory-dlq', {
          job_id: String(job.id),
          payload: job.data,
          error: error.message,
          failed_at: new Date().toISOString(),
        });
      }
    });

    queueSystem.worker = worker;
  }

  return {
    mode: queueSystem.mode,
    orchestrator,
    async ingest(payload, optionsForJob = {}) {
      return ingest(payload, queueSystem, optionsForJob);
    },
    validatePayload,
    eventBus: orchestrator.eventBus,
    auditLogger: orchestrator.auditLogger,
    queueSystem,
    async close() {
      if (queueSystem.worker) {
        await queueSystem.worker.close();
      }
      await queueSystem.close();
    },
  };
}

module.exports = {
  createIngestionPipeline,
  validatePayload,
};
