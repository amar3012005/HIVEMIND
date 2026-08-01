import os from 'node:os';
import crypto from 'node:crypto';
import { appendHqEvent, createHqCycle, getHqRuntime, scheduleHqWake } from './repository.js';
import { NativeHqEngine } from './native-engine.js';
import { HqScheduleStore } from './schedule-store.js';
import { drainHqWorkOrders } from './work-dispatcher.js';
import { createProductionRuntimePlaybookService } from '../runtime-playbooks/service.js';

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
  let cycle = null;
  try {
    const runtime = await getHqRuntime({ prisma, orgId: schedule.org_id });
    if (!runtime || runtime.id !== schedule.runtime_id || String(runtime.epoch) !== String(schedule.runtime_epoch)) {
      throw new Error('hq_schedule_runtime_epoch_mismatch');
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
    const engine = new NativeHqEngine({ prisma, logger, runtimePlaybooks });
    const decision = await engine.runCycle({ runtime: await getHqRuntime({ prisma, orgId: runtime.orgId }), cycle, trigger: { type: schedule.trigger_type, payload: schedule.payload || {}, schedule_id: schedule.id } });
    await prisma.hqCycle.update({
      where: { id: cycle.id, runtimeEpoch: runtime.epoch },
      data: { status: 'COMPLETED', decision, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    await store.complete(schedule.id);
    return { scheduleId: schedule.id, cycleId: cycle.id, status: 'COMPLETED', decision };
  } catch (error) {
    logger.error('[hq-runtime] cycle failed:', error.message);
    if (cycle) {
      await prisma.hqCycle.update({
        where: { id: cycle.id },
        data: { status: 'FAILED', error: String(error.message || error).slice(0, 4000), completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
      }).catch(() => {});
      const runtime = await getHqRuntime({ prisma, orgId: schedule.org_id }).catch(() => null);
      if (runtime) {
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: cycle.runtimeEpoch, cycleId: cycle.id,
          eventType: 'blocked', title: 'HQ cycle failed safely',
          summary: 'No ambiguous external write will be replayed. The cycle is retained for inspection and a bounded retry is scheduled.',
          details: { error: String(error.message || error).slice(0, 1000) },
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
          artifact_counts: accepted.counts,
          verdict: verdict || null,
        },
        evidenceRefs: (artifacts || []).map((artifact) => artifact.id),
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
          idempotencyKey: `runtime-playbook-timeout:${run.id}:${run.checkpointSequence}`,
          triggerType: 'runtime_playbook_event', dueAt: new Date(run.waitingFor.deadline),
          payload: { run_id: run.id, event: { id: `wait-timeout:${run.id}:${run.checkpointSequence}`, type: 'wait.timeout', data: { correlation_ref: correlation, deadline: run.waitingFor.deadline } } },
        });
      }
      await scheduleHqWake({
        prisma,
        runtimeId: trigger.runtime_id,
        orgId: run.orgId,
        runtimeEpoch: trigger.runtime_epoch,
        idempotencyKey: `runtime-playbook-result:${run.id}:${run.version}`,
        triggerType: 'runtime_playbook_result',
        dueAt: new Date(),
        payload: { run_id: run.id, status: run.status, todo_id: trigger.todo_id || null },
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
        }),
        runtimePlaybooks?.drainActive({
          limit: Number(process.env.RUNTIME_PLAYBOOK_WORKER_CONCURRENCY || 2),
        }),
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
  wake();
  logger.log(`[hq-runtime] scheduler active as ${leaseOwner}`);
  return {
    enabled: true, leaseOwner, wake, runtimePlaybooks,
    stop: async () => { clearInterval(timer); },
  };
}
