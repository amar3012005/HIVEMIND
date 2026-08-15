import { AsyncLocalStorage } from 'node:async_hooks';
import { setMaxListeners } from 'node:events';

const stageContext = new AsyncLocalStorage();
const configuredStageListeners = Number(process.env.STAGE_SIGNAL_MAX_LISTENERS || 32);
const STAGE_SIGNAL_MAX_LISTENERS = Number.isFinite(configuredStageListeners)
  ? Math.max(16, Math.floor(configuredStageListeners))
  : 32;

export class StageDeadlineError extends Error {
  constructor(label = 'stage', deadlineAt = null) {
    super(`${label} deadline exceeded`);
    this.name = 'StageDeadlineError';
    this.code = 'STAGE_DEADLINE_EXCEEDED';
    this.label = label;
    this.deadlineAt = deadlineAt;
  }
}

export function isStageDeadlineError(error) {
  return error instanceof StageDeadlineError
    || error?.code === 'STAGE_DEADLINE_EXCEEDED';
}

export function currentStageContext() {
  return stageContext.getStore() || null;
}

export function currentStageSignal() {
  return currentStageContext()?.signal || null;
}

export function remainingStageMs(fallback = Infinity) {
  const deadlineAt = Number(currentStageContext()?.deadlineAt);
  if (!Number.isFinite(deadlineAt)) return fallback;
  return Math.max(0, deadlineAt - Date.now());
}

function earliestDeadline(...values) {
  const finite = values
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

function fallbackValue(fallback, error) {
  return typeof fallback === 'function' ? fallback(error) : fallback;
}

/**
 * Run one asynchronous stage under a cooperative, inheritable deadline.
 *
 * The task is a factory rather than an already-started promise so the child
 * AbortSignal exists before network work begins. Nested stages inherit the
 * earliest parent deadline. When the clock or parent signal fires we abort the
 * child, detach it from the response path, and attach a rejection handler so
 * abandoned work can never become an unhandled rejection.
 */
export async function runWithStageDeadline(task, {
  timeoutMs = null,
  deadlineAt = null,
  signal = null,
  label = 'stage',
  fallback,
  fallbackOnError = false,
  onOutcome = null,
} = {}) {
  if (typeof task !== 'function') throw new TypeError('runWithStageDeadline requires a task function');

  const parent = currentStageContext();
  const inheritedSignal = signal || parent?.signal || null;
  const timeoutDeadline = Number.isFinite(Number(timeoutMs))
    ? Date.now() + Math.max(0, Number(timeoutMs))
    : null;
  const effectiveDeadline = earliestDeadline(deadlineAt, timeoutDeadline, parent?.deadlineAt);
  const controller = new AbortController();
  // A recall stage deliberately fans one deadline into several bounded lanes
  // (vector, lexical, graph, evidence and connector reads). Keep a finite
  // per-stage ceiling high enough for that designed fan-out; this is scoped to
  // the owned signal and still warns if an actual runaway exceeds the ceiling.
  setMaxListeners(STAGE_SIGNAL_MAX_LISTENERS, controller.signal);
  let timer = null;
  let parentAbort = null;
  let deadlineFired = false;

  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (inheritedSignal) {
    parentAbort = () => abort(inheritedSignal.reason || new StageDeadlineError(label, effectiveDeadline));
    if (inheritedSignal.aborted) parentAbort();
    else inheritedSignal.addEventListener('abort', parentAbort, { once: true });
  }
  if (effectiveDeadline != null && !controller.signal.aborted) {
    const delay = Math.max(0, effectiveDeadline - Date.now());
    timer = setTimeout(() => {
      deadlineFired = true;
      abort(new StageDeadlineError(label, effectiveDeadline));
    }, delay);
  }

  const context = {
    label,
    deadlineAt: effectiveDeadline,
    signal: controller.signal,
    remainingMs: () => effectiveDeadline == null ? Infinity : Math.max(0, effectiveDeadline - Date.now()),
  };
  const hasFallback = Object.prototype.hasOwnProperty.call(arguments[1] || {}, 'fallback');

  try {
    return await stageContext.run(context, async () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason || new StageDeadlineError(label, effectiveDeadline);
        onOutcome?.({ status: 'aborted', label, error: reason, deadlineAt: effectiveDeadline });
        if (hasFallback) return fallbackValue(fallback, reason);
        throw reason;
      }

      const work = Promise.resolve().then(() => task(context));
      // If cooperative work rejects after the deadline race has returned, this
      // handler keeps the rejection owned. It does not mask the normal await.
      work.catch(() => {});
      const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason || new StageDeadlineError(label, effectiveDeadline));
        }, { once: true });
      });

      try {
        const value = await Promise.race([work, aborted]);
        onOutcome?.({ status: 'completed', label, deadlineAt: effectiveDeadline });
        return value;
      } catch (error) {
        const timedOut = deadlineFired || isStageDeadlineError(error);
        onOutcome?.({ status: timedOut ? 'timeout' : 'error', label, error, deadlineAt: effectiveDeadline });
        if (timedOut || controller.signal.aborted) {
          if (hasFallback) return fallbackValue(fallback, error);
          throw isStageDeadlineError(error) ? error : new StageDeadlineError(label, effectiveDeadline);
        }
        if (fallbackOnError && hasFallback) return fallbackValue(fallback, error);
        throw error;
      }
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (inheritedSignal && parentAbort) inheritedSignal.removeEventListener('abort', parentAbort);
  }
}

export default runWithStageDeadline;
