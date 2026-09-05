function configuration() {
  if (process.env.DURABLE_CHAT_AGENT_ENABLED !== 'true') return null;
  const baseUrl = String(process.env.CLOUDFLARE_CHAT_AGENT_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CLOUDFLARE_CHAT_AGENT_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

const VALID_MODES = new Set(['off', 'shadow', 'session', 'workflow', 'full']);

export function nativeOrchestratorFor({ useTools = false, nativeMetaMode = 'off' } = {}) {
  if (useTools) return null;
  return nativeMetaMode === 'native-meta-v1' ? 'meta-v1' : 'v2';
}

export class CloudflareChatSessionClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) { this.fetchImpl = fetchImpl; this.logger = logger; }

  async admissionFor({ orgId, userId }) {
    const config = configuration();
    if (!config || !orgId || !userId) return { mode: 'off', nativeMetaMode: 'off' };
    try {
      const response = await this.fetchImpl(`${config.baseUrl}/mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return { mode: 'off', nativeMetaMode: 'off' };
      const payload = await response.json();
      return {
        mode: VALID_MODES.has(payload?.mode) ? payload.mode : 'off',
        nativeMetaMode: payload?.native_meta_mode === 'native-meta-v1' ? 'native-meta-v1' : 'off',
      };
    } catch (error) {
      this.logger.warn?.(`[durable-chat] Flagship evaluation failed closed: ${error.message}`);
      return { mode: 'off', nativeMetaMode: 'off' };
    }
  }

  async modeFor(identity) { return (await this.admissionFor(identity)).mode; }

  async nativeMetaModeFor(identity) { return (await this.admissionFor(identity)).nativeMetaMode; }

  async request(path, payload) {
    const config = configuration();
    if (!config) return null;
    try {
      const response = await this.fetchImpl(`${config.baseUrl}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(3000),
      });
      return response.ok ? response.json().catch(() => ({})) : null;
    } catch (error) {
      this.logger.warn?.(`[durable-chat] session mirror degraded: ${error.message}`);
      return null;
    }
  }

  open(metadata) { return this.request('/sessions/open', metadata); }
  event(metadata) { return this.request('/sessions/event', metadata); }
}
