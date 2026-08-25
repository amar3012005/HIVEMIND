import crypto from 'node:crypto';
import { authorizeKnowledgeScope } from './upload-authorization.js';
import {
  normalizeKnowledgeIngestMode,
  safeUploadFilename,
  sanitizeKnowledgeJson,
  uploadError,
  validateKnowledgeFile,
  withKnowledgeUploadQuotaDetails,
} from './upload-contract.js';
import { countPages } from './page-count.js';
import { orgIsRemote } from '../vector/mneme/driver.js';
import { planLimitBody } from '../billing/limit-response.js';

const ACTIVE_UPLOAD_STATUSES = new Set(['queued', 'processing']);
const KB_INGEST_VERBOSE = String(process.env.KB_INGEST_VERBOSE || '').toLowerCase() === 'true';

function jobIngestMode(job) {
  const normalized = normalizeKnowledgeIngestMode(job?.ingestMode ?? job?.metadata?.ingest_mode);
  return normalized.ok ? normalized.value : 'both';
}

function ingestModeMismatchBody({ job, requestedMode }) {
  const actualMode = jobIngestMode(job);
  return {
    error: 'ingest_mode_mismatch',
    code: 'INGEST_MODE_MISMATCH',
    message: `This upload is already ${job?.status || 'processing'} as ${actualMode}; it cannot be changed to ${requestedMode} mid-flight.`,
    requested_ingest_mode: requestedMode,
    actual_ingest_mode: actualMode,
    job_id: job?.id || null,
    status: job?.status || 'processing',
  };
}

export class KnowledgeUploadService {
  constructor({ prisma, queue, jobStore, planEnforcer, creditService = null, storageReady, isRemoteOrg = orgIsRemote }) {
    this.prisma = prisma;
    this.queue = queue;
    this.jobStore = jobStore;
    this.planEnforcer = planEnforcer;
    this.creditService = creditService;
    this.storageReady = storageReady;
    this.isRemoteOrg = isRemoteOrg;
  }

