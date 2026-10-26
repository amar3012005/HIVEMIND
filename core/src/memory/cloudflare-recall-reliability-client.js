import {
  EVALUATION_STATUS,
  evaluationStatusFromError,
  readTimeoutMsEnv,
} from './recall-degradation.js';

function config() {
  if (process.env.RECALL_PARALLEL_RELIABILITY_ENABLED !== 'true') return null;
  const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

// The reliability flag is advisory. A timeout, network failure or invalid response
// returns enabled=false, so retrieval runs on the legacy lanes.
export class CloudflareRecallReliabilityClient {
  constructor({
    fetchImpl = fetch,
    logger = console,
    timeoutMs = readTimeoutMsEnv('RECALL_RELIABILITY_TIMEOUT_MS', 3000),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {{orgId?: string, userId?: string}} identity tenant and user of the recall
   * @returns {Promise<{enabled: boolean, status: string}>} flag value and EVALUATION_STATUS value
   */
  async evaluate({ orgId, userId }) {
    const c = config();
    if (!c || !orgId || !userId) return { enabled: false, status: EVALUATION_STATUS.NOT_CONFIGURED };
    try {
      const response = await this.fetchImpl(`${c.baseUrl}/recall-enabled?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${c.secret}` }, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return { enabled: false, status: EVALUATION_STATUS.SKIPPED_ERROR };
      return { enabled: (await response.json())?.enabled === true, status: EVALUATION_STATUS.OK };
    } catch (error) {
      const status = evaluationStatusFromError(error);
      this.logger.warn?.(`[recall-reliability] Flagship evaluation skipped (${status}): ${error.message}; retrieval continues with reliability_v1=false`);
      return { enabled: false, status };
    }
  }

  async enabledFor(identity) {
    return (await this.evaluate(identity)).enabled;
  }
}
