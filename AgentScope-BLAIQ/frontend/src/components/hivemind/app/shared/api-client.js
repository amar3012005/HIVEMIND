/**
 * AgentScope-BLAIQ API Client
 *
 * All API calls proxy through Vite dev server → control-plane at port 8020.
 * Prefix: /api/v1/* is proxied to control-plane /v1/*
 */

const BASE = '/api';

async function request(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== null) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, opts);

  if (!res.ok) {
    const err = new Error(`API ${method} ${path} → ${res.status}`);
    err.response = { status: res.status };
    try {
      err.response.data = await res.json();
    } catch {
      err.response.data = {};
    }
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return null;
}

const controlPlane = {
  get: (path) => request('GET', path).then((data) => ({ data })),
  post: (path, body) => request('POST', path, body).then((data) => ({ data })),
  delete: (path, body) => request('DELETE', path, body).then((data) => ({ data })),
};

const apiClient = {
  controlPlane,

  /** Bootstrap: get session + user + org */
  bootstrap: () => request('GET', '/v1/bootstrap'),

  /** Health check */
  health: () => request('GET', '/v1/health'),

  /** Get user memory profile (footprint stats) */
  getProfile: () => request('GET', '/v1/proxy/profile'),

  /** Get recall context for a query */
  getContext: (query) =>
    request('POST', '/v1/proxy/recall', {
      query_context: query,
      max_memories: 5,
    }),

  /** Delete account — requires confirm: "DELETE" */
  deleteAccount: () =>
    request('POST', '/v1/account/delete', { confirm: 'DELETE' }),

  /** Request data export */
  exportData: () => request('POST', '/v1/account/export'),

  /** Connectors */
  getDescriptors: () => request('GET', '/v1/clients/descriptors'),
  getConnectorStatus: () => request('GET', '/v1/proxy/connectors/mcp/status'),
  listConnectorJobs: () => request('GET', '/v1/proxy/connectors/mcp/jobs'),
  listOAuthConnectors: () => request('GET', '/v1/connectors'),
  startConnectorOAuth: (provider, returnTo) =>
    request('POST', `/v1/connectors/${provider}/start`, { return_to: returnTo }),
  disconnectConnector: (provider) => request('POST', `/v1/connectors/${provider}/disconnect`),
  resyncConnector: (provider) => request('POST', `/v1/connectors/${provider}/resync`, {}),

  /** Gmail legacy helpers used by Connectors.jsx */
  gmailConnect: () => request('POST', '/v1/connectors/gmail/start', { return_to: window.location.pathname }),
  gmailDisconnect: () => request('POST', '/v1/connectors/gmail/disconnect'),
  gmailSync: (settings = {}) => request('POST', '/v1/connectors/gmail/resync', settings),

  /** WhatsApp QR connector */
  whatsappQr: () => request('POST', '/connectors/whatsapp/qr'),
  whatsappStatus: () => request('GET', '/connectors/whatsapp/status'),
  whatsappDisconnect: () => request('POST', '/connectors/whatsapp/disconnect'),
};

export default apiClient;