  async admit({ userId, orgId, file, targetScope, projectIds, primaryTeamId, metadata, force = false,
    ingestMode: requestedIngestMode = undefined }) {
    const filename = safeUploadFilename(file.filename);
    const validation = validateKnowledgeFile({
      filename, contentType: file.contentType, bytes: file.data?.length, buffer: file.data,
    });
    if (!validation.ok) return { ok: false, ...uploadError(validation.code, { limits: validation.limits }) };
    const requested = normalizeKnowledgeIngestMode(requestedIngestMode ?? metadata?.ingest_mode);
    if (!requested.ok) return { ok: false, status: 400, body: {
      error: 'invalid_ingest_mode', code: 'INVALID_INGEST_MODE', message: 'ingestMode must be both or evidence.',
    } };
    const ingestMode = requested.value;
    const safeMetadata = sanitizeKnowledgeJson({
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      ingest_mode: ingestMode,
    });
    if (validation.kind === 'image' && ingestMode === 'evidence') {
      return { ok: false, status: 400, body: {
        error: 'evidence_mode_unsupported_for_image',
        message: 'Images use the vision-to-memory pipeline and currently support ingestMode=both only.',
      } };
    }

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

    const estimatedPages = await this._estimatePages(file, validation);
    if (this.planEnforcer) {
      const limit = await this.planEnforcer.checkLimit(orgId, 'kbPages', estimatedPages);
      if (!limit.allowed) return { ok: false, status: limit.status || 402, body: {
        ...withKnowledgeUploadQuotaDetails(planLimitBody(limit, 'kbPages'), {
          metric: 'kbPages', estimatedPages, ingestMode,
        }),
      } };
    }

    const checksum = crypto.createHash('sha256').update(file.data).digest('hex');
    let job = await this.jobStore.findDuplicate({ orgId, scopeKey: scope.scopeKey, checksum });
    // A file already ingested successfully is NOT a failure — it is the best
    // possible outcome. The FE branches on `duplicate` (KnowledgeBase.jsx checks
    // `err.response.status === 409 && err.response.data.duplicate`) to render
    // "already in this scope" with an Upload-anyway action. This body never set
    // that flag, so every previously-ingested file rendered as a red **Failed**
    // row. Observed on a real batch: B&B_Solvis_Kick-Off.docx, Brandind Skizze
    // (1).pdf, BundB-Solvis-Budget.pdf and Dachmarke (1).pdf all showed "Failed"
    // while holding 10, 2, 18 and 7 memories respectively.
    // `message` is included because the FE prefers it over the raw error code.
    // A ready job row OUTLIVES its document. Deleting a document removes the
    // document, its segments and its memories, but not the ingest job — so this
    // reported "already in your knowledge base" for a file the user had just
    // deleted, and there was no way to ingest it again. Verified: deleting
    // BundB-Solvis-Budget.pdf removed all 31 memories, and the very next upload of
    // the same bytes came back duplicate_document.
    //
    // Confirm the document still exists before claiming the file is present. Same
    // check the /upload/precheck route already makes; the two must agree or the
    // pre-flight says "go" and the upload then refuses.
    let _readyDocLives = false;
    if (job?.status === 'ready') {
      if (!job.documentId) {
        _readyDocLives = false; // ready with no document to point at — nothing to reuse
      } else if (this.isRemoteOrg(orgId)) {
        // A self-hosted document is deliberately absent from central Prisma.
        // Treat its durable job reference as live here: a central lookup would
        // otherwise turn every normal AMR re-upload into an accidental
        // re-ingest. Explicit force handles remote cleanup in the worker.
        _readyDocLives = true;
      } else if (job.mediaKind === 'image' && this.prisma?.memory) {
        // Image ingestion intentionally creates one canonical Memory and no
        // KnowledgeDocument. Treating documentId as a document lookup therefore
        // returned false and re-ran vision on every retry, creating duplicate
        // image memories. For image jobs the durable output id is the memory id.
        try {
          _readyDocLives = !!(await this.prisma.memory.findFirst({
            where: { id: job.documentId, orgId, deletedAt: null }, select: { id: true },
          }));
        } catch { _readyDocLives = true; }
      } else if (this.prisma?.knowledgeDocument) {
        try {
          _readyDocLives = !!(await this.prisma.knowledgeDocument.findFirst({
            where: { id: job.documentId, orgId }, select: { id: true },
          }));
        } catch { _readyDocLives = true; } // lookup failed — keep the old, safer behaviour
      } else {
        _readyDocLives = true;
      }
    }
    // An evidence-only document already crossed the durable evidence boundary.
    // Asking for `both` later is a promotion of those stored segments, never a
    // second extraction of the original bytes.
    const existingMode = jobIngestMode(job);
    const promoteExistingEvidence = job?.status === 'ready' && _readyDocLives
      && existingMode === 'evidence' && ingestMode === 'both';
    if (job?.status === 'ready' && _readyDocLives && !force && !promoteExistingEvidence) return { ok: false, status: 409, body: {
      error: 'duplicate_document',
      duplicate: true,
      message: 'Already in your knowledge base — this exact file was ingested before.',
      existing_title: job.filename || null,
      status: 'existing', job_id: job.id,
      existing_document_id: job.documentId, actions: ['view_existing', 'reprocess'],
    } };
    // Ready job whose document is gone: treat it as re-ingestable. Falling through
    // reuses the existing row via the processingVersion bump below, so the retry
    // path and this path stay one state machine.
    const _reingestDeleted = job?.status === 'ready' && !_readyDocLives;
    if (_reingestDeleted) {
      if (KB_INGEST_VERBOSE) {
        console.log(`[upload] re-ingesting ${file.filename}: ready job ${job.id} points at a deleted document`);
      }
    }
    if (job?.userId && job.userId !== userId) {
      return { ok: false, status: 409, body: { error: 'upload_already_processing', status: 'processing' } };
    }
    // The source bytes/scope identify one live upload. A second request must
    // either observe that job or wait for it to become terminal; force cannot
    // enqueue a second worker while the first may still create a document.
    if (job && ACTIVE_UPLOAD_STATUSES.has(job.status)) {
      if (existingMode !== ingestMode) {
        return { ok: false, status: 409, body: ingestModeMismatchBody({ job, requestedMode: ingestMode }) };
      }
      return { ok: true, existing: true, job };
    }
    // `_reingestDeleted` must bypass this guard too: 'ready' is not terminal, so
    // without it a ready-but-deleted job returns existing:true here and the
    // re-ingest never happens — the branch above would be dead code.
    if (job && !force && !_reingestDeleted && !promoteExistingEvidence && !['failed', 'dead', 'cancelled'].includes(job.status)) {
      return { ok: true, existing: true, job };
    }

    const processingVersion = job ? Number(job.processingVersion || 1) + 1 : 1;
    // A ready-but-deleted job is reset exactly like a failed one, so both paths
    // share one state machine (see /api/knowledge/jobs/retry).
    if (job) {
      // Reprocessing preserves the canonical document identity. Central stores
      // reuse its idempotent document/segment rows; self-hosted stores receive
      // the same document id and replace its derived rows before regeneration.
      // This turns evidence-only uploads into `both` without duplicate docs.
      const reprocessMetadata = {
        ...(job.metadata && typeof job.metadata === 'object' ? job.metadata : {}),
        ...safeMetadata,
        project_ids: projectIds,
        primary_team_id: primaryTeamId,
        force_reprocess: !!force,
        ...(force && job.documentId ? { reprocess_document_id: job.documentId } : {}),
        ...(promoteExistingEvidence ? {
          promotion_existing_evidence: true,
          promotion_document_id: job.documentId,
          original_ingest_mode: existingMode,
        } : {}),
      };
      await this.jobStore.updateOwned(job.id, orgId, {
        status: 'queued', stage: 'queued', progress: 0, processingVersion,
        attempt: 0, errorCode: null, errorMessage: null, completedAt: null,
        ingestMode,
        metadata: sanitizeKnowledgeJson(reprocessMetadata),
      });
      job = await this.jobStore.findOwned(job.id, { orgId, userId });
    } else {
      const admitted = await this.jobStore.createOrReuse({
        orgId, userId, scopeType: scope.scopeType, scopeId: scope.scopeId,
        scopeKey: scope.scopeKey, storageMode, filename,
        contentType: file.contentType || 'application/octet-stream', mediaKind: validation.kind,
        checksum, ingestMode, status: 'queued', stage: 'queued', progress: 0, processingVersion,
        metadata: sanitizeKnowledgeJson({ ...safeMetadata, project_ids: projectIds, primary_team_id: primaryTeamId }),
      });
      job = admitted.job;
      // A concurrent identical request won the durable insert. It owns the
      // queue operation; returning its job is idempotent and prevents a second
      // persisted file, reservation, and enqueue.
      if (!admitted.created) {
        if (job?.userId && job.userId !== userId) {
          return { ok: false, status: 409, body: { error: 'upload_already_processing', status: 'processing' } };
        }
        if (jobIngestMode(job) !== ingestMode) {
          return { ok: false, status: 409, body: ingestModeMismatchBody({ job, requestedMode: ingestMode }) };
        }
        return { ok: true, existing: true, job };
      }
    }

    if (this.creditService) {
      const service = ingestMode === 'evidence' ? 'knowledge_page_evidence' : 'knowledge_page_both';
      const credit = await this.creditService.reserve({
        orgId, userId, service, units: estimatedPages, source: 'knowledge_upload',
        idempotencyKey: `knowledge-credit:${job.id}:${processingVersion}`,
        metadata: { job_id: job.id, ingest_mode: ingestMode, estimated_pages: estimatedPages },
      });
      if (!credit.admitted) {
        await this.jobStore.fail(job.id, orgId, Object.assign(new Error('Monthly credits exhausted.'), { code: 'CREDITS_EXHAUSTED' }));
        return { ok: false, status: 402, body: withKnowledgeUploadQuotaDetails(
          planLimitBody(credit.check, 'credits'), { metric: 'credits', estimatedPages, ingestMode },
        ) };
      }
    }

    try {
      const promotionOnly = promoteExistingEvidence && !!job.documentId;
      const filePath = promotionOnly ? null : this.queue.persistFile({ orgId, checksum, filename, fileBuffer: file.data });
      const queued = await this.queue.enqueue({
        userId, orgId, filename, contentType: file.contentType, checksum, filePath,
        trackerJobId: job.id, processingVersion,
        metadata: sanitizeKnowledgeJson({
          ...safeMetadata, media_kind: validation.kind, scope_type: scope.scopeType,
          scope_id: scope.scopeId, project_ids: projectIds, primary_team_id: primaryTeamId,
          force_reprocess: !!force,
          ...(force && job.documentId ? { reprocess_document_id: job.documentId } : {}),
          ...(promotionOnly ? {
            promotion_existing_evidence: true,
            promotion_document_id: job.documentId,
            original_ingest_mode: 'evidence',
          } : {}),
        }),
      });
      if (queued.backpressure) {
        await this.jobStore.fail(job.id, orgId, Object.assign(new Error('Ingestion queue is saturated.'), { code: 'QUEUE_SATURATED' }));
        return { ok: false, status: 429, body: { error: 'queue_saturated', retry_after: 30 } };
      }
      await this.jobStore.updateOwned(job.id, orgId, { queueJobId: queued.queue_job_id });
      return { ok: true, job: await this.jobStore.findOwned(job.id, { orgId, userId }) };
    } catch (error) {
      await this.jobStore.fail(job.id, orgId, error).catch(() => {});
      throw error;
    }
  }

