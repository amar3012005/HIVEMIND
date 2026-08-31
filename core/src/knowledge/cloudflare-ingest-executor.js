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
const PROCESSING_LEASE_KEY = 'knowledge-ingest-production';
const PROCESSING_LEASE_MS = Math.max(60_000, Number(process.env.KNOWLEDGE_INGEST_PROCESSING_LEASE_MS || 20 * 60_000));

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
    await this._claimProcessingLease(job);
    const receipt = await this.steps.get({
      jobId: job.id, processingVersion: job.processingVersion,
      stageKey: 'materialize', shardKey: 'root',
    });
    return {
      ok: true, stage: 'materialize', status: receipt?.status || 'pending',
      attempt: Number(receipt?.attempt || 0), retryable: receipt?.errorCode !== 'NO_RECALLABLE_CONTENT',
      ...(receipt?.status === 'succeeded' ? { receipt_id: receipt.id, result: receipt.outputRefs } : {}),
      ...(receipt?.status === 'failed' ? { error_code: receipt.errorCode, message: receipt.errorMessage } : {}),
    };
  }

  async _acquire(job) {
    const lease = await this._claimProcessingLease(job);
    if (!lease.acquired) return { ok: true, stage: 'acquire', acquired: false, retry_after_seconds: 15 };
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

  async _claimProcessingLease(job) {
    if (!this.prisma?.knowledgeIngestLease) return { acquired: true, legacySchema: true };
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);
    const existing = await this.prisma.knowledgeIngestLease.findUnique({ where: { leaseKey: PROCESSING_LEASE_KEY } });
    if (existing?.jobId === job.id && Number(existing.processingVersion) === Number(job.processingVersion)) {
      await this.prisma.knowledgeIngestLease.update({ where: { leaseKey: PROCESSING_LEASE_KEY }, data: { leaseUntil } });
      return { acquired: true, leaseToken: existing.leaseToken };
    }
    if (existing && existing.leaseUntil > now) return { acquired: false };
    const leaseToken = crypto.randomUUID();
    if (!existing) {
      try {
        await this.prisma.knowledgeIngestLease.create({
          data: { leaseKey: PROCESSING_LEASE_KEY, jobId: job.id, processingVersion: job.processingVersion, leaseToken, leaseUntil },
        });
        return { acquired: true, leaseToken };
      } catch { return { acquired: false }; }
    }
    const claimed = await this.prisma.knowledgeIngestLease.updateMany({
      where: { leaseKey: PROCESSING_LEASE_KEY, leaseUntil: { lte: now } },
      data: { jobId: job.id, processingVersion: job.processingVersion, leaseToken, leaseUntil },
    });
    return { acquired: Number(claimed.count || 0) === 1, leaseToken };
  }

  async _releaseProcessingLease(job) {
    if (!this.prisma?.knowledgeIngestLease) return;
    await this.prisma.knowledgeIngestLease.deleteMany({
      where: { leaseKey: PROCESSING_LEASE_KEY, jobId: job.id, processingVersion: job.processingVersion },
    }).catch(() => null);
  }

  async _materialize(job) {
    const run = await this.steps.run({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'materialize',
      input: { checksum: job.checksum, sourceObjectKey: job.sourceObjectKey, ingestMode: job.ingestMode },
    }, async () => {
      await this.validateJob?.({
        trackerJobId: job.id, userId: job.userId, orgId: job.orgId, metadata: job.metadata || {},
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
      } else {
        const evidenceStage = await this.steps.run({
          jobId: job.id, processingVersion: job.processingVersion, stageKey: 'materialize_evidence',
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
            metadata: job.metadata?.media_kind === 'image'
              ? (job.metadata || {})
              : { ...(job.metadata || {}), ingest_mode: 'evidence' },
            onProgress,
          });
          requireCompleteEvidenceEmbedding(value);
          return { outputRefs: terminalResult(value), coverage: value.coverage || {} };
        });
        const evidence = evidenceStage.receipt.outputRefs;
        result = evidence;
        if (job.ingestMode === 'both' && job.metadata?.media_kind !== 'image') {
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
    return {
      ok: true, stage: 'materialize', reused: run.reused, receipt_id: run.receipt.id,
      result: run.receipt.outputRefs,
    };
  }

  async _reconcile(job) {
    const materialized = await this.steps.get({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'materialize', shardKey: 'root',
    });
    if (materialized?.status !== 'succeeded') {
      throw Object.assign(new Error('Canonical materialization has not completed.'), { code: 'MATERIALIZATION_INCOMPLETE', retryable: true });
    }
    const result = materialized.outputRefs || {};
    const run = await this.steps.run({
      jobId: job.id, processingVersion: job.processingVersion, stageKey: 'reconcile',
      input: { materializeReceipt: materialized.id, documentId: result.documentId },
    }, async () => {
      if (!result.documentId || Number(result.segmentCount || 0) <= 0) {
        throw Object.assign(new Error('Persisted evidence coverage is incomplete.'), { code: 'EVIDENCE_COVERAGE_INCOMPLETE', retryable: true });
      }
      const remoteStorage = await this.isRemoteOrg(job.orgId);
      if (this.prisma?.knowledgeDocument && !remoteStorage) {
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
