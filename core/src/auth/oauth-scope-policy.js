const OPERATOR_INTERNAL_SCOPE = 'ops:deploy';

// Remote OAuth is the public HIVE-MIND MCP authorization surface used by
// Codex, Claude, ChatGPT and Perplexity. Deployment is intentionally absent:
// operator access uses a master credential or a separately issued API key.
export const PUBLIC_MCP_OAUTH_SCOPES = Object.freeze([
  'memory.read',
  'memory.write',
  'web.search',
  'tools.invoke',
  'workspace.connect',
  'mcp.connect',
]);

const OAUTH_SCOPE_ALIASES = Object.freeze({
  'memory:read': 'memory.read',
  'memory:write': 'memory.write',
  'web:search': 'web.search',
  mcp: 'mcp.connect',
});

const OAUTH_SCOPE_TO_INTERNAL = Object.freeze({
  'memory.read': 'memory:read',
  'memory.write': 'memory:write',
  'web.search': 'web:search',
  'tools.invoke': 'mcp',
  'workspace.connect': 'mcp',
  'mcp.connect': 'mcp',
});

export function normalizePublicMcpOAuthScopes(scopeInput, fallbackScopes = ['memory.read']) {
  const rawScopes = Array.isArray(scopeInput)
    ? scopeInput
    : String(scopeInput || '')
      .split(/[\s+]/)
      .map((scope) => scope.trim())
      .filter(Boolean);

  const normalized = rawScopes
    .map((scope) => OAUTH_SCOPE_ALIASES[scope] || scope)
    .filter((scope) => PUBLIC_MCP_OAUTH_SCOPES.includes(scope));

  if (normalized.length === 0) {
    return Array.isArray(fallbackScopes)
      ? fallbackScopes.filter((scope) => PUBLIC_MCP_OAUTH_SCOPES.includes(scope))
      : ['memory.read'];
  }

  return Array.from(new Set(normalized));
}

export function mapPublicMcpOAuthScopesToInternal(scopes) {
  return Array.from(new Set(
    normalizePublicMcpOAuthScopes(scopes, [])
      .map((scope) => OAUTH_SCOPE_TO_INTERNAL[scope])
      .filter(Boolean),
  ));
}

export function removeOperatorScopesFromOAuthPrincipal(scopes) {
  return Array.isArray(scopes)
    ? scopes.filter((scope) => scope !== OPERATOR_INTERNAL_SCOPE && scope !== 'ops.deploy')
    : [];
}