  /**
   * Estimate how many plan "pages" an upload consumes, per media kind — never
   * by raw bytes. The old value `Math.ceil(file.data.length / 50_000)` is a
   * byte heuristic with no basis in the plan's unit: a 3 MB image was billed
   * as ~62 pages (and 402'd a Free org that was well within a 1-page image's
   * allowance), while a 500 KB markdown file billed as 10. The durable
   * counter (settled after ingest) uses the REAL parsed page count; this
   * pre-admit estimate only needs to be accurate enough to not false-block.
   *
   * - image            → 1  (an image is one thing = one page, by definition)
   * - pdf              → real page count (cheap header/count read, same lib the
   *                      parser uses); fall back to 1 if it cannot be read
   * - other documents  → 1  at admit (office/text pages aren't knowable before
   *                      parsing; the durable counter settles the real value)
   */
  async _estimatePages(file, validation) {
    const kind = validation?.kind;
    if (kind === 'image' || String(file?.contentType || '').toLowerCase().startsWith('image/')) {
      return 1;
    }
    // ONE counter for admit and settle. This used to inline a PDF-only count and
    // return 1 for everything else, so the kbPages limit was unenforceable for
    // every PPTX/DOCX/XLSX — a 15-slide deck was admitted as "1 page" and later
    // billed 5 (the count of distinct SEGMENTED pages). countPages reads the real
    // unit out of the container; null means genuinely unknowable (see that file),
    // and 1 remains the honest floor for the admit check.
    const real = await countPages(file?.data, file?.filename);
    return Number.isFinite(real) && real > 0 ? real : 1;
  }

  /** A response-only page estimate for admission rejections before a job exists. */
  async estimatePages(file) {
    const filename = safeUploadFilename(file?.filename);
    const validation = validateKnowledgeFile({
      filename, contentType: file?.contentType, bytes: file?.data?.length, buffer: file?.data,
    });
    if (!validation.ok) return null;
    return this._estimatePages({ ...file, filename }, validation);
  }
}
