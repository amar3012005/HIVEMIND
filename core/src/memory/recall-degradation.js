/**
 * Recall degradation contract shared by the recall route, the recall router and the
 * flagship evaluation clients. No I/O and no native dependencies, so the contract can
 * be unit-tested without the mneme addon.
 *
 * @module src/memory/recall-degradation
 */

/** Outcome of an advisory flagship evaluation (quality mode or reliability flag). */
export const EVALUATION_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED_TIMEOUT: 'skipped_timeout',
  SKIPPED_ERROR: 'skipped_error',
  NOT_CONFIGURED: 'not_configured',
});

/** Outcome of the query embedding used by the vector lane of one recall. */
export const EMBEDDING_STATUS = Object.freeze({
  OK: 'ok',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
  NOT_ATTEMPTED: 'not_attempted',
});

/**
 * Read a millisecond timeout from the environment. An unset or blank value yields `fallback`.
 * Any other value must be an integer from 1 to `max`, otherwise this throws, so a bad value
 * stops the process at load time rather than running with an unintended timeout.
 *
 * @param {string} name environment variable name
 * @param {number} fallback value used when the variable is unset or blank
 * @param {{max?: number}} [options] inclusive upper bound in milliseconds
 * @param {Record<string, string | undefined>} [env] environment map
 * @returns {number} timeout in milliseconds
 */
export function readTimeoutMsEnv(name, fallback, { max = 60000 } = {}, env = process.env) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer number of milliseconds from 1 to ${max}; got '${raw}'`);
  }
  return value;
}

/**
 * Classify a failed evaluation request. Abort and timeout errors are timeouts, every other
 * failure is an error. Both leave the feature in its off state.
 *
 * @param {unknown} error error thrown by fetch or by the response parser
 * @returns {string} an EVALUATION_STATUS value
 */
export function evaluationStatusFromError(error) {
  const name = error?.name;
  return name === 'TimeoutError' || name === 'AbortError'
    ? EVALUATION_STATUS.SKIPPED_TIMEOUT
    : EVALUATION_STATUS.SKIPPED_ERROR;
}

/**
 * Combine the statuses of several evaluations into one. A timeout outranks an error, an error
 * outranks success, and success outranks not-configured.
 *
 * @param {Array<string | null | undefined>} statuses EVALUATION_STATUS values
 * @returns {string} the combined EVALUATION_STATUS value
 */
export function combineEvaluationStatus(statuses) {
  const present = statuses.filter(Boolean);
  if (present.includes(EVALUATION_STATUS.SKIPPED_TIMEOUT)) return EVALUATION_STATUS.SKIPPED_TIMEOUT;
  if (present.includes(EVALUATION_STATUS.SKIPPED_ERROR)) return EVALUATION_STATUS.SKIPPED_ERROR;
  if (present.includes(EVALUATION_STATUS.OK)) return EVALUATION_STATUS.OK;
  return EVALUATION_STATUS.NOT_CONFIGURED;
}

/**
 * One log line per recall. It carries no query text, org id or user id.
 *
 * @param {{route: string, retrieval: string, embedding: string, evaluation: string, status: number, latencyMs: number}} fields
 * @returns {string} log line
 */
export function recallOutcomeLogLine({ route, retrieval, embedding, evaluation, status, latencyMs }) {
  return `[recall] route=${route} retrieval=${retrieval} embedding=${embedding} `
    + `evaluation=${evaluation} status=${status} latency_ms=${latencyMs}`;
}
