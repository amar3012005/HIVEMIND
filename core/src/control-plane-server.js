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

const CONFIG = {
  port: Number(process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010),
  publicBaseUrl: process.env.HIVEMIND_CONTROL_PLANE_PUBLIC_URL || `http://localhost:${process.env.CONTROL_PLANE_PORT || process.env.PORT || 3010}`,
  coreApiBaseUrl: process.env.HIVEMIND_CORE_API_BASE_URL
    || process.env.HIVEMIND_API_URL
    || 'https://api.hivemind.davinciai.eu',
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
  allowedOrigins: (process.env.HIVEMIND_CONTROL_PLANE_ALLOWED_ORIGINS || 'https://hivemind.davincisolutions.de')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
};

const prisma = getPrismaClient();
const sessionStore = new ControlPlaneSessionStore(CONFIG);
const zitadelClient = (CONFIG.zitadelIssuerUrl && CONFIG.zitadelClientId && CONFIG.zitadelClientSecret && CONFIG.zitadelRedirectUri)
  ? new ZitadelOidcClient({
      issuerUrl: CONFIG.zitadelIssuerUrl,
      clientId: CONFIG.zitadelClientId,
      clientSecret: CONFIG.zitadelClientSecret,
      redirectUri: CONFIG.zitadelRedirectUri
    })
  : null;

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
  // (frontend at hivemind.davincisolutions.de, control plane at api.hivemind.davinciai.eu)
  return `${CONFIG.sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=${CONFIG.sessionTtlSeconds}`;
}

function clearSessionCookie() {
  return `${CONFIG.sessionCookieName}=; HttpOnly; Path=/; SameSite=None; Secure; Max-Age=0`;
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
  return membership?.org || null;
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
  const org = await resolveCurrentOrg(user.id);
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
      zitadel_user_id: user.zitadelUserId
    },
    organization: org ? {
      id: org.id,
      name: org.name,
      slug: org.slug
    } : null,
    onboarding: {
      needs_org_setup: !org,
      has_api_key: apiKeys.length > 0
    },
    connectivity: {
      core_api_base_url: CONFIG.coreApiBaseUrl,
      core_health: coreHealth
    },
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp']
  };
}

const server = http.createServer(async (req, res) => {
  // CORS: only allow the configured frontend origin(s) — never '*' with credentials
  const requestOrigin = req.headers.origin;
  if (requestOrigin && CONFIG.allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/health') {
    return jsonResponse(res, {
      ok: true,
      service: 'hivemind-control-plane',
      core_api_base_url: CONFIG.coreApiBaseUrl
    });
  }

  if (pathname === '/auth/login' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect
    });
    // Pass through IdP hints from the frontend (e.g. ?idp_hint=google)
    const authorizeOptions = {};
    if (url.searchParams.get('idp_hint')) {
      authorizeOptions.idpHint = url.searchParams.get('idp_hint');
    }
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
      const org = await resolveCurrentOrg(user.id);
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
