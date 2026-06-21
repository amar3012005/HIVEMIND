/**
 * Upstream 3rd-party MCP server catalog (P0 of the HyperAgents×Connectors plan).
 *
 * These are GLOBAL catalog endpoints (no user_id/org_id) — the same upstream
 * MCP servers the wider ecosystem runs. Per-tenant auth is layered at call
 * time by `enrichEndpointWithToken` (Nango bearer → endpoint.bearer_token),
 * then materialized into the right place by the runner via `token_inject`:
 *   - stdio  → an env var the server reads (var/format declared here)
 *   - http   → Authorization header (default) or a custom header
 *
 * Only providers whose Nango credential is a single bearer/PAT token are
 * listed — they work end-to-end with the existing runner the moment the
 * tenant connects them. Google Workspace + Microsoft 365 are intentionally
 * omitted: they need a refresh-token / device-code shim (see openswarm's
 * google_workspace_mcp_shim) which is a separate P0.5 task, not faked here.
 */

export const MCP_CATALOG = [
  {
    name: 'github',
    label: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    nango_provider: 'github',
    token_inject: { kind: 'env', var: 'GITHUB_PERSONAL_ACCESS_TOKEN', format: 'raw' },
    category: 'code',
  },
  {
    name: 'notion',
    label: 'Notion',
    // Notion's HOSTED MCP. The Nango `notion` integration uses the `notion-mcp`
    // provider (Notion's MCP OAuth / dynamic client registration) — its token is
    // valid for mcp.notion.com but is REJECTED by the REST API (api.notion.com),
    // which the self-hosted @notionhq/notion-mcp-server calls → 401 "API token is
    // invalid". Pointing at the hosted MCP matches the token we already mint.
    transport: 'streamable-http',
    url: 'https://mcp.notion.com/mcp',
    nango_provider: 'notion',
    // default Authorization: Bearer header (token_inject omitted → buildHeaders default)
    category: 'productivity',
  },
  {
    name: 'hubspot',
    label: 'HubSpot',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@hubspot/mcp-server'],
    nango_provider: 'hubspot',
    token_inject: { kind: 'env', var: 'PRIVATE_APP_ACCESS_TOKEN', format: 'raw' },
    category: 'crm',
  },
  {
    name: 'slack',
    label: 'Slack',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'slack-mcp-server@latest', '--transport', 'stdio'],
    nango_provider: 'slack',
    token_inject: { kind: 'env', var: 'SLACK_MCP_XOXP_TOKEN', format: 'raw' },
    category: 'comms',
  },
  {
    name: 'airtable',
    label: 'Airtable',
    transport: 'streamable-http',
    url: 'https://mcp.airtable.com/mcp',
    nango_provider: 'airtable',
    // default Authorization: Bearer header (token_inject omitted → buildHeaders default)
    category: 'data',
  },
  {
    name: 'linear',
    label: 'Linear',
    transport: 'sse',
    url: 'https://mcp.linear.app/sse',
    nango_provider: 'linear',
    category: 'project',
  },
];

/**
 * Upsert the global catalog into a registry-backed service. Idempotent —
 * `registry.upsert` keys on `name`, so re-running just refreshes the defs.
 * Per-tenant entries (with user_id/org_id) are never touched.
 *
 * @param {{ registerEndpoint: (e:object)=>any }} service — MCPIngestionService
 * @returns {string[]} names seeded
 */
export function seedMcpCatalog(service) {
  if (!service || typeof service.registerEndpoint !== 'function') {
    throw new Error('seedMcpCatalog requires an MCPIngestionService');
  }
  const seeded = [];
  for (const entry of MCP_CATALOG) {
    service.registerEndpoint({ ...entry, source: 'catalog', updated_at: new Date().toISOString() });
    seeded.push(entry.name);
  }
  return seeded;
}
