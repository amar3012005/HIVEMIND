export function getOAuthConfig() {
  return {
    providerId: 'slack',
    clientId: process.env.SLACK_CLIENT_ID || '',
    clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'im:history', 'mpim:history', 'users:read', 'team:read'],
  };
}

export function buildAuthUrl({ redirectUri, state }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(','),
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

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: null,
    email: data.authed_user?.id || null,  // Slack user ID for attribution
    team: data.team?.name || null,
    team_id: data.team?.id || null,
    authed_user_id: data.authed_user?.id || null,
  };
}
