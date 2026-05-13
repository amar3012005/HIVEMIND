/**
 * Atlassian OAuth 2.0 (3LO).
 *
 * Covers Jira + Confluence under a single integration. After the user
 * grants consent we additionally hit
 *   GET https://api.atlassian.com/oauth/token/accessible-resources
 * to resolve the user's cloud_id (one per Jira/Confluence Cloud site).
 * cloud_id is required for every subsequent Jira/Confluence API call,
 * so we stash it in provider_metadata at exchangeCode time.
 *
 * Required env vars (control-plane container):
 *   ATLASSIAN_CLIENT_ID
 *   ATLASSIAN_CLIENT_SECRET
 *   ATLASSIAN_REDIRECT_URI  (optional override)
 *
 * App registration: developer.atlassian.com → Console → OAuth 2.0 (3LO).
 * Scopes used below match the Jira + Confluence read APIs we need; tweak
 * if you also want write access later.
 */

const SCOPES = [
  // Jira (read-only + project metadata)
  'read:jira-work',
  'read:jira-user',
  // Confluence
  'read:confluence-content.summary',
  'read:confluence-content.all',
  'read:confluence-space.summary',
  'read:confluence-user',
  // Required for refresh tokens
  'offline_access',
];

export function getOAuthConfig() {
  return {
    providerId: 'atlassian',
    clientId: process.env.ATLASSIAN_CLIENT_ID || '',
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET || '',
    authUrl: 'https://auth.atlassian.com/authorize',
    tokenUrl: 'https://auth.atlassian.com/oauth/token',
    scopes: SCOPES,
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: config.clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent', // force refresh_token issue
  });
  return `${config.authUrl}?${params}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Atlassian token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  // Resolve the user's accessible Atlassian Cloud sites (one cloud_id per site).
  // We persist the FIRST site only for now; multi-site users can be supported
  // later by storing all sites and letting the user pick.
  let cloudSite = null;
  try {
    const arRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (arRes.ok) {
      const sites = await arRes.json();
      cloudSite = Array.isArray(sites) ? sites[0] : null;
    }
  } catch (err) {
    console.warn('[atlassian.oauth] accessible-resources fetch failed:', err.message);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || null,
    email: cloudSite?.name || cloudSite?.url || null,
    provider_metadata: {
      cloud_id: cloudSite?.id || null,
      cloud_url: cloudSite?.url || null,
      cloud_name: cloudSite?.name || null,
      cloud_scopes: cloudSite?.scopes || [],
    },
  };
}

export async function refreshToken({ refreshToken }) {
  const config = getOAuthConfig();
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Atlassian token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || null,
  };
}
