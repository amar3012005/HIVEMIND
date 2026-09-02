import { recordRuntimeMetric } from './runtime-metrics.js';

export const RUNTIME_RELIABILITY_RELEASE_0 = 'runtime_reliability_release_0';
export const RUNTIME_ROLLOUT_MODES = Object.freeze(['OFF', 'SHADOW', 'ENFORCE', 'KILL_SWITCHED']);

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function mode(value, fallback = 'OFF') {
  const candidate = String(value || fallback).trim().toUpperCase();
  return RUNTIME_ROLLOUT_MODES.includes(candidate) && candidate !== 'KILL_SWITCHED' ? candidate : fallback;
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function countOrZero(work) {
  return work().catch(() => 0);
}

export function isRuntimeReliabilityKillSwitched(env = process.env) {
  return truthy(env.RUNTIME_RELIABILITY_KILL_SWITCH);
}

export async function getRuntimeRollout({ prisma, orgId, feature = RUNTIME_RELIABILITY_RELEASE_0, env = process.env }) {
  if (!prisma || !orgId) throw new Error('runtime_rollout_requires_prisma_and_org');
  const policy = await prisma.runtimeRolloutPolicy.findUnique({
    where: { orgId_feature: { orgId, feature } },
  }).catch(() => null);
  const configuredMode = mode(policy?.mode);
  const effectiveMode = isRuntimeReliabilityKillSwitched(env) ? 'KILL_SWITCHED' : configuredMode;
  return {
    feature,
    configuredMode,
    effectiveMode,
    killSwitched: effectiveMode === 'KILL_SWITCHED',
    metadata: policy?.metadata || {},
    updatedAt: policy?.updatedAt || null,
  };
}

export async function setRuntimeRollout({ prisma, orgId, feature = RUNTIME_RELIABILITY_RELEASE_0, requestedMode, metadata = {} }) {
  if (!prisma || !orgId) throw new Error('runtime_rollout_requires_prisma_and_org');
  const configuredMode = mode(requestedMode);
  const policy = await prisma.runtimeRolloutPolicy.upsert({
    where: { orgId_feature: { orgId, feature } },
    create: { orgId, feature, mode: configuredMode, metadata: metadata && typeof metadata === 'object' ? metadata : {} },
    update: { mode: configuredMode, metadata: metadata && typeof metadata === 'object' ? metadata : {} },
  });
  return { feature, configuredMode: mode(policy.mode), metadata: policy.metadata || {}, updatedAt: policy.updatedAt };
}

export async function collectRuntimeReliabilityBaseline({ prisma, orgId, feature = RUNTIME_RELIABILITY_RELEASE_0, now = new Date(), windowHours = 24 }) {
  if (!prisma || !orgId) throw new Error('runtime_baseline_requires_prisma_and_org');
  const observedTo = new Date(now);
  const observedFrom = new Date(observedTo.getTime() - Math.max(1, Number(windowHours) || 24) * 3600000);
  const runtime = await prisma.hqRuntime.findFirst({ where: { orgId }, select: { id: true, epoch: true, state: true } });
  const runWhere = { orgId, ...(runtime ? { trigger: { path: ['runtime_id'], equals: runtime.id } } : {}) };
  const [wakes, visibleEvents, cycles, activeRuns, expiredPlaybookLeases, expiredWorkOrders, uncertainCampaignAttempts, uncertainCalls, retriedCampaignAttempts, retriedCalls, latency, noops] = await Promise.all([
    countOrZero(() => prisma.hqSchedule.count({ where: { orgId, createdAt: { gte: observedFrom } } })),
    countOrZero(() => prisma.hqRuntimeEvent.count({ where: { orgId, visibility: 'USER', createdAt: { gte: observedFrom } } })),
    countOrZero(() => prisma.hqCycle.count({ where: { orgId, createdAt: { gte: observedFrom } } })),
    countOrZero(() => prisma.runtimePlaybookRun.count({ where: { ...runWhere, status: { notIn: ['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION'] } } })),
    countOrZero(() => prisma.runtimePlaybookRun.count({ where: { ...runWhere, leaseExpiresAt: { lt: observedTo }, status: { in: ['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY'] } } })),
    countOrZero(() => prisma.hyperWorkOrder.count({ where: { orgId, leaseExpiresAt: { lt: observedTo }, status: { in: ['queued', 'running'] } } })),
    countOrZero(() => prisma.campaignActionAttempt.count({ where: { status: { in: ['UNCERTAIN', 'NEEDS_RECONCILIATION'] }, action: { campaign: { orgId } } } })),
    countOrZero(() => prisma.taraCallAttempt.count({ where: { orgId, reconciliationState: { in: ['pending', 'needs_reconciliation'] } } })),
    countOrZero(() => prisma.campaignActionAttempt.count({ where: { attempt: { gt: 1 }, action: { campaign: { orgId } } } })),
    countOrZero(() => prisma.taraCallAttempt.count({ where: { orgId, attemptNo: { gt: 1 } } })),
    prisma.runtimePerformanceMetric.aggregate({ where: { orgId, metric: 'hq_cycle_latency', createdAt: { gte: observedFrom } }, _avg: { value: true } }).catch(() => ({ _avg: { value: null } })),
    prisma.runtimePerformanceMetric.aggregate({ where: { orgId, metric: 'hq_noop_cycle', createdAt: { gte: observedFrom } }, _sum: { value: true } }).catch(() => ({ _sum: { value: null } })),
  ]);
  const metrics = {
    wakes: safeNumber(wakes),
    visible_events: safeNumber(visibleEvents),
    cycles: safeNumber(cycles),
    active_nonterminal_runs: safeNumber(activeRuns),
    expired_playbook_leases: safeNumber(expiredPlaybookLeases),
    expired_work_orders: safeNumber(expiredWorkOrders),
    uncertain_campaign_attempts: safeNumber(uncertainCampaignAttempts),
    uncertain_call_attempts: safeNumber(uncertainCalls),
    campaign_action_retries: safeNumber(retriedCampaignAttempts),
    call_action_retries: safeNumber(retriedCalls),
    avg_cycle_latency_ms: safeNumber(latency?._avg?.value),
    noop_cycles: safeNumber(noops?._sum?.value),
  };
  await Promise.all(Object.entries(metrics).map(([metric, value]) => recordRuntimeMetric(prisma, {
    orgId,
    metric: `runtime_baseline_${metric}`,
    value,
    unit: metric.endsWith('_ms') ? 'ms' : 'count',
    source: 'runtime-reliability-release-0',
    metadata: { feature, observed_from: observedFrom.toISOString(), observed_to: observedTo.toISOString() },
  })));
  return {
    feature,
    runtime: runtime ? { id: runtime.id, epoch: runtime.epoch, state: runtime.state } : null,
    observedFrom,
    observedTo,
    metrics,
  };
}

export async function recordRuntimeReleaseEvidence({ prisma, orgId, userId = null, feature = RUNTIME_RELIABILITY_RELEASE_0, releaseSha, migrationIds = [], mode: evidenceMode = 'OFF', tests = {}, metrics = {}, rollbackImages = {}, operatorDecision = null, observedFrom = null, observedTo = null }) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(releaseSha || ''))) throw new Error('runtime_release_evidence_sha_invalid');
  return prisma.runtimeReleaseEvidence.create({
    data: {
      orgId,
      feature,
      releaseSha: String(releaseSha).toLowerCase(),
      migrationIds: Array.isArray(migrationIds) ? migrationIds.map(String).slice(0, 30) : [],
      mode: mode(evidenceMode),
      tests: tests && typeof tests === 'object' ? tests : {},
      metrics: metrics && typeof metrics === 'object' ? metrics : {},
      rollbackImages: rollbackImages && typeof rollbackImages === 'object' ? rollbackImages : {},
      operatorDecision: operatorDecision ? String(operatorDecision).slice(0, 4000) : null,
      observedFrom: observedFrom ? new Date(observedFrom) : null,
      observedTo: observedTo ? new Date(observedTo) : null,
      recordedByUserId: userId || null,
    },
  });
}
