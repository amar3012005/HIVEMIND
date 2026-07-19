/**
 * MCP Client Pool — per-user Streamable HTTP MCP clients.
 *
 * Each entry binds (userId, orgId, provider) → live MCP client. Clients hold the
 * Mcp-Session-Id assigned by the server on initialize. Bearer tokens are
 * resolved lazily via the Nango bridge (token rotation handled there).
 *
 * Cache invalidation: 401 from MCP server triggers re-initialize + retry
 * with refreshed bearer. Idle clients age out after IDLE_TTL_MS.
 *
 * Transport: MCP Streamable HTTP (POST + SSE response).
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */

const PROTOCOL_VERSION = '2025-06-18';
const IDLE_TTL_MS = 10 * 60 * 1000; // 10 min
const REQUEST_TIMEOUT_MS = 25_000;

/** Provider → MCP endpoint URL. */
const MCP_ENDPOINTS = {
  slack: 'https://mcp.slack.com/mcp',
  notion: 'https://mcp.notion.com/mcp',
  github: 'https://api.githubcopilot.com/mcp',
  linear: 'https://mcp.linear.app/mcp',
};

/**
 * Nango provider_config_key per MCP live-tool provider.
 *
 * This dict covers providers that expose a live MCP HTTP endpoint and whose
 * OAuth tokens are fetched from Nango at call time. Only add entries here
 * when a provider has a real, reachable MCP endpoint (see MCP_ENDPOINTS above).
 *
 * Ingestion-only connectors — personio-v2, datev, sap-business-one — are
 * intentionally NOT listed here. They have no live MCP endpoint; all token
 * resolution for those connectors goes through connector-store.js (which reads
 * nango_connection_id from the DB and calls the Nango proxy directly). Adding
 * them here would be misleading and would silently break pool look-ups.
 *
 * To add a live Personio MCP tool endpoint in the future:
 *   1. Confirm Personio publishes an MCP-compatible HTTP endpoint URL.
 *   2. Add the URL to MCP_ENDPOINTS above: personio: '<endpoint-url>'.
 *   3. Add the Nango config key here:       personio: 'personio-v2'.
 *   4. Update getOrCreateClient() if the provider requires non-standard auth.
 */
const NANGO_KEY_BY_PROVIDER = {
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  linear: 'linear',
};

class McpClient {
  constructor({ url, bearerResolver, logger = console }) {
    this.url = url;
    this.bearerResolver = bearerResolver;
    this.logger = logger;
    this._sessionId = null;
    this._toolsCache = null;
    this._lastUsed = Date.now();
    this._initPromise = null;
  }

  touch() { this._lastUsed = Date.now(); }

  async _initialize() {
    if (this._sessionId) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const bearer = await this.bearerResolver();
      const headers = {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'hivemind-agent', version: '1.0' },
          },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`mcp init ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      this._sessionId = res.headers.get('mcp-session-id') || null;
      // Drain init response body.
      await res.text();
      // Send notifications/initialized handshake completion.
      await this._rpc('notifications/initialized', {}, { isNotification: true });
    })().finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  async _rpc(method, params, { isNotification = false } = {}) {
    const bearer = await this.bearerResolver();
    const headers = {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
    const body = { jsonrpc: '2.0', method, params };
    if (!isNotification) body.id = Date.now();
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      // Token rotated. Drop session + retry once.
      this._sessionId = null;
      const err = new Error('mcp 401 — bearer rotated');
      err.code = 'AUTH';
      throw err;
    }
    if (!res.ok) {
      throw new Error(`mcp ${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    if (isNotification) {
      await res.text().catch(() => '');
      return null;
    }
    const text = await res.text();
    // Streamable HTTP can return either pure JSON or SSE 'event: message\ndata: {...}\n\n'.
    const sseMatch = text.match(/^event: message\s*\n\s*data:\s*(.*)$/m);
    const payload = sseMatch ? sseMatch[1] : text;
    try {
      const parsed = JSON.parse(payload);
      if (parsed.error) {
        const err = new Error(`mcp ${method}: ${parsed.error.message}`);
        err.code = parsed.error.code;
        throw err;
      }
      return parsed.result;
    } catch (parseErr) {
      throw new Error(`mcp ${method} parse: ${parseErr.message} | body=${text.slice(0, 200)}`);
    }
  }

  async listTools() {
    this.touch();
    if (this._toolsCache) return this._toolsCache;
    await this._initialize();
    try {
      const r = await this._rpc('tools/list', {});
      this._toolsCache = r.tools || [];
      return this._toolsCache;
    } catch (err) {
      if (err.code === 'AUTH') {
        await this._initialize();
        const r = await this._rpc('tools/list', {});
        this._toolsCache = r.tools || [];
        return this._toolsCache;
      }
      throw err;
    }
  }

  async callTool(name, args) {
    this.touch();
    await this._initialize();
    try {
      const r = await this._rpc('tools/call', { name, arguments: args || {} });
      return r;
    } catch (err) {
      if (err.code === 'AUTH') {
        await this._initialize();
        return await this._rpc('tools/call', { name, arguments: args || {} });
      }
      throw err;
    }
  }
}

// ── Pool ──────────────────────────────────────────────────────────────────

export class McpClientPool {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    /** @type {Map<string, { client: McpClient, lastUsed: number }>} */
    this._cache = new Map();
  }

  _cacheKey(userId, orgId, provider) { return `${userId}:${orgId}:${provider}`; }

  /**
   * Get (or create) an MCP client for (userId, orgId, provider).
   * Returns null when no Nango connection exists for that exact tenant binding.
   */
  async resolve(userId, orgId, provider) {
    if (!orgId) throw new Error('orgId is required for MCP connector resolution');
    const url = MCP_ENDPOINTS[provider];
    if (!url) throw new Error(`unknown MCP provider: ${provider}`);
    const key = this._cacheKey(userId, orgId, provider);
    const cached = this._cache.get(key);
    if (cached) {
      if (Date.now() - cached.lastUsed > IDLE_TTL_MS) {
        this._cache.delete(key);
      } else {
        cached.lastUsed = Date.now();
        return cached.client;
      }
    }
    const nangoKey = NANGO_KEY_BY_PROVIDER[provider] || provider;
    const bearerResolver = async () => {
      const row = await this.prisma.nangoConnection.findFirst({
        where: { userId, orgId, providerKey: nangoKey, status: 'active' },
        select: { connectionId: true },
      });
      if (!row?.connectionId) {
        throw new Error(`no active Nango connection for ${provider} in the active organisation`);
      }
      const { fetchBearerFromNango } = await import('../connectors/mcp/nango-service.js');
      return await fetchBearerFromNango(nangoKey, row.connectionId);
    };
    const client = new McpClient({ url, bearerResolver, logger: this.logger });
    this._cache.set(key, { client, lastUsed: Date.now() });
    return client;
  }

  evict(userId, orgId, provider) {
    this._cache.delete(this._cacheKey(userId, orgId, provider));
  }

  evictAllForUser(userId) {
    for (const k of Array.from(this._cache.keys())) {
      if (k.startsWith(userId + ':')) this._cache.delete(k);
    }
  }
}

export { MCP_ENDPOINTS, NANGO_KEY_BY_PROVIDER };
