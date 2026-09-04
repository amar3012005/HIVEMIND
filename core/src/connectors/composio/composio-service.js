/**
 * Composio connector service — live/on-demand tool-call connectors ONLY.
 *
 * Complements (does not replace) nango-service.js: Nango stays the OAuth
 * broker for every INGESTION connector (Gmail sync, Drive index, Slack
 * history — anything with a scheduled batch pull into memories/Qdrant),
 * because Composio has no batch-sync concept at all — every call is a
 * live, on-demand tool execution. Composio owns LIVE-mode connectors
 * instead: on-demand reads/writes an agent triggers at chat/room time
 * (LinkedIn, X, HubSpot actions, GitHub actions, etc).
 *
 * Deliberately raw `fetch` against the REST API, no @composio/core SDK
 * dependency — same rationale as nango-service.js's comment: avoid pulling
 * a heavy client into every caller of this module. Every endpoint used
 * here was hand-verified against the live API before being wired in.
 *
 * Multi-tenant model: ONE Composio project (one COMPOSIO_API_KEY, set only
 * on the control plane, never sent to the frontend). Tenant isolation is
 * the `user_id` parameter Composio scopes connected_accounts/executions
 * by — we pass HIVEMIND's own orgId (or `${orgId}:${userId}` for a
 * connector that must be per-user rather than org-wide) as that user_id.
 * Auth configs (one per toolkit) are created once, ops-time, in the
 * Composio dashboard or via createAuthConfig() below — never per-tenant.
 */

const COMPOSIO_BASE_URL = process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || '';

// Toolkit slug -> auth_config_id. One auth config per toolkit, shared by
// every tenant. Set as a single JSON blob so adding a toolkit connected in
// the Composio dashboard doesn't need a code change — just an env update.
//   COMPOSIO_AUTH_CONFIGS='{"linkedin":"ac_xxx","gmail":"ac_yyy"}'
function authConfigMap() {
  try {
    return JSON.parse(process.env.COMPOSIO_AUTH_CONFIGS || '{}');
  } catch {
    return {};
  }
}

export function isComposioConfigured() {
  return Boolean(COMPOSIO_API_KEY);
}

export function getAuthConfigId(toolkitSlug) {
  return authConfigMap()[toolkitSlug] || null;
}

