import {
  EVALUATION_STATUS,
  evaluationStatusFromError,
  readTimeoutMsEnv,
} from './recall-degradation.js';

// Flagship is the sole admission switch. A missing Worker, invalid response,
// timeout or network failure leaves the recall quality mode 'off' and retrieval
// runs unscored. The evaluation status says which of these happened.
export class CloudflareRecallQualityClient {
  constructor({
    fetchImpl = fetch,
    logger = console,
    timeoutMs = readTimeoutMsEnv('RECALL_QUALITY_MODE_TIMEOUT_MS', 1500),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {{orgId?: string, userId?: string}} identity tenant and user of the recall
   * @returns {Promise<{mode: 'on'|'shadow'|'off', status: string}>} mode and EVALUATION_STATUS value
   */
  async evaluate({ orgId, userId }) {
    if (!orgId || !userId) return { mode: 'off', status: EVALUATION_STATUS.NOT_CONFIGURED };
    const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
    const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
    if (!baseUrl || !secret) return { mode: 'off', status: EVALUATION_STATUS.NOT_CONFIGURED };
    try {
      const response = await this.fetchImpl(`${baseUrl}/recall-quality-mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { mode: 'off', status: EVALUATION_STATUS.SKIPPED_ERROR };
      const mode = (await response.json())?.mode;
      return { mode: mode === 'on' || mode === 'shadow' ? mode : 'off', status: EVALUATION_STATUS.OK };
    } catch (error) {
      const status = evaluationStatusFromError(error);
      this.logger.warn?.(`[recall-quality] Flagship evaluation skipped (${status}): ${error.message}; retrieval continues with mode=off`);
      return { mode: 'off', status };
    }
  }

  async modeFor(identity) {
    return (await this.evaluate(identity)).mode;
  }
}
