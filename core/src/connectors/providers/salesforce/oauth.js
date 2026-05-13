/**
 * Salesforce OAuth 2.0 (Web Server flow).
 *
 * Required env vars (control-plane container):
 *   SALESFORCE_CLIENT_ID
 *   SALESFORCE_CLIENT_SECRET
 *   SALESFORCE_REDIRECT_URI   (optional override)
 *   SALESFORCE_LOGIN_HOST     — defaults to login.salesforce.com.
 *                               Use test.salesforce.com for sandboxes.
 *
 * Connected App setup (Salesforce Setup → App Manager):
 *   - Enable OAuth Settings
 *   - Callback URL: getConnectorCallbackUrl('salesforce')
 *   - Scopes: api, refresh_token, offline_access, chatter_api
 *   - Wait ~10 min for OAuth policies to propagate before first auth
 *
 * Token response includes `instance_url` which is the org-specific REST
 * base — we stash it in provider_metadata so every adapter request can
 * use it without re-introspection.
 */

const SCOPES = ['api', 'refresh_token', 'offline_access', 'chatter_api'];

function loginHost() {
  return process.env.SALESFORCE_LOGIN_HOST || 'login.salesforce.com';
}

export function getOAuthConfig() {
  return {
    providerId: 'salesforce',
    clientId: process.env.SALESFORCE_CLIENT_ID || '',
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET || '',
    authUrl: `https://${loginHost()}/services/oauth2/authorize`,
    tokenUrl: `https://${loginHost()}/services/oauth2/token`,
    scopes: SCOPES,
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `${config.authUrl}?${params}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Salesforce token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  // Salesforce identity endpoint returns the user's email.
  let email = null;
  if (data.id) {
    try {
      const idRes = await fetch(data.id, { headers: { Authorization: `Bearer ${data.access_token}` } });
      if (idRes.ok) {
        const id = await idRes.json();
        email = id.email || id.username || null;
      }
    } catch (err) {
      console.warn('[salesforce.oauth] identity lookup failed:', err.message);
    }
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || null,
    email,
    provider_metadata: {
      instance_url: data.instance_url,
      signature: data.signature || null,
      issued_at: data.issued_at || null,
      id_url: data.id || null,
      token_type: data.token_type || 'Bearer',
    },
  };
}

export async function refreshToken({ refreshToken }) {
  const config = getOAuthConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Salesforce token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || null,
    // instance_url can change after a refresh in some edge cases — return
    // it so the framework can update provider_metadata if it wants to.
    provider_metadata: data.instance_url ? { instance_url: data.instance_url } : undefined,
  };
}
