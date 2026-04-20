export type BuildAuthorizeUrlInput = {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource?: string;
  state: string;
  codeChallenge: string;
};

export type ExchangeCodeInput = {
  baseUrl: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
};

export type RefreshAccessTokenInput = {
  baseUrl: string;
  refreshToken: string;
  clientId: string;
};

export type RevokeTokenInput = {
  baseUrl: string;
  token: string;
  clientId: string;
};

export type GetConnectionStatusInput = {
  baseUrl: string;
  accessToken: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

async function parseJsonResponse(resp: Response): Promise<any> {
  let payload: any = {};
  try {
    payload = await resp.json();
  } catch {
    payload = {};
  }
  if (!resp.ok) {
    const description = payload?.error_description || payload?.message || `HTTP ${resp.status}`;
    throw new Error(description);
  }
  return payload;
}

export function buildAuthorizeUrl({
  baseUrl,
  clientId,
  redirectUri,
  scope,
  resource,
  state,
  codeChallenge
}: BuildAuthorizeUrlInput): string {
  const root = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  if (resource) params.set('resource', resource);
  return `${root}/oauth/authorize?${params.toString()}`;
}

export async function exchangeCode({
  baseUrl,
  code,
  codeVerifier,
  redirectUri,
  clientId
}: ExchangeCodeInput): Promise<any> {
  const root = normalizeBaseUrl(baseUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: clientId
  });
  const resp = await fetch(`${root}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return parseJsonResponse(resp);
}

export async function refreshAccessToken({
  baseUrl,
  refreshToken,
  clientId
}: RefreshAccessTokenInput): Promise<any> {
  const root = normalizeBaseUrl(baseUrl);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId
  });
  const resp = await fetch(`${root}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return parseJsonResponse(resp);
}

export async function revokeToken({
  baseUrl,
  token,
  clientId
}: RevokeTokenInput): Promise<any> {
  const root = normalizeBaseUrl(baseUrl);
  const body = new URLSearchParams({
    token,
    client_id: clientId
  });
  const resp = await fetch(`${root}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return parseJsonResponse(resp);
}

export async function getConnectionStatus({
  baseUrl,
  accessToken
}: GetConnectionStatusInput): Promise<any> {
  const root = normalizeBaseUrl(baseUrl);
  const resp = await fetch(`${root}/oauth/connection-status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return parseJsonResponse(resp);
}
