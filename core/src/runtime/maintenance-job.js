import { withGovernanceLock } from '../resident/advisory-lock.js';

const DEFAULT_TX_TIMEOUT_MS = Number(process.env.HIVEMIND_MAINTENANCE_LOCK_TIMEOUT_MS || 60 * 60 * 1000);
const DEFAULT_MAX_WAIT_MS = Number(process.env.HIVEMIND_MAINTENANCE_LOCK_MAX_WAIT_MS || 1000);

export async function runSingletonMaintenanceJob({
  prisma,
  jobName,
  run,
  transactionTimeoutMs = DEFAULT_TX_TIMEOUT_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
} = {}) {
  if (typeof run !== 'function') return false;
  if (!prisma || !jobName) {
    await run();
    return true;
  }

  try {
    await prisma.$transaction(async (tx) => {
      await withGovernanceLock(tx, { orgId: 'global', agentName: `maintenance:${jobName}` }, run);
    }, {
      timeout: transactionTimeoutMs,
      maxWait: maxWaitMs,
    });
    return true;
  } catch (err) {
    if (err?.code === 'GOVERNANCE_LOCK_BUSY') return false;
    throw err;
  }
}

export function scheduleRecurringMaintenanceJob({
  enabled = true,
  prisma,
  jobName,
  run,
  initialDelayMs = 0,
  intervalMs,
  logger = console,
  singleton = true,
  transactionTimeoutMs,
  maxWaitMs,
} = {}) {
  if (!enabled || typeof run !== 'function') return () => {};

  const invoke = async () => {
    try {
      if (singleton) {
        await runSingletonMaintenanceJob({
          prisma,
          jobName,
          run,
          transactionTimeoutMs,
          maxWaitMs,
        });
        return;
      }
      await run();
    } catch (err) {
      logger?.warn?.(`[${jobName}] scheduler failed: ${err?.message || err}`);
    }
  };

  const timeout = setTimeout(() => { void invoke(); }, Math.max(0, Number(initialDelayMs) || 0));
  const interval = Number(intervalMs) > 0
    ? setInterval(() => { void invoke(); }, Number(intervalMs))
    : null;

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}
