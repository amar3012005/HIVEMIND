/**
 * Linear OAuth 2.0.
 *
 * Standard authorization-code flow; the token Linear hands back is a
 * single Bearer used against https://api.linear.app/graphql.
 *
 * Required env vars (control-plane container):
 *   LINEAR_CLIENT_ID
 *   LINEAR_CLIENT_SECRET
 *   LINEAR_REDIRECT_URI   (optional override)
 *
 * App registration: linear.app/<workspace>/settings/api → OAuth apps.
 * Redirect URI must match getConnectorCallbackUrl('linear') exactly,
 * e.g. https://api.hivemind.davinciai.eu:8040/v1/connectors/linear/callback
 */

const SCOPES = [
  'read',
  'issues:read',
  'projects:read',
  // Stay read-only for v1; bump to 'write' later when we want to create
  // / comment on Linear issues from inside HIVEMIND.
];

export function getOAuthConfig() {
  return {
    providerId: 'linear',
    clientId: process.env.LINEAR_CLIENT_ID || '',
    clientSecret: process.env.LINEAR_CLIENT_SECRET || '',
    authUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    scopes: SCOPES,
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
    // Linear supports "actor" — set to "user" so the access token acts
    // as the granting user rather than the app itself.
    actor: 'user',
  });
  return `${config.authUrl}?${params}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  // Linear token endpoint expects x-www-form-urlencoded, not JSON.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Linear token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  // Resolve viewer email so the account_ref column shows something useful.
  let email = null;
  try {
    const v = await _gql(data.access_token, '{ viewer { email name } }');
    email = v?.viewer?.email || v?.viewer?.name || null;
  } catch (err) {
    console.warn('[linear.oauth] viewer fetch failed:', err.message);
  }

  return {
    access_token: data.access_token,
    refresh_token: null, // Linear access tokens are long-lived; no refresh
    expires_in: data.expires_in || null,
    email,
    provider_metadata: { token_type: data.token_type || 'Bearer' },
  };
}

async function _gql(token, query) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Linear GraphQL ${res.status}`);
  const data = await res.json();
  return data?.data || null;
}