async function _composioRequest(method, path, body, { retries = 2, timeoutMs = 15_000 } = {}) {
  if (!COMPOSIO_API_KEY) {
    throw new Error('Composio is not configured on this deployment (COMPOSIO_API_KEY missing)');
  }
  const url = `${COMPOSIO_BASE_URL}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'x-api-key': COMPOSIO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text().catch(() => '');
      let parsed;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      if (!res.ok) {
        const message = parsed?.error?.message || parsed?.message || text.slice(0, 300);
        const err = new Error(`Composio ${method} ${path} ${res.status}: ${message}`);
        err.status = res.status;
        err.composioCode = parsed?.error?.code;
        throw err;
      }
      return parsed;
    } catch (err) {
      if (attempt === retries || err.status) throw err; // don't retry a clean HTTP error, only network faults
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

function composioGet(path) { return _composioRequest('GET', path); }
function composioPost(path, body) { return _composioRequest('POST', path, body); }
function composioDelete(path) { return _composioRequest('DELETE', path); }

/**
 * Delete every connected account an org has for one toolkit (disconnect).
 * Returns the number of accounts removed.
 */
export async function disconnectToolkit(orgId, toolkitSlug) {
  const accountData = await _composioRequest(
    'GET',
    `/api/v3.1/connected_accounts?user_ids=${encodeURIComponent(orgId)}`,
    null,
    { retries: 0, timeoutMs: 3_000 },
  );
  const accounts = (accountData?.items || []).map((item) => ({
    id: item.id,
    toolkit: item.toolkit?.slug,
    status: item.status,
  }));
  const rows = accounts.filter((a) => a.toolkit === toolkitSlug);
  let removed = 0;
  for (const row of rows) {
    try {
      await composioDelete(`/api/v3.1/connected_accounts/${encodeURIComponent(row.id)}`);
      removed += 1;
    } catch (err) {
      // 404 = already gone; anything else is a real failure worth surfacing.
      if (err.status !== 404) throw err;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

/**
 * List this org's connected Composio accounts, one row per toolkit
 * connection attempt (active, expired, initiated, etc).
 *
 * @param {string} orgId — used as Composio's user_id (tenant key)
 * @returns {Promise<Array<{ id, toolkit, status }>>}
 */
export async function listConnectedAccounts(orgId) {
  const data = await composioGet(`/api/v3.1/connected_accounts?user_ids=${encodeURIComponent(orgId)}`);
  return (data?.items || []).map((it) => ({
    id: it.id,
    toolkit: it.toolkit?.slug,
    status: it.status, // ACTIVE | INITIATED | EXPIRED | FAILED
    email: it.data?.email || it.email || it.member?.email || it.metadata?.email || null,
    createdAt: it.created_at,
    updatedAt: it.updated_at,
  }));
}

/**
 * Resolve a toolkit's connection state for an org into the same
 * available|connected|reauth|error vocabulary the Connectors.jsx state
 * machine already uses for Nango connectors.
 */
export function toolkitStatusFromAccounts(toolkitSlug, accounts = []) {
  const rows = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account?.toolkit === toolkitSlug);
  if (rows.some((row) => row.status === 'ACTIVE')) return 'connected';
  if (rows.some((row) => row.status === 'EXPIRED' || row.status === 'FAILED')) return 'reauth';
  return 'available';
}

export async function getToolkitStatus(orgId, toolkitSlug) {
  const accounts = await listConnectedAccounts(orgId);
  return toolkitStatusFromAccounts(toolkitSlug, accounts);
}

/**
 * A session, in this wrapper's sense, is just "the live tool set this org
 * can currently execute" — the toolkits it has an ACTIVE connection for,
 * with schemas fetched and cached per toolkit (schemas rarely change).
 * Shaped as OpenAI function-calling tools so they merge straight into the
 * existing ReAct /chat and HyperAgents tool arrays with no adapter layer.
 *
 * @param {string} orgId
 * @returns {Promise<{ orgId: string, toolkits: string[], tools: Array<object> }>}
 */
export async function getSession(orgId) {
  const accounts = await listConnectedAccounts(orgId);
  const activeToolkits = [...new Set(accounts.filter((a) => a.status === 'ACTIVE').map((a) => a.toolkit))];
  const tools = (await Promise.all(activeToolkits.map((tk) => getToolkitTools(tk)))).flat();
  return { orgId, toolkits: activeToolkits, tools };
}

// ---------------------------------------------------------------------------
// Tool schemas (per-toolkit, cached — schemas change on Composio's release
// cadence, not per request; a 10-minute in-memory cache avoids re-fetching
// the full schema list on every chat turn / room tick).
// ---------------------------------------------------------------------------

const TOOL_SCHEMA_CACHE = new Map(); // toolkitSlug -> { at, tools }
const TOOL_SCHEMA_TTL_MS = 10 * 60 * 1000;

export async function getToolkitTools(toolkitSlug) {
  const cached = TOOL_SCHEMA_CACHE.get(toolkitSlug);
  if (cached && Date.now() - cached.at < TOOL_SCHEMA_TTL_MS) return cached.tools;

  const items = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ toolkit_slug: toolkitSlug, limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const data = await composioGet(`/api/v3.1/tools?${qs.toString()}`);
    items.push(...(data?.items || []));
    cursor = data?.next_cursor || null;
  } while (cursor);

  const tools = items.map((tool) => ({
    type: 'function',
    function: {
      // Namespaced so a tool-call name is unambiguous about where it
      // executes: composio_<TOOL_SLUG lowercased>. Composio's own slugs
      // already embed the toolkit (LINKEDIN_*, GITHUB_*, GMAIL_*) — don't
      // re-prefix with toolkitSlug too, or you get composio_linkedin_linkedin_...
      name: `composio_${tool.slug}`.toLowerCase(),
      description: (tool.description || tool.slug).slice(0, 1024),
      parameters: tool.input_parameters || tool.inputParameters || { type: 'object', properties: {} },
    },
    // Kept alongside the OpenAI-shaped fields (ignored by the LLM, read by
    // executeTool's caller) so dispatch doesn't need to re-derive the real
    // Composio slug from the namespaced function name.
    _composio: { toolkit: toolkitSlug, slug: tool.slug },
  }));
  TOOL_SCHEMA_CACHE.set(toolkitSlug, { at: Date.now(), tools });
  return tools;
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/**
 * Start a connect flow for one toolkit on behalf of an org. Composio's
 * managed-auth connect is redirect-out (hosted OAuth page), not
 * embeddable — mirrors how the existing Nango Connect button already
 * opens a hosted page rather than an in-app iframe.
 *
 * @param {string} toolkitSlug
 * @param {string} orgId
 * @param {{ callbackUrl?: string }} [opts]
 * @returns {Promise<{ redirectUrl: string, connectedAccountId: string, expiresAt: string }>}
 */
export async function createConnectLink(toolkitSlug, orgId, opts = {}) {
  // opts.toolkitMeta (from listToolkits) lets the browse-the-full-catalog
  // grid connect a toolkit that has no ops-curated auth config yet, by
  // auto-provisioning a Composio-managed one on first use.
  const authConfigId = opts.toolkitMeta
    ? await getOrCreateAuthConfigId(toolkitSlug, opts.toolkitMeta)
    : getAuthConfigId(toolkitSlug);
  if (!authConfigId) {
    throw new Error(`No Composio auth config registered for toolkit "${toolkitSlug}"`);
  }
  const body = {
    auth_config_id: authConfigId,
    user_id: orgId,
    ...(opts.callbackUrl ? { callback_url: opts.callbackUrl } : {}),
  };
  const data = await composioPost('/api/v3/connected_accounts/link', body);
  return {
    redirectUrl: data.redirect_url,
    connectedAccountId: data.connected_account_id,
    expiresAt: data.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute one Composio tool for an org's connected account.
 *
 * @param {string} orgId — Composio user_id (tenant key)
 * @param {string} toolSlug — real Composio slug (e.g. 'LINKEDIN_GET_MY_INFO'),
 *   NOT the namespaced composio_<toolkit>_<slug> function name — callers
 *   dispatching from a tool_call should read `_composio.slug` off the
 *   matched schema from getSession()/getToolkitTools() rather than parse it
 *   back out of the function name.
 * @param {object} args — tool arguments
 * @returns {Promise<{ successful: boolean, data: any, error: string|null }>}
 */
export async function executeTool(orgId, toolSlug, args = {}) {
  const result = await composioPost(`/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`, {
    user_id: orgId,
    arguments: args || {},
    version: 'latest',
  });
  return {
    successful: Boolean(result?.successful),
    data: result?.data ?? null,
    error: result?.error ?? null,
  };
}

/**
 * Translate one bounded natural-language step into the provider tool's current
 * structured arguments without executing it. This is used only as a
 * completeness fallback before a governed read or approval draft; it cannot
 * cause a provider side effect by itself.
 */
export async function generateToolInputs(toolSlug, text, { systemPrompt = null } = {}) {
  const result = await composioPost(`/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}/input`, {
    text: String(text || '').slice(0, 14_000),
    ...(systemPrompt ? { system_prompt: String(systemPrompt).slice(0, 1000) } : {}),
    version: 'latest',
  });
  if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
  return result?.arguments && typeof result.arguments === 'object' ? result.arguments : {};
}

// ---------------------------------------------------------------------------
// Tool Router Sessions — bounded discovery/execution for chat.
//
// Sessions are deliberately kept behind the existing compound planner. The
// planner still owns the DAG, native HIVE-MIND tools still execute locally,
// and writes still become pendingWrite drafts. Sessions only replace repeated
// per-toolkit schema enumeration and direct connector READ execution. Any
// Session failure is safe to fall back from because no write is executed here.
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = Number(process.env.COMPOSIO_SESSION_TTL_MS || 10 * 60 * 1000);
const SESSION_DISCOVERY_TTL_MS = Number(process.env.COMPOSIO_SESSION_DISCOVERY_TTL_MS || 10 * 60 * 1000);
const TOOL_ROUTER_SESSION_CACHE = new Map();
const TOOL_ROUTER_DISCOVERY_CACHE = new Map();

function normalizedSessionKey(orgId, toolkits) {
  return `${orgId}:${[...new Set(toolkits || [])].map(String).sort().join(',')}`;
}

function collectToolSlugs(value, prefixes, output = new Set()) {
  if (typeof value === 'string') {
    if (/^[A-Z][A-Z0-9]+_[A-Z0-9_]+$/.test(value)
      && (!prefixes.length || prefixes.some((prefix) => value.startsWith(`${prefix}_`)))) output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolSlugs(item, prefixes, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectToolSlugs(item, prefixes, output);
  }
  return output;
}

function collectPrimaryToolSlugs(value, prefixes, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPrimaryToolSlugs(item, prefixes, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'primary_tool_slugs' && Array.isArray(item)) {
        for (const slug of item) {
          if (typeof slug === 'string'
            && (!prefixes.length || prefixes.some((prefix) => slug.startsWith(`${prefix}_`)))) output.add(slug);
        }
      } else {
        collectPrimaryToolSlugs(item, prefixes, output);
      }
    }
  }
  return output;
}

async function executeSessionMeta(sessionId, slug, args) {
  const result = await _composioRequest('POST', `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/execute_meta`, {
    slug,
    arguments: { ...(args || {}), session_id: sessionId },
  }, { retries: 0, timeoutMs: 6_500 });
  if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
  return result;
}

/** Create or reuse a tenant-scoped Tool Router Session. */
export async function getToolRouterSession(orgId, toolkits) {
  const enabled = [...new Set((toolkits || []).map((toolkit) => String(toolkit).toLowerCase()).filter(Boolean))].sort();
  if (!orgId || !enabled.length) throw new Error('Composio Session requires an org and at least one toolkit');
  const key = normalizedSessionKey(orgId, enabled);
  const cached = TOOL_ROUTER_SESSION_CACHE.get(key);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return { ...cached.value, cacheHit: true };

  const accounts = await listConnectedAccounts(orgId);
  const connectedAccounts = {};
  const { isUseToolsUnifiedDagEnabled } = await import('../../agent/use-tools-unified-flag.js');
  const unified = isUseToolsUnifiedDagEnabled();
  for (const toolkit of enabled) {
    const account = accounts.find((row) => row.toolkit === toolkit && row.status === 'ACTIVE');
    if (!account) {
      if (unified) continue;
      throw new Error(`No active Composio account for ${toolkit}`);
    }
    connectedAccounts[toolkit] = account.id;
  }
  const { loadHivemindCustomToolkit, composioSessionExperimentalFromToolkit } = await import('./hivemind-custom-toolkit.js');
  const hivemindToolkit = await loadHivemindCustomToolkit();
  const data = await _composioRequest('POST', '/api/v3/tool_router/session', {
    user_id: orgId,
    toolkits: { enable: enabled },
    connected_accounts: connectedAccounts,
    manage_connections: { enable: false },
    workbench: { enable: false },
    experimental: composioSessionExperimentalFromToolkit(hivemindToolkit),
  }, { retries: 0, timeoutMs: 5_000 });
  const value = { id: data?.session_id, toolkits: enabled, connectedAccounts };
  if (!value.id) throw new Error('Composio Session did not return a session_id');
  TOOL_ROUTER_SESSION_CACHE.set(key, { at: Date.now(), value });
  return { ...value, cacheHit: false };
}

function mapCatalogTool(tool, toolkitFallback = '') {
  const toolkit = String(tool?.toolkit?.slug || tool?.toolkit || toolkitFallback || '').toLowerCase();
  return {
    type: 'function',
    function: {
      name: `composio_${tool.slug}`.toLowerCase(),
      description: String(tool.description || tool.slug).slice(0, 1024),
      parameters: tool.input_parameters || tool.inputParameters || { type: 'object', properties: {} },
    },
    _composio: { toolkit, slug: tool.slug },
  };
}

async function listCatalogTools({ search, toolkitSlug, important = false, limit = 24 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (search) qs.set('search', String(search).slice(0, 200));
  if (toolkitSlug) qs.set('toolkit_slug', toolkitSlug);
  if (important) qs.set('important', 'true');
  const data = await composioGet(`/api/v3.1/tools?${qs.toString()}`);
  return (data?.items || []).map((tool) => mapCatalogTool(tool, toolkitSlug)).filter((tool) => tool._composio.slug);
}

/**
 * Compact catalog for the HIVEMIND planner: Composio REST search on the
 * user intent (any app), plus this org's connected accounts, plus featured
 * tools for those apps. No session LLM — COMPOSIO_SEARCH_TOOLS is too slow
 * for first-action planning. Flash Lite only sees this catalog, not 1000 apps.
 */
export async function searchToolsByIntent(orgId, useCase, { toolkits } = {}) {
  const query = String(useCase || '').trim().slice(0, 200);
  const [accounts, searchedTools, searchedApps] = await Promise.all([
    orgId ? listConnectedAccounts(orgId).catch(() => []) : Promise.resolve([]),
    query ? listCatalogTools({ search: query, limit: 24 }).catch(() => []) : Promise.resolve([]),
    query ? listToolkits({ search: query, limit: 12 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
  ]);
  const connectedToolkits = [...new Set(
    accounts.filter((row) => row.status === 'ACTIVE').map((row) => row.toolkit).filter(Boolean),
  )];
  const bySlug = new Map();
  for (const tool of searchedTools) bySlug.set(tool._composio.slug, tool);
  const represented = new Set([...bySlug.values()].map((tool) => tool._composio.toolkit).filter(Boolean));
  const fillToolkits = [...new Set([
    ...connectedToolkits,
    ...(searchedApps.items || []).map((item) => item.slug).filter(Boolean),
    ...(toolkits || []),
  ])].filter((toolkit) => !represented.has(toolkit)).slice(0, 8);
  if (fillToolkits.length) {
    const extras = await Promise.all(fillToolkits.map((toolkit) =>
      listCatalogTools({ toolkitSlug: toolkit, important: true, limit: 6 }).catch(() => [])));
    for (const tool of extras.flat()) {
      if (!bySlug.has(tool._composio.slug)) bySlug.set(tool._composio.slug, tool);
    }
  }
  return { tools: [...bySlug.values()].slice(0, 32), connectedToolkits, accounts };
}

export async function discoverSessionTools(orgId, { toolkits, useCases }) {
  const session = await getToolRouterSession(orgId, toolkits);
  const normalizedCases = (useCases || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!normalizedCases.length) throw new Error('Composio Session discovery requires a use-case');
  const cacheKey = `${session.id}:${JSON.stringify(normalizedCases.map((item) => item.toLowerCase()))}`;
  const cached = TOOL_ROUTER_DISCOVERY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < SESSION_DISCOVERY_TTL_MS) {
    return { ...cached.value, sessionCacheHit: session.cacheHit, discoveryCacheHit: true };
  }

  const searched = await executeSessionMeta(session.id, 'COMPOSIO_SEARCH_TOOLS', {
    queries: normalizedCases.map((use_case) => ({ use_case })),
    session: { id: session.id },
    model: process.env.COMPOSIO_SESSION_SEARCH_MODEL || 'openai/gpt-oss-20b',
  });
  const prefixes = session.toolkits.map((toolkit) => toolkit.replace(/[^a-z0-9]/gi, '').toUpperCase());
  const primary = collectPrimaryToolSlugs(searched?.data, prefixes);
  const slugs = [...(primary.size ? primary : collectToolSlugs(searched?.data, prefixes))].slice(0, 24);
  if (!slugs.length) throw new Error('Composio Session found no matching tools');
  const schemaResult = await executeSessionMeta(session.id, 'COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: slugs });
  const schemas = schemaResult?.data?.tool_schemas || {};
  const tools = Object.entries(schemas).map(([slug, schema]) => ({
    type: 'function',
    function: {
      name: `composio_${slug}`.toLowerCase(),
      description: String(schema?.description || slug).slice(0, 1024),
      parameters: schema?.input_schema || { type: 'object', properties: {} },
    },
    _composio: {
      toolkit: String(schema?.toolkit || slug.split('_')[0]).toLowerCase(),
      slug,
      sessionId: session.id,
    },
  }));
  const value = { sessionId: session.id, tools, searchedLogId: searched?.log_id || null, schemaLogId: schemaResult?.log_id || null };
  TOOL_ROUTER_DISCOVERY_CACHE.set(cacheKey, { at: Date.now(), value });
  return { ...value, sessionCacheHit: session.cacheHit, discoveryCacheHit: false };
}

/** Execute one already-discovered READ through the same Session. */
export async function executeSessionTool(sessionId, toolSlug, args = {}) {
  const result = await executeSessionMeta(sessionId, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
    tools: [{ tool_slug: toolSlug, arguments: args || {} }],
    thought: 'Execute the selected read-only capability for the current workflow step.',
    current_step: 'EXECUTING_TOOL',
    current_step_metric: '0/1 tools',
  });
  const response = result?.data?.results?.[0]?.response;
  return {
    successful: Boolean(response?.successful),
    data: response?.data ?? null,
    error: response?.error ?? result?.error ?? null,
    session_log_id: result?.log_id || null,
  };
}

export function getToolRouterCacheStats() {
  return { sessions: TOOL_ROUTER_SESSION_CACHE.size, discoveries: TOOL_ROUTER_DISCOVERY_CACHE.size };
}

export function clearToolRouterCaches() {
  TOOL_ROUTER_SESSION_CACHE.clear();
  TOOL_ROUTER_DISCOVERY_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Toolkit catalog browser — Composio's full ~1,100-toolkit catalog (Gmail,
// Perplexity, SerpApi, Airtable, ...), not just the handful HIVEMIND
// curates in connectors-catalog.js. Used by the "browse all toolkits" grid.
// ---------------------------------------------------------------------------

/**
 * Search/page Composio's global toolkit catalog. Thin passthrough — the
 * frontend never sees COMPOSIO_API_KEY, only this proxied, paginated view.
 *
 * @param {{ search?: string, cursor?: string, limit?: number }} [opts]
 * @returns {Promise<{ items: Array, nextCursor: string|null, totalItems: number }>}
 */
export async function listToolkits({ search = '', cursor = null, limit = 40 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (search) qs.set('search', search);
  if (cursor) qs.set('cursor', cursor);
  const data = await composioGet(`/api/v3.1/toolkits?${qs.toString()}`);
  return {
    items: (data?.items || []).map((tk) => ({
      slug: tk.slug,
      name: tk.name,
      logo: tk.meta?.logo || null,
      description: tk.meta?.description || null,
      toolsCount: tk.meta?.tools_count ?? 0,
      triggersCount: tk.meta?.triggers_count ?? 0,
      authSchemes: tk.auth_schemes || [],
      composioManagedAuthSchemes: tk.composio_managed_auth_schemes || [],
      noAuth: Boolean(tk.no_auth),
      version: tk.meta?.version || null,
      categories: (tk.meta?.categories || []).map((c) => c.name),
    })),
    nextCursor: data?.next_cursor || null,
    totalItems: data?.total_items ?? 0,
  };
}

const TOOLKIT_CATALOG_TTL_MS = 10 * 60 * 1000;
let toolkitCatalogCache = null;

/**
 * Return the complete toolkit catalog for app recognition and suggestions.
 * The catalog is public provider metadata, so it is safe to cache globally;
 * tenant-specific connection state is overlaid by the authenticated route.
 */
export async function listAllToolkits({ search = '' } = {}) {
  const normalizedSearch = String(search || '').trim().toLowerCase();
  const now = Date.now();
  if (!toolkitCatalogCache || (now - toolkitCatalogCache.loadedAt) > TOOLKIT_CATALOG_TTL_MS) {
    const items = [];
    let cursor = null;
    do {
      const page = await listToolkits({ cursor, limit: 100 });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && items.length < 2000);
    toolkitCatalogCache = { loadedAt: now, items };
  }
  const items = normalizedSearch
    ? toolkitCatalogCache.items.filter((toolkit) => {
      const haystack = `${toolkit.slug} ${toolkit.name} ${toolkit.description || ''}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    })
    : toolkitCatalogCache.items;
  return { items, nextCursor: null, totalItems: items.length };
}

