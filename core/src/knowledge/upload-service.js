import crypto from 'node:crypto';
import { authorizeKnowledgeScope } from './upload-authorization.js';
import { safeUploadFilename, uploadError, validateKnowledgeFile } from './upload-contract.js';

export class KnowledgeUploadService {
  constructor({ prisma, queue, jobStore, planEnforcer, storageReady }) {
    this.prisma = prisma;
    this.queue = queue;
    this.jobStore = jobStore;
    this.planEnforcer = planEnforcer;
    this.storageReady = storageReady;
  }

  async admit({ userId, orgId, file, targetScope, projectIds, primaryTeamId, metadata }) {
    const filename = safeUploadFilename(file.filename);
    const validation = validateKnowledgeFile({
      filename, contentType: file.contentType, bytes: file.data?.length, buffer: file.data,
    });
    if (!validation.ok) return { ok: false, ...uploadError(validation.code, { limits: validation.limits }) };

    const scope = await authorizeKnowledgeScope({
      prisma: this.prisma, userId, orgId, targetScope, projectIds, primaryTeamId,
    });
    if (!scope.ok) return { ok: false, status: scope.status, body: { error: scope.code } };

    const org = await this.prisma.organization.findFirst({
      where: { id: orgId }, select: { memoryStorageMode: true },
    });
    if (!org) return { ok: false, status: 404, body: { error: 'scope_not_found' } };
    const storageMode = org.memoryStorageMode || 'hybrid';
    if (!this.storageReady(orgId, storageMode)) {
      return { ok: false, status: 503, body: {
        error: 'storage_unavailable', message: 'The selected memory storage is unavailable. No central fallback was used.',
      } };
    }
    if (!await this.queue?.isAvailable()) {
      return { ok: false, status: 503, body: { error: 'queue_unavailable', message: 'Durable ingestion is temporarily unavailable.' } };
    }

    if (this.planEnforcer) {
      const estimatedPages = Math.max(1, Math.ceil(file.data.length / 50_000));
      const limit = await this.planEnforcer.checkLimit(orgId, 'kbPages', estimatedPages);
      if (!limit.allowed) return { ok: false, status: limit.status || 402, body: {
        error: 'quota_reached', metric: 'kbPages', estimated_pages: estimatedPages,
      } };
    }

    const checksum = crypto.createHash('sha256').update(file.data).digest('hex');
    let job = await this.jobStore.findDuplicate({ orgId, scopeKey: scope.scopeKey, checksum });
    if (job?.status === 'ready') return { ok: false, status: 409, body: {
      error: 'duplicate_document', status: 'existing', job_id: job.id,
      existing_document_id: job.documentId, actions: ['view_existing', 'reprocess'],
    } };
    if (job && job.userId !== userId) {
      return { ok: false, status: 409, body: { error: 'upload_already_processing', status: 'processing' } };
    }
    if (job && !['failed', 'dead', 'cancelled'].includes(job.status)) {
      return { ok: true, existing: true, job };
    }

    const processingVersion = job ? job.processingVersion + 1 : 1;
    if (job) {
      await this.jobStore.updateOwned(job.id, orgId, {
        status: 'queued', stage: 'queued', progress: 0, processingVersion,
        attempt: 0, errorCode: null, errorMessage: null, completedAt: null,
      });
      job = await this.jobStore.findOwned(job.id, { orgId, userId });
    } else {
      job = await this.jobStore.create({
        orgId, userId, scopeType: scope.scopeType, scopeId: scope.scopeId,
        scopeKey: scope.scopeKey, storageMode, filename,
        contentType: file.contentType || 'application/octet-stream', mediaKind: validation.kind,
        checksum, status: 'queued', stage: 'queued', progress: 0, processingVersion,
        metadata: { ...metadata, project_ids: projectIds, primary_team_id: primaryTeamId },
      });
    }

    const filePath = this.queue.persistFile({ orgId, checksum, filename, fileBuffer: file.data });
    const queued = await this.queue.enqueue({
      userId, orgId, filename, contentType: file.contentType, checksum, filePath,
      trackerJobId: job.id, processingVersion,
      metadata: {
        ...metadata, media_kind: validation.kind, scope_type: scope.scopeType,
        scope_id: scope.scopeId, project_ids: projectIds, primary_team_id: primaryTeamId,
      },
    });
    if (queued.backpressure) {
      await this.jobStore.fail(job.id, orgId, Object.assign(new Error('Ingestion queue is saturated.'), { code: 'QUEUE_SATURATED' }));
      return { ok: false, status: 429, body: { error: 'queue_saturated', retry_after: 30 } };
    }
    await this.jobStore.updateOwned(job.id, orgId, { queueJobId: queued.queue_job_id });
    return { ok: true, job: await this.jobStore.findOwned(job.id, { orgId, userId }) };
  }
}
