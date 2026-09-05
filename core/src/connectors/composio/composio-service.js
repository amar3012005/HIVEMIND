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
 * by. Governed runs use a stable `${orgId}:${userId}` subject so one user's
 * connected account is never silently reused by another person in the same
 * organization. Older non-governed routes remain explicitly org-scoped until
 * their connection migration is complete.
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
 * A connection subject is authority, not a display identifier. New governed
 * calls must supply userId and are user-scoped by default. Legacy routes can
 * remain organization scoped only by omitting userId or explicitly choosing
 * connectionScope:"org" during the migration window.
 */
export function composioConnectionSubject(orgId, { userId = null, connectionScope = null } = {}) {
  const scope = String(connectionScope || process.env.COMPOSIO_GOVERNED_CONNECTION_SCOPE || (userId ? 'user' : 'org')).toLowerCase();
  if (scope === 'user' && userId) return `${orgId}:${userId}`;
  return String(orgId || '');
}

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
export async function listConnectedAccounts(orgId, opts = {}) {
  const subject = composioConnectionSubject(orgId, opts);
  const data = await composioGet(`/api/v3.1/connected_accounts?user_ids=${encodeURIComponent(subject)}`);
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
    user_id: composioConnectionSubject(orgId, opts),
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

function normalizedSessionKey(orgId, toolkits, {
  userId = null,
  connectionScope = null,
  includeCustomToolkit = true,
  manageConnections = false,
  callbackUrl = null,
} = {}) {
  const subject = composioConnectionSubject(orgId, { userId, connectionScope });
  const modes = [
    includeCustomToolkit ? 'custom' : 'external-only',
    manageConnections ? 'connections' : 'no-connections',
    manageConnections && callbackUrl ? `callback:${String(callbackUrl).slice(0, 400)}` : '',
  ].filter(Boolean).join('|');
  return `${subject}:${[...new Set(toolkits || [])].map(String).sort().join(',')}:${modes}`;
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
            && (slug.startsWith('LOCAL_HIVEMIND_')
              || slug.startsWith('HIVEMIND_')
              || !prefixes.length
              || prefixes.some((prefix) => slug.startsWith(`${prefix}_`)))) output.add(slug);
        }
      } else {
        collectPrimaryToolSlugs(item, prefixes, output);
      }
    }
  }
  return output;
}

async function executeSessionMeta(sessionId, slug, args, { timeoutMs = 6_500 } = {}) {
  const result = await _composioRequest('POST', `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/execute_meta`, {
    slug,
    arguments: { ...(args || {}), session_id: sessionId },
  }, { retries: 0, timeoutMs });
  if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
  return result;
}

