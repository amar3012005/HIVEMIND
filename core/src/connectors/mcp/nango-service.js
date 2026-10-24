/**
 * Nango token resolution service.
 *
 * Resolves user/org Nango connections and fetches a fresh bearer token
 * (auto-refreshed by Nango) before any MCP runner call.
 *
 * Intended to sit *outside* the transport-level MCPConnectorRunner,
 * called from MCPIngestionService (and future live-tool service)
 * so the runner stays transport-pure.
 */

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const NANGO_URL = process.env.NANGO_URL || 'http://nango:3003';
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY || 'dev-secret-change-me';

// ---------------------------------------------------------------------------
// Fetch helper — lightweight, avoids pulling @nangohq/node as a heavy dep.
// If you prefer the official SDK, swap this for:
//   import Nango from '@nangohq/node';
//   const nango = new Nango({ baseUrl: NANGO_URL, secretKey: NANGO_SECRET_KEY });
// ---------------------------------------------------------------------------

/** GET wrapper. */
export async function nangoGet(path, opts = {}) {
  return _nangoRequest('GET', path, null, opts);
}

/** POST wrapper. */
async function nangoPost(path, body, opts = {}) {
  return _nangoRequest('POST', path, body, opts);
}

/** DELETE wrapper. */
async function nangoDelete(path, opts = {}) {
  return _nangoRequest('DELETE', path, null, opts);
}

/**
 * Delete a Nango connection (revoke OAuth grant at Nango).
 * Returns true on 200/204, false if connection was already gone.
 */
export async function deleteConnection(providerKey, connectionId) {
  try {
    await nangoDelete(`/connection/${connectionId}?provider_config_key=${encodeURIComponent(providerKey)}`);
    return true;
  } catch (err) {
    // 404 = already deleted; treat as success
    if (String(err.message).includes('404')) return false;
    throw err;
  }
}

async function _nangoRequest(method, path, body, { retries = 2 } = {}) {
  const url = `${NANGO_URL}${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${NANGO_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Nango ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
      }
      try { return JSON.parse(text); } catch { return text; }
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the Nango connection_id for a given user/org/provider.
 * Returns null if no connection exists.
 *
 * @param {{ userId: string, orgId: string, providerKey: string }} params
 * @param {{ db: any }} ctx — prisma client or compatible repository
 */
export async function getConnectionId({ userId, orgId, providerKey }, { db }) {
  // orgId is non-nullable in the NangoConnection schema, so passing
  // `orgId: null` makes Prisma throw "Argument orgId must not be null" —
  // which is exactly what the sync scheduler did on every tick (it has no
  // org context) and what broke every scheduled Slack sync. Treat a falsy
  // orgId as "any org for this user" instead of an invalid filter.
  const where = { userId, providerKey, status: 'active' };
  if (orgId) where.orgId = orgId;
  const row = await db.nangoConnection.findFirst({
    where,
    select: { connectionId: true },
  });
  return row?.connectionId ?? null;
}

/**
 * Fetch credentials from Nango for a given connection_id.
 * Returns the bearer token (access_token or apiKey).
 *
 * @param {string} providerKey
 * @param {string} connectionId
 * @returns {Promise<string>}
 */
export async function fetchBearerFromNango(providerKey, connectionId) {
  // Nango credentials endpoint: /connection/<id>?provider_config_key=<key>
  // (NOT /connection/<key>/<id> — that path 404s)
  const creds = await nangoGet(
    `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
  );
  const bearer =
    creds?.credentials?.access_token ||
    creds?.credentials?.apiKey ||
    null;
  if (!bearer) {
    throw new Error(`Nango returned no bearer token for provider ${providerKey}`);
  }
  return bearer;
}

/**
 * Confirm with Nango that a connection was created through a Connect session
 * for this principal before HIVEMIND binds it. A client-supplied
 * `connection_id` is otherwise only an identifier: without this check a
 * caller could bind another tenant's connection to their own user and read
 * that tenant's data through it.
 *
 * Nango records the Connect session's `end_user` (and organization) on the
 * connection; newer Nango releases expose the same identity as reserved
 * `tags`. Both are accepted. A connection with no recorded owner is rejected.
 *
 * @param {{ providerKey: string, connectionId: string, userId: string, orgId?: string | null }} params
 * @param {{ get?: (path: string) => Promise<any> }} [deps] Nango GET implementation (tests)
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'connection_not_found' | 'connection_unverifiable' | 'connection_owner_mismatch' }>}
 */
