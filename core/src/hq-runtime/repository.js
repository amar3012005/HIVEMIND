import { assertHqTransition, normalizeAuthorityPolicy } from './contracts.js';

export async function getHqRuntime({ prisma, orgId }) {
  if (!orgId) throw new Error('hq_runtime_org_required');
  return prisma.hqRuntime.findUnique({ where: { orgId } });
}

export async function ensureHqRuntime({ prisma, orgId, userId, objective, authorityPolicy = {} }) {
  if (!orgId || !userId) throw new Error('hq_runtime_tenant_required');
  if (!String(objective || '').trim()) throw new Error('hq_runtime_objective_required');
  return prisma.hqRuntime.upsert({
    where: { orgId },
    create: {
      orgId, ownerUserId: userId, objective: String(objective).trim(),
      authorityPolicy: normalizeAuthorityPolicy(authorityPolicy),
    },
    update: {},
  });
}

export async function resetHqForCompanyReplacement({ prisma, orgId }) {
  if (!orgId) throw new Error('hq_runtime_org_required');
  const runtime = await getHqRuntime({ prisma, orgId });
  if (!runtime) return null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.hyperWorkOrder.updateMany({
      where: { orgId, hqCycleId: { not: null }, status: { in: ['queued', 'processing', 'running'] } },
      data: { status: 'cancelled', error: 'Company context was replaced during onboarding.', completedAt: now },
    });
    await tx.hqCapabilityRequest.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqTodo.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqInstruction.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqRuntimeEvent.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqSchedule.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqCycle.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqRuntime.update({
      where: { id: runtime.id },
      data: {
        state: 'INACTIVE', activeGoalId: null, activeStageId: null,
        currentCycleId: null, nextWakeAt: null, pauseReason: null,
        blockedReason: null, eventSequence: 0, activatedAt: null,
        version: { increment: 1 },
      },
    });
  });
  return getHqRuntime({ prisma, orgId });
}

export async function activateHqAfterOnboarding({ prisma, orgId, userId, objective, onboardedAt }) {
  if (!orgId || !userId) throw new Error('hq_runtime_tenant_required');
  const normalizedObjective = String(objective || '').trim();
  if (!normalizedObjective) throw new Error('hq_runtime_objective_required');
  const activatedAt = new Date();
  const runtime = await prisma.hqRuntime.upsert({
    where: { orgId },
    create: {
      orgId, ownerUserId: userId, objective: normalizedObjective,
      authorityPolicy: normalizeAuthorityPolicy({}), state: 'OBSERVING', activatedAt,
    },
    update: {
      ownerUserId: userId, objective: normalizedObjective, state: 'OBSERVING',
      activeGoalId: null, activeStageId: null, currentCycleId: null,
      nextWakeAt: null, pauseReason: null, blockedReason: null,
      activatedAt, version: { increment: 1 },
    },
  });
  const sourceStamp = String(onboardedAt || activatedAt.toISOString());
  const schedule = await scheduleHqWake({
    prisma, runtimeId: runtime.id, orgId,
    idempotencyKey: `onboarding_complete:${sourceStamp}`,
    triggerType: 'onboarding_complete', dueAt: activatedAt,
    payload: { onboarded_at: sourceStamp },
  });
  return { runtime: await getHqRuntime({ prisma, orgId }), schedule };
}

export async function appendHqEvent({ prisma, runtimeId, orgId, cycleId = null, eventType, title, summary, details = {}, skillRef = null, toolRef = null, workOrderId = null, evidenceRefs = [], visibility = 'USER' }) {
  if (!runtimeId || !orgId) throw new Error('hq_event_tenant_required');
  return prisma.$transaction(async (tx) => {
    const updated = await tx.hqRuntime.update({
      where: { id: runtimeId, orgId },
      data: { eventSequence: { increment: 1 }, version: { increment: 1 } },
      select: { eventSequence: true },
    });
    return tx.hqRuntimeEvent.create({
      data: { runtimeId, orgId, cycleId, sequence: updated.eventSequence, eventType, title, summary, details, skillRef, toolRef, workOrderId, evidenceRefs, visibility },
    });
  });
}

export async function transitionHqRuntime({ prisma, runtimeId, orgId, from, to, data = {} }) {
  assertHqTransition(from, to);
  const result = await prisma.hqRuntime.updateMany({
    where: { id: runtimeId, orgId, state: from },
    data: { ...data, state: to, version: { increment: 1 } },
  });
  if (result.count !== 1) throw new Error('hq_runtime_transition_conflict');
  return prisma.hqRuntime.findFirst({ where: { id: runtimeId, orgId } });
}

export async function createHqCycle({ prisma, runtimeId, orgId, idempotencyKey, triggerType, triggerPayload = {}, inputRefs = [] }) {
  return prisma.hqCycle.upsert({
    where: { orgId_idempotencyKey: { orgId, idempotencyKey } },
    create: { runtimeId, orgId, idempotencyKey, triggerType, triggerPayload, inputRefs },
    update: {},
  });
}

export async function scheduleHqWake({ prisma, runtimeId, orgId, idempotencyKey, triggerType, dueAt, payload = {} }) {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.hqSchedule.upsert({
      where: { orgId_idempotencyKey: { orgId, idempotencyKey } },
      create: { runtimeId, orgId, idempotencyKey, triggerType, dueAt, payload },
      update: {},
    });
    await tx.hqRuntime.updateMany({
      where: { id: runtimeId, orgId, OR: [{ nextWakeAt: null }, { nextWakeAt: { gt: dueAt } }] },
      data: { nextWakeAt: dueAt, version: { increment: 1 } },
    });
    return schedule;
  });
}
