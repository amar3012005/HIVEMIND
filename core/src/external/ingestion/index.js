const { createIngestionQueue, ingest, validatePayload } = require('./queue');
const { IngestionPipelineOrchestrator } = require('./pipeline-orchestrator');
const { IngestionAuditLogger } = require('./audit-logger');

const _withOrg = (job, fn) => {
  const o = job && job.data && (job.data.org_id || (job.data.payload && job.data.payload.org_id));
  const ctx = globalThis.__hivemindOrgCtx;
  if (o && ctx && ctx.runWithOrg) return ctx.runWithOrg(o, fn);
  return fn();
};

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

  if (queueSystem.mode === 'in-memory') {
    queueSystem.queue.process(async (job) => _withOrg(job, () => orchestrator.process(job)));
  } else {
    const { Worker } = require('bullmq');
    const worker = new Worker(
      options.queue?.queueName || 'hivemind-ingestion',
      async (job) => _withOrg(job, () => orchestrator.process(job)),
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
