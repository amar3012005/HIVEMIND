import crypto from 'node:crypto';
import { sanitizeKnowledgeJson } from './upload-contract.js';

const COMPLETE = 'succeeded';

function safeError(error) {
  return {
    errorCode: String(error?.code || 'INGEST_STAGE_FAILED').slice(0, 80),
    errorMessage: String(error?.message || error || 'Ingestion stage failed').slice(0, 2000),
  };
}

export function ingestStepDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sanitizeKnowledgeJson(value ?? null))).digest('hex');
}

export class KnowledgeIngestStepStore {
  constructor({ prisma, logger = console, leaseMs = 30 * 60 * 1000 } = {}) {
    this.prisma = prisma;
    this.logger = logger;
    this.leaseMs = Math.max(30_000, Number(leaseMs) || 30 * 60 * 1000);
  }

  _model() {
    const model = this.prisma?.knowledgeIngestStep;
    if (!model?.upsert || !model?.updateMany) {
      throw new Error('knowledgeIngestStep unavailable — apply the knowledge ingest workflow migration');
    }
    return model;
  }

  async get(identity) {
    return this._model().findUnique({
      where: { jobId_processingVersion_stageKey_shardKey: identity },
    });
  }

  async claim({ jobId, processingVersion, stageKey, shardKey = 'root', inputDigest = null }) {
    const identity = { jobId, processingVersion: Number(processingVersion) || 1, stageKey, shardKey };
    const model = this._model();
    const existing = await model.upsert({
      where: { jobId_processingVersion_stageKey_shardKey: identity },
      create: { ...identity, inputDigest, status: 'pending' },
      update: {},
    });
    if (existing.status === COMPLETE) {
      if (existing.inputDigest && inputDigest && existing.inputDigest !== inputDigest) {
        throw Object.assign(new Error(`Ingestion stage ${stageKey}/${shardKey} input changed within one processing version`), {
          code: 'INGEST_STAGE_INPUT_MISMATCH', retryable: false,
        });
      }
      return { acquired: false, complete: true, receipt: existing };
    }
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const leaseToken = crypto.randomUUID();
    const claimed = await model.updateMany({
      where: {
        ...identity,
        status: { not: COMPLETE },
        OR: [
          { status: { in: ['pending', 'failed'] } },
          { status: 'processing', leaseUntil: { lt: now } },
        ],
      },
      data: {
        status: 'processing', attempt: { increment: 1 }, inputDigest,
        leaseUntil, leaseToken, startedAt: now, completedAt: null, errorCode: null, errorMessage: null,
      },
    });
    if (!claimed.count) {
      return { acquired: false, complete: false, busy: true, receipt: await this.get(identity) };
    }
    return { acquired: true, complete: false, receipt: await this.get(identity) };
  }

  async succeed(identity, leaseToken, { outputRefs = {}, coverage = {} } = {}) {
    const now = new Date();
    const updated = await this._model().updateMany({
      where: { ...identity, status: 'processing', leaseToken },
      data: {
        status: COMPLETE, outputRefs: sanitizeKnowledgeJson(outputRefs),
        coverage: sanitizeKnowledgeJson(coverage), leaseUntil: null, leaseToken: null,
        completedAt: now, errorCode: null, errorMessage: null,
      },
    });
    if (!updated.count) {
      throw Object.assign(new Error(`Ingestion stage ${identity.stageKey}/${identity.shardKey} lease was superseded`), {
        code: 'INGEST_STAGE_LEASE_LOST', retryable: true,
      });
    }
    return this.get(identity);
  }

  async fail(identity, leaseToken, error) {
    await this._model().updateMany({
      where: { ...identity, status: 'processing', leaseToken },
      data: { status: 'failed', leaseUntil: null, leaseToken: null, ...safeError(error) },
    });
    return this.get(identity);
  }

  async run({ jobId, processingVersion, stageKey, shardKey = 'root', input = null }, work) {
    const identity = { jobId, processingVersion: Number(processingVersion) || 1, stageKey, shardKey };
    const claim = await this.claim({ ...identity, inputDigest: ingestStepDigest(input) });
    if (claim.complete) return { reused: true, receipt: claim.receipt, result: claim.receipt.outputRefs };
    if (!claim.acquired) {
      const error = Object.assign(new Error(`Ingestion stage ${stageKey}/${shardKey} is already leased`), {
        code: 'INGEST_STAGE_BUSY', retryable: true,
      });
      throw error;
    }
    try {
      const result = await work(claim.receipt);
      const receipt = await this.succeed(identity, claim.receipt.leaseToken, {
        outputRefs: result?.outputRefs || result || {},
        coverage: result?.coverage || {},
      });
      return { reused: false, receipt, result };
    } catch (error) {
      await this.fail(identity, claim.receipt.leaseToken, error).catch((failure) => {
        this.logger.warn?.(`[knowledge-workflow] could not record failed stage ${stageKey}: ${failure.message}`);
      });
      throw error;
    }
  }
}
