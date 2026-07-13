import { runWithOrg } from '../db/prisma.js';
import { validateDerivation } from './derivation-validator.js';

export async function processDerivationBatch({ prisma, engine, limit = 10, logger = console, validate = validateDerivation }) {
  if (!prisma?.derivationJob || !engine) return { claimed: 0, completed: 0, rejected: 0, failed: 0 };
  const jobs = await prisma.derivationJob.findMany({
    where: { status: 'queued' },
    include: {
      sourceMemory: { select: { userId: true, orgId: true, content: true, memoryType: true } },
      targetMemory: { select: { userId: true, orgId: true, content: true, memoryType: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.min(50, limit)),
  });
  let claimed = 0;
  let completed = 0;
  let rejected = 0;
  let failed = 0;
  for (const job of jobs) {
    const claim = await prisma.derivationJob.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'processing' },
    });
    if (claim.count !== 1) continue;
    claimed += 1;
    try {
      const orgId = job.sourceMemory?.orgId;
      const userId = job.sourceMemory?.userId;
      if (!orgId || !userId || job.targetMemory?.orgId !== orgId || job.targetMemory?.userId !== userId) {
        throw new Error('Derivation job scope mismatch');
      }
      const verdict = await validate({ source: job.sourceMemory, target: job.targetMemory });
      if (!verdict.approved || verdict.confidence < 0.75) {
        await prisma.derivationJob.update({
          where: { id: job.id },
          data: {
            status: 'rejected',
            processedAt: new Date(),
            metadata: { ...(job.metadata || {}), validation: verdict },
          },
        });
        rejected += 1;
        continue;
      }
      await runWithOrg(orgId, () => engine.applyDerives(job.sourceMemoryId, job.targetMemoryId, {
        user_id: userId,
        org_id: orgId,
        confidence: Math.min(job.confidence, verdict.confidence),
        reason: job.metadata?.reason || 'Derives',
        async_verified: true,
      }));
      await prisma.derivationJob.update({
        where: { id: job.id },
        data: { status: 'completed', processedAt: new Date() },
      });
      completed += 1;
    } catch (error) {
      await prisma.derivationJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          processedAt: new Date(),
          metadata: { ...(job.metadata || {}), error: String(error.message || error).slice(0, 500) },
        },
      }).catch(() => {});
      logger.warn?.(`[derivation-worker] job ${job.id} failed: ${error.message}`);
      failed += 1;
    }
  }
  return { claimed, completed, rejected, failed };
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
