import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getPrismaClient } from './db/prisma.js';
import {
  createPersistedApiKey,
  listPersistedApiKeys,
  revokePersistedApiKey
} from './auth/api-keys.js';
import { buildAllClientDescriptors, buildClientDescriptor } from './control-plane/descriptors.js';
import { ControlPlaneSessionStore, buildSessionCookie, verifySessionCookie } from './control-plane/session-store.js';
import { ZitadelOidcClient } from './control-plane/zitadel.js';
import { ConnectorStore } from './connectors/framework/connector-store.js';
import {
  installConsoleCapture,
  getRecentLogs,
  getLogSummary,
} from './admin/live-log-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

function loadLocalEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv(path.join(PROJECT_ROOT, '.env'));
installConsoleCapture('control-plane');

const CONFIG = {
  port: Number(process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010),
  publicBaseUrl: process.env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || `http://localhost:${process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010}`,
  coreApiBaseUrl: process.env.HIVEMIND_CORE_API_BASE_URL
    || process.env.HIVEMIND_API_URL
    || 'https://core.hivemind.davinciai.eu:8050',
  sessionCookieName: process.env.HIVEMIND_CONTROL_PLANE_SESSION_COOKIE || 'hm_cp_session',
  sessionSecret: process.env.HIVEMIND_CONTROL_PLANE_SESSION_SECRET || process.env.SESSION_SECRET || 'change-me',
  sessionTtlSeconds: Number(process.env.HIVEMIND_CONTROL_PLANE_SESSION_TTL_SECONDS || 60 * 60 * 24 * 7),
  authStateTtlSeconds: Number(process.env.HIVEMIND_CONTROL_PLANE_AUTH_STATE_TTL_SECONDS || 600),
  redisUrl: process.env.HIVEMIND_CONTROL_PLANE_REDIS_URL || process.env.REDIS_URL || null,
  redisHost: process.env.REDIS_HOST || null,
  redisPort: Number(process.env.REDIS_PORT || 6379),
  redisPassword: process.env.REDIS_PASSWORD || null,
  zitadelIssuerUrl: process.env.ZITADEL_ISSUER_URL || process.env.HIVEMIND_ZITADEL_ISSUER_URL || null,
  zitadelClientId: process.env.ZITADEL_CLIENT_ID || null,
  zitadelClientSecret: process.env.ZITADEL_CLIENT_SECRET || null,
  zitadelRedirectUri: process.env.ZITADEL_REDIRECT_URI || null,
  postLoginRedirect: process.env.HIVEMIND_CONTROL_PLANE_POST_LOGIN_REDIRECT || '/',
  allowedOrigins: (process.env.HIVEMIND_CONTROL_PLANE_ALLOWED_ORIGINS
    || process.env.HIVEMIND_ALLOWED_ORIGINS
    || 'https://hivemind.davinciai.eu')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
};

const prisma = getPrismaClient();
const sessionStore = new ControlPlaneSessionStore(CONFIG);
const connectorStore = prisma ? new ConnectorStore(prisma) : null;
const ADMIN_SECRET = process.env.HIVEMIND_ADMIN_SECRET || 'local-admin-secret-change-me';

// Provider registry — add new providers here
const PROVIDER_REGISTRY = {
  gmail: {
    oauthModule: './connectors/providers/gmail/oauth.js',
    adapterModule: './connectors/providers/gmail/adapter.js',
    adapterClass: 'GmailAdapter',
    label: 'Gmail',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email'],
  },
  slack: {
    oauthModule: './connectors/providers/slack/oauth.js',
    adapterModule: './connectors/providers/slack/adapter.js',
    adapterClass: 'SlackAdapter',
    label: 'Slack',
    scopes: ['channels:history', 'channels:read', 'users:read'],
  },
  github: {
    oauthModule: './connectors/providers/github/oauth.js',
    adapterModule: './connectors/providers/github/adapter.js',
    adapterClass: 'GitHubAdapter',
    label: 'GitHub',
    scopes: ['repo', 'read:user'],
  },
  notion: {
    oauthModule: './connectors/providers/notion/oauth.js',
    adapterModule: './connectors/providers/notion/adapter.js',
    adapterClass: 'NotionAdapter',
    label: 'Notion',
    scopes: [],
  },
  gdrive: {
    oauthModule: './connectors/providers/gdrive/oauth.js',
    adapterModule: './connectors/providers/gdrive/adapter.js',
    adapterClass: 'GDriveAdapter',
    label: 'Google Drive',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  },
};

