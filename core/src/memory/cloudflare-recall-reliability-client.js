function config() {
  if (process.env.RECALL_PARALLEL_RELIABILITY_ENABLED !== 'true') return null;
  const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

export class CloudflareRecallReliabilityClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) { this.fetchImpl = fetchImpl; this.logger = logger; }
  async enabledFor({ orgId, userId }) {
    const c = config();
    if (!c || !orgId || !userId) return false;
    try {
      const response = await this.fetchImpl(`${c.baseUrl}/recall-enabled?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${c.secret}` }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return false;
      return (await response.json())?.enabled === true;
    } catch (error) {
      this.logger.warn?.(`[recall-reliability] Flagship evaluation failed closed: ${error.message}`);
      return false;
    }
  }
}
