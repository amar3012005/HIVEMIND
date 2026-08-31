import crypto from 'node:crypto';
import { KnowledgeIngestStepStore } from './ingest-step-store.js';
import {
  isStoredEvidencePromotion,
  requireCompleteEvidenceEmbedding,
} from './kb-ingest-queue.js';
import { sanitizeKnowledgeJson } from './upload-contract.js';
import { knowledgeWorkflowEnabled } from './cloudflare-ingest-client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(['acquire', 'materialize', 'reconcile']);
const activeMaterializations = new Map();
const PROCESSING_LEASE_PREFIX = 'knowledge-ingest-production';
const PROCESSING_LEASE_MS = Math.max(60_000, Number(process.env.KNOWLEDGE_INGEST_PROCESSING_LEASE_MS || 20 * 60_000));
const stageWaiters = new Set();
const STAGE_CAPACITY = {
  extract: {
    global: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_EXTRACT_CONCURRENCY || 4)),
    org: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_EXTRACT_ORG_CONCURRENCY || 2)),
  },
  embed: {
    global: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_EMBED_CONCURRENCY || 3)),
    org: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_EMBED_ORG_CONCURRENCY || 2)),
  },
  promote: {
    global: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_PROMOTE_CONCURRENCY || 4)),
    org: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_PROMOTE_ORG_CONCURRENCY || 2)),
  },
  project: {
    global: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_PROJECT_CONCURRENCY || 6)),
    org: Math.max(1, Number(process.env.KNOWLEDGE_INGEST_PROJECT_ORG_CONCURRENCY || 3)),
  },
};
const TERMINAL_MATERIALIZATION_ERRORS = new Set([
  'IMAGE_NOT_A_DOCUMENT', 'NO_RECALLABLE_CONTENT', 'SOURCE_OBJECT_INTEGRITY_FAILED',
  'UNSUPPORTED_FILE_TYPE', 'MIME_EXTENSION_MISMATCH', 'FILE_SIGNATURE_MISMATCH',
  'INVALID_WORKFLOW_PAYLOAD', 'UPLOAD_NOT_AUTHORIZED', 'UPLOAD_SCOPE_REVOKED',
]);

