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
    return { ok: true, stage: 'acquire', reused: run.reused, receipt_id: run.receipt.id };
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
        result = await this.dfi.promoteStoredEvidence({
          documentId: job.metadata.promotion_document_id,
          userId: job.userId,
          orgId: job.orgId,
          metadata: job.metadata || {},
          onProgress,
          promotionStrategy: 'upgrade_evidence_to_both',
        });
      } else {
        const fileBuffer = await this.objectClient.getObject(job.sourceObjectKey, {
          expectedEtag: job.sourceObjectEtag || null,
        });
        const actualChecksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        if (actualChecksum !== job.checksum) {
          throw Object.assign(new Error('Durable source object checksum does not match admission.'), {
            code: 'SOURCE_OBJECT_INTEGRITY_FAILED', retryable: false,
          });
        }
        result = await this.processUpload({
          userId: job.userId, orgId: job.orgId, filename: job.filename,
          contentType: job.contentType, fileBuffer, metadata: job.metadata || {}, onProgress,
        });
      }
      await Promise.allSettled(progressWrites);
      if (!result?.documentId || (Number(result.promotedCount || 0) === 0 && Number(result.segmentCount || 0) === 0)) {
        throw Object.assign(new Error('Ingestion produced no recallable document or evidence.'), {
          code: 'NO_RECALLABLE_CONTENT', retryable: false,
        });
      }
      requireCompleteEvidenceEmbedding(result);
      await this._recordCanonicalStageReceipts(job, result);
      return { outputRefs: terminalResult(result), coverage: result.coverage || {} };
    });
    return {
      ok: true, stage: 'materialize', reused: run.reused, receipt_id: run.receipt.id,
      result: run.receipt.outputRefs,
    };
  }

  async _recordCanonicalStageReceipts(job, result) {
    const output = terminalResult(result);
    const evidence = output.coverage?.evidence_embed || {};
    const stages = [
      {
        stageKey: 'extract',
        input: { checksum: job.checksum, sourceObjectEtag: job.sourceObjectEtag },
        outputRefs: { source_object_key: job.sourceObjectKey || null, pages: output.pages },
        coverage: { pages: output.pages },
      },
      {
        stageKey: 'persist_evidence',
        input: { documentId: output.documentId },
        outputRefs: { document_id: output.documentId, segments: output.segmentCount },
        coverage: { total: output.segmentCount, succeeded: output.segmentCount, failed: 0 },
      },
      {
        stageKey: 'embed_evidence',
        input: { documentId: output.documentId, pipelineVersion: job.pipelineVersion || 1 },
        outputRefs: { document_id: output.documentId },
        coverage: evidence,
      },
      {
        stageKey: 'evidence_gate',
        input: { documentId: output.documentId, ingestMode: job.ingestMode },
        outputRefs: { passed: true, evidence_only: job.ingestMode === 'evidence' },
        coverage: evidence,
      },
      {
        stageKey: 'generate_memories',
        input: { documentId: output.documentId, ingestMode: job.ingestMode },
        outputRefs: {
          skipped: job.ingestMode === 'evidence',
          memory_ids: output.promotedMemoryIds,
          evidence_only_reason: output.evidenceOnlyReason,
        },
        coverage: { candidates: output.candidateCount, succeeded: output.promotedCount },
      },
      {
        stageKey: 'project_entities_claims',
        input: { documentId: output.documentId, memoryIds: output.promotedMemoryIds },
        outputRefs: { awaited: true, memory_ids: output.promotedMemoryIds },
        coverage: { memories: output.promotedCount },
      },
      {
        stageKey: 'persist_relationships_citations',
        input: { documentId: output.documentId, memoryIds: output.promotedMemoryIds },
        outputRefs: { awaited: true, document_id: output.documentId },
        coverage: { memories: output.promotedCount },
      },
    ];
    for (const stage of stages) {
      await this.steps.run({
        jobId: job.id,
        processingVersion: job.processingVersion,
        stageKey: stage.stageKey,
        input: stage.input,
      }, async () => ({ outputRefs: stage.outputRefs, coverage: stage.coverage }));
    }
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
    return { ok: true, failed: true };
  }
}
