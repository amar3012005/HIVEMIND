const STAGES = ['load', 'reconstruct', 'resolve', 'normalize', 'persist', 'reconcile', 'complete'];
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'FALLBACK_COMPLETED']);

export function projectionFailureCode(value, fallback = 'projection_failed') {
  const code = String(value || '').toLowerCase().match(/[a-z][a-z0-9_]{2,63}/)?.[0];
  return code || fallback;
}

export function projectionWorkflowInstanceId(memoryId, processingVersion) {
  return `claim-${memoryId}-v${processingVersion}`;
}

export function projectionAttemptStatus(attempt) {
  return {
    memory_id: attempt.memoryId,
    processing_version: attempt.processingVersion,
    mode: attempt.admittedMode,
    executor: attempt.executor,
    workflow_instance_id: attempt.workflowInstanceId,
    status: attempt.status,
    current_stage: attempt.currentStage,
    retry_count: attempt.retryCount,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
    completed_at: attempt.completedAt,
    failure_code: attempt.lastError || null,
  };
}

export async function admitProjectionAttempt({ prisma, memoryId, organizationId, processingVersion = 1, admittedMode, executor = 'cloudflare' }) {
  const workflowInstanceId = executor === 'cloudflare' ? projectionWorkflowInstanceId(memoryId, processingVersion) : null;
  try {
    const attempt = await prisma.memoryProjectionAttempt.create({ data: {
      memoryId, organizationId, processingVersion, admittedMode, executor, workflowInstanceId,
    } });
    return { attempt, reused: false };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const attempt = await prisma.memoryProjectionAttempt.findUnique({
      where: { memoryId_processingVersion: { memoryId, processingVersion } },
    });
    if (!attempt) throw error;
    return { attempt, reused: true };
  }
}

export async function beginProjectionStage({ prisma, memoryId, processingVersion, organizationId, admittedMode, stage }) {
  const attempt = await prisma.memoryProjectionAttempt.findUnique({
    where: { memoryId_processingVersion: { memoryId, processingVersion } },
  });
  if (!attempt || attempt.organizationId !== organizationId || attempt.admittedMode !== admittedMode || attempt.executor !== 'cloudflare') {
    return { accepted: false, reason: 'attempt_not_admitted' };
  }
  const receipts = attempt.stageReceipts && typeof attempt.stageReceipts === 'object' ? attempt.stageReceipts : {};
  if (receipts[stage]) return { accepted: false, duplicate: true, receipt: receipts[stage], attempt };
  if (TERMINAL.has(attempt.status)) return { accepted: false, reason: 'attempt_terminal', attempt };
  if (stage === 'failed') return { accepted: true, attempt };
  const expected = STAGES[STAGES.indexOf(stage) - 1] || null;
  const retryingSameStage = attempt.currentStage === stage && attempt.status === 'ACTIVE';
  if ((attempt.currentStage || null) !== expected && !retryingSameStage) return { accepted: false, reason: 'stale_stage', attempt };
  // Claim before expensive Core work. A second callback sees STAGE_RUNNING and
  // cannot materialize the same version concurrently; a failed attempt releases
  // back to ACTIVE so the Workflow retry can claim that exact stage again.
  if (typeof prisma.memoryProjectionAttempt.updateMany === 'function') {
    const claimed = await prisma.memoryProjectionAttempt.updateMany({
      where: { id: attempt.id, status: { in: ['ADMISSION_PENDING', 'ACTIVE'] }, currentStage: attempt.currentStage || null },
      data: { status: 'STAGE_RUNNING', currentStage: stage, startedAt: attempt.startedAt || new Date() },
    });
    if (claimed.count !== 1) return { accepted: false, reason: 'stage_busy', attempt };
  }
  return { accepted: true, attempt: { ...attempt, status: 'STAGE_RUNNING', currentStage: stage } };
}

export async function finishProjectionStage({ prisma, attempt, stage, receipt, failure = null }) {
  const receipts = { ...(attempt.stageReceipts && typeof attempt.stageReceipts === 'object' ? attempt.stageReceipts : {}), [stage]: receipt };
  const terminal = stage === 'complete' || stage === 'failed';
  return prisma.memoryProjectionAttempt.update({
    where: { id: attempt.id },
    data: {
      currentStage: stage,
      stageReceipts: receipts,
      status: stage === 'failed' ? 'FAILED' : (stage === 'complete' ? 'COMPLETED' : 'ACTIVE'),
      startedAt: attempt.startedAt || new Date(),
      completedAt: terminal ? new Date() : null,
      lastError: failure ? projectionFailureCode(failure) : null,
    },
  });
}

export async function releaseProjectionStage({ prisma, attempt, error }) {
  return prisma.memoryProjectionAttempt.update({
    where: { id: attempt.id },
    data: { status: 'ACTIVE', lastError: projectionFailureCode(error, 'stage_execution_failed') },
  });
}

export async function selectCoreFallback({ prisma, attempt, reason }) {
  if (attempt.executor !== 'cloudflare' || attempt.status !== 'ADMISSION_PENDING') return null;
  return prisma.memoryProjectionAttempt.update({
    where: { id: attempt.id },
    data: { executor: 'core_fallback', status: 'FALLBACK_ACTIVE', lastError: projectionFailureCode(reason, 'cloudflare_admission_rejected'), workflowInstanceId: null, startedAt: new Date() },
  });
}

export async function finishCoreFallback({ prisma, attempt, receipt }) {
  return prisma.memoryProjectionAttempt.update({
    where: { id: attempt.id },
    data: { status: 'FALLBACK_COMPLETED', currentStage: 'complete', stageReceipts: { complete: receipt }, completedAt: new Date(), lastError: null },
  });
}
