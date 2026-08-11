// Connector Runtime V1 — stateless MCP gateway handler (plan §6).
//
// Implements the MCP streamable-HTTP JSON-RPC methods the AgentScope 1.0.21
// HttpStatelessClient speaks (protocol 2025-11-25, confirmed by the Phase 1
// spike): initialize, tools/list, tools/call (+ ping / notifications). It is a
// pure function of (connectorId, jsonrpc request, verified token claims,
// runtime) → jsonrpc response, so it unit-tests with no HTTP server.
//
// SECURITY: the ConnectorExecutionContext is derived ONLY from the verified
// capability-token claims (sub/org/role/surface/projects) — NEVER from the
// request body. The model/client cannot set identity, and a token can only
// reach the connectors + access level it was granted (defence-in-depth on top
// of the runtime's own policy engine).

import { parseToolName } from './contracts.js';

export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** Convert a CanonicalConnectorResult into an MCP tools/call result. */
export function canonicalResultToMcp(result) {
  const status = result?.status || 'failed';
  const isError = status !== 'completed' && status !== 'approval_required';
  const content = (result?.content || []).map((c) => {
    if (c.type === 'json') return { type: 'text', text: safeJson(c.data) };
    if (c.type === 'resource') return { type: 'text', text: c.uri || '' };
    return { type: 'text', text: c.text != null ? String(c.text) : '' };
  });
  return {
    content: content.length ? content : [{ type: 'text', text: status }],
    isError,
    _meta: {
      status,
      truncated: !!result?.metadata?.truncated,
      ...(result?.approval ? { approval: result.approval } : {}),
      ...(result?.metadata?.sourceIds ? { sourceIds: result.metadata.sourceIds } : {}),
    },
  };
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

function ctxFromClaims(claims, connectorId, reqId) {
  return {
    requestId: `mcp-${connectorId}-${reqId}`,
    userId: claims.sub,
    orgId: claims.org,
    role: claims.role || 'member',
    surface: claims.surface,
    projectIds: Array.isArray(claims.projects) ? claims.projects : [],
    roomId: claims.room || undefined,
    sessionId: claims.sid || undefined,
    capabilityId: claims.jti,
    // read-only grant → the runtime policy engine blocks write tools
    readOnly: claims.access !== 'write',
  };
}

/**
 * Handle one JSON-RPC request against a connector.
 * @param {object} p
 * @param {string} p.connectorId  from the URL (/mcp/connectors/:connectorId)
 * @param {object} p.request  JSON-RPC { jsonrpc:'2.0', id, method, params }
 * @param {object} p.claims  verified capability-token claims
 * @param {import('./connector-runtime.js').ConnectorRuntime} p.runtime
 * @returns {Promise<object|null>} JSON-RPC response, or null for a notification
 */
export async function handleMcpRequest({ connectorId, request, claims, runtime }) {
  const id = request && 'id' in request ? request.id : null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return error(-32600, 'invalid request');
  }
  const granted = Array.isArray(claims?.connectors) ? claims.connectors : [];

  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `hivemind-connector:${connectorId}`, version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications get no response

    case 'ping':
      return reply({});

    case 'tools/list': {
      if (!granted.includes(connectorId)) return error(-32001, `connector "${connectorId}" not granted to this capability`);
      const ctx = ctxFromClaims(claims, connectorId, id);
      const cats = await runtime.listTools(ctx, { connectors: [connectorId] });
      const tools = cats.flatMap((c) => c.tools)
        // a read-only capability never even sees write tools
        .filter((t) => claims.access === 'write' || t.access === 'read')
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      return reply({ tools });
    }

    case 'tools/call': {
      const params = request.params || {};
      const name = params.name;
      const args = params.arguments || {};
      if (!granted.includes(connectorId)) return error(-32001, `connector "${connectorId}" not granted to this capability`);
      if (typeof name !== 'string') return error(-32602, 'tools/call requires params.name');
      const { connector } = parseToolName(name);
      if (connector !== connectorId) return error(-32602, `tool "${name}" does not belong to connector "${connectorId}"`);
      const ctx = ctxFromClaims(claims, connectorId, id);
      const result = await runtime.executeTool(name, args, ctx);
      return reply(canonicalResultToMcp(result));
    }

    default:
      return error(-32601, `method not found: ${request.method}`);
  }
}
