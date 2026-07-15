import { runWithOrg } from '../db/prisma.js';
import {
  DERIVATION_CONFIDENCE_THRESHOLD,
  hasVerifiedDerivationSource,
  validateDerivation,
} from './derivation-validator.js';

const EMPTY_RESULT = Object.freeze({ claimed: 0, completed: 0, rejected: 0, failed: 0 });

export async function processDerivationBatch({ prisma, engine, limit = 10, logger = console, validate = validateDerivation }) {
  if (!prisma?.derivationJob || !engine) return { ...EMPTY_RESULT };
  const jobs = await prisma.derivationJob.findMany({
    where: { status: 'queued' },
    include: {
      sourceMemory: {
        select: {
          id: true, userId: true, orgId: true, content: true, memoryType: true,
          sourceMessageId: true, sourceSessionId: true, sourceUrl: true,
          synthesisEvidenceIds: true,
          sourceMetadata: { select: { sourceId: true, sourceUrl: true, sourceType: true } },
          evidenceLinks: { select: { id: true }, take: 1 },
        },
      },
      targetMemory: { select: { id: true, userId: true, orgId: true, content: true, memoryType: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.min(50, limit)),
  });
  const result = { ...EMPTY_RESULT };
  for (const job of jobs) {
    const claim = await prisma.derivationJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'processing' },
    });
    if (claim.count !== 1) continue;
    result.claimed += 1;
    try {
      const orgId = job.sourceMemory?.orgId;
      const userId = job.sourceMemory?.userId;
      if (!orgId || !userId || job.targetMemory?.orgId !== orgId || job.targetMemory?.userId !== userId) {
        throw new Error('Derivation job scope mismatch');
      }
      if (!hasVerifiedDerivationSource(job.sourceMemory)) {
        await prisma.derivationJob.update({
          where: { id: job.id },
          data: {
            status: 'rejected', processedAt: new Date(),
            metadata: { ...(job.metadata || {}), validation: { approved: false, confidence: 0, reason: 'source_provenance_unverified' } },
          },
        });
        result.rejected += 1;
        continue;
      }
      if (Number(job.confidence) < DERIVATION_CONFIDENCE_THRESHOLD) {
        await prisma.derivationJob.update({
          where: { id: job.id },
          data: {
            status: 'rejected', processedAt: new Date(),
            metadata: { ...(job.metadata || {}), validation: { approved: false, confidence: Number(job.confidence) || 0, reason: 'candidate_confidence_below_threshold' } },
          },
        });
        result.rejected += 1;
        continue;
      }
      const verdict = await validate({ source: job.sourceMemory, target: job.targetMemory });
      if (!verdict.approved || verdict.confidence < DERIVATION_CONFIDENCE_THRESHOLD) {
        await prisma.derivationJob.update({
          where: { id: job.id },
          data: { status: 'rejected', processedAt: new Date(), metadata: { ...(job.metadata || {}), validation: verdict } },
        });
        result.rejected += 1;
        continue;
      }
      await runWithOrg(orgId, () => engine.applyDerives(job.sourceMemoryId, job.targetMemoryId, {
        user_id: userId,
        org_id: orgId,
        confidence: Math.min(Number(job.confidence) || 0, verdict.confidence),
        reason: job.metadata?.reason || 'Derives',
        async_verified: true,
        verification: verdict,
      }));
      await prisma.derivationJob.update({ where: { id: job.id }, data: { status: 'completed', processedAt: new Date(), metadata: { ...(job.metadata || {}), validation: verdict } } });
      result.completed += 1;
    } catch (error) {
      await prisma.derivationJob.update({
        where: { id: job.id },
        data: { status: 'failed', processedAt: new Date(), metadata: { ...(job.metadata || {}), error: String(error.message || error).slice(0, 500) } },
      }).catch(() => {});
      logger.warn?.(`[derivation-worker] job ${job.id} failed: ${error.message}`);
      result.failed += 1;
    }
  }
  return result;
}

export function startDerivationWorker({ prisma, engine, intervalMs = 5_000, limit = 10, logger = console }) {
  let active = false;
  const run = async () => {
    if (active) return;
    active = true;
    try { await processDerivationBatch({ prisma, engine, limit, logger }); }
    catch (error) { logger.warn?.(`[derivation-worker] batch failed: ${error.message}`); }
    finally { active = false; }
  };
  const timer = setInterval(run, Math.max(1_000, intervalMs));
  timer.unref?.();
  setTimeout(run, 250).unref?.();
  return () => clearInterval(timer);
}