export function isRetryableMaterializationError(errorCode) {
  return !TERMINAL_MATERIALIZATION_ERRORS.has(String(errorCode || '').toUpperCase());
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export function isAuthorizedKnowledgeWorkflowRequest(req) {
  if (!knowledgeWorkflowEnabled()) return false;
  const expected = process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET || '';
  const actual = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEqual(actual, expected);
}

function terminalResult(result = {}) {
  return sanitizeKnowledgeJson({
    documentId: result.documentId || null,
    promotedMemoryIds: Array.isArray(result.promotedMemoryIds) ? result.promotedMemoryIds : [],
    pages: Math.max(1, Number(result.pages) || 1),
    segmentCount: Number(result.segmentCount) || 0,
    candidateCount: Number(result.candidateCount) || 0,
    promotedCount: Number(result.promotedCount) || 0,
    evidenceOnlyReason: result.evidenceOnlyReason || null,
    coverage: result.coverage || {},
  });
}

export class CloudflareKnowledgeIngestExecutor {
  constructor({
    prisma, jobStore, objectClient, documentFirstIngestion,
    validateJob, processUpload, isRemoteOrg = () => false, stepStore = null,
    logger = console,
  }) {
    this.prisma = prisma;
    this.jobStore = jobStore;
    this.objectClient = objectClient;
    this.dfi = documentFirstIngestion;
    this.validateJob = validateJob;
    this.processUpload = processUpload;
    this.isRemoteOrg = isRemoteOrg;
    this.logger = logger;
    this.steps = stepStore || new KnowledgeIngestStepStore({ prisma, logger });
    this.schedulerReady = this._recoverStageScheduler();
  }

  async _recoverStageScheduler() {
    if (!this.prisma?.knowledgeIngestLease || !this.prisma?.knowledgeIngestStep
      || typeof this.prisma?.$transaction !== 'function') return;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe?.("SELECT pg_advisory_xact_lock(hashtext('hivemind-knowledge-ingest-stage-recovery'))");
        // Production has one Core scheduler. A process restart invalidates every
        // in-process stage holder, while the durable Workflow and step receipts
        // remain authoritative and will resume the current processing version.
        await tx.knowledgeIngestLease.deleteMany({
          where: { leaseKey: { startsWith: `${PROCESSING_LEASE_PREFIX}:` } },
        });
        await tx.$executeRawUnsafe(
          `UPDATE knowledge_ingest_steps AS s
              SET status = 'pending', lease_until = NULL, lease_token = NULL,
                  updated_at = NOW()
             FROM knowledge_ingest_jobs AS j
            WHERE j.id = s.job_id
              AND s.stage_key LIKE 'capacity\\_%' ESCAPE '\\'
              AND s.status = 'processing'
              AND j.status IN ('queued', 'processing')`,
        );
      });
    } catch (error) {
      this.logger.warn?.(`[knowledge-workflow] stage scheduler recovery deferred: ${error.message}`);
    }
  }

  async _job({ jobId, orgId, userId, processingVersion }) {
    if (!UUID.test(jobId) || !UUID.test(orgId) || !UUID.test(userId)) {
      throw Object.assign(new Error('job_id, org_id, and user_id must be UUIDs'), { code: 'INVALID_WORKFLOW_PAYLOAD', retryable: false });
    }
    const job = await this.jobStore.findOwned(jobId, { orgId });
    if (!job) throw Object.assign(new Error('Knowledge ingest job was not found.'), { code: 'JOB_NOT_FOUND', retryable: false });
    if (job.userId !== userId) {
      throw Object.assign(new Error('Workflow user does not own this ingest job.'), { code: 'WORKFLOW_USER_MISMATCH', retryable: false });
    }
    if (job.orchestrationMode !== 'cloudflare_workflow') {
      throw Object.assign(new Error('Job is not owned by the Cloudflare orchestrator.'), { code: 'ORCHESTRATOR_MISMATCH', retryable: false });
    }
    if (Number(job.processingVersion || 1) !== Number(processingVersion || 1)) {
      throw Object.assign(new Error('Workflow processing version is stale.'), { code: 'STALE_WORKFLOW', retryable: false });
    }
    if (job.status === 'cancelled') {
      throw Object.assign(new Error('Upload was cancelled.'), { code: 'UPLOAD_CANCELLED', retryable: false });
    }
    return job;
  }

  async execute({ jobId, orgId, userId, processingVersion, stage }) {
    if (!STAGES.has(stage)) {
      throw Object.assign(new Error('stage must be acquire, materialize, or reconcile'), { code: 'INVALID_STAGE', retryable: false });
    }
    const job = await this._job({ jobId, orgId, userId, processingVersion });
    if (stage === 'acquire') return this._acquire(job);
    if (stage === 'materialize') return this._materialize(job);
    return this._reconcile(job);
  }

  async startMaterialize({ jobId, orgId, userId, processingVersion }) {
    const job = await this._job({ jobId, orgId, userId, processingVersion });
    const identity = {
      jobId: job.id, processingVersion: job.processingVersion,
      stageKey: 'materialize', shardKey: 'root',
    };
    const existing = await this.steps.get(identity);
    if (existing?.status === 'succeeded') {
      return { ok: true, stage: 'materialize', accepted: false, reused: true, status: 'succeeded', result: existing.outputRefs };
    }
    const key = `${job.id}:${job.processingVersion}`;
    if (!activeMaterializations.has(key)) {
      const task = this._materialize(job)
        .catch((error) => {
          if (error?.code !== 'INGEST_STAGE_BUSY') {
            this.logger.error?.(`[knowledge-workflow] background materialization failed for ${job.id}: ${error.message}`);
          }
        })
        .finally(() => activeMaterializations.delete(key));
      activeMaterializations.set(key, task);
    }
    return { ok: true, stage: 'materialize', accepted: true, reused: false, status: existing?.status || 'pending' };
  }

  async materializeStatus({ jobId, orgId, userId, processingVersion }) {
    const job = await this._job({ jobId, orgId, userId, processingVersion });
    const receipt = await this.steps.get({
      jobId: job.id, processingVersion: job.processingVersion,
      stageKey: 'materialize', shardKey: 'root',
    });
    return {
      ok: true, stage: 'materialize', status: receipt?.status || 'pending',
      attempt: Number(receipt?.attempt || 0), retryable: isRetryableMaterializationError(receipt?.errorCode),
      ...(receipt?.status === 'succeeded' ? { receipt_id: receipt.id, result: receipt.outputRefs } : {}),
      ...(receipt?.status === 'failed' ? { error_code: receipt.errorCode, message: receipt.errorMessage } : {}),
    };
  }

  async _acquire(job) {
    const run = await this.steps.run({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'acquire',
      input: { orgId: job.orgId, userId: job.userId, scopeKey: job.scopeKey, storageMode: job.storageMode },
    }, async () => {
      await this.validateJob?.({
        trackerJobId: job.id, userId: job.userId, orgId: job.orgId, metadata: job.metadata || {},
      });
      if (!isStoredEvidencePromotion(job.metadata) && !job.sourceObjectKey) {
        throw Object.assign(new Error('Durable source object is missing.'), { code: 'SOURCE_OBJECT_MISSING', retryable: false });
      }
      await this.jobStore.progress(job.id, job.orgId, 'acquiring', 5, {
        orchestration_mode: 'cloudflare_workflow', processing_version: job.processingVersion,
      }, { processingVersion: job.processingVersion });
      return { outputRefs: { authorized: true, source_object_key: job.sourceObjectKey || null } };
    });
    return { ok: true, stage: 'acquire', acquired: true, reused: run.reused, receipt_id: run.receipt.id };
  }

  async _claimProcessingLease(job, stage = 'extract') {
    if (!this.prisma?.knowledgeIngestLease) return { acquired: true, legacySchema: true };
    const capacity = STAGE_CAPACITY[stage] || STAGE_CAPACITY.extract;
    const prefix = `${PROCESSING_LEASE_PREFIX}:${stage}`;
    const transact = this.prisma.$transaction
      // The transaction-scoped PostgreSQL advisory lock below is the single
      // scheduler mutex. Adding Serializable isolation caused harmless slot
      // claims to abort under burst admission, delaying the next stage by the
      // retry timer even though no capacity conflict existed.
      ? (work) => this.prisma.$transaction(work)
      : (work) => work(this.prisma);
    try {
      return await transact(async (tx) => {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);
        // Serializes the tiny scheduler decision only. Parsing and embedding never
        // hold a database lock.
        await tx.$executeRawUnsafe?.(`SELECT pg_advisory_xact_lock(hashtext('hivemind-knowledge-ingest-${stage}-slots'))`);
        const leases = await tx.knowledgeIngestLease.findMany({
          where: { leaseKey: { startsWith: `${prefix}:` } },
          orderBy: { leaseKey: 'asc' },
        });
        const owned = leases.find((lease) => lease.jobId === job.id
          && Number(lease.processingVersion) === Number(job.processingVersion));
        if (owned) {
          await tx.knowledgeIngestLease.update({ where: { leaseKey: owned.leaseKey }, data: { leaseUntil } });
          return { acquired: true, leaseToken: owned.leaseToken, slot: owned.leaseKey };
        }
        const active = leases.filter((lease) => lease.leaseUntil > now);
        if (active.length >= capacity.global) return { acquired: false };
        if (active.filter((lease) => lease.orgId === job.orgId).length >= Math.min(capacity.global, capacity.org)) {
          return { acquired: false };
        }

        // The durable capacity rows are the queue. Only the oldest live row for
        // this stage may claim next, so a thundering herd cannot let a newer job
        // jump ahead. This is an indexed, one-row lookup; it never scans/ranks
        // the KnowledgeIngestJob table inside the scheduler transaction.
        const queued = await tx.$queryRawUnsafe?.(
          `SELECT s.job_id AS "jobId", s.processing_version AS "processingVersion"
             FROM knowledge_ingest_steps s
             JOIN knowledge_ingest_jobs j ON j.id = s.job_id
            WHERE s.stage_key = $1
              AND s.status = 'pending'
              AND j.status IN ('queued', 'processing')
              AND j.processing_version = s.processing_version
            ORDER BY s.created_at ASC, s.id ASC
            LIMIT 1`,
          `capacity_${stage}`,
        );
        const next = Array.isArray(queued) ? queued[0] : null;
        if (next && (next.jobId !== job.id
          || Number(next.processingVersion) !== Number(job.processingVersion))) {
          return { acquired: false };
        }

        const used = new Set(active.map((lease) => lease.leaseKey));
        const slot = Array.from({ length: capacity.global }, (_, index) => `${prefix}:${index}`)
          .find((key) => !used.has(key));
        if (!slot) return { acquired: false };
        const leaseToken = crypto.randomUUID();
        const existing = leases.find((lease) => lease.leaseKey === slot);
        const data = {
          jobId: job.id, orgId: job.orgId, processingVersion: job.processingVersion,
          leaseToken, leaseUntil,
        };
        if (existing) await tx.knowledgeIngestLease.update({ where: { leaseKey: slot }, data });
        else await tx.knowledgeIngestLease.create({ data: { leaseKey: slot, ...data } });
        await tx.knowledgeIngestStep?.updateMany?.({
          where: {
            jobId: job.id, processingVersion: job.processingVersion,
            stageKey: `capacity_${stage}`, shardKey: 'root', status: 'pending',
          },
          data: { status: 'processing', attempt: { increment: 1 }, leaseUntil, leaseToken, startedAt: now },
        });
        return { acquired: true, leaseToken, slot };
      });
    } catch (error) {
      this.logger.warn?.(`[knowledge-workflow] slot claim contention for ${job.id}: ${error.message}`);
      return { acquired: false };
    }
  }

  async _waitForProcessingLease(job, stage) {
    await this.schedulerReady;
    if (this.prisma?.knowledgeIngestStep) {
      await this.prisma.knowledgeIngestStep.upsert({
        where: { jobId_processingVersion_stageKey_shardKey: {
          jobId: job.id, processingVersion: job.processingVersion,
          stageKey: `capacity_${stage}`, shardKey: 'root',
        } },
        create: {
          jobId: job.id, processingVersion: job.processingVersion,
          stageKey: `capacity_${stage}`, shardKey: 'root', status: 'pending',
        },
        update: {
          status: 'pending', leaseUntil: null, leaseToken: null,
          errorCode: null, errorMessage: null, completedAt: null,
        },
      });
    }
    while (true) {
      let wake;
      const released = new Promise((resolve) => {
        wake = () => { stageWaiters.delete(wake); resolve(); };
        stageWaiters.add(wake);
      });
      const lease = await this._claimProcessingLease(job, stage);
      if (lease.acquired) {
        stageWaiters.delete(wake);
        // Capacity may still have another free slot. Wake the next durable
        // waiter immediately so the pool fills without a timer.
        for (const notify of [...stageWaiters]) notify();
        return lease;
      }
      await released;
      const current = await this._job({
        jobId: job.id, orgId: job.orgId, userId: job.userId,
        processingVersion: job.processingVersion,
      });
      if (current.status === 'cancelled') throw Object.assign(new Error('Upload was cancelled.'), { code: 'UPLOAD_CANCELLED', retryable: false });
    }
  }

  async _releaseProcessingLease(job, stage = null) {
    if (!this.prisma?.knowledgeIngestLease) return;
    const prefix = stage ? `${PROCESSING_LEASE_PREFIX}:${stage}:` : `${PROCESSING_LEASE_PREFIX}:`;
    await this.prisma.knowledgeIngestLease.deleteMany({
      where: {
        leaseKey: { startsWith: prefix },
        jobId: job.id, processingVersion: job.processingVersion,
      },
    }).catch(() => null);
    if (this.prisma?.knowledgeIngestStep) {
      await this.prisma.knowledgeIngestStep.updateMany({
        where: {
          jobId: job.id, processingVersion: job.processingVersion,
          ...(stage ? { stageKey: `capacity_${stage}` } : { stageKey: { startsWith: 'capacity_' } }),
          status: 'processing',
        },
        data: { status: 'succeeded', leaseUntil: null, leaseToken: null, completedAt: new Date() },
      }).catch(() => null);
    }
    for (const wake of [...stageWaiters]) wake();
  }

  async _materialize(job) {
    const isImage = job.mediaKind === 'image' || job.metadata?.media_kind === 'image';
    const durableMetadata = isImage
      ? { ...(job.metadata || {}), media_kind: 'image', ingest_mode: 'both' }
      : (job.metadata || {});
    let run;
    try {
      run = await this.steps.run({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'materialize',
      input: { checksum: job.checksum, sourceObjectKey: job.sourceObjectKey, ingestMode: job.ingestMode },
    }, async () => {
      await this._waitForProcessingLease(job, 'extract');
      await this.validateJob?.({
        trackerJobId: job.id, userId: job.userId, orgId: job.orgId, metadata: durableMetadata,
      });
      const progressWrites = [];
      const onProgress = (frame = {}) => {
        progressWrites.push(this.jobStore.progress(
          job.id, job.orgId, frame.stage || 'processing', frame.progress ?? 10,
          sanitizeKnowledgeJson({ ...frame, orchestration_mode: 'cloudflare_workflow' }),
          { processingVersion: job.processingVersion },
        ));
      };
      let result;
      if (isStoredEvidencePromotion(job.metadata)) {
        await this._releaseProcessingLease(job, 'extract');
        await this._waitForProcessingLease(job, 'promote');
        const promoted = await this.steps.run({
          jobId: job.id, processingVersion: job.processingVersion, stageKey: 'promote_memories',
          input: { documentId: job.metadata.promotion_document_id, strategy: 'upgrade_evidence_to_both' },
        }, async () => {
          const value = await this.dfi.promoteStoredEvidence({
            documentId: job.metadata.promotion_document_id, userId: job.userId, orgId: job.orgId,
            metadata: job.metadata || {}, onProgress, promotionStrategy: 'upgrade_evidence_to_both',
          });
          return { outputRefs: terminalResult(value), coverage: value.coverage || {} };
        });
        result = promoted.receipt.outputRefs;
        await this._releaseProcessingLease(job, 'promote');
      } else {
        const evidenceStage = await this.steps.run({
          jobId: job.id, processingVersion: job.processingVersion,
          stageKey: isImage ? 'materialize_image' : 'materialize_evidence',
          input: { checksum: job.checksum, sourceObjectKey: job.sourceObjectKey, sourceObjectEtag: job.sourceObjectEtag },
        }, async () => {
          const fileBuffer = await this.objectClient.getObject(job.sourceObjectKey, {
            expectedEtag: job.sourceObjectEtag || null,
          });
          const actualChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
          if (actualChecksum !== job.checksum) {
            throw Object.assign(new Error('Durable source object checksum does not match admission.'), {
              code: 'SOURCE_OBJECT_INTEGRITY_FAILED', retryable: false,
            });
          }
          const value = await this.processUpload({
            userId: job.userId, orgId: job.orgId, filename: job.filename,
            contentType: job.contentType, fileBuffer,
            // Real checkpoint boundary: document/evidence/vector persistence is
            // completed first. Promotion later reuses those stored segments.
            metadata: isImage
              ? durableMetadata
              : { ...durableMetadata, ingest_mode: 'evidence' },
            onProgress,
            stageHooks: isImage ? null : {
              beforeEvidenceEmbedding: async () => {
                await this._releaseProcessingLease(job, 'extract');
                await this._waitForProcessingLease(job, 'embed');
              },
            },
          });
          requireCompleteEvidenceEmbedding(value);
          return { outputRefs: terminalResult(value), coverage: value.coverage || {} };
        });
        const evidence = evidenceStage.receipt.outputRefs;
        // Extraction, parsing and embedding capacity is released as soon as
        // durable evidence exists. The next document starts immediately while
        // this one proceeds through memory generation on an independent pool.
        await this._releaseProcessingLease(job, 'extract');
        if (!isImage) await this._releaseProcessingLease(job, 'embed');
        result = evidence;
        if (job.ingestMode === 'both' && !isImage) {
          await this._waitForProcessingLease(job, 'promote');
          const promotionStage = await this.steps.run({
            jobId: job.id, processingVersion: job.processingVersion, stageKey: 'promote_memories',
            input: { documentId: evidence.documentId, evidenceReceipt: evidenceStage.receipt.id },
          }, async () => {
            const value = await this.dfi.promoteStoredEvidence({
              documentId: evidence.documentId, userId: job.userId, orgId: job.orgId,
              metadata: { ...(job.metadata || {}), ingest_mode: 'both' }, onProgress,
              promotionStrategy: 'workflow_evidence_checkpoint',
            });
            return { outputRefs: terminalResult(value), coverage: value.coverage || {} };
          });
          result = {
            ...promotionStage.receipt.outputRefs,
            pages: evidence.pages,
            segmentCount: evidence.segmentCount,
            coverage: { ...evidence.coverage, ...promotionStage.receipt.outputRefs.coverage },
          };
          await this._releaseProcessingLease(job, 'promote');
        }
      }
      await Promise.allSettled(progressWrites);
      if (!result?.documentId || (Number(result.promotedCount || 0) === 0 && Number(result.segmentCount || 0) === 0)) {
        throw Object.assign(new Error('Ingestion produced no recallable document or evidence.'), {
          code: 'NO_RECALLABLE_CONTENT', retryable: false,
        });
      }
      requireCompleteEvidenceEmbedding(result);
      return { outputRefs: terminalResult(result), coverage: result.coverage || {} };
      });
    } catch (error) {
      // A parser/provider failure must never pin either capacity pool until the
      // lease TTL. Checkpoint replay remains durable; capacity is immediately
      // returned for another document.
      await this._releaseProcessingLease(job);
      throw error;
    }
    return {
      ok: true, stage: 'materialize', reused: run.reused, receipt_id: run.receipt.id,
      result: run.receipt.outputRefs,
    };
  }

  async _reconcile(job) {
    const isImage = job.mediaKind === 'image' || job.metadata?.media_kind === 'image';
    const materialized = await this.steps.get({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'materialize', shardKey: 'root',
    });
    if (materialized?.status !== 'succeeded') {
      throw Object.assign(new Error('Canonical materialization has not completed.'), { code: 'MATERIALIZATION_INCOMPLETE', retryable: true });
    }
    const result = materialized.outputRefs || {};
    await this._waitForProcessingLease(job, 'project');
    let run;
    try {
      run = await this.steps.run({
        jobId: job.id, processingVersion: job.processingVersion, stageKey: 'reconcile',
        input: { materializeReceipt: materialized.id, documentId: result.documentId },
      }, async () => {
      if (!result.documentId || (isImage
        ? Number(result.promotedCount || 0) <= 0
        : Number(result.segmentCount || 0) <= 0)) {
        throw Object.assign(new Error('Persisted evidence coverage is incomplete.'), { code: 'EVIDENCE_COVERAGE_INCOMPLETE', retryable: true });
      }
      const remoteStorage = await this.isRemoteOrg(job.orgId);
      if (isImage && this.prisma?.memory && !remoteStorage) {
        const memory = await this.prisma.memory.findFirst({
          where: { id: result.documentId, orgId: job.orgId, deletedAt: null }, select: { id: true },
        }).catch(() => null);
        if (!memory) {
          throw Object.assign(new Error('Persisted image memory reconciliation failed.'), {
            code: 'IMAGE_MEMORY_RECONCILIATION_FAILED', retryable: true,
          });
        }
      } else if (!isImage && this.prisma?.knowledgeDocument && !remoteStorage) {
        const document = await this.prisma.knowledgeDocument.findFirst({
          where: { id: result.documentId, orgId: job.orgId },
          select: { id: true, _count: { select: { segments: true, memoryLinks: true } } },
        }).catch(() => null);
        if (!document || Number(document._count?.segments || 0) < Number(result.segmentCount || 0)) {
          throw Object.assign(new Error('Persisted document/segment reconciliation failed.'), {
            code: 'EVIDENCE_RECONCILIATION_FAILED', retryable: true,
          });
        }
      }
      const completed = await this.jobStore.complete(
        job.id, job.orgId, job.userId, result, { processingVersion: job.processingVersion },
      );
      if (!completed) {
        throw Object.assign(new Error('Workflow could not settle the selected processing version.'), {
          code: 'STALE_WORKFLOW', retryable: false,
        });
      }
      await this.objectClient.deleteObject(job.sourceObjectKey);
      await this._releaseProcessingLease(job);
      return {
        outputRefs: {
          document_id: result.documentId,
          segments: Number(result.segmentCount || 0),
          memories: Number(result.promotedCount || 0),
          terminal: true,
        },
        coverage: result.coverage || {},
      };
      });
    } finally {
      await this._releaseProcessingLease(job, 'project');
    }
    return { ok: true, stage: 'reconcile', reused: run.reused, receipt_id: run.receipt.id, terminal: true };
  }

  async fail({ jobId, orgId, userId, processingVersion, errorCode, message, retryable }) {
    const job = await this._job({ jobId, orgId, userId, processingVersion });
    if (retryable === true) return { ok: true, deferred: true };
    const error = Object.assign(new Error(String(message || 'Cloudflare workflow failed')), {
      code: String(errorCode || 'WORKFLOW_FAILED').slice(0, 80),
    });
    await this.jobStore.fail(job.id, job.orgId, error, { processingVersion: job.processingVersion });
    await this._releaseProcessingLease(job);
    return { ok: true, failed: true };
  }
}
