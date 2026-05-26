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
  const row = await db.nangoConnection.findFirst({
    where: { userId, orgId, providerKey, status: 'active' },
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

  const bearer = await fetchBearerFromNango(endpoint.nango_provider, connectionId);

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