/** Create or reuse a tenant-scoped Tool Router Session. */
export async function getToolRouterSession(orgId, toolkits, {
  allowDisconnected = false,
  userId = null,
  connectionScope = null,
  sessionId = null,
  includeCustomToolkit = true,
  manageConnections = false,
  callbackUrl = null,
} = {}) {
  const enabled = [...new Set((toolkits || []).map((toolkit) => String(toolkit).toLowerCase()).filter(Boolean))].sort();
  if (!orgId || !enabled.length) throw new Error('Composio Session requires an org and at least one toolkit');
  const subject = composioConnectionSubject(orgId, { userId, connectionScope });
  const sessionOptions = { userId, connectionScope, includeCustomToolkit, manageConnections, callbackUrl };
  const key = normalizedSessionKey(orgId, enabled, sessionOptions);

  // A graph checkpoint is the authority for a resumed run. Reattach to its
  // stored Composio session before consulting the process-local cache, so a
  // worker restart cannot silently create a different tool context.
  if (sessionId) {
    try {
      const existing = await composioGet(`/api/v3.1/tool_router/session/${encodeURIComponent(String(sessionId))}`);
      const sessionSubject = existing?.config?.user_id || existing?.user_id || null;
      if (sessionSubject && String(sessionSubject) !== subject) throw new Error('Composio session subject mismatch');
      const value = {
        id: String(sessionId), subject, toolkits: enabled, connectedAccounts: {},
        customToolkitAttached: false, customToolkitError: null,
      };
      TOOL_ROUTER_SESSION_CACHE.set(key, { at: Date.now(), value });
      return { ...value, cacheHit: true, resumed: true };
    } catch (error) {
      // A deleted/expired remote session is safe to replace for the same
      // authenticated subject. All other failures are observable rather than
      // being masked by a fresh session.
      if (error?.status !== 404) throw error;
    }
  }
  const cached = TOOL_ROUTER_SESSION_CACHE.get(key);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return { ...cached.value, cacheHit: true };

  const accounts = await listConnectedAccounts(orgId, { userId, connectionScope });
  const connectedAccounts = {};
  const { isUseToolsUnifiedDagEnabled } = await import('../../agent/use-tools-unified-flag.js');
  const unified = isUseToolsUnifiedDagEnabled();
  for (const toolkit of enabled) {
    const account = accounts.find((row) => row.toolkit === toolkit && row.status === 'ACTIVE');
    if (!account) {
      if (unified || allowDisconnected) continue;
      throw new Error(`No active Composio account for ${toolkit}`);
    }
    connectedAccounts[toolkit] = account.id;
  }
  const body = {
    // The remote Tool Router session must use the same authority subject that
    // owns its connected accounts. This is what keeps session discovery,
    // schemas, and execution scoped to the authenticated app user.
    user_id: subject,
    toolkits: { enable: enabled },
    connected_accounts: connectedAccounts,
    manage_connections: manageConnections
      ? {
        enable: true,
        enable_wait_for_connections: false,
        ...(callbackUrl ? { callback_url: String(callbackUrl).slice(0, 1800) } : {}),
      }
      : { enable: false },
    workbench: { enable: false },
  };
  let data;
  let customToolkitAttached = false;
  let customToolkitError = null;
  if (!includeCustomToolkit) {
    data = await _composioRequest('POST', '/api/v3/tool_router/session', body, { retries: 0, timeoutMs: 5_000 });
  } else {
    try {
      const { loadHivemindCustomToolkit, composioSessionExperimentalFromToolkit } = await import('./hivemind-custom-toolkit.js');
      const hivemindToolkit = await loadHivemindCustomToolkit();
      data = await _composioRequest('POST', '/api/v3/tool_router/session', {
        ...body,
        experimental: composioSessionExperimentalFromToolkit(hivemindToolkit),
      }, { retries: 0, timeoutMs: 8_000 });
      customToolkitAttached = true;
    } catch (error) {
      customToolkitError = String(error.message || error).slice(0, 240);
      data = await _composioRequest('POST', '/api/v3/tool_router/session', body, { retries: 0, timeoutMs: 5_000 });
    }
  }
  const value = { id: data?.session_id, subject, toolkits: enabled, connectedAccounts, customToolkitAttached, customToolkitError };
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

async function listCatalogTools({ search, toolkitSlug, important = false, limit = 24, cursor = null } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (search) qs.set('search', String(search).slice(0, 200));
  if (toolkitSlug) qs.set('toolkit_slug', toolkitSlug);
  if (important) qs.set('important', 'true');
  if (cursor) qs.set('cursor', String(cursor));
  const data = await composioGet(`/api/v3.1/tools?${qs.toString()}`);
  return {
    tools: (data?.items || []).map((tool) => mapCatalogTool(tool, toolkitSlug)).filter((tool) => tool._composio.slug),
    nextCursor: data?.next_cursor || null,
  };
}

const TOOLKIT_READ_CACHE = new Map();
const TOOLKIT_READ_TTL_MS = Number(process.env.COMPOSIO_TOOLKIT_READ_TTL_MS || 10 * 60 * 1000);
const CATALOG_READ_RE = /_(LIST|GET|SEARCH|FETCH|FIND|READ|RETRIEVE)_|^[A-Z0-9]+_(LIST|GET|SEARCH|FETCH|FIND|READ|RETRIEVE)/i;
const CATALOG_WRITE_RE = /_(DELETE|CREATE|ADD|UPDATE|SEND|REMOVE|TRASH|CLOSE|ABORT|ACCEPT|ENABLE|DISABLE|COMMIT|UPLOAD|POST|SET)_/;
function isCatalogReadTool(slug) {
  const value = String(slug || '');
  if (CATALOG_WRITE_RE.test(value) && !CATALOG_READ_RE.test(value)) return false;
  return CATALOG_READ_RE.test(value);
}

function isStrongCatalogRead(slug) {
  const value = String(slug || '');
  if (/PLAYLIST_ITEMS|LIST_USER_PLAYLISTS/i.test(value)) return true;
  return /LIST_/i.test(value)
    && /(REPOSITOR|PLAYLIST|VIDEO|DOCUMENT|FILE|PAGE)/i.test(value)
    && /(AUTHENTICATED|LIST_USER_|_MY_|_MINE_)/i.test(value);
}

async function listCatalogReadTools(toolkitSlug, { maxReads = 12, maxPages = 16 } = {}) {
  const key = String(toolkitSlug || '').toLowerCase();
  const cached = TOOLKIT_READ_CACHE.get(key);
  if (cached && Date.now() - cached.at < TOOLKIT_READ_TTL_MS) return cached.tools;
  const strong = [];
  const rest = [];
  let cursor = null;
  for (let page = 0; page < maxPages && strong.length < 2; page += 1) {
    const { tools, nextCursor } = await listCatalogTools({ toolkitSlug: key, limit: 50, cursor }).catch(() => ({ tools: [], nextCursor: null }));
    for (const tool of tools) {
      const slug = tool._composio.slug;
      if (!isCatalogReadTool(slug)) continue;
      if (isStrongCatalogRead(slug)) strong.push(tool);
      else rest.push(tool);
    }
    cursor = nextCursor;
    if (!cursor) break;
  }
  strong.sort((left, right) => {
    const rank = (slug) => (/LIST_USER_|AUTHENTICATED|_MY_|_MINE_/i.test(slug) ? 0 : 1);
    return rank(left._composio.slug) - rank(right._composio.slug);
  });
  const tools = [...strong, ...rest].slice(0, maxReads);
  TOOLKIT_READ_CACHE.set(key, { at: Date.now(), tools });
  return tools;
}

/**
 * Compact catalog for the HIVEMIND planner: Composio REST search on the
 * user intent (any app), plus this org's connected accounts, plus featured
 * tools for those apps. No session LLM — COMPOSIO_SEARCH_TOOLS is too slow
 * for first-action planning. Flash Lite only sees this catalog, not 1000 apps.
 */
export async function searchToolsByIntent(orgId, useCase, { toolkits } = {}) {
  const query = String(useCase || '').trim().slice(0, 200);
  const scoped = [...new Set((toolkits || []).map((toolkit) => String(toolkit || '').toLowerCase()).filter(Boolean))];
  const [accounts, searchedApps, globalPage] = await Promise.all([
    orgId ? listConnectedAccounts(orgId).catch(() => []) : Promise.resolve([]),
    query && !scoped.length ? listToolkits({ search: query, limit: 12 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    query && !scoped.length ? listCatalogTools({ search: query, limit: 24 }).catch(() => ({ tools: [] })) : Promise.resolve({ tools: [] }),
  ]);
  const globalTools = globalPage.tools || [];
  const connectedToolkits = [...new Set(
    accounts.filter((row) => row.status === 'ACTIVE').map((row) => row.toolkit).filter(Boolean),
  )];
  const fillToolkits = scoped.length
    ? scoped
    : [...new Set([
      ...connectedToolkits,
      ...(searchedApps.items || []).map((item) => item.slug).filter(Boolean),
    ])].slice(0, 8);
  const bySlug = new Map();
  if (fillToolkits.length) {
    const extras = await Promise.all(fillToolkits.flatMap((toolkit) => {
      const jobs = [
        listCatalogTools({ toolkitSlug: toolkit, important: true, limit: 12 }).then((row) => row.tools).catch(() => []),
        query ? listCatalogTools({ toolkitSlug: toolkit, search: query, limit: 12 }).then((row) => row.tools).catch(() => []) : Promise.resolve([]),
      ];
      if (scoped.length) jobs.unshift(listCatalogReadTools(toolkit).catch(() => []));
      return jobs;
    }));
    for (const tool of extras.flat()) {
      if (tool?._composio?.slug) bySlug.set(tool._composio.slug, tool);
    }
  }
  if (!scoped.length) {
    for (const tool of globalTools) {
      if (tool?._composio?.slug && !bySlug.has(tool._composio.slug)) bySlug.set(tool._composio.slug, tool);
    }
  }
  return {
    tools: [...bySlug.values()].slice(0, 48),
    connectedToolkits,
    accounts,
    apps: searchedApps.items || [],
  };
}

function searchMissesNamedToolkit(slugs, toolkits) {
  const prefixes = (toolkits || [])
    .map((toolkit) => String(toolkit || '').replace(/[^a-z0-9]/gi, '').toUpperCase())
    .filter((prefix) => prefix && prefix !== 'HIVEMIND' && prefix !== 'LOCAL');
  if (!prefixes.length) return false;
  return prefixes.some((prefix) => !(slugs || []).some((slug) => String(slug).startsWith(`${prefix}_`)));
}

function collectRelatedToolSlugs(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRelatedToolSlugs(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'related_tool_slugs' && Array.isArray(item)) {
        for (const slug of item) {
          if (typeof slug === 'string' && slug.trim()) output.add(slug);
        }
      } else {
        collectRelatedToolSlugs(item, output);
      }
    }
  }
  return output;
}

function normalizeToolkitConnectionStatuses(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const slug = String(row?.toolkit || row?.slug || row?.app || '').toLowerCase();
      if (slug) out[slug] = row;
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw)) {
      out[String(key).toLowerCase()] = val;
    }
  }
  return out;
}

