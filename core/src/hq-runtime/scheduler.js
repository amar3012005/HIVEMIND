import os from 'node:os';
import crypto from 'node:crypto';
import { appendHqEvent, createHqCycle, getHqRuntime } from './repository.js';
import { NativeHqEngine } from './native-engine.js';
import { HqScheduleStore } from './schedule-store.js';
import { dispatchNextHqWorkOrder } from './work-dispatcher.js';

export async function runDueHqSchedule({ prisma, leaseOwner, logger = console }) {
  const store = new HqScheduleStore({ prisma, logger });
  const schedule = await store.leaseNext(leaseOwner);
  if (!schedule) return null;
  let cycle = null;
  try {
    const runtime = await getHqRuntime({ prisma, orgId: schedule.org_id });
    if (!runtime || runtime.id !== schedule.runtime_id) throw new Error('hq_schedule_runtime_mismatch');
    cycle = await createHqCycle({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId,
      idempotencyKey: `schedule:${schedule.id}`, triggerType: schedule.trigger_type,
      triggerPayload: schedule.payload || {}, inputRefs: [schedule.id],
    });
    cycle = await prisma.hqCycle.update({
      where: { id: cycle.id },
      data: { status: 'RUNNING', leaseOwner, leaseExpiresAt: new Date(Date.now() + 120000), startedAt: cycle.startedAt || new Date() },
    });
    await prisma.hqRuntime.updateMany({
      where: { id: runtime.id, orgId: runtime.orgId },
      data: { currentCycleId: cycle.id, version: { increment: 1 } },
    });
    const engine = new NativeHqEngine({ prisma, logger });
    const decision = await engine.runCycle({ runtime: await getHqRuntime({ prisma, orgId: runtime.orgId }), cycle, trigger: { type: schedule.trigger_type, payload: schedule.payload || {}, schedule_id: schedule.id } });
    await prisma.hqCycle.update({
      where: { id: cycle.id },
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
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, cycleId: cycle.id,
          eventType: 'blocked', title: 'HQ cycle failed safely',
          summary: 'No ambiguous external write will be replayed. The cycle is retained for inspection and a bounded retry is scheduled.',
          details: { error: String(error.message || error).slice(0, 1000) },
        }).catch(() => {});
        await prisma.hqRuntime.updateMany({
          where: { id: runtime.id, orgId: runtime.orgId, state: { not: 'PAUSED' } },
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
  const leaseOwner = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while (await runDueHqSchedule({ prisma, leaseOwner, logger })) { /* drain due work serially */ }
      while (await dispatchNextHqWorkOrder({ prisma, logger })) { /* drain bounded specialist work serially */ }
    } finally { running = false; }
  };
  const wake = () => tick().catch((error) => logger.error('[hq-runtime] scheduler wake failed:', error.message));
  const timer = setInterval(wake, intervalMs);
  timer.unref?.();
  wake();
  logger.log(`[hq-runtime] scheduler active as ${leaseOwner}`);
  return { enabled: true, leaseOwner, wake, stop: () => clearInterval(timer) };
}
