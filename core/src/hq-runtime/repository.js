import crypto from 'node:crypto';
import { assertHqTransition, normalizeAuthorityPolicy } from './contracts.js';

export const FIRST_LIFE_OBJECTIVE = 'Derive company priorities from current evidence and the user operating requirements.';

export async function getHqRuntime({ prisma, orgId }) {
  if (!orgId) throw new Error('hq_runtime_org_required');
  return prisma.hqRuntime.findUnique({ where: { orgId } });
}

export async function ensureHqRuntime({ prisma, orgId, userId, objective, authorityPolicy = {} }) {
  if (!orgId || !userId) throw new Error('hq_runtime_tenant_required');
  if (!String(objective || '').trim()) throw new Error('hq_runtime_objective_required');
  const current = await prisma.hqRuntime.findUnique({ where: { orgId }, select: { authorityPolicy: true } });
  const mergedAuthorityPolicy = normalizeAuthorityPolicy({
    ...(current?.authorityPolicy || {}),
    ...authorityPolicy,
  });
  return prisma.hqRuntime.upsert({
    where: { orgId },
    create: {
      orgId, ownerUserId: userId, objective: String(objective).trim(),
      authorityPolicy: mergedAuthorityPolicy,
    },
    update: {
      ownerUserId: userId, objective: String(objective).trim(),
      authorityPolicy: mergedAuthorityPolicy,
    },
  });
}

export async function resetHqForCompanyReplacement({ prisma, orgId }) {
  if (!orgId) throw new Error('hq_runtime_org_required');
  const runtime = await getHqRuntime({ prisma, orgId });
  if (!runtime) return null;
  const now = new Date();
  const nextEpoch = crypto.randomUUID();
  await prisma.$transaction(async (tx) => {
    // Reset is a hard operating boundary. Delete derived Runtime work and growth
    // history rather than leaving cancelled rows that a fresh context can read.
    // The immutable audit ledger and tenant connector credentials are separate.
    await tx.hyperWorkResult.deleteMany({
      where: { workOrderId: { in: (await tx.hyperWorkOrder.findMany({
        where: { orgId, hqCycleId: { not: null } }, select: { id: true },
      })).map((row) => row.id) } },
    });
    await tx.hyperWorkOrder.deleteMany({ where: { orgId, hqCycleId: { not: null } } });
    await tx.hyperTurn.deleteMany({
      where: { room: { orgId }, OR: [
        { idempotencyKey: { startsWith: 'hq-wo:' } },
        { idempotencyKey: { startsWith: 'growth-plan:' } },
      ] },
    });
    await tx.growthJournal.deleteMany({ where: { orgId } });
    await tx.growthHypothesis.deleteMany({ where: { orgId } });
    await tx.growthDelegation.deleteMany({ where: { orgId } });
    await tx.growthStage.deleteMany({ where: { orgId } });
    await tx.growthGoal.deleteMany({ where: { orgId } });
    await tx.knowledgeDocument.deleteMany({
      where: { orgId, sourceArtifact: { sourcePlatform: { startsWith: 'growth_' } } },
    });
    await tx.sourceArtifact.deleteMany({ where: { orgId, sourcePlatform: { startsWith: 'growth_' } } });
    await tx.runtimePlaybookRun.deleteMany({ where: { orgId } });
    await tx.hqWorkflow.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqCapabilityRequest.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqTodo.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqInstruction.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqRuntimeEvent.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqSchedule.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqCycle.deleteMany({ where: { runtimeId: runtime.id, orgId } });
    await tx.hqRuntime.update({
      where: { id: runtime.id },
      data: {
        epoch: nextEpoch,
        objective: FIRST_LIFE_OBJECTIVE,
        state: 'INACTIVE', activeGoalId: null, activeStageId: null,
        currentCycleId: null, nextWakeAt: null, pauseReason: null,
        blockedReason: null, eventSequence: 0, activatedAt: null,
        version: { increment: 1 },
      },
    });
  });
  const [events, schedules, cycles, todos, instructions, capabilities, workflows, playbookRuns, growthArtifacts, growthGoals, workOrders] = await Promise.all([
    prisma.hqRuntimeEvent.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqSchedule.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqCycle.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqTodo.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqInstruction.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqCapabilityRequest.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.hqWorkflow.count({ where: { runtimeId: runtime.id, orgId } }),
    prisma.runtimePlaybookRun.count({ where: { orgId } }),
    prisma.sourceArtifact.count({ where: { orgId, sourcePlatform: { startsWith: 'growth_' } } }),
    prisma.growthGoal.count({ where: { orgId } }),
    prisma.hyperWorkOrder.count({ where: { orgId, hqCycleId: { not: null } } }),
  ]);
  const verification = { events, schedules, cycles, todos, instructions, capabilities, workflows, playbookRuns, growthArtifacts, growthGoals, workOrders };
  if (Object.values(verification).some((count) => count !== 0)) {
    throw new Error(`hq_runtime_reset_verification_failed:${JSON.stringify(verification)}`);
  }
  const reset = await getHqRuntime({ prisma, orgId });
  return { ...reset, resetVerification: verification };
}

