function configuration() {
  // Cloudflare's tenant admission response selects the chat variant.  Core
  // keeps only the protected Worker transport credentials; a local ENABLED
  // switch must not override a latched Flagship decision for a user turn.
  const baseUrl = String(process.env.CLOUDFLARE_CHAT_AGENT_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CLOUDFLARE_CHAT_AGENT_SECRET || '');
  return baseUrl && secret ? { baseUrl, secret } : null;
}

const VALID_MODES = new Set(['off', 'shadow', 'session', 'workflow', 'full']);
const VALID_ORCHESTRATOR_V2_MODES = new Set(['off', 'shadow', 'serve']);
const VALID_MEETING_LIFECYCLE_MODES = new Set(['off', 'consent']);

function defaultAdmission() {
  return {
    mode: 'off', nativeMetaMode: 'off', unifiedDag: false,
    orchestratorV2Mode: 'off', compoundOrchestrator: false,
    meetingLifecycleMode: 'off',
  };
}

export function nativeOrchestratorFor({ useTools = false, nativeMetaMode = 'off' } = {}) {
  if (nativeMetaMode === 'unified-meta-v2') return 'unified-meta-v2';
  if (useTools) return null;
  return nativeMetaMode === 'native-meta-v1' ? 'meta-v1' : 'v2';
}

export class CloudflareChatSessionClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) { this.fetchImpl = fetchImpl; this.logger = logger; }

  async admissionFor({ orgId, userId }) {
    const config = configuration();
    if (!config || !orgId || !userId) return defaultAdmission();
    try {
      const response = await this.fetchImpl(`${config.baseUrl}/mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return defaultAdmission();
      const payload = await response.json();
      return {
        mode: VALID_MODES.has(payload?.mode) ? payload.mode : 'off',
        nativeMetaMode: ['native-meta-v1', 'unified-meta-v2'].includes(payload?.native_meta_mode)
          ? payload.native_meta_mode
          : 'off',
        unifiedDag: payload?.unified_dag === true,
        orchestratorV2Mode: VALID_ORCHESTRATOR_V2_MODES.has(payload?.chat_orchestrator_v2_mode)
          ? payload.chat_orchestrator_v2_mode
          : 'off',
        compoundOrchestrator: payload?.compound_orchestrator === true,
        meetingLifecycleMode: VALID_MEETING_LIFECYCLE_MODES.has(payload?.meeting_lifecycle_mode)
          ? payload.meeting_lifecycle_mode
          : 'off',
      };
    } catch (error) {
      this.logger.warn?.(`[durable-chat] Flagship evaluation failed closed: ${error.message}`);
      return defaultAdmission();
    }
  }

  async modeFor(identity) { return (await this.admissionFor(identity)).mode; }

  async nativeMetaModeFor(identity) { return (await this.admissionFor(identity)).nativeMetaMode; }

  async meetingLifecycleModeFor(identity) { return (await this.admissionFor(identity)).meetingLifecycleMode; }

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
