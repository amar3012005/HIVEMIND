// Flagship is the sole admission switch. A missing Worker, invalid response,
// or network failure retains the existing recall behavior.
export class CloudflareRecallQualityClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) {
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  async modeFor({ orgId, userId }) {
    if (!orgId || !userId) return 'off';
    const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
    const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
    if (!baseUrl || !secret) return 'off';
    try {
      const response = await this.fetchImpl(`${baseUrl}/recall-quality-mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return 'off';
      const mode = (await response.json())?.mode;
      return mode === 'on' || mode === 'shadow' ? mode : 'off';
    } catch (error) {
      this.logger.warn?.(`[recall-quality] Flagship evaluation failed closed: ${error.message}`);
      return 'off';
    }
  }
}