async function getProviderRuntimeConfig(providerConfig) {
  if (!providerConfig?.oauthModule) {
    return null;
  }

  try {
    const oauthModule = await import(providerConfig.oauthModule);
    if (typeof oauthModule.getOAuthConfig === 'function') {
      return oauthModule.getOAuthConfig();
    }
  } catch {
    return null;
  }

  return null;
}

function evaluateProviderConfiguration(providerId, oauthConfig) {
  if (!oauthConfig) {
    return {
      configured: false,
      disabledReason: 'OAuth module unavailable',
    };
  }

  const clientId = String(oauthConfig.clientId || '').trim();
  const clientSecret = String(oauthConfig.clientSecret || '').trim();
  const requiresSecret = providerId !== 'notion' ? true : true;

  if (!clientId) {
    return {
      configured: false,
      disabledReason: 'Missing client ID',
    };
  }

  if (requiresSecret && !clientSecret) {
    return {
      configured: false,
      disabledReason: 'Missing client secret',
    };
  }

  return {
    configured: true,
    disabledReason: null,
  };
}

function getConnectorCallbackUrl(provider) {
  return `${CONFIG.publicBaseUrl}/v1/connectors/${provider}/callback`;
}

function isAdminAuthorized(req, url) {
  return req.headers['x-admin-secret'] === ADMIN_SECRET || url.searchParams.get('admin_secret') === ADMIN_SECRET;
}

function buildAdminServiceSnapshot() {
  return {
    service: 'control-plane',
    observed_at: new Date().toISOString(),
    health: {
      ok: true,
      service: 'hivemind-control-plane',
      core_api_base_url: CONFIG.coreApiBaseUrl,
    },
    runtime: {
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      node_env: process.env.NODE_ENV || 'development',
    },
    summary: getLogSummary('control-plane'),
    logs: getRecentLogs({ service: 'control-plane', limit: 150 }),
  };
}

