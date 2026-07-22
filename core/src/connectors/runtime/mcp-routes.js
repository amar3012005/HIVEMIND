// Connector Runtime V1 — HTTP handlers for the capability endpoint + MCP
// gateway (plan §6). Kept as pure-ish handlers (no Express coupling) so they
// unit-test without a server and so the server.js switch-case wiring stays a
// thin flag-gated shim added only at cutover.
//
//   POST /api/connectors/runtime/capabilities   → issue a capability token
//   POST /mcp/connectors/:connectorId            → stateless MCP JSON-RPC
//
// Identity is ALWAYS the authenticated principal (server-owned); the request
// body cannot set user/org/role. The capability endpoint only grants connectors
// that are (a) registered, (b) enabled for the surface by config, and (c)
// requested by the caller — intersection, never a superset.

import { mintCapabilityToken, verifyCapabilityToken } from './capability-token.js';
import { handleMcpRequest } from './mcp-gateway.js';
import { SURFACES } from './contracts.js';

const REMOTE_SURFACES = new Set(['hyperagents', 'tara', 'mcp']);

/**
 * Issue a capability token for a remote surface.
 * @param {object} p
 * @param {object} p.body  { surface, room_id?, session_id?, requested_connectors?, requested_access? }
 * @param {object} p.principal  authenticated { userId, orgId, role? }
 * @param {import('./connector-runtime.js').ConnectorRuntime} p.runtime
 * @param {string} [p.mcpBasePath='/mcp/connectors']
 * @returns {{ status:number, body:object }}
 */
export function handleCapabilityRequest({ body = {}, principal, runtime, mcpBasePath = '/mcp/connectors' }) {
  if (!principal || !principal.userId || !principal.orgId) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const surface = String(body.surface || '').trim();
  if (!SURFACES.includes(surface) || !REMOTE_SURFACES.has(surface)) {
    return { status: 400, body: { error: `surface must be one of ${[...REMOTE_SURFACES].join('|')}` } };
  }
  const access = body.requested_access === 'write' ? 'write' : 'read';
  const requested = Array.isArray(body.requested_connectors) ? body.requested_connectors.map(String) : null;

  // Intersect requested (or all) with registered + surface-enabled connectors.
  const granted = [];
  for (const plugin of runtime.registry.listConnectors()) {
    const id = plugin.id;
    if (requested && !requested.includes(id)) continue;
    if (!runtime._allowed(surface, id)) continue; // config flag gate
    if (!plugin.manifest.supportedSurfaces.includes(surface)) continue;
    const tools = plugin.manifest.tools.filter((t) => (access === 'write' || t.access === 'read') && t.allowedSurfaces.includes(surface));
    if (!tools.length) continue;
    granted.push({
      id,
      endpoint: `${mcpBasePath}/${id}`,
      group: id,
      description: plugin.manifest.description || plugin.manifest.displayName,
      tool_count: tools.length,
    });
  }
  if (!granted.length) {
    return { status: 403, body: { error: 'no connectors available for this surface/grant' } };
  }

  const { token, expiresAt } = mintCapabilityToken({
    userId: principal.userId,
    orgId: principal.orgId,
    role: principal.role || 'member',
    surface,
    connectors: granted.map((g) => g.id),
    access,
    projectIds: principal.projectIds || [],
    roomId: body.room_id,
    sessionId: body.session_id,
  });
  return { status: 200, body: { expires_at: expiresAt, capability_token: token, connectors: granted } };
}

/**
 * Handle a stateless MCP JSON-RPC POST to /mcp/connectors/:connectorId.
 * @param {object} p
 * @param {string} p.connectorId @param {string} p.authHeader  'Bearer <token>'
 * @param {object} p.request  parsed JSON-RPC body
 * @param {import('./connector-runtime.js').ConnectorRuntime} p.runtime
 * @param {(jti:string)=>Promise<boolean>} [p.isRevoked]
 * @returns {Promise<{ status:number, body:object|null }>}
 */
export async function handleGatewayRequest({ connectorId, authHeader, request, runtime, isRevoked }) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || ''));
  if (!m) return { status: 401, body: jsonRpcError(request, -32000, 'missing bearer capability token') };
  const v = await verifyCapabilityToken(m[1], { isRevoked });
  if (!v.valid) return { status: 401, body: jsonRpcError(request, -32000, `invalid capability token: ${v.reason}`) };

  const response = await handleMcpRequest({ connectorId, request, claims: v.claims, runtime });
  // notifications → 202 no body
  if (response === null) return { status: 202, body: null };
  return { status: 200, body: response };
}

function jsonRpcError(request, code, message) {
  return { jsonrpc: '2.0', id: request && 'id' in request ? request.id : null, error: { code, message } };
}