/**
 * Resolve (creating on demand if needed) the auth_config to connect a
 * toolkit through. Static COMPOSIO_AUTH_CONFIGS entries win — e.g. the
 * hand-tuned LinkedIn org-admin scope config from earlier stays in charge
 * for 'linkedin' rather than being replaced by an auto-provisioned one.
 * For any other OAuth2 toolkit with no static entry, auto-create a
 * Composio-managed auth config with default scopes so "browse the full
 * catalog, click Connect" works without an ops step per toolkit.
 *
 * Returns null for NO_AUTH toolkits (nothing to connect) and for API_KEY
 * toolkits (handled by a plain credential form, not a redirect link — see
 * createApiKeyConnection below).
 *
 * @param {string} toolkitSlug
 * @param {{ authSchemes: string[], composioManagedAuthSchemes: string[], noAuth: boolean }} toolkitMeta
 */
export async function getOrCreateAuthConfigId(toolkitSlug, toolkitMeta) {
  const existing = getAuthConfigId(toolkitSlug);
  if (existing) return existing;
  if (toolkitMeta?.noAuth) return null;
  if (!toolkitMeta?.composioManagedAuthSchemes?.includes('OAUTH2')) return null;

  const data = await composioPost('/api/v3.1/auth_configs', {
    toolkit: { slug: toolkitSlug },
    auth_config: {
      type: 'use_composio_managed_auth',
      name: `${toolkitSlug}-auto`,
      credentials: {}, // default scopes — narrower than a hand-tuned config, sufficient for browse-and-try
    },
  });
  return data?.auth_config?.id || null;
}

/**
 * Connect a toolkit whose auth scheme is a plain API key (SerpApi, Linear,
 * Firecrawl, ...) rather than OAuth2 — no redirect, the caller already has
 * the key. Deliberately NOT logged/persisted anywhere but Composio itself.
 *
 * @param {string} orgId
 * @param {string} toolkitSlug
 * @param {string} apiKey
 */
export async function createApiKeyConnection(orgId, toolkitSlug, apiKey) {
  const authConfigId = getAuthConfigId(toolkitSlug) || await (async () => {
    const data = await composioPost('/api/v3.1/auth_configs', {
      toolkit: { slug: toolkitSlug },
      auth_config: { type: 'use_custom_auth', auth_scheme: 'API_KEY', name: `${toolkitSlug}-api-key` },
    });
    return data?.auth_config?.id || null;
  })();
  if (!authConfigId) throw new Error(`Could not resolve an auth config for "${toolkitSlug}"`);

  const data = await composioPost('/api/v3.1/connected_accounts', {
    auth_config: { id: authConfigId },
    connection: { user_id: orgId, state: { authScheme: 'API_KEY', val: { status: 'INITIALIZED', api_key: apiKey } } },
  });
  return { id: data?.id, status: data?.status };
}
