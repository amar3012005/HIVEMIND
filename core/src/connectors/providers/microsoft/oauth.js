/**
 * Microsoft (Outlook + Calendar + Teams + SharePoint) OAuth 2.0 via Azure AD.
 *
 * One client registration covers everything Microsoft Graph exposes; we
 * use a curated subset of delegated scopes that map to the adapter's
 * fetch surface (mail, calendar, teams chat). SharePoint + Files are
 * reachable with the same token if we widen scopes later.
 *
 * Required env vars (control-plane container):
 *   MICROSOFT_TENANT_ID     — Azure AD tenant or "common" for multi-tenant
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_REDIRECT_URI  (optional override)
 *
 * App registration: portal.azure.com → App registrations → New
 *   Supported account types: Multitenant (or single tenant if internal)
 *   Redirect URI (web): https://api.hivemind.davinciai.eu:8040/v1/connectors/microsoft/callback
 *   API permissions (delegated): Mail.Read, Calendars.Read, Chat.Read,
 *     ChannelMessage.Read.All, User.Read, offline_access
 */

const SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
  'Chat.Read',
  'ChannelMessage.Read.All',
];

function tenant() {
  return process.env.MICROSOFT_TENANT_ID || 'common';
}

export function getOAuthConfig() {
  return {
    providerId: 'microsoft',
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    authUrl: `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    scopes: SCOPES,
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `${config.authUrl}?${params}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Microsoft token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();

  // Resolve the user's email so account_ref / connector label is human readable.
  let email = null;
  let userId = null;
  try {
    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (meRes.ok) {
      const me = await meRes.json();
      email = me.mail || me.userPrincipalName || me.displayName || null;
      userId = me.id || null;
    }
  } catch (err) {
    console.warn('[microsoft.oauth] /me lookup failed:', err.message);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || null,
    email,
    provider_metadata: {
      tenant: tenant(),
      graph_user_id: userId,
      id_token: data.id_token || null,
    },
  };
}

export async function refreshToken({ refreshToken }) {
  const config = getOAuthConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${res.status}`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || null,
  };
}
