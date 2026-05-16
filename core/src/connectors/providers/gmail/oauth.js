/**
 * Gmail OAuth Configuration
 *
 * Read-only scopes for ingestion. No write-back to Gmail.
 */

// Per-service scope map. Caller picks which services to request.
// Adding a service here = one more checkbox in the consent screen,
// nothing else changes server-side.
const SCOPE_MAP = {
  gmail:    ['https://www.googleapis.com/auth/gmail.readonly'],
  drive:    ['https://www.googleapis.com/auth/drive.readonly'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  docs:     ['https://www.googleapis.com/auth/documents.readonly'],
  sheets:   ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  slides:   ['https://www.googleapis.com/auth/presentations.readonly'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
  chat:     ['https://www.googleapis.com/auth/chat.messages.readonly'],
  tasks:    ['https://www.googleapis.com/auth/tasks.readonly'],
  forms:    ['https://www.googleapis.com/auth/forms.body.readonly'],
};

const BASE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export function getOAuthConfig(options = {}) {
  // services: ['gmail', 'drive', ...]  default = gmail only for backward compat
  const services = Array.isArray(options.services) && options.services.length > 0
    ? options.services
    : ['gmail'];

  const serviceScopes = services.flatMap(s => SCOPE_MAP[s] || []);
  const scopes = [...new Set([...BASE_SCOPES, ...serviceScopes])];

  return {
    providerId: 'gmail', // kept for backward compat — callback path still /gmail/callback
    clientId: process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes,
    accessType: 'offline',
    prompt: 'consent',
    services,
  };
}

export const AVAILABLE_SERVICES = Object.keys(SCOPE_MAP);
export { SCOPE_MAP };

/**
 * Build the OAuth authorization URL for Gmail.
 */
export function buildAuthUrl({ redirectUri, state, services }) {
  const config = getOAuthConfig({ services });
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    access_type: config.accessType,
    prompt: config.prompt,
    state,
    // include_granted_scopes DELIBERATELY OMITTED.
    // With it set to 'true' Google would return EVERY previously
    // authorized scope on this client, so a user clicking "Connect
    // Gmail" after having once granted Drive/Calendar would end up
    // with platform_integration rows for all of them. We want a
    // single Connect to grant only what was explicitly requested.
  });
  return `${config.authUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCode({ code, redirectUri }) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gmail token exchange failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();

  // Fetch user info to get email
  let email = null;
  try {
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userInfoResponse.ok) {
      const userInfo = await userInfoResponse.json();
      email = userInfo.email;
    }
  } catch {
    // Non-critical
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type,
    scope: data.scope,
    email,
  };
}
