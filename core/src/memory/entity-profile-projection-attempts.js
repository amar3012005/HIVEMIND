import crypto from 'node:crypto';

export function entityProfileWorkflowInstanceId(entityId, watermark) {
  return `entity-profile-${entityId}-${crypto.createHash('sha256').update(String(watermark)).digest('hex').slice(0, 24)}`;
}

export async function admitEntityProfileAttempt({ prisma, organizationId, entityId, sourceWatermark, admittedMode }) {
  const workflowInstanceId = entityProfileWorkflowInstanceId(entityId, sourceWatermark);
  try {
    const attempt = await prisma.entityProfileProjectionAttempt.create({ data: { organizationId, entityId, sourceWatermark, admittedMode, workflowInstanceId } });
    return { attempt, reused: false };
  } catch (error) {
    if (error?.code !== 'P2002') throw error;
    const attempt = await prisma.entityProfileProjectionAttempt.findUnique({ where: { entityId_sourceWatermark: { entityId, sourceWatermark } } });
    if (!attempt) throw error;
    return { attempt, reused: true };
  }
}

export async function completeEntityProfileAttempt({ prisma, attempt, receipt }) {
  return prisma.entityProfileProjectionAttempt.update({ where: { id: attempt.id }, data: { status: 'COMPLETED', stageReceipts: { complete: receipt }, completedAt: new Date(), lastError: null } });
}

export async function failEntityProfileAttempt({ prisma, attempt, error }) {
  return prisma.entityProfileProjectionAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED', lastError: String(error?.message || error || 'projection_failed').slice(0, 256) } });
}