export async function activateHqAfterOnboarding({ prisma, orgId, userId, objective, onboardedAt }) {
  if (!orgId || !userId) throw new Error('hq_runtime_tenant_required');
  const normalizedObjective = String(objective || FIRST_LIFE_OBJECTIVE).trim();
  const runtime = await prisma.hqRuntime.upsert({
    where: { orgId },
    create: {
      orgId, ownerUserId: userId, objective: normalizedObjective,
      authorityPolicy: normalizeAuthorityPolicy({}), state: 'INACTIVE', activatedAt: null,
    },
    update: {
      ownerUserId: userId, objective: normalizedObjective, state: 'INACTIVE',
      activeGoalId: null, activeStageId: null, currentCycleId: null,
      nextWakeAt: null, pauseReason: null, blockedReason: null,
      activatedAt: null, version: { increment: 1 },
    },
  });
  return { runtime: await getHqRuntime({ prisma, orgId }), schedule: null, onboardedAt };
}

export async function appendHqEvent({ prisma, runtimeId, orgId, runtimeEpoch = null, cycleId = null, eventType, title, summary, details = {}, skillRef = null, toolRef = null, workOrderId = null, evidenceRefs = [], visibility = 'USER' }) {
  if (!runtimeId || !orgId) throw new Error('hq_event_tenant_required');
  return prisma.$transaction(async (tx) => {
    // Runtime events can arrive concurrently from the scheduler, a Room result,
    // and provider callbacks. Lock the Runtime row and reconcile against the
    // append-only ledger before assigning the next sequence.
    const locked = await tx.$queryRawUnsafe(
      `SELECT epoch, event_sequence
         FROM hivemind.hq_runtimes
        WHERE id = $1::uuid AND org_id = $2::uuid
        FOR UPDATE`,
      runtimeId, orgId,
    );
    if (!locked.length || (runtimeEpoch && String(locked[0].epoch) !== String(runtimeEpoch))) {
      throw new Error('hq_runtime_event_epoch_conflict');
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
         FROM hivemind.hq_runtime_events
        WHERE runtime_id = $1::uuid`,
      runtimeId,
    );
    const sequence = [locked[0].event_sequence, rows[0]?.max_sequence]
      .reduce((highest, value) => BigInt(value || 0) > highest ? BigInt(value || 0) : highest, 0n) + 1n;
    await tx.hqRuntime.update({
      where: { id: runtimeId },
      data: { eventSequence: sequence, version: { increment: 1 } },
    });
    return tx.hqRuntimeEvent.create({
      data: { runtimeId, orgId, cycleId, sequence, eventType, title, summary, details, skillRef, toolRef, workOrderId, evidenceRefs, visibility },
    });
  });
}

export async function transitionHqRuntime({ prisma, runtimeId, orgId, runtimeEpoch = null, from, to, data = {} }) {
  assertHqTransition(from, to);
  const result = await prisma.hqRuntime.updateMany({
    where: { id: runtimeId, orgId, state: from, ...(runtimeEpoch ? { epoch: runtimeEpoch } : {}) },
    data: { ...data, state: to, version: { increment: 1 } },
  });
  if (result.count !== 1) throw new Error('hq_runtime_transition_conflict');
  return prisma.hqRuntime.findFirst({ where: { id: runtimeId, orgId } });
}

export async function createHqCycle({ prisma, runtimeId, orgId, runtimeEpoch, idempotencyKey, triggerType, triggerPayload = {}, inputRefs = [] }) {
  if (!runtimeEpoch) throw new Error('hq_runtime_epoch_required');
  return prisma.hqCycle.upsert({
    where: { orgId_idempotencyKey: { orgId, idempotencyKey } },
    create: { runtimeId, orgId, runtimeEpoch, idempotencyKey, triggerType, triggerPayload, inputRefs },
    update: {},
  });
}

export async function scheduleHqWake({ prisma, runtimeId, orgId, runtimeEpoch = null, idempotencyKey, triggerType, dueAt, payload = {} }) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.hqRuntime.findFirst({
      where: { id: runtimeId, orgId, ...(runtimeEpoch ? { epoch: runtimeEpoch } : {}) },
      select: { id: true, epoch: true },
    });
    if (!current) throw new Error('hq_runtime_epoch_obsolete');
    const effectiveEpoch = runtimeEpoch || current.epoch;
    const schedule = await tx.hqSchedule.upsert({
      where: { orgId_idempotencyKey: { orgId, idempotencyKey } },
      create: { runtimeId, orgId, runtimeEpoch: effectiveEpoch, idempotencyKey, triggerType, dueAt, payload },
      update: {},
    });
    await tx.hqRuntime.updateMany({
      where: { id: runtimeId, orgId, epoch: effectiveEpoch, OR: [{ nextWakeAt: null }, { nextWakeAt: { gt: dueAt } }] },
      data: { nextWakeAt: dueAt, version: { increment: 1 } },
    });
    return schedule;
  });
}
