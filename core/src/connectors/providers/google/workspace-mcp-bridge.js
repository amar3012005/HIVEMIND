/**
 * Google Workspace MCP Bridge
 *
 * Wraps the workspace-mcp sidecar (taylorwilsdon/google_workspace_mcp running
 * in EXTERNAL_OAUTH21_PROVIDER mode). HIVEMIND owns OAuth + tokens; this bridge
 * forwards tool calls with the user's stored Google access token as Bearer.
 *
 * Architecture:
 *   HIVEMIND code → callTool(userId, 'gmail_search_messages', { query }) →
 *     1. Fetch user's encrypted Google access_token from platform_integrations
 *     2. Refresh if expired
 *     3. POST to workspace-mcp /mcp/tools/call with Authorization: Bearer ya29.*
 *     4. Return tool result
 *
 * Multi-tenant safety:
 *   - Each call independently authenticated via the user's own Bearer token
 *   - workspace-mcp is stateless (WORKSPACE_MCP_STATELESS_MODE=true)
 *   - No cross-tenant token leakage possible
 */

const DEFAULT_MCP_URL = process.env.WORKSPACE_MCP_URL || 'http://workspace-mcp:8000';
const MCP_TIMEOUT_MS = 60_000;

export class WorkspaceMcpBridge {
  /**
   * @param {object} deps
   * @param {import('@prisma/client').PrismaClient} deps.prisma
   * @param {Function} deps.decryptToken - (encryptedTokenString) => plaintextToken
   * @param {Function} deps.refreshOAuthToken - async (connector) => freshAccessToken
   */
  constructor({ prisma, decryptToken, refreshOAuthToken, mcpUrl = DEFAULT_MCP_URL }) {
    this.prisma = prisma;
    this.decryptToken = decryptToken;
    this.refreshOAuthToken = refreshOAuthToken;
    this.mcpUrl = mcpUrl.replace(/\/$/, '');
  }

  /**
   * Get a valid (refreshed if needed) Google access token for a HIVEMIND user.
   * Looks up the platform_integrations row for either 'gmail' or 'google_workspace'.
   */
  async getAccessToken(userId) {
    // Any active Google service row carries the shared token. Pick the most
    // recently updated one (Gmail is always present if any Google service is
    // connected because we always upsert gmail as the primary row).
    const googleProviders = [
      'gmail', 'google_drive', 'google_calendar', 'google_docs',
      'google_sheets', 'google_slides', 'google_contacts', 'google_chat',
      'google_tasks', 'google_forms', 'google_workspace',
    ];
    // Don't filter by isActive — sync errors flip it false but token may
    // still be valid for live queries. Revoked is the hard fail signal.
    const row = await this.prisma.platformIntegration.findFirst({
      where: {
        userId,
        platformType: { in: googleProviders },
        syncStatus: { not: 'revoked' },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) {
      throw new Error('No Google connection for this user. Connect Google Workspace first.');
    }
    if (!row.accessTokenEncrypted) {
      throw new Error('Google connection missing access token. Reconnect required.');
    }

    let token = this.decryptToken(row.accessTokenEncrypted);

    // Refresh if expiry is past or within 60s
    const expiresAt = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : 0;
    if (expiresAt && expiresAt < Date.now() + 60_000 && row.refreshTokenEncrypted && this.refreshOAuthToken) {
      try {
        token = await this.refreshOAuthToken(row);
      } catch (refreshErr) {
        console.warn(`[workspace-mcp-bridge] refresh failed for user ${userId}: ${refreshErr.message}`);
      }
    }

    return token;
  }

  /**
   * Call an MCP tool against workspace-mcp with the user's Google token.
   *
   * @param {string} userId - HIVEMIND user id
   * @param {string} toolName - e.g. 'gmail_search_messages', 'drive_list_files'
   * @param {object} args - Tool arguments
   * @returns {Promise<object>} Tool result content
   */
  async callTool(userId, toolName, args = {}) {
    const accessToken = await this.getAccessToken(userId);

    const requestId = `hm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const body = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

    let response;
    try {
      response = await fetch(`${this.mcpUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        throw new Error(`workspace-mcp timeout after ${MCP_TIMEOUT_MS}ms calling ${toolName}`);
      }
      throw new Error(`workspace-mcp unreachable at ${this.mcpUrl}: ${fetchErr.message}`);
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`workspace-mcp ${response.status}: ${text}`);
      // Surface upstream Google auth failures as proper 401s so sync-engine
      // catches them, attempts token refresh, and on failure flips the
      // connector to revoked/needs_reauth. Without this, every google_*
      // connector stays stuck in 'error' with a stale token.
      err.status = response.status;
      err.response = { status: response.status, body: text };
      if (response.status === 401 || /invalid_token|expired_token|token_expired|invalid_grant/i.test(text)) {
        err.status = 401;
        err.code = 'AUTH_REQUIRED';
      }
      throw err;
    }

    const contentType = response.headers.get('content-type') || '';
    let payload;
    if (contentType.includes('text/event-stream')) {
      // FastMCP returns SSE for streamable-http — pluck the first data: line
      const text = await response.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data:'));
      if (dataLines.length === 0) {
        throw new Error('workspace-mcp returned empty SSE response');
      }
      const lastLine = dataLines[dataLines.length - 1];
      payload = JSON.parse(lastLine.slice(5).trim());
    } else {
      payload = await response.json();
    }

    if (payload.error) {
      const e = new Error(`workspace-mcp tool error: ${JSON.stringify(payload.error)}`);
      const errStr = JSON.stringify(payload.error).toLowerCase();
      if (/invalid_token|expired_token|token_expired|invalid_grant|401|"code"\s*:\s*401/i.test(errStr)) {
        e.status = 401;
        e.code = 'AUTH_REQUIRED';
      }
      throw e;
    }
    return payload.result;
  }

  /**
   * List available tools (for debugging / health checks).
   */
  async listTools() {
    const body = { jsonrpc: '2.0', id: 'hm-list', method: 'tools/list', params: {} };
    const response = await fetch(`${this.mcpUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`workspace-mcp ${response.status}: ${await response.text()}`);
    const text = await response.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data:'));
    const payload = dataLines.length > 0
      ? JSON.parse(dataLines[dataLines.length - 1].slice(5).trim())
      : JSON.parse(text);
    return payload.result?.tools || [];
  }

  /**
   * Health check — pings sidecar /health endpoint.
   */
  async health() {
    try {
      const response = await fetch(`${this.mcpUrl}/health`, { method: 'GET' });
      return { ok: response.ok, status: response.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}
