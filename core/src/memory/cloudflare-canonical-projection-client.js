const MODES = new Set(['off', 'shadow', 'write', 'read', 'full']);

function config() {
  if (process.env.CANONICAL_KNOWLEDGE_ENABLED !== 'true' || process.env.CANONICAL_KNOWLEDGE_KILL_SWITCH === 'true') return null;
  const baseUrl = String(process.env.CANONICAL_PROJECTION_WORKFLOW_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

export class CloudflareCanonicalProjectionClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) { this.fetchImpl = fetchImpl; this.logger = logger; }
  configured() { return !!config(); }
  async modeFor({ orgId, userId }) {
    const c = config(); if (!c || !orgId || !userId) return 'off';
    try {
      const response = await this.fetchImpl(`${c.baseUrl}/enabled?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${c.secret}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return 'off';
      const body = await response.json(); const mode = String(body?.mode || (body?.enabled ? 'write' : 'off')).toLowerCase();
      return MODES.has(mode) ? mode : 'off';
    } catch (error) { this.logger.warn?.(`[canonical-projection] Flagship evaluation failed closed: ${error.message}`); return 'off'; }
  }
  async start({ memoryId, orgId, userId, processingVersion = 1, requiredProjection = 'write' }) {
    const c = config(); if (!c) return null;
    const response = await this.fetchImpl(`${c.baseUrl}/start`, {
      method: 'POST', headers: { authorization: `Bearer ${c.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ memory_id: memoryId, org_id: orgId, user_id: userId, processing_version: processingVersion, required_projection: requiredProjection }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `canonical workflow admission failed: HTTP ${response.status}`);
    return body;
  }
}
