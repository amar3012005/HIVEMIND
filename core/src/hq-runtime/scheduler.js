import os from 'node:os';
import crypto from 'node:crypto';
import { appendHqEvent, createHqCycle, getHqRuntime, scheduleHqWake } from './repository.js';
import { NativeHqEngine } from './native-engine.js';
import { HqScheduleStore } from './schedule-store.js';
import { drainHqWorkOrders } from './work-dispatcher.js';
import { createProductionRuntimePlaybookService } from '../runtime-playbooks/service.js';
import { employeesSidecarUrl, warmRuntimeOrigin } from '../runtime-transport/client.js';
import { recordRuntimeMetric } from './runtime-metrics.js';
import { projectExternalActionEvent } from './external-action-marker.js';
import { evaluateHqScheduleEligibility } from './wake-eligibility.js';

// Which accepted-checkpoint artifact KEYS are worth a Runtime terminal
// popup (vs. a plain trace bubble). Most Room checkpoints (campaign_status,
// campaign_capability_status, preflight results, ...) are routine pipeline
// steps — popping a modal for every one of them would flood the terminal.
// `research_decision` (core/src/runtime-playbooks/artifact-schema.js) is a
// real deliverable someone actually wants to read/download/share. Extend
// this set as more genuinely presentable artifact keys ship.
const ROOM_ARTIFACT_POPUP_KEYS = new Set(['research_decision']);

/**
 * Lightweight {id, key} refs for an ACCEPTED checkpoint's artifacts, plus
 * whether any of them warrant a Runtime terminal popup. Pulled out as its
 * own pure function so it's directly unit-testable — the calling closure
 * (onStageState, inside startHqScheduler) needs a live Postgres-backed
 * playbook service to exercise otherwise.
 */
export function acceptedArtifactPopupState(phase, artifacts = []) {
  const refs = phase === 'ACCEPTED' ? (artifacts || []).map((a) => ({ id: a.id, key: a.key })) : [];
  return { refs, popupWorthy: refs.some((a) => ROOM_ARTIFACT_POPUP_KEYS.has(a.key)) };
}

function artifactCountSummary(artifacts = []) {
  const counts = artifacts.reduce((result, artifact) => {
    const key = String(artifact?.key || 'artifact');
    result[key] = Number(result[key] || 0) + 1;
    return result;
  }, {});
  return {
    counts,
    text: Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(', '),
  };
}