export async function verifyConnectionOwnership({ providerKey, connectionId, userId, orgId = null }, { get = nangoGet } = {}) {
  if (!providerKey || !connectionId || !userId) return { ok: false, reason: 'connection_owner_mismatch' };
  let connection;
  try {
    connection = await get(
      `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
    );
  } catch (err) {
    return { ok: false, reason: /\b404\b/.test(String(err?.message)) ? 'connection_not_found' : 'connection_unverifiable' };
  }
  if (!connection || typeof connection !== 'object') return { ok: false, reason: 'connection_unverifiable' };
  const configKey = connection.provider_config_key ?? connection.providerConfigKey;
  if (configKey !== undefined && String(configKey) !== String(providerKey)) {
    return { ok: false, reason: 'connection_owner_mismatch' };
  }
  const tags = connection.tags && typeof connection.tags === 'object' ? connection.tags : {};
  const endUser = connection.end_user && typeof connection.end_user === 'object' ? connection.end_user : {};
  const ownerUserId = endUser.id ?? endUser.end_user_id ?? tags.end_user_id ?? null;
  const ownerOrgId = endUser.organization?.id ?? endUser.organization_id ?? tags.organization_id ?? null;
  if (!ownerUserId || String(ownerUserId) !== String(userId)) return { ok: false, reason: 'connection_owner_mismatch' };
  if (orgId && ownerOrgId && String(ownerOrgId) !== String(orgId)) return { ok: false, reason: 'connection_owner_mismatch' };
  return { ok: true };
}

export function isPermanentNangoCredentialError(error) {
  return /refresh limit|invalid_credentials|unknown_account|authentication failed|\b401\b|\b424\b/i
    .test(String(error?.message || error || ''));
}

/**
 * Enrich an MCP endpoint config with a live bearer token from Nango.
 * Leaves the endpoint unchanged if it has no `nango_provider`.
 *
 * @param {object} endpoint — MCP endpoint descriptor from registry
 * @param {{ userId: string, orgId: string }} scope
 * @param {{ db: any }} ctx
 * @returns {Promise<object>} — endpoint with bearer_token injected
 */
export async function enrichEndpointWithToken(endpoint, { userId, orgId }, { db }) {
  if (!endpoint.nango_provider) {
    return endpoint;
  }

  const connectionId = await getConnectionId(
    { userId, orgId, providerKey: endpoint.nango_provider },
    { db },
  );

  if (!connectionId) {
    throw new Error(
      `No Nango connection for provider ${endpoint.nango_provider} (user ${userId}, org ${orgId})`,
    );
  }

  let bearer;
  try {
    bearer = await fetchBearerFromNango(endpoint.nango_provider, connectionId);
  } catch (err) {
    // Self-heal: a connection whose credentials are permanently dead
    // ("refresh limit has been reached", invalid_credentials) never recovers.
    // Flip it out of 'active' so getConnectionId stops returning it — this
    // path (MCP status/inspect, polled by the Connectors page) was hammering
    // Nango with the same dead gmail/gdocs connections on every poll.
    if (isPermanentNangoCredentialError(err)) {
      db?.nangoConnection?.updateMany({
        where: { connectionId, providerKey: endpoint.nango_provider, status: 'active' },
        data: { status: 'error' },
      }).then((r) => {
        if (r?.count) console.warn(`[Nango] marked dead connection ${connectionId} (${endpoint.nango_provider}) status=error — user must reconnect`);
      }).catch(() => {});
    }
    throw err;
  }

  return {
    ...endpoint,
    bearer_token: bearer,
  };
}

/**
 * Create a Nango Connect session for the user.
 * Used by the backend to generate a session token for the frontend popup.
 *
 * @param {{ userId: string, orgId: string, allowedIntegrations: string[] }} params
 * @returns {Promise<string>} connectSessionToken
 */
export async function createConnectSession({ userId, orgId, allowedIntegrations }) {
  // Nango Connect REST API: POST /connect/sessions
  // https://docs.nango.dev/reference/api/connect/sessions/create
  const body = await nangoPost('/connect/sessions', {
    end_user: { id: userId },
    ...(orgId ? { organization: { id: orgId } } : {}),
    allowed_integrations: allowedIntegrations,
  });
  return body?.data?.token || body?.token || body?.connect_session_token || null;
}