export async function discoverSessionTools(orgId, {
  toolkits,
  useCases,
  searchPayload = null,
  allowDisconnected = false,
  userId = null,
  connectionScope = null,
  sessionId = null,
  includeCustomToolkit = true,
  manageConnections = false,
  callbackUrl = null,
}) {
  const { formatComposioSearch, extractWorkflowSessionId } = await import('./composio-search-formatter.js');
  const session = await getToolRouterSession(orgId, toolkits, {
    allowDisconnected, userId, connectionScope, sessionId, includeCustomToolkit, manageConnections, callbackUrl,
  });
  const normalizedCases = (useCases || []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!normalizedCases.length && !searchPayload?.queries?.length) {
    throw new Error('Composio Session discovery requires a use-case');
  }
  const legalPayload = searchPayload && Array.isArray(searchPayload.queries)
    ? {
      ...searchPayload,
      search_strategy: searchPayload.search_strategy === 'tool_search' ? 'tool_search' : 'auto',
      session: searchPayload.session?.generate_id === true || !searchPayload.session?.id
        || /^trs_/i.test(String(searchPayload.session.id || searchPayload.session.generate_id || ''))
        ? { generate_id: true }
        : { id: String(searchPayload.session.id) },
      queries: searchPayload.queries.map((query) => ({
        use_case: String(query.use_case || '').trim(),
        known_fields: typeof query.known_fields === 'string'
          ? query.known_fields
          : formatComposioSearch({
            message: query.use_case,
            destinationApps: toolkits,
          }).queries[0].known_fields,
      })),
    }
    : formatComposioSearch({
      message: normalizedCases.join(' '),
      destinationApps: toolkits,
      generateId: true,
    });
  const cacheKey = `${session.id}:${JSON.stringify({
    cases: normalizedCases.map((item) => item.toLowerCase()),
    strategy: legalPayload.search_strategy,
    fields: legalPayload.queries,
  })}`;
  const cached = TOOL_ROUTER_DISCOVERY_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < SESSION_DISCOVERY_TTL_MS) {
    return { ...cached.value, sessionCacheHit: session.cacheHit, discoveryCacheHit: true };
  }

  const prefixes = session.toolkits.map((toolkit) => toolkit.replace(/[^a-z0-9]/gi, '').toUpperCase());
  let searched = await executeSessionMeta(session.id, 'COMPOSIO_SEARCH_TOOLS', legalPayload, { timeoutMs: 20_000 });
  let primary = collectPrimaryToolSlugs(searched?.data, prefixes);
  let slugs = [...(primary.size ? primary : collectToolSlugs(searched?.data, prefixes))];
  const workflowId = extractWorkflowSessionId(searched);
  if (searchMissesNamedToolkit(slugs, session.toolkits) && legalPayload.search_strategy !== 'tool_search') {
    const retryPayload = {
      ...legalPayload,
      search_strategy: 'tool_search',
      session: workflowId ? { id: workflowId } : { generate_id: true },
    };
    searched = await executeSessionMeta(session.id, 'COMPOSIO_SEARCH_TOOLS', retryPayload, { timeoutMs: 20_000 });
    primary = collectPrimaryToolSlugs(searched?.data, prefixes);
    slugs = [...(primary.size ? primary : collectToolSlugs(searched?.data, prefixes))];
  }
  slugs = slugs.slice(0, 24);
  if (!slugs.length) throw new Error('Composio Session found no matching tools');
  const schemaResult = await executeSessionMeta(session.id, 'COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: slugs }, { timeoutMs: 10_000 });
  const schemas = schemaResult?.data?.tool_schemas || searched?.data?.tool_schemas || {};
  const tools = slugs.map((slug) => {
    const schema = schemas[slug] || {};
    return {
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
    };
  });
  const statuses = normalizeToolkitConnectionStatuses(
    searched?.data?.toolkit_connection_statuses
    || searched?.data?.connection_statuses
    || searched?.toolkit_connection_statuses
    || {},
  );
  const value = {
    sessionId: session.id,
    workflowSessionId: workflowId,
    tools,
    primaryToolSlugs: [...primary],
    relatedToolSlugs: [...collectRelatedToolSlugs(searched?.data)],
    toolkitConnectionStatuses: statuses,
    recommendedPlanSteps: searched?.data?.recommended_plan_steps || [],
    nextStepsGuidance: searched?.data?.next_steps_guidance || null,
    searchedLogId: searched?.log_id || null,
    schemaLogId: schemaResult?.log_id || null,
    toolSchemas: schemas,
    customToolkitAttached: Boolean(session.customToolkitAttached),
    searchStrategy: legalPayload.search_strategy,
  };
  TOOL_ROUTER_DISCOVERY_CACHE.set(cacheKey, { at: Date.now(), value });
  return { ...value, sessionCacheHit: session.cacheHit, discoveryCacheHit: false };
}

