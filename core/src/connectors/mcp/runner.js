import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Render a resolved bearer token into the shape a given upstream MCP server
// expects. Driven by `endpoint.token_inject` (data, not hardcoded per provider)
// so adding a connector is a registry entry, never a runner edit.
//   format: 'raw'              → "<token>"
//           'bearer'           → "Bearer <token>"
//           'json_auth_header' → '{"Authorization":"Bearer <token>", ...extra}'
function formatToken(token, format, extra) {
  if (format === 'bearer') return `Bearer ${token}`;
  if (format === 'json_auth_header') {
    return JSON.stringify({ Authorization: `Bearer ${token}`, ...(extra || {}) });
  }
  return token; // 'raw' (default)
}

// stdio servers receive their credential through an env var (the var name +
// encoding differ per server — declared in endpoint.token_inject).
function buildEnv(endpoint) {
  const env = { ...(endpoint.env || {}) };
  const inj = endpoint.token_inject;
  if (endpoint.bearer_token && inj && inj.kind === 'env' && inj.var) {
    env[inj.var] = formatToken(endpoint.bearer_token, inj.format, inj.extra);
  }
  return env;
}

function buildHeaders(endpoint) {
  const headers = new Headers(endpoint.headers || {});
  const inj = endpoint.token_inject;
  if (endpoint.bearer_token) {
    if (inj && inj.kind === 'header' && inj.name) {
      headers.set(inj.name, formatToken(endpoint.bearer_token, inj.format || 'bearer', inj.extra));
    } else {
      // Default: standard Authorization: Bearer (back-compat — most http MCPs).
      headers.set('Authorization', `Bearer ${endpoint.bearer_token}`);
    }
  }
  return headers;
}

function buildTransport(endpoint) {
  if (endpoint.transport === 'stdio') {
    return new StdioClientTransport({
      command: endpoint.command,
      args: endpoint.args || [],
      env: buildEnv(endpoint),
      cwd: endpoint.cwd || process.cwd(),
    });
  }

  if (endpoint.transport === 'streamable-http' || endpoint.transport === 'http') {
    if (!endpoint.url) {
      throw new Error('endpoint.url is required for streamable-http transport');
    }

    return new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: buildHeaders(endpoint),
      },
    });
  }

  if (endpoint.transport === 'sse') {
    if (!endpoint.url) {
      throw new Error('endpoint.url is required for sse transport');
    }

    return new SSEClientTransport(new URL(endpoint.url), {
      requestInit: {
        headers: buildHeaders(endpoint),
      },
      eventSourceInit: {
        fetch: (url, init) => fetch(url, {
          ...init,
          headers: buildHeaders(endpoint),
        }),
      },
    });
  }

  throw new Error(`Unsupported MCP transport: ${endpoint.transport}`);
}

export class MCPConnectorRunner {
  constructor({ clientName = 'hivemind-mcp-connector', clientVersion = '1.0.0' } = {}) {
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    // Persistent (long-lived) client pool — keyed by endpoint name or url.
    // Only used when endpoint.supports_persistent_client is true.
    this._persistentPool = new Map();
  }

  async withClient(endpoint, fn) {
    let transport = buildTransport(endpoint);
    const client = new Client({
      name: this.clientName,
      version: this.clientVersion,
    });

    try {
      try {
        await client.connect(transport);
      } catch (error) {
        const shouldFallback = (endpoint.transport === 'streamable-http' || endpoint.transport === 'http')
          && endpoint.allow_sse_fallback !== false;

        if (!shouldFallback) {
          throw error;
        }

        transport = buildTransport({
          ...endpoint,
          transport: 'sse',
        });

        await client.connect(transport);
        return await fn(client);
      }

      return await fn(client);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /**
   * Acquire a persistent (warm) client for live-tool endpoints.
   * Only keeps the client alive if endpoint.supports_persistent_client is true;
   * otherwise falls back to a fresh connect+dispose cycle via withClient().
   *
   * @param {object} endpoint
   * @param {(client: Client) => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async withPersistentClient(endpoint, fn) {
    if (!endpoint.supports_persistent_client) {
      return this.withClient(endpoint, fn);
    }

    const key = endpoint.name || endpoint.url || endpoint.command;
    let entry = this._persistentPool.get(key);

    if (!entry) {
      const transport = buildTransport(endpoint);
      const client = new Client({
        name: this.clientName,
        version: this.clientVersion,
      });
      await client.connect(transport);
      entry = { client, transport };
      this._persistentPool.set(key, entry);
    }

    try {
      return await fn(entry.client);
    } catch (err) {
      // On any transport error, evict and let caller retry fresh.
      try { await entry.transport.close().catch(() => {}); } catch (_) {}
      this._persistentPool.delete(key);
      throw err;
    }
  }

  /**
   * Explicitly close and evict a persistent client.
   * Safe to call even if no client is pooled.
   */
  async closePersistentClient(endpoint) {
    const key = endpoint.name || endpoint.url || endpoint.command;
    const entry = this._persistentPool.get(key);
    if (entry) {
      try { await entry.transport.close().catch(() => {}); } catch (_) {}
      this._persistentPool.delete(key);
    }
  }

  async inspect(endpoint) {
    return this.withClient(endpoint, async client => {
      const [tools, resources, prompts] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
        client.listPrompts().catch(() => ({ prompts: [] })),
      ]);

      return {
        tools: tools.tools || [],
        resources: resources.resources || [],
        prompts: prompts.prompts || [],
      };
    });
  }

  async execute(endpoint, operation) {
    if (!operation?.type) {
      throw new Error('operation.type is required');
    }

    return this.withClient(endpoint, async client => {
      if (operation.type === 'tool') {
        return client.callTool({
          name: operation.name,
          arguments: operation.arguments || {},
        });
      }

      if (operation.type === 'resource') {
        return client.readResource({
          uri: operation.uri,
        });
      }

      throw new Error(`Unsupported MCP operation type: ${operation.type}`);
    });
  }
}
