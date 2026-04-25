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

export type ManagedTokens = {
  accessToken: string;
  refreshToken?: string;
  scope?: string;
};

export type ManagedToolClientInput = {
  baseUrl: string;
  clientId: string;
  getTokens: () => Promise<ManagedTokens> | ManagedTokens;
  saveTokens: (tokens: ManagedTokens) => Promise<void> | void;
};

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type CallToolInput = {
  name: string;
  arguments?: Record<string, unknown>;
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

async function runJsonRpcRequest({
  baseUrl,
  accessToken,
  body
}: {
  baseUrl: string;
  accessToken: string;
  body: Record<string, unknown>;
}): Promise<any> {
  const root = normalizeBaseUrl(baseUrl);
  const resp = await fetch(`${root}/api/mcp/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });

  if (resp.status === 401) {
    const error = new Error('Unauthorized');
    (error as Error & { status?: number }).status = 401;
    throw error;
  }

  const payload = await parseJsonResponse(resp);
  if (payload?.error) {
    throw new Error(payload.error.message || 'JSON-RPC request failed');
  }
  return payload?.result;
}

export class ManagedToolClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly getTokensFn: ManagedToolClientInput['getTokens'];
  private readonly saveTokensFn: ManagedToolClientInput['saveTokens'];

  constructor({ baseUrl, clientId, getTokens, saveTokens }: ManagedToolClientInput) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.clientId = clientId;
    this.getTokensFn = getTokens;
    this.saveTokensFn = saveTokens;
  }

  async getConnectionStatus(): Promise<any> {
    return this.withRefresh(tokens => getConnectionStatus({
      baseUrl: this.baseUrl,
      accessToken: tokens.accessToken
    }));
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.withRefresh(tokens => runJsonRpcRequest({
      baseUrl: this.baseUrl,
      accessToken: tokens.accessToken,
      body: {
        jsonrpc: '2.0',
        id: 'tools-list',
        method: 'tools/list',
        params: {}
      }
    }));
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(input: CallToolInput): Promise<any> {
    return this.withRefresh(tokens => runJsonRpcRequest({
      baseUrl: this.baseUrl,
      accessToken: tokens.accessToken,
      body: {
        jsonrpc: '2.0',
        id: 'tool-call',
        method: 'tools/call',
        params: {
          name: input.name,
          arguments: input.arguments || {}
        }
      }
    }));
  }

  private async withRefresh<T>(operation: (tokens: ManagedTokens) => Promise<T>): Promise<T> {
    let tokens = await this.getTokensFn();

    try {
      return await operation(tokens);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status !== 401 || !tokens.refreshToken) {
        throw error;
      }

      const refreshed = await refreshAccessToken({
        baseUrl: this.baseUrl,
        refreshToken: tokens.refreshToken,
        clientId: this.clientId
      });

      tokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || tokens.refreshToken,
        scope: refreshed.scope || tokens.scope
      };
      await this.saveTokensFn(tokens);
      return operation(tokens);
    }
  }
}
