/**
 * Dedicated Engine Box durable ingestion worker.
 *
 * It deliberately composes the same DocumentFirstIngestionService as the
 * local API. There is no Cloudflare workflow client, hosted quota client, or
 * remote-org routing fallback in this process.
 */
import { KbIngestQueue } from '../knowledge/kb-ingest-queue.js';
import { KnowledgeUploadJobStore } from '../knowledge/upload-job-store.js';
import { createLocalEngineRuntime } from '../engine-box/local-runtime.mjs';
import { pathToFileURL } from 'node:url';

function assertEngineBox(env) {
  if (env.ENGINE_BOX_MODE !== 'true') throw new Error('ENGINE_BOX_MODE=true is required for the Engine Box ingestion worker');
  if (env.KB_QUEUE_MODE !== 'all') throw new Error('KB_QUEUE_MODE=all is required for durable Engine Box ingestion');
}

export async function startEngineBoxIngestionWorker(env = process.env, { runtime = null, logger = console } = {}) {
  assertEngineBox(env);
  const local = runtime || createLocalEngineRuntime({ env, logger });
  const jobStore = new KnowledgeUploadJobStore({ prisma: local.db, logger });
  const queue = new KbIngestQueue({
    documentFirstIngestion: local.documentFirstIngestion,
    ingestTracker: local.ingestTracker,
    jobStore,
    // Re-authorize at execution time. Local API admission owns OIDC scope
    // checks; this guard prevents stale or deleted jobs from running.
    validateJob: async ({ trackerJobId, userId, orgId }) => {
      const job = await jobStore.findOwned(trackerJobId, { userId, orgId });
      if (!job || job.status === 'cancelled') {
        throw Object.assign(new Error('local upload authorization is no longer valid'), { code: 'UPLOAD_NOT_AUTHORIZED' });
      }
    },
    processUpload: async ({ userId, orgId, filename, contentType, fileBuffer, metadata, onProgress, stageHooks }) => (
      local.documentFirstIngestion.ingestSource({
        userId,
        orgId,
        source: { type: 'kb', filename },
        file: { buffer: fileBuffer, contentType, filename },
        metadata,
        ingestMode: metadata?.ingest_mode || 'both',
        onProgress,
        stageHooks,
      })
    ),
    logger,
  });
  if (!await queue.isAvailable()) throw new Error('durable local Redis ingestion queue is unavailable');
  logger.info?.(JSON.stringify({ svc: 'hm-ingestion-worker', event: 'ready', mode: 'engine_box', queue: 'knowledge-ingest' }));
  const stop = async (signal) => {
    logger.info?.(JSON.stringify({ svc: 'hm-ingestion-worker', event: 'stopping', signal }));
    await queue.close().catch(() => {});
    local.ingestTracker.destroy?.();
    process.exit(0);
  };
  process.once('SIGTERM', () => { void stop('SIGTERM'); });
  process.once('SIGINT', () => { void stop('SIGINT'); });
  return { ...local, jobStore, queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startEngineBoxIngestionWorker();
