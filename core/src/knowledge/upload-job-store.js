const TERMINAL = new Set(['ready', 'failed', 'dead', 'cancelled']);
const LIVE_UPLOAD_STATUSES = ['queued', 'processing'];

function isUniqueViolation(error) {
  return error?.code === 'P2002' || error?.code === '23505';
}

export class KnowledgeUploadJobStore {
  constructor({ prisma, planEnforcer = null, creditService = null, logger = console }) {
    this.prisma = prisma;
    this.planEnforcer = planEnforcer;
    this.creditService = creditService;
    this.logger = logger;
  }


  /**
   * The prisma export is a CONTEXT PROXY, not a client. When the underlying
   * client is not yet bound its handler returns `undefined` for any model
   * (db/prisma.js: `if (!c) return undefined`), so `prisma.knowledgeIngestJob`
   * silently becomes undefined and `.updateMany(...)` throws
   *   "Cannot read properties of undefined (reading 'updateMany')"
   *
   * That is timing-dependent, which is why byte-identical source worked in one
   * build and killed three uploads into the DLQ in another (Solvis Personas_SHK,
   * Solvis_Branding_Projekt_Skizze, Solvis_Gemeinwohlbilanz — each dead after 3
   * attempts, 2026-08-02). Nothing about the ingest logic was wrong; the model
   * handle simply was not there yet.
   *
   * Resolve the model at CALL time and fail with a message that names the real
   * cause instead of a stray TypeError.
   */
  _model() {
    const m = this.prisma?.knowledgeIngestJob;
    if (!m || typeof m.updateMany !== 'function') {
      throw new Error('knowledgeIngestJob unavailable — prisma client not bound yet (retryable)');
    }
    return m;
  }

  async create(input) {
    return this._model().create({ data: input });
  }