export async function runDueHqSchedule({ prisma, leaseOwner, logger = console, runtimePlaybooks = null }) {
  const store = new HqScheduleStore({ prisma, logger });
  const schedule = await store.leaseNext(leaseOwner);
  if (!schedule) return null;
  const cycleStartedAt = Date.now();
  const observed = async (status, extra = {}) => {
    const latency = Date.now() - cycleStartedAt;
    logger.info?.('[hq-runtime] cycle transport metric', {
      schedule_id: schedule.id,
      trigger_type: schedule.trigger_type,
      status,
      latency_ms: latency,
      ...extra,
    });
    await recordRuntimeMetric(prisma, {
      orgId: schedule.org_id,
      runId: extra.run_id || schedule.payload?.run_id || null,
      metric: 'hq_cycle_latency', value: latency, unit: 'ms', source: 'hq-runtime-scheduler',
      metadata: {
        schedule_id: schedule.id,
        cycle_id: extra.cycle_id || null,
        trigger_type: schedule.trigger_type,
        status,
      },
    });
  };
  let cycle = null;
  try {
    const runtime = await getHqRuntime({ prisma, orgId: schedule.org_id });
    if (!runtime || runtime.id !== schedule.runtime_id || String(runtime.epoch) !== String(schedule.runtime_epoch)) {
      throw new Error('hq_schedule_runtime_epoch_mismatch');
    }
    const eligibility = await evaluateHqScheduleEligibility({ prisma, schedule });
    if (!eligibility.eligible) {
      await store.complete(schedule.id);
      await observed('NOOP', { no_op_reason: eligibility.reason });
      return { scheduleId: schedule.id, cycleId: null, status: 'NOOP', reason: eligibility.reason };
    }
    if (schedule.trigger_type === 'runtime_playbook_event') {
      if (!runtimePlaybooks) throw new Error('runtime_playbook_service_unavailable');
      const runId = String(schedule.payload?.run_id || '');
      const providerEvent = schedule.payload?.event;
      if (!runId || !providerEvent?.id || !providerEvent?.type) {
        throw new Error('runtime_playbook_event_payload_invalid');
      }
      const result = await runtimePlaybooks.resumeEvent(runId, runtime.orgId, providerEvent);
      await store.complete(schedule.id);
      await observed('COMPLETED', { runtime_playbook_event: true, run_id: runId });
      return { scheduleId: schedule.id, cycleId: null, status: 'COMPLETED', decision: result };
    }
    cycle = await createHqCycle({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
      idempotencyKey: `schedule:${schedule.id}`, triggerType: schedule.trigger_type,
      triggerPayload: schedule.payload || {}, inputRefs: [schedule.id],
    });
    cycle = await prisma.hqCycle.update({
      where: { id: cycle.id, runtimeEpoch: runtime.epoch },
      data: { status: 'RUNNING', leaseOwner, leaseExpiresAt: new Date(Date.now() + 120000), startedAt: cycle.startedAt || new Date() },
    });
    await prisma.hqRuntime.updateMany({
      where: { id: runtime.id, orgId: runtime.orgId, epoch: runtime.epoch },
      data: { currentCycleId: cycle.id, version: { increment: 1 } },
    });
    await appendHqEvent({
      prisma,
      runtimeId: runtime.id,
      orgId: runtime.orgId,
      runtimeEpoch: runtime.epoch,
      cycleId: cycle.id,
      eventType: 'wake_received',
      title: 'Runtime received a wake trigger',
      summary: 'The trigger is durably claimed. I am loading the current company state before choosing or executing any action.',
      details: {
        trigger_type: schedule.trigger_type,
        schedule_id: schedule.id,
        cycle_id: cycle.id,
        runtime_epoch: runtime.epoch,
        instruction_id: schedule.payload?.instruction_id || null,
      },
    });
    const engine = new NativeHqEngine({ prisma, logger, runtimePlaybooks });
    const decision = await engine.runCycle({ runtime: await getHqRuntime({ prisma, orgId: runtime.orgId }), cycle, trigger: { type: schedule.trigger_type, payload: schedule.payload || {}, schedule_id: schedule.id } });
    await prisma.hqCycle.update({
      where: { id: cycle.id, runtimeEpoch: runtime.epoch },
      data: { status: 'COMPLETED', decision, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    await store.complete(schedule.id);
    await observed('COMPLETED', { cycle_id: cycle.id });
    return { scheduleId: schedule.id, cycleId: cycle.id, status: 'COMPLETED', decision };
  } catch (error) {
    await observed('FAILED', { cycle_id: cycle?.id || null, error: String(error?.message || error).slice(0, 300) });
    const diagnostic = String(error?.stack || error?.message || error).slice(0, 12000);
    logger.error('[hq-runtime] cycle failed:', diagnostic);
    if (cycle) {
      await prisma.hqCycle.update({
        where: { id: cycle.id },
        data: { status: 'FAILED', error: diagnostic.slice(0, 4000), completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
      }).catch(() => {});
      const runtime = await getHqRuntime({ prisma, orgId: schedule.org_id }).catch(() => null);
      if (runtime) {
        // Honest failure summary: only claim an "ambiguous external write" when that is
        // actually the failure (error.code / message). The old hardcoded text said
        // "ambiguous external write" for EVERY cycle error — including transient planning
        // failures that self-resolve on retry — which actively misled diagnosis (the real
        // cause is in details.error, and no HQ cycle path performs an x-ads write). Reflect
        // the true reason; nothing external is ever replayed either way.
        const _msg = String(error?.message || error || '');
        const _ambiguous = error?.code === 'ambiguous_write' || /ambiguous/i.test(_msg);
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: cycle.runtimeEpoch, cycleId: cycle.id,
          eventType: 'blocked', title: 'HQ cycle failed safely',
          summary: _ambiguous
            ? 'An ambiguous external provider result was left unreplayed. The cycle is retained for reconciliation and a bounded retry is scheduled.'
            : 'The cycle hit an error and was retained for inspection; nothing external was replayed and a bounded retry is scheduled.',
          details: { error: _msg.slice(0, 1000), ambiguous: _ambiguous },
        }).catch(() => {});
        await prisma.hqRuntime.updateMany({
          where: { id: runtime.id, orgId: runtime.orgId, epoch: cycle.runtimeEpoch, state: { not: 'PAUSED' } },
          data: { currentCycleId: null, blockedReason: String(error.message || error).slice(0, 2000), state: 'BLOCKED', version: { increment: 1 } },
        }).catch(() => {});
      }
    }
    await store.fail(schedule.id, error).catch(() => {});
    return { scheduleId: schedule.id, cycleId: cycle?.id || null, status: 'FAILED', error: error.message };
  }
}

export async function startHqScheduler({ prisma, logger = console, intervalMs = 2000 } = {}) {
  if (!prisma) return { enabled: false, reason: 'database_unavailable' };
  const exists = await prisma.$queryRawUnsafe(`SELECT to_regclass('hivemind.hq_schedules') IS NOT NULL AS available`).catch(() => []);
  if (!exists[0]?.available) return { enabled: false, reason: 'migration_not_applied' };
  const runtimePlaybooks = await createProductionRuntimePlaybookService({
    prisma,
    logger,
    onStageState: async ({ phase, run, stage, artifacts, verdict }) => {
      const trigger = run.trigger && typeof run.trigger === 'object' ? run.trigger : {};
      if (!trigger.runtime_id || !trigger.runtime_epoch) return;
      const accepted = artifactCountSummary(artifacts);
      const externalAction = phase === 'ACCEPTED'
        ? projectExternalActionEvent({ run, stage, artifacts })
        : null;
      // Lightweight refs (id/key only, not the full data) — the popup fetches
      // full content via the existing GET /v1/hq/artifacts/:id when opened,
      // the same path the Artifacts panel already uses, rather than bloating
      // every checkpoint event with a full payload most of them never need.
      const { refs: acceptedArtifactRefs, popupWorthy } = acceptedArtifactPopupState(phase, artifacts);
      if (externalAction) {
        await appendHqEvent({
          prisma,
          runtimeId: trigger.runtime_id,
          orgId: run.orgId,
          runtimeEpoch: trigger.runtime_epoch,
          cycleId: trigger.cycle_id || null,
          ...externalAction,
          idempotencyKey: `external-action:${run.id}:${run.checkpointSequence}:${phase}`,
        });
      }
      await appendHqEvent({
        prisma,
        runtimeId: trigger.runtime_id,
        orgId: run.orgId,
        runtimeEpoch: trigger.runtime_epoch,
        cycleId: trigger.cycle_id || null,
        eventType: phase === 'REJECTED' ? 'blocked' : phase === 'ACCEPTED' ? 'tool_result' : 'tool_started',
        title: phase === 'STARTED' ? `Room checkpoint started: ${stage.id}`
          : phase === 'ACCEPTED' ? `I read and accepted the Room output: ${stage.id}`
          : `Room checkpoint needs evidence: ${stage.id}`,
        summary: phase === 'STARTED'
          ? stage.objective
          : phase === 'ACCEPTED'
            ? `I read ${(artifacts || []).length} persisted output(s)${accepted.text ? `: ${accepted.text}` : ''}. Every declared predicate and provider verification passed, so this lifecycle can advance from ${stage.id}.`
            : `The checkpoint retained its current evidence but did not advance. Unmet predicates: ${(verdict?.unmet || []).map((item) => item.id || item.predicate || item.reason).join(', ') || 'unknown'}.`,
        details: {
          runtime_playbook_run_id: run.id,
          playbook_id: run.playbookId,
          playbook_version: run.playbookVersion,
          stage_id: stage.id,
          phase,
          artifact_refs: (artifacts || []).map((artifact) => artifact.id),
          artifacts: acceptedArtifactRefs,
          ...(popupWorthy ? { type: 'room.artifact_ready' } : {}),
          artifact_counts: accepted.counts,
          verdict: verdict || null,
          contract_rejections: verdict?.contract_rejections || [],
        },
        evidenceRefs: (artifacts || []).map((artifact) => artifact.id),
        idempotencyKey: `room-checkpoint:${run.id}:${run.checkpointSequence}:${phase}`,
      });
    },
    onRunState: async ({ run }) => {
      if (!['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION', 'WAITING_AUTHORITY', 'WAITING_EVENT'].includes(String(run.status))) return;
      const trigger = run.trigger && typeof run.trigger === 'object' ? run.trigger : {};
      if (!trigger.runtime_id || !trigger.runtime_epoch) return;
      if (run.status === 'WAITING_EVENT' && run.waitingFor?.deadline) {
        const correlation = (run.waitingFor.correlation_values || [run.waitingFor.correlation_value]).filter(Boolean)[0] || null;
        await scheduleHqWake({
          prisma, runtimeId: trigger.runtime_id, orgId: run.orgId, runtimeEpoch: trigger.runtime_epoch,
          materialCauseId: `deadline:${run.id}:${run.currentStageId}:${run.waitingFor.deadline}`,
          triggerType: 'runtime_playbook_event', dueAt: new Date(run.waitingFor.deadline),
          payload: {
            run_id: run.id,
            wake_contract: { kind: 'deadline', run_id: run.id, checkpoint_sequence: run.checkpointSequence, deadline: run.waitingFor.deadline },
            event: { id: `wait-timeout:${run.id}:${run.checkpointSequence}`, type: 'wait.timeout', data: { correlation_ref: correlation, deadline: run.waitingFor.deadline } },
          },
        });
      }
      await scheduleHqWake({
        prisma,
        runtimeId: trigger.runtime_id,
        orgId: run.orgId,
        runtimeEpoch: trigger.runtime_epoch,
        materialCauseId: `run:${run.id}:checkpoint:${run.checkpointSequence}:${run.status}`,
        triggerType: 'runtime_playbook_result',
        dueAt: new Date(),
        payload: {
          run_id: run.id, status: run.status, todo_id: trigger.todo_id || null,
          wake_contract: {
            kind: 'playbook_transition', run_id: run.id,
            checkpoint_sequence: run.checkpointSequence, status: run.status,
          },
        },
      });
    },
  }).catch((error) => {
    logger.warn('[runtime-playbooks] worker unavailable:', error.message);
    return null;
  });
  const leaseOwner = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  let schedulesRunning = false;
  let workersRunning = false;
  const drainSchedules = async () => {
    if (schedulesRunning) return;
    schedulesRunning = true;
    try {
      while (await runDueHqSchedule({ prisma, leaseOwner, logger, runtimePlaybooks })) { /* drain due work serially */ }
    } finally { schedulesRunning = false; }
  };
  const drainWorkers = async () => {
    if (workersRunning) return;
    workersRunning = true;
    try {
      await Promise.all([
        drainHqWorkOrders({
          prisma, logger,
          concurrency: Number(process.env.HQ_WORKER_CONCURRENCY || 2),
          leaseOwner,
        }),
        runtimePlaybooks?.monitorDeadlines().then(() => runtimePlaybooks.drainActive({
          limit: Number(process.env.RUNTIME_PLAYBOOK_WORKER_CONCURRENCY || 2),
        })),
      ]);
    } finally { workersRunning = false; }
  };
  const wake = () => {
    // HQ decisions and Room execution use independent drains. A long specialist
    // call must never prevent a new instruction, connector event, or completed
    // result from waking the control plane and re-ranking the queue.
    drainSchedules()
      .then(() => drainWorkers())
      .catch((error) => logger.error('[hq-runtime] schedule drain failed:', error.message));
    drainWorkers().catch((error) => logger.error('[hq-runtime] worker drain failed:', error.message));
  };
  const timer = setInterval(wake, intervalMs);
  timer.unref?.();
  await warmRuntimeOrigin(employeesSidecarUrl(), { force: true }).catch((error) => {
    logger.warn('[hq-runtime] Employees transport warmup was unavailable; normal reconciliation remains active:', error.message);
  });
  wake();
  logger.log(`[hq-runtime] scheduler active as ${leaseOwner}`);
  return {
    enabled: true, leaseOwner, wake, runtimePlaybooks,
    stop: async () => { clearInterval(timer); },
  };
}
