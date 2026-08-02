const TERMINAL = new Set(['ready', 'failed', 'dead', 'cancelled']);

export class KnowledgeUploadJobStore {
  constructor({ prisma, planEnforcer = null, logger = console }) {
    this.prisma = prisma;
    this.planEnforcer = planEnforcer;
    this.logger = logger;
  }

  async create(input) {
    return this.prisma.knowledgeIngestJob.create({ data: input });
  }

  async findOwned(jobId, { orgId, userId = null }) {
    if (!jobId || !orgId) return null;
    return this.prisma.knowledgeIngestJob.findFirst({ where: {
      id: jobId, orgId, ...(userId ? { userId } : {}),
    } });
  }

  async findDuplicate({ orgId, scopeKey, checksum }) {
    return this.prisma.knowledgeIngestJob.findFirst({
      where: { orgId, scopeKey, checksum }, orderBy: { createdAt: 'desc' },
    });
  }

  async updateOwned(jobId, orgId, data) {
    return this.prisma.knowledgeIngestJob.updateMany({ where: { id: jobId, orgId }, data });
  }

  async progress(jobId, orgId, stage, progress, extra = {}) {
    await this.updateOwned(jobId, orgId, { stage, progress: Math.max(0, Math.min(100, Number(progress) || 0)), ...extra });
  }

  async fail(jobId, orgId, error) {
    await this.prisma.knowledgeIngestJob.updateMany({
      where: { id: jobId, orgId, status: { notIn: [...TERMINAL] } }, data: {
      status: 'failed', stage: 'failed', progress: 100,
      errorCode: error?.code || 'INGEST_FAILED', errorMessage: String(error?.message || error || 'Ingestion failed').slice(0, 2000),
      completedAt: new Date(),
    } });
  }

  async complete(jobId, orgId, userId, result) {
    const updated = await this.prisma.knowledgeIngestJob.updateMany({
      where: { id: jobId, orgId, userId, status: { notIn: [...TERMINAL] } },
      data: {
        status: 'ready', stage: 'ready', progress: 100, documentId: result.documentId || null,
        memoryIds: result.promotedMemoryIds || [], pageCount: Math.max(1, Number(result.pages) || 1),
        segmentCount: Number(result.segmentCount) || 0, candidateCount: Number(result.candidateCount) || 0,
        promotedCount: Number(result.promotedCount) || 0, completedAt: new Date(), errorCode: null, errorMessage: null,
      },
    });
    if (!updated.count) {
      const existing = await this.findOwned(jobId, { orgId, userId });
      if (existing?.status !== 'ready' || existing.usageSettledAt) return false;
    }
    await this.settle(jobId, orgId, userId, 'uploads', 1);
    await this.settle(jobId, orgId, userId, 'kbPages', Math.max(1, Number(result.pages) || 1));
    await this.settle(jobId, orgId, userId, 'memories', Math.max(0, Number(result.promotedCount) || 0));
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
    return {
      job_id: job.id, status: job.status, stage: job.stage, progress: job.progress,
      document_id: job.documentId, memory_ids: job.memoryIds || [], storage_mode: job.storageMode,
      counts: { pages: job.pageCount, segments: job.segmentCount, candidates: job.candidateCount, memories: job.promotedCount },
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
      created_at: job.createdAt, updated_at: job.updatedAt, completed_at: job.completedAt,
    };
  }
}
