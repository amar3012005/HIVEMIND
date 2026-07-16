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
 * Most providers' Nango credential is a single bearer/PAT token and work
 * end-to-end with the runner the moment the tenant connects them.
 *
 * Google Workspace (gmail/drive/calendar/docs/gemini) + Salesforce are also
 * seeded, but as CONNECT-ONLY mappings: their only job here is to let
 * /api/connectors/connect-session resolve connector_id → nango_provider and
 * mint a Nango Connect session against the Nango that holds the OAuth
 * integrations. Gmail/Docs ingestion is the first-party native connector, and
 * the MCP runner is on-demand (never auto-invoked for these). Microsoft 365
 * still needs a device-code shim (P0.5).
 */

export const MCP_CATALOG = [
  {
    // Google Maps Platform (Places/Geocoding/Routes) — per-tenant API key via
    // Nango (integration id 'google-maps', API-key auth: the user pastes their
    // Maps key in the Connect UI; fetchBearerFromNango reads credentials.apiKey
    // and the runner injects it as GOOGLE_MAPS_API_KEY for the stdio server).
    // Prospecting backbone for outreach rooms: places_search_text/places_nearby
    // return real local businesses with phone + website (feeds TARA dialing +
    // impressum mining).
    name: 'google-maps',
    label: 'Google Maps',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'google-maps-mcp-server'],
    nango_provider: 'google-maps',
    token_inject: { kind: 'env', var: 'GOOGLE_MAPS_API_KEY', format: 'raw' },
    mode: 'live',
    supports_ingestion: false,
    supports_live_tools: true,
    category: 'geo',
  },
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
    // Slack is served IN-PROCESS by the native toolkit (SlackBridge + the
    // SLACK_TOOL_SPECS in agent/connector-toolkits/slack-tools.js) — not an
    // external MCP server. The old stdio/npx slack-mcp-server entry never
    // worked in the container (npx EACCES, no Nango slack integration) and
    // shadowed the internal executor by exact-name match in getEndpoint().
    name: 'slack',
    label: 'Slack',
    mode: 'live',
    transport: 'internal',
    auth_strategy: 'native',
    adapter_type: 'slack',
    native_provider: 'slack',
    supports_ingestion: false,
    supports_live_tools: true,
    default_project: 'connector-slack',
    default_tags: ['slack', 'live'],
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
  // ── Google Workspace + Salesforce (Nango connect mappings) ───────────────
  // These exist so /api/connectors/connect-session can map connector_id →
  // nango_provider and mint a Nango Connect session against the (central)
  // Nango that holds the OAuth integrations. The Nango unique_key MUST match
  // nango_provider. Gmail/Docs ingestion runs in the first-party connector;
  // these entries are connect-only (the MCP runner is on-demand, never
  // auto-invoked for them). Matches the working reference deployment.
  { name: 'gmail',           label: 'Gmail',           transport: 'streamable-http', url: 'https://gmail.googleapis.com',            nango_provider: 'gmail',           category: 'google_workspace' },
  { name: 'google-drive',    label: 'Google Drive',    transport: 'streamable-http', url: 'https://www.googleapis.com/drive',        nango_provider: 'google-drive',    category: 'google_workspace' },
  { name: 'google-calendar', label: 'Google Calendar', transport: 'streamable-http', url: 'https://www.googleapis.com/calendar',     nango_provider: 'google-calendar', category: 'google_workspace' },
  { name: 'google-docs',     label: 'Google Docs',     transport: 'streamable-http', url: 'https://docs.googleapis.com',             nango_provider: 'google-docs',     category: 'google_workspace' },
  { name: 'google-gemini',   label: 'Google Gemini',   transport: 'streamable-http', url: 'https://generativelanguage.googleapis.com', nango_provider: 'google-gemini', category: 'google_workspace' },
  { name: 'salesforce',      label: 'Salesforce',      transport: 'streamable-http', url: 'https://api.salesforce.com',              nango_provider: 'salesforce',      category: 'crm' },
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
