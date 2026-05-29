// Slack OAuth v2 — bot scopes vs user scopes are separate.
// `scope`      → installed bot's permissions (workspace-wide).
// `user_scope` → permissions delegated by the installing user.
// search.messages can only be called with a user token (search:read is a
// user-only scope), so we request it via user_scope and use authed_user.access_token
// for live search calls.

// Must EXACTLY match the Slack app's configured Bot Token Scopes — requesting
// any bot scope the app doesn't have => Slack OAuth "invalid_scope_requested".
const BOT_SCOPES = [
  'channels:history', 'channels:read',
  'groups:history',
  'im:history', 'mpim:history',
  'users:read',
  'team:read',
  'chat:write',
  'app_mentions:read',
];

const USER_SCOPES = [
  'search:read',
];

export function getOAuthConfig() {
  return {
    providerId: 'slack',
    clientId: process.env.SLACK_CLIENT_ID || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: BOT_SCOPES,
    userScopes: USER_SCOPES,
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(','),
    user_scope: config.userScopes.join(','),
    state,
  });
  return `${config.authUrl}?${params}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) throw new Error(`Slack token exchange failed: ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(`Slack OAuth error: ${data.error}`);

  // Persist bot token as primary access_token (used for channel reads, posting,
  // user info, etc.). The user-scope token (authed_user.access_token) is what
  // powers search.messages — store it in metadata so the bridge can pick it up.
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: null,
    email: data.authed_user?.id || null,  // Slack user ID for attribution
    team: data.team?.name || null,
    team_id: data.team?.id || null,
    authed_user_id: data.authed_user?.id || null,
    user_access_token: data.authed_user?.access_token || null,
    user_scope: data.authed_user?.scope || null,
    bot_scope: data.scope || null,
  };
}