function encodeConnectorState(payload) {
  const issuedAt = Date.now();
  const body = Buffer.from(JSON.stringify({ ...payload, issuedAt }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', CONFIG.sessionSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodeConnectorState(stateToken) {
  if (!stateToken || !stateToken.includes('.')) {
    return null;
  }

  const [body, signature] = stateToken.split('.');
  if (!body || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', CONFIG.sessionSecret).update(body).digest('base64url');
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const issuedAt = Number(payload.issuedAt || 0);
    if (!issuedAt || Number.isNaN(issuedAt)) {
      return null;
    }
    if (Date.now() - issuedAt > CONFIG.authStateTtlSeconds * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

const zitadelClient = (CONFIG.zitadelIssuerUrl && CONFIG.zitadelClientId && CONFIG.zitadelClientSecret && CONFIG.zitadelRedirectUri)
  ? new ZitadelOidcClient({
      issuerUrl: CONFIG.zitadelIssuerUrl,
      clientId: CONFIG.zitadelClientId,
      clientSecret: CONFIG.zitadelClientSecret,
      redirectUri: CONFIG.zitadelRedirectUri
    })
  : null;
const USE_SECURE_CROSS_SITE_COOKIE = CONFIG.publicBaseUrl.startsWith('https://');

function jsonResponse(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function redirect(res, location, cookies = []) {
  const headers = {
    Location: location
  };
  if (cookies.length) {
    headers['Set-Cookie'] = cookies;
  }
  res.writeHead(302, headers);
  res.end();
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, entry) => {
    const [rawKey, ...rest] = entry.trim().split('=');
    if (!rawKey) return acc;
    acc[rawKey] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function makeSessionCookie(sessionId) {
  const value = buildSessionCookie(CONFIG.sessionSecret, sessionId);
  // SameSite=None; Secure required for cross-site cookie auth
  return `${CONFIG.sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=${CONFIG.sessionTtlSeconds}`;
}

function clearSessionCookie() {
  return `${CONFIG.sessionCookieName}=; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=0`;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  if (CONFIG.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sanitizeSlug(input) {
  return `${input || 'workspace'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `workspace-${crypto.randomUUID().slice(0, 8)}`;
}

async function getCurrentSession(req) {
  const cookies = parseCookies(req);
  const rawCookie = cookies[CONFIG.sessionCookieName];
  const sessionId = verifySessionCookie(CONFIG.sessionSecret, rawCookie);
  if (!sessionId) {
    return null;
  }
  const session = await sessionStore.getSession(sessionId);
  return session ? { sessionId, session } : null;
}

async function requireSession(req, res) {
  const current = await getCurrentSession(req);
  if (!current) {
    jsonResponse(res, { error: 'Unauthorized' }, 401);
    return null;
  }
  return current;
}

async function resolveCurrentOrg(userId) {
  const membership = await prisma?.userOrganization.findFirst({
    where: { userId },
    include: { org: true },
    orderBy: { joinedAt: 'asc' }
  });
  if (!membership) return { org: null, role: null };
  return { org: membership.org, role: membership.role || 'admin' };
}

async function upsertUserFromZitadel(userInfo) {
  if (!prisma) {
    throw new Error('Database unavailable');
  }

  const existing = await prisma.user.findUnique({
    where: { zitadelUserId: userInfo.sub }
  });

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        locale: userInfo.locale || existing.locale,
        lastActiveAt: new Date()
      }
    });
  }

  return prisma.user.create({
    data: {
      zitadelUserId: userInfo.sub,
      email: userInfo.email,
      displayName: userInfo.name,
      avatarUrl: userInfo.picture,
      locale: userInfo.locale || 'en',
      lastActiveAt: new Date()
    }
  });
}

async function buildBootstrapPayload(user) {
  const { org, role } = await resolveCurrentOrg(user.id);
  const apiKeys = await listPersistedApiKeys(prisma, user.id, org?.id || null);
  let coreHealth = null;

  try {
    const healthResponse = await fetch(`${CONFIG.coreApiBaseUrl}/health`);
    coreHealth = {
      ok: healthResponse.ok,
      status: healthResponse.status
    };
  } catch {
    coreHealth = {
      ok: false,
      status: null
    };
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      zitadel_user_id: user.zitadelUserId,
      role: role || 'admin',  // admin | developer | viewer
    },
    organization: org ? {
      id: org.id,
      name: org.name,
      slug: org.slug
    } : null,
    onboarding: {
      needs_org_setup: !org,
      has_api_key: apiKeys.length > 0,
      needs_first_source: apiKeys.length > 0 && !org,
    },
    connectivity: {
      core_api_base_url: CONFIG.coreApiBaseUrl,
      core_health: coreHealth
    },
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp'],
    // Session key: frontend uses this to call core API without manual key setup.
    // Auto-creates one if user has an org but no keys yet.
    session_api_key: org ? await getOrCreateSessionKey(user.id, org.id) : null,
  };
}

/**
 * Get or create a session API key for the frontend.
 * Reuses existing 'auto-session' key if available, creates one if not.
 * Returns the raw key string.
 */
async function getOrCreateSessionKey(userId, orgId) {
  try {
    // Check for existing auto-session key
    const existing = await prisma.apiKey.findFirst({
      where: { userId, name: 'auto-session', revokedAt: null },
    });
    if (existing) {
      // Return the raw key from description (stored at creation time)
      try {
        const meta = JSON.parse(existing.description || '{}');
        if (meta.rawKey) return meta.rawKey;
      } catch {}
      // If no raw key stored, create a new one
    }

    // Create a new session key
    const result = await createPersistedApiKey(prisma, {
      userId,
      orgId,
      name: 'auto-session',
      scopes: ['memory', 'search', 'web_search', 'web_crawl', 'mcp', 'admin'],
    });

    // Store raw key in description for future bootstrap calls
    if (result.record?.id && result.rawKey) {
      await prisma.apiKey.update({
        where: { id: result.record.id },
        data: { description: JSON.stringify({ rawKey: result.rawKey, auto: true }) },
      }).catch(() => {});
    }

    return result.rawKey || null;
  } catch (err) {
    console.warn('[bootstrap] Failed to get/create session key:', err.message);
    return null;
  }
}

/**
 * Generic proxy: forward an authenticated frontend request to the core API.
 * Authenticates with the master API key and injects user/org context headers.
 */
async function proxyToCore(req, res, { session, method, path, body, query, rawBody }) {
  try {
    const coreUrl = new URL(path, CONFIG.coreApiBaseUrl);
    if (query) coreUrl.search = query;

    const headers = {
      'X-API-Key': process.env.HIVEMIND_MASTER_API_KEY || process.env.API_MASTER_KEY || 'hm_master_key_99228811',
      'X-HM-User-Id': session.userId || '',
      'X-HM-Org-Id': session.orgId || '',
    };

    // Forward content-type for POST/multipart
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }

    const fetchOpts = { method, headers };

    if (method !== 'GET' && method !== 'HEAD') {
      if (rawBody) {
        fetchOpts.body = rawBody; // multipart — forward as-is
      } else if (body && Object.keys(body).length > 0) {
        fetchOpts.body = JSON.stringify(body);
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const coreResp = await fetch(coreUrl.toString(), fetchOpts);
    const respBody = await coreResp.text();

    res.writeHead(coreResp.status, {
      'Content-Type': coreResp.headers.get('content-type') || 'application/json',
    });
    res.end(respBody);
  } catch (err) {
    console.error('[proxy] Error forwarding to core:', err.message);
    jsonResponse(res, { error: 'Proxy error', detail: err.message }, 502);
  }
}

const server = http.createServer(async (req, res) => {
  applyCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/admin/api/logs' && req.method === 'GET') {
    if (!isAdminAuthorized(req, url)) {
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }
    return jsonResponse(res, buildAdminServiceSnapshot());
  }

  if (pathname === '/health') {
    return jsonResponse(res, {
      ok: true,
      service: 'hivemind-control-plane',
      core_api_base_url: CONFIG.coreApiBaseUrl
    });
  }

  // ─── Direct Google OAuth (bypasses Zitadel) ──────────────────
  if (pathname === '/auth/google' && req.method === 'GET') {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return jsonResponse(res, { error: 'Google OAuth not configured' }, 503);
    }
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect,
      provider: 'google',
    });
    const cpBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const googleParams = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${cpBase}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${googleParams}`);
  }

  if (pathname === '/auth/google/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return redirect(res, `${CONFIG.postLoginRedirect}?auth_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    const authState = await sessionStore.consumeAuthState(state);
    if (!authState) {
      return jsonResponse(res, { error: 'Invalid login state' }, 400);
    }

    try {
      // Exchange code for tokens
      const cpBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${cpBase}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        throw new Error(`Google token exchange failed: ${errText}`);
      }

      const tokens = await tokenResp.json();

      // Get user info
      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userInfoResp.json();

      // Upsert user — use Google sub as zitadel user id (with prefix to avoid collision)
      const user = await upsertUserFromZitadel({
        sub: `google:${userInfo.id}`,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        locale: userInfo.locale,
      });

      const { org } = await resolveCurrentOrg(user.id);
      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null,
      });

      return redirect(res, authState.returnTo || CONFIG.postLoginRedirect, [makeSessionCookie(sessionId)]);
    } catch (err) {
      console.error('[google-auth] Callback failed:', err.message);
      return redirect(res, `${CONFIG.postLoginRedirect}?auth_error=${encodeURIComponent(err.message)}`);
    }
  }

  // ─── Zitadel SSO Login ──────────────────────────────────────
  if (pathname === '/auth/login' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect
    });
    const authorizeOptions = {};
    if (url.searchParams.get('login_hint')) {
      authorizeOptions.loginHint = url.searchParams.get('login_hint');
    }
    return redirect(res, zitadelClient.buildAuthorizeUrl(state, authorizeOptions));
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    const authState = await sessionStore.consumeAuthState(state);
    if (!authState) {
      return jsonResponse(res, { error: 'Invalid login state' }, 400);
    }

    try {
      const { userInfo } = await zitadelClient.exchangeAndResolveUser(code);
      const user = await upsertUserFromZitadel(userInfo);
      const { org } = await resolveCurrentOrg(user.id);
      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null
      });

      return redirect(res, authState.returnTo || CONFIG.postLoginRedirect, [makeSessionCookie(sessionId)]);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  if (pathname === '/auth/logout' && req.method === 'POST') {
    const current = await getCurrentSession(req);
    if (current) {
      await sessionStore.destroySession(current.sessionId);
    }
    return jsonResponse(res, { success: true }, 200, {
      'Set-Cookie': clearSessionCookie()
    });
  }

  if (pathname === '/v1/bootstrap' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const user = await prisma?.user.findUnique({ where: { id: current.session.userId } });
    if (!user) {
      return jsonResponse(res, { error: 'User not found' }, 404);
    }
    return jsonResponse(res, await buildBootstrapPayload(user));
  }

  if (pathname === '/v1/orgs' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);
    if (!body.name) {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }

    const slugBase = sanitizeSlug(body.slug || body.name);
    const existing = await prisma.organization.findUnique({ where: { slug: slugBase } });
    const slug = existing ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;
    const org = await prisma.organization.create({
      data: {
        zitadelOrgId: `cp-org-${crypto.randomUUID()}`,
        name: body.name,
        slug
      }
    });

    await prisma.userOrganization.create({
      data: {
        userId: current.session.userId,
        orgId: org.id,
        role: 'owner',
        joinedAt: new Date()
      }
    });

    await sessionStore.destroySession(current.sessionId);
    const sessionId = await sessionStore.createSession({
      ...current.session,
      orgId: org.id
    });

    return jsonResponse(res, {
      success: true,
      organization: {
        id: org.id,
        name: org.name,
        slug: org.slug
      }
    }, 201, {
      'Set-Cookie': makeSessionCookie(sessionId)
    });
  }

  if (pathname === '/v1/api-keys' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;

    const keys = await listPersistedApiKeys(prisma, current.session.userId, current.session.orgId || null);
    return jsonResponse(res, {
      keys: keys.map(key => ({
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        scopes: key.scopes,
        expires_at: key.expiresAt,
        last_used_at: key.lastUsedAt,
        created_at: key.createdAt
      }))
    });
  }

  if (pathname === '/v1/api-keys' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const body = await parseBody(req);

    const { rawKey, record } = await createPersistedApiKey(prisma, {
      userId: current.session.userId,
      orgId: current.session.orgId || null,
      name: body.name || 'Primary API Key',
      description: body.description || null,
      scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['memory:read', 'memory:write', 'mcp'],
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
      rateLimitPerMinute: body.rate_limit_per_minute || 60,
      createdByIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null
    });

    return jsonResponse(res, {
      success: true,
      api_key: rawKey,
      key: {
        id: record.id,
        name: record.name,
        key_prefix: record.keyPrefix,
        scopes: record.scopes,
        created_at: record.createdAt
      },
      descriptors: buildAllClientDescriptors({
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: rawKey
      })
    }, 201);
  }

  const revokeMatch = pathname.match(/^\/v1\/api-keys\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const revoked = await revokePersistedApiKey(prisma, revokeMatch[1], current.session.userId);
    if (!revoked) {
      return jsonResponse(res, { error: 'API key not found' }, 404);
    }
    return jsonResponse(res, { success: true, key_id: revoked.id, revoked_at: revoked.revokedAt });
  }

  if (pathname === '/v1/clients/descriptors' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    return jsonResponse(res, {
      core_api_base_url: CONFIG.coreApiBaseUrl,
      descriptors: buildAllClientDescriptors({
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: null
      })
    });
  }

  const descriptorMatch = pathname.match(/^\/v1\/clients\/descriptors\/([^/]+)$/);
  if (descriptorMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    try {
      return jsonResponse(res, buildClientDescriptor(descriptorMatch[1], {
        coreApiBaseUrl: CONFIG.coreApiBaseUrl,
        userId: current.session.userId,
        apiKey: null
      }));
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }

  // ─── Connector OAuth Routes ──────────────────────────────────────

  // GET /v1/connectors — list all connectors for current user
  if (pathname === '/v1/connectors' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    const connectors = await connectorStore.listConnectors(current.session.userId);

    // Merge with provider registry to show available + connected
    const result = await Promise.all(Object.entries(PROVIDER_REGISTRY).map(async ([providerId, meta]) => {
      const connector = connectors.find(c => c.provider === providerId);
      const oauthConfig = await getProviderRuntimeConfig(meta);
      const availability = evaluateProviderConfiguration(providerId, oauthConfig);
      const status = connector
        ? connector.status
        : availability.configured
          ? 'disconnected'
          : 'not_configured';
      return {
        provider: providerId,
        label: meta.label,
        status,
        account_ref: connector?.account_ref || null,
        last_sync_at: connector?.last_sync_at || null,
        last_error: connector?.last_error || null,
        is_active: connector?.is_active || false,
        scopes: connector?.scopes || meta.scopes,
        created_at: connector?.created_at || null,
        configured: availability.configured,
        disabled_reason: availability.disabledReason,
      };
    }));

    return jsonResponse(res, { connectors: result });
  }

  // POST /v1/connectors/:provider/start — begin OAuth flow
  const connectorStartMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/start$/);
  if (connectorStartMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    const provider = connectorStartMatch[1];
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) {
      return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
    }

    try {
      const oauthModule = await import(providerConfig.oauthModule);
      const availability = evaluateProviderConfiguration(
        provider,
        typeof oauthModule.getOAuthConfig === 'function' ? oauthModule.getOAuthConfig() : null
      );

      if (!availability.configured) {
        return jsonResponse(res, {
          error: `${provider} connector is not configured`,
          message: availability.disabledReason,
        }, 503);
      }

      const { buildAuthUrl } = oauthModule;
      const body = await parseBody(req);
      const returnTo = body.return_to || '/hivemind/app/connectors';

      // Create CSRF-safe stateless state bound to user/org
      const stateId = encodeConnectorState({
        userId: current.session.userId,
        orgId: current.session.orgId,
        provider,
        returnTo,
      });

      const authUrl = buildAuthUrl({
        redirectUri: getConnectorCallbackUrl(provider),
        state: stateId,
      });

      return jsonResponse(res, { auth_url: authUrl });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // GET /v1/connectors/:provider/callback — OAuth callback
  const connectorCallbackMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/callback$/);
  if (connectorCallbackMatch && req.method === 'GET') {
    const provider = connectorCallbackMatch[1];
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) {
      return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return redirect(res, `/hivemind/app/connectors?connector_error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    // Verify CSRF state
    const authState = decodeConnectorState(state);
    if (!authState || authState.provider !== provider) {
      return redirect(res, `/hivemind/app/connectors?connector_error=invalid_state`);
    }

    try {
      const { exchangeCode } = await import(providerConfig.oauthModule);
      const tokens = await exchangeCode({
        code,
        redirectUri: getConnectorCallbackUrl(provider),
      });

      // Store encrypted tokens
      await connectorStore.upsertConnector({
        userId: authState.userId,
        provider,
        accountRef: tokens.email || tokens.account_ref || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        scopes: providerConfig.scopes,
      });

      // Enqueue initial sync (fire-and-forget background)
      setImmediate(async () => {
        try {
          const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
          if (!apiKey) {
            console.error(`[connector] HIVEMIND_MASTER_API_KEY is not configured; initial sync skipped for ${provider}:${authState.userId}`);
            return;
          }
          const syncResponse = await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/sync`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': apiKey,
            },
            body: JSON.stringify({
              provider,
              user_id: authState.userId,
              org_id: authState.orgId,
              incremental: false,
            }),
          });
          console.log(`[connector] Initial sync enqueued for ${provider}:${authState.userId} → ${syncResponse.status}`);
        } catch (syncError) {
          console.error(`[connector] Initial sync failed for ${provider}:`, syncError.message);
        }
      });

      const returnTo = authState.returnTo || '/hivemind/app/connectors';
      return redirect(res, `${returnTo}?connector_success=${provider}`);
    } catch (tokenError) {
      console.error(`[connector] OAuth exchange failed for ${provider}:`, tokenError.message);
      return redirect(res, `/hivemind/app/connectors?connector_error=${encodeURIComponent(tokenError.message)}`);
    }
  }

  // GET /v1/connectors/:provider/status — detailed connector status
  const connectorStatusMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/status$/);
  if (connectorStatusMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    const connector = await connectorStore.getConnector(current.session.userId, connectorStatusMatch[1]);
    if (!connector) {
      return jsonResponse(res, { provider: connectorStatusMatch[1], status: 'disconnected' });
    }
    return jsonResponse(res, connector);
  }

  // POST /v1/connectors/:provider/disconnect
  const connectorDisconnectMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/disconnect$/);
  if (connectorDisconnectMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    if (!connectorStore) return jsonResponse(res, { error: 'Database unavailable' }, 503);

    const success = await connectorStore.disconnect(current.session.userId, connectorDisconnectMatch[1]);
    return jsonResponse(res, { success, provider: connectorDisconnectMatch[1] });
  }

  // POST /v1/connectors/:provider/resync — trigger manual resync
  const connectorResyncMatch = pathname.match(/^\/v1\/connectors\/([a-z_-]+)\/resync$/);
  if (connectorResyncMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;

    const provider = connectorResyncMatch[1];
    const connector = await connectorStore?.getConnector(current.session.userId, provider);
    if (!connector || connector.status === 'disconnected') {
      return jsonResponse(res, { error: 'Connector not connected' }, 400);
    }

    // Trigger sync via core API
    try {
      const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
      if (!apiKey) {
        return jsonResponse(res, { error: 'HIVEMIND_MASTER_API_KEY is not configured' }, 503);
      }
      const body = await parseBody(req);
      await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          provider,
          user_id: current.session.userId,
          org_id: current.session.orgId,
          incremental: body.incremental !== false,
        }),
      });
      return jsonResponse(res, { success: true, message: 'Sync enqueued' });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // ─── End Connector Routes ──────────────────────────────────────

  // ─── Proxy Routes (session-cookie → core API with master key) ─────
  if (pathname.startsWith('/v1/proxy/')) {
    const current = await requireSession(req, res);
    if (!current) return;

    // Map /v1/proxy/health → /health, everything else → /api/...
    let corePath;
    if (pathname === '/v1/proxy/health') {
      corePath = '/health';
    } else {
      corePath = pathname.replace('/v1/proxy/', '/api/');
    }

    const isMultipart = (req.headers['content-type'] || '').startsWith('multipart/');

    // Read body: raw Buffer for multipart, parsed JSON for everything else
    let body = undefined;
    let rawBody = undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (isMultipart) {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        rawBody = Buffer.concat(chunks);
      } else {
        body = await parseBody(req);
      }
    }

    return proxyToCore(req, res, {
      session: current.session,
      method: req.method,
      path: corePath,
      body,
      query: url.search || '',
      rawBody,
    });
  }
  // ─── End Proxy Routes ─────────────────────────────────────────

  if (pathname === '/' && req.method === 'GET') {
    return jsonResponse(res, {
      service: 'hivemind-control-plane',
      login_url: '/auth/login',
      bootstrap_url: '/v1/bootstrap',
      core_api_base_url: CONFIG.coreApiBaseUrl
    });
  }

  return jsonResponse(res, { error: 'Not found' }, 404);
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`[control-plane] listening on ${CONFIG.port}`);
});