  /**
   * Serialize same-source admission across API processes. The partial unique
   * index only covers live jobs; historical failed rows remain retryable via
   * the normal state machine without becoming a second active upload.
   */
  async createOrReuse(input) {
    try {
      return { job: await this.create(input), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const job = await this.findDuplicate({
        orgId: input.orgId, scopeKey: input.scopeKey, checksum: input.checksum,
      });
      if (!job) throw error;
      return { job, created: false };
    }
  }

  /**
   * Mark jobs failed that died without ever reaching a terminal state.
   *
   * A container recreate loses in-flight BullMQ jobs, but the row here stays as
   * it was — so a job sits `queued` or `processing` forever. Nothing times it
   * out, nothing retries it, nothing surfaces it: the user gets a spinner that
   * never resolves and an upload that silently never happened.
   *
   * Measured 2026-08-02: kb-canary-amr.md and kb-canary-hybrid.md had been
   * `queued` over FIVE HOURS (18086s / 18524s) having never started, and
   * BundB-Solvis_Pitch-Praesentation.pptx `processing` for two — all orphaned by
   * restarts during that session's deploys.
   *
   * Failing them is the honest outcome: an upload that will never finish should
   * say so, so the user can retry. Silence is the worst available option.
   *
   * Thresholds are deliberately generous — a 54-page enriched PDF legitimately
   * takes ~11 minutes and can wait behind others before it starts.
   */
  async reapStale({ queuedMaxMin = 90, processingMaxMin = 45, bootOrphanMin = 5, bootedAt = null } = {}) {
    const cutoff = (mins) => new Date(Date.now() - mins * 60_000);
    try {
      // A job created BEFORE this process booted, still non-terminal, has no
      // BullMQ job behind it — the worker died with the previous container. It
      // will never progress, so age it out in minutes rather than waiting for the
      // 90-minute generic threshold.
      //
      // Measured 2026-08-02: four uploads sat `queued` for 26 minutes with no
      // document and zero memories, orphaned by restarts during a deploy. Under
      // the generic threshold alone they would have shown a spinner for another
      // 64 minutes before failing. The user reasonably read that as "upload is
      // broken" — and functionally it was.
      const orphanClauses = bootedAt
        ? [{ status: { in: ['queued', 'processing'] }, documentId: null,
             createdAt: { lt: new Date(Math.min(bootedAt.getTime(), Date.now() - bootOrphanMin * 60_000)) } }]
        : [];
      const { count } = await this._model().updateMany({
        where: {
          OR: [
            { status: 'queued', createdAt: { lt: cutoff(queuedMaxMin) } },
            { status: 'processing', updatedAt: { lt: cutoff(processingMaxMin) } },
            ...orphanClauses,
          ],
        },
        data: {
          status: 'failed',
          stage: 'failed',
          errorCode: 'STALE_ABANDONED',
          errorMessage: 'Ingestion never completed — the worker was lost, most often a service '
            + 'restart mid-flight. Nothing was partially saved; re-upload to retry.',
          completedAt: new Date(),
        },
      });
      if (count > 0) {
        this.logger?.warn?.(`[upload-jobs] reaped ${count} stale ingest job(s) → failed `
          + '(user now sees a retryable error instead of a spinner that never resolves)');
      }
      return count;
    } catch (e) {
      this.logger?.warn?.(`[upload-jobs] reapStale failed: ${e.message}`);
      return 0;
    }
  }

  async findOwned(jobId, { orgId, userId = null }) {
    if (!jobId || !orgId) return null;
    return this._model().findFirst({ where: {
      id: jobId, orgId, ...(userId ? { userId } : {}),
    } });
  }

  async findDuplicate({ orgId, scopeKey, checksum }) {
    // scopeKey is REQUIRED by the upload path (a file may legitimately exist in
    // two scopes) but OPTIONAL for the pre-check, where the client only knows the
    // bytes. Passing null previously produced an invalid Prisma invocation, so
    // omit the key entirely rather than filtering on null — that widens the match
    // to "anywhere in this org", which is exactly what a pre-check should answer.
    // orgId is never omitted: the tenant boundary is not negotiable here.
    const where = { orgId, checksum };
    if (scopeKey !== null && scopeKey !== undefined) where.scopeKey = scopeKey;
    // Legacy retries can leave a newer failed row beside an older live row.
    // Always find the live source owner first; otherwise a second request can
    // miss the active work and enqueue a competing extraction.
    const model = this._model();
    const live = await model.findFirst({
      where: { ...where, status: { in: LIVE_UPLOAD_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (live) return live;
    return model.findFirst({ where, orderBy: { createdAt: 'desc' } });
  }

  async updateOwned(jobId, orgId, data) {
    return this._model().updateMany({ where: { id: jobId, orgId }, data });
  }

  async progress(jobId, orgId, stage, progress, extra = {}) {
    await this._model().updateMany({
      where: { id: jobId, orgId, status: { notIn: [...TERMINAL] } },
      data: {
        // A job that is REPORTING A STAGE is being worked on, so `status` must say
        // so. This wrote stage+progress but never touched status, which therefore
        // stayed 'queued' from creation until the terminal write. Measured on a live
        // ingest: stage went parsing(10) -> promoting(80) while status sat at
        // 'queued' the whole time, so every consumer that reads status — the upload
        // row, which falls back to the status label whenever a poll frame omits
        // stage, and any API client — was told the document was still waiting for a
        // worker while it was actively being extracted.
        //
        // This is also the documented contract: queued -> processing -> done.
        // The where-clause already excludes TERMINAL, so a finished, failed or
        // cancelled job can never be dragged back into 'processing'. `extra` is
        // spread last so an explicit caller-supplied status still wins.
        status: 'processing',
        stage,
        progress: Math.max(0, Math.min(100, Number(progress) || 0)),
        ...extra,
      },
    });
  }

  async fail(jobId, orgId, error) {
    const before = await this.findOwned(jobId, { orgId });
    await this._model().updateMany({
      where: { id: jobId, orgId, status: { notIn: [...TERMINAL] } }, data: {
      status: 'failed', stage: 'failed', progress: 100,
      errorCode: error?.code || 'INGEST_FAILED', errorMessage: String(error?.message || error || 'Ingestion failed').slice(0, 2000),
      completedAt: new Date(),
    } });
    if (this.creditService) await this.creditService.release({ orgId, idempotencyKey: `knowledge-credit:${jobId}:${before?.processingVersion || 1}` }).catch(() => {});
  }

  async complete(jobId, orgId, userId, result) {
    const jobBefore = await this.findOwned(jobId, { orgId, userId });
    if (jobBefore?.status === 'ready' && jobBefore.usageSettledAt) return false;
    if (this.creditService) {
      const pages = Math.max(1, Number(result.pages) || 1);
      const service = jobBefore?.ingestMode === 'evidence' ? 'knowledge_page_evidence' : 'knowledge_page_both';
      const creditKey = `knowledge-credit:${jobId}:${jobBefore?.processingVersion || 1}`;
      const adjusted = await this.creditService.adjustReservation({ orgId, idempotencyKey: creditKey, service, units: pages });
      if (!adjusted.admitted && adjusted.admitted !== undefined) {
        throw Object.assign(new Error('Monthly credits exhausted before upload settlement.'), { code: 'CREDITS_EXHAUSTED' });
      }
    }
    const updated = await this._model().updateMany({
      where: { id: jobId, orgId, userId, status: { notIn: [...TERMINAL] } },
      data: {
        status: 'ready', stage: 'ready', progress: 100, documentId: result.documentId || null,
        memoryIds: result.promotedMemoryIds || [], pageCount: Math.max(1, Number(result.pages) || 1),
        segmentCount: Number(result.segmentCount) || 0, candidateCount: Number(result.candidateCount) || 0,
        promotedCount: Number(result.promotedCount) || 0,
        evidenceOnlyReason: result.evidenceOnlyReason || null,
        completedAt: new Date(), errorCode: null, errorMessage: null,
      },
    });
    if (!updated.count) {
      const existing = await this.findOwned(jobId, { orgId, userId });
      if (existing?.status !== 'ready' || existing.usageSettledAt) return false;
    }
    await this.settle(jobId, orgId, userId, 'uploads', 1);
    await this.settle(jobId, orgId, userId, 'kbPages', Math.max(1, Number(result.pages) || 1));
    await this.settle(jobId, orgId, userId, 'memories', Math.max(0, Number(result.promotedCount) || 0));
    if (this.creditService) await this.creditService.settle({ orgId, idempotencyKey: `knowledge-credit:${jobId}:${jobBefore?.processingVersion || 1}` });
    await this.updateOwned(jobId, orgId, { usageSettledAt: new Date() });
    return true;
  }

  async settle(jobId, orgId, userId, metric, amount) {
    if (!this.planEnforcer || amount <= 0) return;
    try {
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO "knowledge_usage_settlements" ("org_id", "user_id", "job_id", "metric", "amount")
        VALUES (${orgId}::uuid, ${userId}::uuid, ${jobId}::uuid, ${metric}, ${BigInt(amount)})
        ON CONFLICT ("job_id", "metric") DO NOTHING`;
      if (Number(inserted) === 1) {
        this.planEnforcer.recordUsage(orgId, metric, amount, { feature: 'knowledge-upload', userId });
      }
    } catch (error) {
      this.logger.error?.(`[knowledge-usage] settlement failed job=${jobId} metric=${metric}: ${error.message}`);
      throw error;
    }
  }

  static response(job) {
    if (!job) return null;
    const ready = job.status === 'ready';
    const evidenceOnly = ready && Number(job.segmentCount || 0) > 0 && Number(job.promotedCount || 0) === 0;
    const ingestMode = job.ingestMode === 'evidence' || job.metadata?.ingest_mode === 'evidence'
      ? 'evidence'
      : 'both';
    return {
      job_id: job.id, status: job.status, stage: ready ? 'ready' : job.stage, progress: ready ? 100 : job.progress,
      document_id: job.documentId, memory_ids: job.memoryIds || [], storage_mode: job.storageMode,
      ingest_mode: ingestMode, evidence_only: evidenceOnly,
      evidence_only_reason: evidenceOnly ? (job.evidenceOnlyReason || 'extraction_yield_zero') : null,
      memory_generation_failed: ready && job.evidenceOnlyReason === 'promotion_failed',
      counts: { pages: job.pageCount, segments: job.segmentCount, candidates: job.candidateCount, memories: job.promotedCount },
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
      created_at: job.createdAt, updated_at: job.updatedAt, completed_at: job.completedAt,
    };
  }
}
