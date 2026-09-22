import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_MCP_OAUTH_SCOPES,
  mapPublicMcpOAuthScopesToInternal,
  normalizePublicMcpOAuthScopes,
  removeOperatorScopesFromOAuthPrincipal,
} from '../../src/auth/oauth-scope-policy.js';

test('public MCP OAuth never advertises or grants deployment scope', () => {
  assert.equal(PUBLIC_MCP_OAUTH_SCOPES.includes('ops.deploy'), false);
  assert.deepEqual(
    normalizePublicMcpOAuthScopes('memory.read memory.write ops.deploy ops:deploy mcp.connect'),
    ['memory.read', 'memory.write', 'mcp.connect'],
  );
  assert.deepEqual(
    mapPublicMcpOAuthScopesToInternal(['memory.read', 'ops.deploy', 'mcp.connect']),
    ['memory:read', 'mcp'],
  );
});

test('legacy OAuth access tokens cannot retain operator capability', () => {
  assert.deepEqual(
    removeOperatorScopesFromOAuthPrincipal(['memory:read', 'mcp', 'ops:deploy', 'ops.deploy']),
    ['memory:read', 'mcp'],
  );
});