function connectionRedirectUrl(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 24)) {
      const found = connectionRedirectUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['redirect_url', 'redirectUrl', 'auth_url', 'authUrl', 'url']) {
    const found = connectionRedirectUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(value).slice(0, 24)) {
    const found = connectionRedirectUrl(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Connection management for governed sessions is itself a Composio Meta Tool.
 * The returned link is tied to the same session/user that discovered the
 * capability; Core only presents it and resumes its own graph after OAuth.
 */
export async function manageSessionConnections(sessionId, toolkits, { reinitiateAll = false } = {}) {
  const enabled = [...new Set((toolkits || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  if (!sessionId || !enabled.length) throw new Error('Composio connection management requires a session and toolkit');
  const result = await executeSessionMeta(sessionId, 'COMPOSIO_MANAGE_CONNECTIONS', {
    toolkits: enabled,
    reinitiate_all: Boolean(reinitiateAll),
  }, { timeoutMs: 20_000 });
  if (result?.successful === false || result?.data?.successful === false) {
    throw new Error(String(result?.error || result?.data?.error || 'Composio connection management failed').slice(0, 300));
  }
  return {
    successful: true,
    redirectUrl: connectionRedirectUrl(result?.data || result),
  };
}

export async function getSessionToolSchemas(sessionId, slugs = []) {
  const list = [...new Set((slugs || []).map((slug) => String(slug || '').trim()).filter(Boolean))].slice(0, 12);
  if (!sessionId || !list.length) return {};
  const schemaResult = await executeSessionMeta(sessionId, 'COMPOSIO_GET_TOOL_SCHEMAS', { tool_slugs: list }, { timeoutMs: 10_000 });
  return schemaResult?.data?.tool_schemas || {};
}

/** Execute one already-discovered READ through the same Session. */
export async function executeSessionTool(sessionId, toolSlug, args = {}) {
  const batch = await executeToolsParallel(null, [{ slug: toolSlug, arguments: args }], { sessionId });
  return batch[0] || { successful: false, data: null, error: 'no result', session_log_id: null };
}

export async function executeToolsParallel(orgId, tools = [], { sessionId, allowDirectFallback = true } = {}) {
  const calls = (Array.isArray(tools) ? tools : []).map((tool) => ({
    slug: tool.slug || tool.tool_slug,
    arguments: tool.arguments || tool.args || {},
  })).filter((tool) => tool.slug);
  if (sessionId) {
    try {
      const result = await executeSessionMeta(sessionId, 'COMPOSIO_MULTI_EXECUTE_TOOL', {
        tools: calls.map((tool) => ({ tool_slug: tool.slug, arguments: tool.arguments })),
        thought: 'Execute independent read tools in parallel.',
        sync_response_to_workbench: false,
        current_step: 'EXECUTING_READS',
        current_step_metric: `0/${calls.length} tools`,
      });
      const rows = result?.data?.results || [];
      return calls.map((tool, index) => {
        const row = rows.find((item) => item?.index === index) || rows[index] || {};
        const response = row.response || {};
        return {
          successful: Boolean(response.successful ?? result?.successful),
          data: response.data ?? null,
          error: response.error || row.error || result?.error || null,
          slug: tool.slug,
          session_log_id: result?.log_id || null,
        };
      });
    } catch (error) {
      // Direct execute is the reliable path when session multi-execute rejects a mixed batch.
      if (!allowDirectFallback) {
        return calls.map((tool) => ({ successful: false, data: null, error: String(error.message || error).slice(0, 300), slug: tool.slug }));
      }
    }
  }
  return Promise.all(calls.map(async (tool) => {
    try {
      const output = await executeTool(orgId, tool.slug, tool.arguments);
      return { ...output, slug: tool.slug };
    } catch (error) {
      return { successful: false, data: null, error: String(error.message || error).slice(0, 300), slug: tool.slug };
    }
  }));
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
