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
import { PLANS } from './billing/plans.js';
import {
  installConsoleCapture,
  getRecentLogs,
  getLogSummary,
} from './admin/live-log-store.js';
import { ROLES, effectiveRoles, hasPermission, assertPermission } from './auth/permissions.js';
import { attachSsoContext, resolveSsoConfig } from './auth/sso-resolver.js';
import { handleScimRequest } from './scim/scim-router.js';

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

// Import log capture for control plane
const { captureLogs: captureControlPlaneLogs, getLogBuffer: getControlPlaneLogBuffer } = await import('./log-streamer.js');
installConsoleCapture('control-plane');
captureControlPlaneLogs('hm-control');

const defaultAllowedOrigins = (process.env.HIVEMIND_CONTROL_PLANE_ALLOWED_ORIGINS
  || process.env.HIVEMIND_ALLOWED_ORIGINS
  || 'https://hivemind.davinciai.eu,https://www.davinciai.eu,https://davinciai.eu')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)
  .concat([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5000',
    'http://localhost:5001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5001'
  ]);

const defaultFrontendBaseUrl = process.env.HIVEMIND_FRONTEND_URL
  || defaultAllowedOrigins[0]
  || 'https://hivemind.davinciai.eu';

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
  postLoginRedirect: process.env.HIVEMIND_CONTROL_PLANE_POST_LOGIN_REDIRECT || `${defaultFrontendBaseUrl}/hivemind/login`,
  allowedOrigins: defaultAllowedOrigins
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
    scopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'im:history', 'mpim:history', 'users:read', 'team:read'],
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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
  // Verify either cookie or Bearer token (for cross-origin sync)
  let sessionId = verifySessionCookie(CONFIG.sessionSecret, rawCookie);
  
  if (!sessionId) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      sessionId = authHeader.substring(7).trim();
    }
  }

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

async function getOrgMembership(userId, orgId) {
  if (!prisma || !userId || !orgId) return null;
  return prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: {
      org: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          lastActiveAt: true,
        },
      },
    },
  });
}

function canManageOrg(role) {
  return role === 'owner' || role === 'admin';
}

async function requireOrgAdmin(req, res, userId, orgId) {
  const membership = await getOrgMembership(userId, orgId);
  if (!membership) {
    jsonResponse(res, { error: 'Organization membership not found' }, 404);
    return null;
  }
  // Prefer new roles[] array; fall back to legacy single role column
  const roles = effectiveRoles(membership);
  const allowed = hasPermission(roles, 'org', 'manage') || canManageOrg(membership.role);
  if (!allowed) {
    jsonResponse(res, { error: 'Forbidden' }, 403);
    return null;
  }
  // Attach effective roles to the membership object for callers that need it
  membership._roles = roles;
  return membership;
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

  let existing = await prisma.user.findUnique({
    where: { zitadelUserId: userInfo.sub }
  });

  // Fallback: find by email (handles re-auth or manual user creation)
  if (!existing && userInfo.email) {
    existing = await prisma.user.findUnique({ where: { email: userInfo.email } });
  }

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        zitadelUserId: userInfo.sub,
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

async function getCoreHealth() {
  try {
    const healthResponse = await fetch(`${CONFIG.coreApiBaseUrl}/health`);
    return {
      ok: healthResponse.ok,
      status: healthResponse.status
    };
  } catch {
    return {
      ok: false,
      status: null
    };
  }
}

async function buildAnonymousBootstrapPayload() {
  return {
    authenticated: false,
    user: null,
    organization: null,
    onboarding: null,
    connectivity: {
      core_api_base_url: CONFIG.coreApiBaseUrl,
      core_health: await getCoreHealth()
    },
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp', 'notebooklm'],
    session_api_key: null,
  };
}

async function buildBootstrapPayload(user) {
  const { org, role } = await resolveCurrentOrg(user.id);
  const apiKeys = await listPersistedApiKeys(prisma, user.id, org?.id || null);
  const coreHealth = await getCoreHealth();

  return {
    authenticated: true,
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
      slug: org.slug,
      plan: org.plan || 'free'
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
    client_support: ['claude', 'antigravity', 'vscode', 'remote-mcp', 'notebooklm'],
    // Session key: frontend uses this to call core API without manual key setup.
    // Auto-creates one if user has an org but no keys yet.
    session_api_key: org ? await getOrCreateSessionKey(user.id, org.id) : null,
  };
}

async function purgeUserVectors(userId) {
  try {
    const qdrantUrl = process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
    const qdrantCollection = process.env.QDRANT_COLLECTION || 'hivemind_memories';
    const qdrantKey = process.env.QDRANT_API_KEY || '';
    if (!qdrantUrl || !userId) {
      console.warn('[account-delete] ⚠ Qdrant purge skipped — no URL or userId:', { qdrantUrl: !!qdrantUrl, userId: !!userId });
      return;
    }

    console.log('[account-delete] Purging Qdrant vectors for userId:', userId, 'collection:', qdrantCollection);
    const resp = await fetch(`${qdrantUrl}/collections/${qdrantCollection}/points/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(qdrantKey ? { 'api-key': qdrantKey } : {}),
      },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'user_id', match: { value: userId } }],
        },
        wait: true,
      }),
    });
    const respBody = await resp.text();
    console.log('[account-delete] Qdrant response:', resp.status, respBody.slice(0, 200));
  } catch (error) {
    console.warn('[account-delete] ⚠ Qdrant delete failed:', error.message);
  }
}

/**
 * Perform cascading account deletion with optional progress callback.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string[]} opts.orgIdsToDelete
 * @param {(pct: number, step: string) => void} [opts.onProgress] - Called with 0-100 and step label
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function performAccountDeletion({ userId, orgIdsToDelete = [], onProgress }) {
  const t0 = Date.now();
  const BATCH_SIZE = 5000;
  const emit = (pct, step) => {
    console.log(`[account-delete] [${pct}%] ${step}`);
    if (onProgress) onProgress(pct, step);
  };

  emit(0, 'Starting deletion...');
  try {
    const memoryIds = (
      await prisma.memory.findMany({
        where: { userId },
        select: { id: true },
      })
    ).map((memory) => memory.id);
    emit(5, `Found ${memoryIds.length} memories`);

    if (memoryIds.length) {
      const totalBatches = Math.ceil(memoryIds.length / BATCH_SIZE);
      // Memory deletion is 5% - 70% of progress
      const memoryProgressRange = 65; // 5% to 70%
      for (let i = 0; i < memoryIds.length; i += BATCH_SIZE) {
        const batch = memoryIds.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const batchPct = Math.round(5 + (batchNum / totalBatches) * memoryProgressRange);

        await prisma.auditLog.updateMany({
          where: { resourceId: { in: batch } },
          data: { resourceId: null },
        });
        await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: batch } } });
        await prisma.codeMemoryMetadata.deleteMany({ where: { memoryId: { in: batch } } });
        await prisma.vectorEmbedding.deleteMany({ where: { memoryId: { in: batch } } });
        await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: batch } } });
        await prisma.relationship.deleteMany({
          where: {
            OR: [
              { fromId: { in: batch } },
              { toId: { in: batch } },
            ],
          },
        });
        await prisma.derivationJob.deleteMany({
          where: {
            OR: [
              { sourceMemoryId: { in: batch } },
              { targetMemoryId: { in: batch } },
            ],
          },
        });
        await prisma.memory.deleteMany({ where: { id: { in: batch } } });

        emit(batchPct, `Deleted memory batch ${batchNum}/${totalBatches} (${batch.length} memories)`);
      }
    } else {
      emit(70, 'No memories to delete');
    }

    await prisma.platformIntegration.deleteMany({ where: { userId } });
    emit(75, 'Deleted integrations');

    await prisma.apiKey.deleteMany({ where: { userId } });
    emit(78, 'Deleted API keys');

    await prisma.dataExportRequest.deleteMany({ where: { userId } });
    await prisma.syncLog.deleteMany({ where: { userId } });
    emit(80, 'Deleted export requests & sync logs');

    await prisma.session.deleteMany({ where: { userId } });
    emit(83, 'Deleted sessions');

    await prisma.userOrganization.deleteMany({ where: { userId } });
    emit(85, 'Deleted org memberships');

    await prisma.auditLog.updateMany({
      where: { userId },
      data: { userId: null },
    });
    emit(88, 'Anonymized audit logs');

    await prisma.user.delete({ where: { id: userId } });
    emit(90, 'Deleted user record');

    await purgeUserVectors(userId);
    emit(95, 'Purged vector embeddings');

    if (Array.isArray(orgIdsToDelete) && orgIdsToDelete.length) {
      try {
        await prisma.organization.deleteMany({
          where: { id: { in: orgIdsToDelete } },
        });
      } catch (error) {
        console.warn('[account-delete] ⚠ Orphan org cleanup skipped:', error.message);
      }
    }

    emit(100, 'Account deleted');
    console.log('[account-delete] ✅ Finished in', Date.now() - t0, 'ms for userId:', userId);
    return { ok: true };
  } catch (error) {
    console.error('[account-delete] ✗ FAILED at', Date.now() - t0, 'ms:', error.message);
    console.error('[account-delete] Stack:', error.stack);
    return { ok: false, error: error.message };
  }
}

async function validateAccountDeletion(userId) {
  console.log('[account-delete] Validating deletion for userId:', userId);
  const ownerMemberships = await prisma.userOrganization.findMany({
    where: { userId, role: 'owner' },
    include: { org: true },
  });
  console.log('[account-delete] Owner memberships found:', ownerMemberships.length,
    ownerMemberships.map(m => ({ orgId: m.orgId, orgName: m.org?.name })));

  const orgIdsToDelete = [];

  for (const membership of ownerMemberships) {
    const otherOwners = await prisma.userOrganization.count({
      where: {
        orgId: membership.orgId,
        role: 'owner',
        userId: { not: userId },
      },
    });

    const otherMembers = await prisma.userOrganization.count({
      where: {
        orgId: membership.orgId,
        userId: { not: userId },
      },
    });

    console.log('[account-delete] Org', membership.org?.name, '(', membership.orgId, '): otherOwners=', otherOwners, 'otherMembers=', otherMembers);

    if (otherOwners === 0 && otherMembers > 0) {
      console.warn('[account-delete] ✗ BLOCKED — sole owner of org with', otherMembers, 'members:', membership.org?.name);
      return {
        ok: false,
        status: 409,
        error: 'Transfer ownership or remove other members before deleting this account.',
        org: {
          id: membership.org.id,
          name: membership.org.name,
          slug: membership.org.slug,
        },
      };
    }

    if (otherOwners === 0 && otherMembers === 0) {
      orgIdsToDelete.push(membership.orgId);
    }
  }

  console.log('[account-delete] ✓ Validation passed. Orgs to delete:', orgIdsToDelete);
  return { ok: true, orgIdsToDelete };
}

/**
 * Get or create a session API key for the frontend.
 * Reuses existing 'auto-session' key if available, creates one if not.
 * Returns the raw key string.
 */
async function getOrCreateSessionKey(userId, orgId) {
  try {
    // Only reuse an auto-session key if it is scoped to the active org.
    const existing = await prisma.apiKey.findFirst({
      where: {
        userId,
        orgId,
        name: 'auto-session',
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      try {
        const meta = JSON.parse(existing.description || '{}');
        if (meta.rawKey) return meta.rawKey;
      } catch {}
    }

    // Revoke stale auto-session keys for other orgs so bootstrap can rotate cleanly.
    await prisma.apiKey.updateMany({
      where: {
        userId,
        name: 'auto-session',
        revokedAt: null,
        OR: [
          { orgId: null },
          { orgId: { not: orgId } },
        ],
      },
      data: { revokedAt: new Date() },
    }).catch(() => {});

    // Also revoke malformed duplicates for the same org that no longer expose a raw key.
    await prisma.apiKey.updateMany({
      where: {
        userId,
        orgId,
        name: 'auto-session',
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    }).catch(() => {});

    if (existing) {
      try {
        const meta = JSON.parse(existing.description || '{}');
        if (meta.rawKey) {
          await prisma.apiKey.update({
            where: { id: existing.id },
            data: { revokedAt: null },
          }).catch(() => {});
          return meta.rawKey;
        }
      } catch {}
    }

    // Create a new session key
    const result = await createPersistedApiKey(prisma, {
      userId,
      orgId,
      name: 'auto-session',
      scopes: ['memory', 'search', 'web_search', 'web_crawl', 'mcp', 'admin', 'coding'],
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
    const contentType = coreResp.headers.get('content-type') || 'application/json';

    // SSE streaming: pipe through without buffering
    if (contentType.includes('text/event-stream') && coreResp.body) {
      res.writeHead(coreResp.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const reader = coreResp.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(value);
          }
        } catch { res.end(); }
      };
      req.on('close', () => { try { reader.cancel(); } catch {} });
      return pump();
    }

    const respBody = await coreResp.text();
    res.writeHead(coreResp.status, { 'Content-Type': contentType });
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

  // Attach SSO context early (subdomain-based org routing; no-op on non-subdomain hosts)
  if (prisma) await attachSsoContext(req, prisma);

  // API endpoint for log streaming
  if (pathname === '/api/logs' && req.method === 'GET') {
    const container = url.searchParams.get('container') || 'hm-control';
    const logs = getControlPlaneLogBuffer(container).map(e => `[${e.timestamp}] [${e.type.toUpperCase()}] ${e.line}`);
    return jsonResponse(res, { container, logs });
  }

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
    const returnTo = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;
    console.log(`[google-auth] Login initiated, returnTo: ${returnTo}`);
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      return jsonResponse(res, { error: 'Google OAuth not configured' }, 503);
    }
    const returnToValue = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;
    const state = await sessionStore.createAuthState({
      returnTo: returnToValue,
      provider: 'google',
    });
    // Encode return_to in the state itself as a fallback (base64 suffix after UUID)
    // Format: <stateId>.<base64_return_to> — Google passes this back unchanged
    const encodedReturnTo = Buffer.from(returnToValue).toString('base64url');
    const compositeState = `${state}.${encodedReturnTo}`;
    const cpBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    const googleParams = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${cpBase}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state: compositeState,
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${googleParams}`);
  }

  if (pathname === '/auth/google/callback' && req.method === 'GET') {
    console.log(`[google-auth] Callback received from Google - URL: ${req.url}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    console.log(`[google-auth] Callback params - code: ${code ? 'present' : 'missing'}, state: ${state ? 'present' : 'missing'}, error: ${error || 'none'}`);

    if (error) {
      console.log(`[google-auth] OAuth error: ${error}`);
      return redirect(res, `${CONFIG.postLoginRedirect}?auth_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      console.log(`[google-auth] Missing code or state parameter`);
      return jsonResponse(res, { error: 'Missing code or state' }, 400);
    }

    // State format: <stateId>.<base64_return_to> or just <stateId>
    const stateParts = state.split('.');
    const stateId = stateParts[0];
    const encodedFallbackReturnTo = stateParts[1] || null;

    let authState = await sessionStore.consumeAuthState(stateId);
    console.log(`[google-auth] Auth state consumed - returnTo: ${authState?.returnTo}, provider: ${authState?.provider}`);
    if (!authState) {
      // Fallback: decode return_to from the state parameter itself
      let fallbackReturnTo = CONFIG.postLoginRedirect;
      if (encodedFallbackReturnTo) {
        try {
          fallbackReturnTo = Buffer.from(encodedFallbackReturnTo, 'base64url').toString('utf8');
          console.log(`[google-auth] Recovered returnTo from state param: ${fallbackReturnTo}`);
        } catch {}
      }
      console.warn(`[google-auth] Auth state lost, using fallback returnTo: ${fallbackReturnTo}`);
      authState = { returnTo: fallbackReturnTo, provider: 'google' };
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
        console.log(`[google-auth] Token exchange failed: ${tokenResp.status} - ${errText}`);
        throw new Error(`Google token exchange failed: ${errText}`);
      }

      const tokens = await tokenResp.json();
      console.log(`[google-auth] Token exchange successful - access_token: ${tokens.access_token ? 'present' : 'missing'}`);

      // Get user info
      console.log(`[google-auth] Fetching user info from Google...`);
      const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userInfoResp.json();
      console.log(`[google-auth] User info retrieved - email: ${userInfo.email}, id: ${userInfo.id}`);

      // Upsert user — use Google sub as zitadel user id (with prefix to avoid collision)
      console.log(`[google-auth] Upserting user...`);
      const user = await upsertUserFromZitadel({
        sub: `google:${userInfo.id}`,
        zitadelUserId: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        locale: userInfo.locale,
      });
      console.log(`[google-auth] User upserted - id: ${user.id}, email: ${user.email}`);

      const { org } = await resolveCurrentOrg(user.id);
      console.log(`[google-auth] Organization resolved - orgId: ${org?.id || 'none'}`);

      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null,
      });
      console.log(`[google-auth] Session created - sessionId: ${sessionId}`);

      let finalRedirect = authState.returnTo || CONFIG.postLoginRedirect;
      console.log(`[google-auth] Preparing redirect - initial finalRedirect: ${finalRedirect}`);

      // Cross-origin handshake support for external tools (MiroFish, VS Code, etc.)
      const isExternalTool = finalRedirect.includes('localhost') || finalRedirect.includes('?hivemind_auth=callback');
      console.log(`[google-auth] External tool check - includes localhost: ${finalRedirect.includes('localhost')}, includes hivemind_auth: ${finalRedirect.includes('?hivemind_auth=callback')}, isExternalTool: ${isExternalTool}`);

      if (isExternalTool) {
        console.log(`[google-auth] External tool callback detected, appending token`);
        const separator = finalRedirect.includes('?') ? '&' : '?';
        finalRedirect += `${separator}token=${sessionId}`;
        console.log(`[google-auth] Token appended - separator: '${separator}', new finalRedirect: ${finalRedirect}`);
      } else {
        console.log(`[google-auth] Not an external tool callback, no token appended`);
      }

      console.log(`[google-auth] Final redirect prepared: ${finalRedirect}`);
      return redirect(res, finalRedirect, [makeSessionCookie(sessionId)]);
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

  // ─── Zitadel Registration (prompt=create) ────────────────────
  if (pathname === '/auth/register' && req.method === 'GET') {
    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }
    const state = await sessionStore.createAuthState({
      returnTo: url.searchParams.get('return_to') || CONFIG.postLoginRedirect
    });
    const authorizeOptions = { prompt: 'create' };
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

      // JIT Provisioning: if org resolved and OrgSsoConfig has jitProvisioning=true,
      // auto-create UserOrganization if not already a member.
      if (org?.id && prisma) {
        try {
          const ssoConf = await prisma.orgSsoConfig.findUnique({
            where: { orgId: org.id },
            select: { jitProvisioning: true, defaultRole: true, defaultTeamId: true, enabled: true },
          });
          if (ssoConf?.enabled && ssoConf.jitProvisioning) {
            const existingMembership = await prisma.userOrganization.findUnique({
              where: { userId_orgId: { userId: user.id, orgId: org.id } },
            });
            if (!existingMembership) {
              const role = ssoConf.defaultRole || 'member';
              await prisma.userOrganization.create({
                data: { userId: user.id, orgId: org.id, role, joinedAt: new Date() },
              });
              if (ssoConf.defaultTeamId) {
                await prisma.teamMember.upsert({
                  where: { teamId_userId: { teamId: ssoConf.defaultTeamId, userId: user.id } },
                  create: { teamId: ssoConf.defaultTeamId, userId: user.id, role: 'member' },
                  update: {},
                }).catch(() => {});
              }
              // Audit JIT provisioning event
              const auditLoggerInst = await _getAuditLogger();
              auditLoggerInst?.log({
                userId: user.id,
                organizationId: org.id,
                eventType: 'sso.jit_provisioned',
                eventCategory: 'provisioning',
                action: 'create',
                resourceType: 'user_organization',
                newValue: { role, default_team_id: ssoConf.defaultTeamId },
                metadata: { sso_provider: 'oidc' },
              }).catch(() => {});
            }
          }
        } catch (jitErr) {
          // JIT errors must not block login
          console.warn('[auth/callback] JIT provisioning error:', jitErr.message);
        }
      }

      const sessionId = await sessionStore.createSession({
        userId: user.id,
        email: user.email,
        orgId: org?.id || null
      });

      let finalRedirect = authState.returnTo || CONFIG.postLoginRedirect;
      // Cross-origin handshake support for external tools (MiroFish, VS Code, etc.)
      if (finalRedirect.includes('localhost') || finalRedirect.includes('?hivemind_auth=callback')) {
          const separator = finalRedirect.includes('?') ? '&' : '?';
          finalRedirect += `${separator}token=${sessionId}`;
      }

      return redirect(res, finalRedirect, [makeSessionCookie(sessionId)]);
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

  // ─── /auth/cli — OAuth loopback for CLI tools (Claude Code plugin etc.) ──
  // Flow:
  //   1. CLI calls /auth/cli?callback=http://localhost:NNNN/callback&client=claude_code
  //   2. If session is missing, kick off Zitadel SSO with returnTo back to /auth/cli
  //   3. On authenticated session, mint an API key with scopes [memory:read, memory:write, mcp, coding]
  //      and 302 to <callback>?apikey=hm_...&user_id=...&org_id=...
  //
  // Loopback safety: callback MUST be http://localhost:* or http://127.0.0.1:* to prevent open-redirect abuse.
  if (pathname === '/auth/cli' && req.method === 'GET') {
    const callback = url.searchParams.get('callback') || '';
    const client = url.searchParams.get('client') || 'cli';

    let cbUrl;
    try {
      cbUrl = new URL(callback);
    } catch {
      return jsonResponse(res, { error: 'invalid callback' }, 400);
    }
    // Allowed callback origins:
    //   - http(s)://localhost:NNNN | 127.0.0.1 | ::1   (CLI loopback)
    //   - https://<allowed-frontend-origin>            (browser-driven 1-click flow)
    // Frontend origins are read from HIVEMIND_ALLOWED_ORIGINS env (comma-separated).
    const isLoopback =
      (cbUrl.protocol === 'http:' || cbUrl.protocol === 'https:') &&
      (cbUrl.hostname === 'localhost' ||
        cbUrl.hostname === '127.0.0.1' ||
        cbUrl.hostname === '::1');
    const allowedFrontendOrigins = (process.env.HIVEMIND_ALLOWED_ORIGINS || '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    const cbOrigin = `${cbUrl.protocol}//${cbUrl.host}`;
    const isAllowedFrontend =
      cbUrl.protocol === 'https:' && allowedFrontendOrigins.includes(cbOrigin);
    if (!isLoopback && !isAllowedFrontend) {
      return jsonResponse(
        res,
        {
          error: 'callback must be http(s)://localhost:NNNN, 127.0.0.1, or an allowed frontend origin',
          allowed_frontend_origins: allowedFrontendOrigins,
        },
        400
      );
    }

    const current = await getCurrentSession(req);
    if (!current) {
      // No session — start Zitadel SSO with returnTo pointing back here so the
      // post-auth redirect re-enters this branch with a session cookie.
      if (!zitadelClient) {
        return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
      }
      const cpBase =
        process.env.HIVEMIND_CONTROL_PLANE_URL ||
        `https://api.hivemind.davinciai.eu:8040`;
      const selfReturnTo = `${cpBase}/auth/cli?callback=${encodeURIComponent(
        callback
      )}&client=${encodeURIComponent(client)}`;
      const state = await sessionStore.createAuthState({
        returnTo: selfReturnTo,
      });
      return redirect(res, zitadelClient.buildAuthorizeUrl(state, {}));
    }

    // Authenticated — mint an API key for this client.
    try {
      const userId = current.session.userId;
      const orgId = current.session.orgId || null;
      if (!prisma) {
        return jsonResponse(res, { error: 'persistence offline' }, 503);
      }
      const userAgent = req.headers['user-agent'] || '';
      const ip =
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const { rawKey } = await createPersistedApiKey(prisma, {
        userId,
        orgId,
        name: `cli:${client}`,
        description: `Issued via /auth/cli for ${client} on ${new Date().toISOString()}`,
        scopes: ['memory:read', 'memory:write', 'mcp', 'coding', 'web_search', 'web_crawl'],
        expiresAt: null,
        rateLimitPerMinute: 120,
        createdByIp: ip,
        userAgent,
      });

      const params = new URLSearchParams({
        apikey: rawKey,
        user_id: userId,
        ...(orgId ? { org_id: orgId } : {}),
        client,
      });
      const sep = cbUrl.search ? '&' : '?';
      const target = `${callback}${sep}${params.toString()}`;
      return redirect(res, target);
    } catch (err) {
      console.error('[auth/cli] failed:', err.message);
      const params = new URLSearchParams({ error: err.message });
      const sep = cbUrl.search ? '&' : '?';
      return redirect(res, `${callback}${sep}${params.toString()}`);
    }
  }

  if (pathname === '/v1/bootstrap' && req.method === 'GET') {
    const current = await getCurrentSession(req);
    if (!current) {
      return jsonResponse(res, await buildAnonymousBootstrapPayload());
    }
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
    const requestedPlan = typeof body.plan === 'string' ? body.plan.trim().toLowerCase() : 'free';
    if (!PLANS[requestedPlan]) {
      return jsonResponse(res, { error: 'invalid plan', valid: Object.keys(PLANS) }, 400);
    }

    const slugBase = sanitizeSlug(body.slug || body.name);
    const existing = await prisma.organization.findUnique({ where: { slug: slugBase } });
    const slug = existing ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;
    const org = await prisma.organization.create({
      data: {
        zitadelOrgId: `cp-org-${crypto.randomUUID()}`,
        name: body.name,
        slug,
        plan: requestedPlan
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
        slug: org.slug,
        plan: org.plan || requestedPlan
      }
    }, 201, {
      'Set-Cookie': makeSessionCookie(sessionId)
    });
  }

  const inviteCollectionMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites$/);
  if (inviteCollectionMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteCollectionMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const body = await parseBody(req);
    // Support both legacy `role` and new `roles[]`
    let inviteRoles = [];
    if (Array.isArray(body.roles) && body.roles.length > 0) {
      const invalid = body.roles.filter(r => !ROLES.has(r));
      if (invalid.length > 0) {
        return jsonResponse(res, { error: `Invalid roles: ${invalid.join(', ')}` }, 400);
      }
      inviteRoles = body.roles;
    } else {
      const legacyRole = typeof body.role === 'string' && body.role.trim() ? body.role.trim().toLowerCase() : 'member';
      if (!['member', 'viewer', 'developer', 'admin', 'org_admin', 'team_lead', 'compliance_admin'].includes(legacyRole)) {
        return jsonResponse(res, { error: 'invalid role' }, 400);
      }
      // Map legacy to new role name if needed
      const legacyMap = { admin: 'org_admin', owner: 'org_owner', developer: 'member' };
      inviteRoles = [legacyMap[legacyRole] || legacyRole];
    }

    // team_ids: optional array of team UUIDs to auto-join on accept
    const teamIds = Array.isArray(body.team_ids) ? body.team_ids.filter(id => typeof id === 'string') : [];

    const token = crypto.randomBytes(24).toString('hex');
    // Keep backward-compat `role` column as the first role mapped back to legacy
    const legacyRoleReverse = inviteRoles.includes('org_owner') ? 'owner'
      : inviteRoles.includes('org_admin') ? 'admin'
      : inviteRoles[0] || 'member';

    const invite = await prisma.orgInvite.create({
      data: {
        orgId,
        email: typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : null,
        role: legacyRoleReverse,
        roles: inviteRoles,
        teamIds,
        token,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
        createdBy: current.session.userId,
      },
    });

    const joinUrl = `${CONFIG.publicBaseUrl.replace(/\/$/, '')}/hivemind/join/${membership.org.slug}/${invite.token}`;
    return jsonResponse(res, {
      success: true,
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        roles: invite.roles,
        team_ids: invite.teamIds,
        token: invite.token,
        expires_at: invite.expiresAt,
        created_at: invite.createdAt,
        join_url: joinUrl,
      },
    }, 201);
  }

  if (inviteCollectionMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteCollectionMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const invites = await prisma.orgInvite.findMany({
      where: { orgId, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return jsonResponse(res, {
      invites: invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        expires_at: invite.expiresAt,
        created_at: invite.createdAt,
        join_url: `${CONFIG.publicBaseUrl.replace(/\/$/, '')}/hivemind/join/${membership.org.slug}/${invite.token}`,
      })),
    });
  }

  const inviteDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/invites\/([^/]+)$/);
  if (inviteDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = inviteDetailMatch[1];
    const inviteId = inviteDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const deleted = await prisma.orgInvite.deleteMany({
      where: { id: inviteId, orgId, usedAt: null },
    });

    if (!deleted.count) {
      return jsonResponse(res, { error: 'Invite not found' }, 404);
    }

    return jsonResponse(res, { success: true, invite_id: inviteId });
  }

  const joinMatch = pathname.match(/^\/v1\/join\/([^/]+)$/);
  if (joinMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const token = joinMatch[1];

    const invite = await prisma.orgInvite.findUnique({
      where: { token },
      include: { org: true },
    });

    if (!invite || invite.usedAt) {
      return jsonResponse(res, { error: 'Invite not found' }, 404);
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      return jsonResponse(res, { error: 'Invite expired' }, 410);
    }
    if (invite.email && invite.email !== (current.session.email || '').toLowerCase()) {
      return jsonResponse(res, { error: 'Invite email does not match current account' }, 403);
    }

    const inviteRoles = Array.isArray(invite.roles) && invite.roles.length > 0
      ? invite.roles
      : [invite.role || 'member'];

    await prisma.userOrganization.upsert({
      where: { userId_orgId: { userId: current.session.userId, orgId: invite.orgId } },
      update: {
        role: invite.role,
        roles: inviteRoles,
        joinedAt: new Date(),
        isActive: true,
        deactivatedAt: null,
      },
      create: {
        userId: current.session.userId,
        orgId: invite.orgId,
        role: invite.role,
        roles: inviteRoles,
        invitedAt: invite.createdAt,
        joinedAt: new Date(),
        isActive: true,
      },
    });

    // Auto-add to invited teams
    const teamIds = Array.isArray(invite.teamIds) ? invite.teamIds : [];
    if (teamIds.length > 0) {
      for (const teamId of teamIds) {
        await prisma.teamMember.upsert({
          where: { teamId_userId: { teamId, userId: current.session.userId } },
          update: {},
          create: { teamId, userId: current.session.userId, role: 'member', addedById: invite.createdBy },
        }).catch(() => null); // silently skip if team doesn't exist
      }
    }

    await prisma.orgInvite.update({
      where: { id: invite.id },
      data: {
        usedAt: new Date(),
        usedBy: current.session.userId,
      },
    });

    audit({
      organizationId: invite.orgId,
      userId: current.session.userId,
      eventType: 'invite.accepted',
      eventCategory: 'auth',
      action: 'create',
      resourceType: 'user',
      resourceId: current.session.userId,
      newValue: { roles: inviteRoles, team_ids: teamIds },
      ..._reqMeta(req),
    });

    await sessionStore.destroySession(current.sessionId);
    const sessionId = await sessionStore.createSession({
      ...current.session,
      orgId: invite.orgId,
    });

    return jsonResponse(res, {
      success: true,
      organization: {
        id: invite.org.id,
        name: invite.org.name,
        slug: invite.org.slug,
        plan: invite.org.plan || 'free',
      },
    }, 200, {
      'Set-Cookie': makeSessionCookie(sessionId),
    });
  }

  const membersMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members$/);
  if (membersMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = membersMatch[1];
    const membership = await getOrgMembership(current.session.userId, orgId);
    if (!membership) {
      return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    }
    // Require user:read permission to list members (org_admin, compliance_admin, team_lead)
    const callerRoles = effectiveRoles(membership);
    if (!hasPermission(callerRoles, 'user', 'read')) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }

    const members = await prisma.userOrganization.findMany({
      where: { orgId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            lastActiveAt: true,
          },
        },
      },
      orderBy: [
        { role: 'asc' },
        { joinedAt: 'asc' },
      ],
    });

    return jsonResponse(res, {
      members: members.map((entry) => ({
        user_id: entry.userId,
        role: entry.role,
        roles: entry.roles && entry.roles.length ? entry.roles : effectiveRoles(entry),
        is_active: entry.isActive ?? true,
        deactivated_at: entry.deactivatedAt ?? null,
        invited_at: entry.invitedAt,
        joined_at: entry.joinedAt,
        email: entry.user?.email || null,
        display_name: entry.user?.displayName || null,
        avatar_url: entry.user?.avatarUrl || null,
        last_active_at: entry.user?.lastActiveAt || null,
      })),
    });
  }

  const projectsMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/projects$/);
  if (projectsMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectsMatch[1];
    const membership = await getOrgMembership(current.session.userId, orgId);
    if (!membership) {
      return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    }
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const projects = await prisma.project.findMany({
      where: { orgId },
      orderBy: { updatedAt: 'desc' },
    });

    return jsonResponse(res, {
      projects: projects.map((project) => ({
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      })),
    });
  }

  if (projectsMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectsMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const body = await parseBody(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }
    const slugBase = sanitizeSlug(body.slug || name);
    const existing = await prisma.project.findFirst({ where: { orgId, slug: slugBase } });
    const slug = existing ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;

    const project = await prisma.project.create({
      data: {
        orgId,
        name,
        slug,
        description: typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null,
        createdBy: current.session.userId,
      },
    });

    return jsonResponse(res, {
      success: true,
      project: {
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    }, 201);
  }

  const memberDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)$/);
  if (memberDetailMatch && req.method === 'PATCH') {
    // Legacy: PATCH /v1/orgs/:id/members/:userId — update single role (kept for compat)
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDetailMatch[1];
    const targetUserId = memberDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const body = await parseBody(req);
    const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
    if (!['member', 'viewer', 'developer', 'admin'].includes(role)) {
      return jsonResponse(res, { error: 'invalid role' }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }
    if (targetMembership.role === 'owner') {
      return jsonResponse(res, { error: 'Owner role cannot be changed here' }, 400);
    }

    const updated = await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { role },
    });

    return jsonResponse(res, { success: true, member: { user_id: updated.userId, role: updated.role } });
  }

  // ─── RBAC: member role management (P0-4) ─────────────────────────────────

  // PATCH /v1/orgs/:id/members/:userId/roles — set roles[] (multi-role RBAC)
  const memberRolesMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/roles$/);
  if (memberRolesMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberRolesMatch[1];
    const targetUserId = memberRolesMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    const body = await parseBody(req);
    const newRoles = Array.isArray(body.roles) ? body.roles : [];

    // Validate: all entries must be known roles
    const invalidRoles = newRoles.filter(r => !ROLES.has(r));
    if (newRoles.length === 0 || invalidRoles.length > 0) {
      return jsonResponse(res, {
        error: `Invalid roles: ${invalidRoles.join(', ') || 'roles[] must be non-empty'}. Allowed: ${[...ROLES].join(', ')}`,
      }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    // Last org_owner protection: block demotion if this would drop owner count to 0
    if (!newRoles.includes('org_owner')) {
      const targetCurrentRoles = effectiveRoles(targetMembership);
      if (targetCurrentRoles.includes('org_owner')) {
        const ownerCount = await prisma.userOrganization.count({
          where: {
            orgId,
            roles: { has: 'org_owner' },
          },
        });
        const legacyOwnerCount = ownerCount === 0
          ? await prisma.userOrganization.count({ where: { orgId, role: 'owner' } })
          : 0;
        const totalOwners = ownerCount + legacyOwnerCount;
        if (totalOwners <= 1) {
          return jsonResponse(res, { error: 'Cannot remove the last org_owner' }, 400);
        }
      }
    }

    // Prevent self-demotion below org_owner if caller is the only owner
    if (targetUserId === current.session.userId && !newRoles.includes('org_owner')) {
      const callerRoles = effectiveRoles(callerMembership);
      if (callerRoles.includes('org_owner')) {
        const ownerCount = await prisma.userOrganization.count({
          where: { orgId, roles: { has: 'org_owner' } },
        });
        if (ownerCount <= 1) {
          return jsonResponse(res, { error: 'Cannot self-demote: you are the last org_owner' }, 400);
        }
      }
    }

    const oldRoles = effectiveRoles(targetMembership);
    const updated = await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { roles: newRoles },
    });

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'rbac.role_changed',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      oldValue: { roles: oldRoles },
      newValue: { roles: newRoles },
      ..._reqMeta(req),
    });

    return jsonResponse(res, {
      success: true,
      member: { user_id: updated.userId, roles: updated.roles },
    });
  }

  // POST /v1/orgs/:id/members/:userId/deactivate
  const memberDeactivateMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/deactivate$/);
  if (memberDeactivateMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDeactivateMatch[1];
    const targetUserId = memberDeactivateMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    if (targetUserId === current.session.userId) {
      return jsonResponse(res, { error: 'Cannot deactivate yourself' }, 400);
    }

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    const now = new Date();
    await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { isActive: false, deactivatedAt: now },
    });

    // Revoke API keys for this user
    await prisma.apiKey.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Delete sessions for this user
    await prisma.session.deleteMany({ where: { userId: targetUserId } }).catch(() => null);

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'user.deactivated',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      newValue: { is_active: false, deactivated_at: now.toISOString() },
      ..._reqMeta(req),
    });

    return jsonResponse(res, { success: true, user_id: targetUserId, deactivated_at: now.toISOString() });
  }

  // POST /v1/orgs/:id/members/:userId/reactivate
  const memberReactivateMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/members\/([^/]+)\/reactivate$/);
  if (memberReactivateMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberReactivateMatch[1];
    const targetUserId = memberReactivateMatch[2];
    const callerMembership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!callerMembership) return;

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }

    await prisma.userOrganization.update({
      where: { userId_orgId: { userId: targetUserId, orgId } },
      data: { isActive: true, deactivatedAt: null },
    });

    audit({
      organizationId: orgId,
      userId: current.session.userId,
      eventType: 'user.reactivated',
      eventCategory: 'data_modification',
      action: 'update',
      resourceType: 'user',
      resourceId: targetUserId,
      newValue: { is_active: true },
      ..._reqMeta(req),
    });

    return jsonResponse(res, { success: true, user_id: targetUserId });
  }

  const projectDetailMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/projects\/([^/]+)$/);
  if (projectDetailMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectDetailMatch[1];
    const projectId = projectDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const body = await parseBody(req);
    const updateData = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      updateData.name = body.name.trim();
    }
    if (typeof body.description === 'string') {
      updateData.description = body.description.trim() || null;
    }
    if (typeof body.slug === 'string' && body.slug.trim()) {
      const slugBase = sanitizeSlug(body.slug);
      const conflict = await prisma.project.findFirst({
        where: {
          orgId,
          slug: slugBase,
          id: { not: projectId },
        },
      });
      updateData.slug = conflict ? `${slugBase}-${crypto.randomUUID().slice(0, 6)}` : slugBase;
    }

    if (!Object.keys(updateData).length) {
      return jsonResponse(res, { error: 'No valid fields to update' }, 400);
    }

    const existingProject = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!existingProject) {
      return jsonResponse(res, { error: 'Project not found' }, 404);
    }

    const project = await prisma.project.update({
      where: { id: projectId },
      data: updateData,
    });

    return jsonResponse(res, {
      success: true,
      project: {
        id: project.id,
        org_id: project.orgId,
        name: project.name,
        slug: project.slug,
        description: project.description,
        created_by: project.createdBy,
        created_at: project.createdAt,
        updated_at: project.updatedAt,
      },
    });
  }

  if (memberDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = memberDetailMatch[1];
    const targetUserId = memberDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    const targetMembership = await getOrgMembership(targetUserId, orgId);
    if (!targetMembership) {
      return jsonResponse(res, { error: 'Member not found' }, 404);
    }
    if (targetMembership.role === 'owner') {
      return jsonResponse(res, { error: 'Owner cannot be removed' }, 400);
    }

    await prisma.userOrganization.delete({
      where: { userId_orgId: { userId: targetUserId, orgId } },
    });

    return jsonResponse(res, { success: true, user_id: targetUserId });
  }

  if (projectDetailMatch && req.method === 'DELETE') {
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = projectDetailMatch[1];
    const projectId = projectDetailMatch[2];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;
    if (membership.org?.plan !== 'enterprise') {
      return jsonResponse(res, { error: 'Projects require an enterprise workspace' }, 403);
    }

    const deleted = await prisma.project.deleteMany({
      where: { id: projectId, orgId },
    });

    if (!deleted.count) {
      return jsonResponse(res, { error: 'Project not found' }, 404);
    }

    return jsonResponse(res, { success: true, project_id: projectId });
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
      scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['memory:read', 'memory:write', 'mcp', 'coding'],
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

  if ((pathname === '/v1/account' && req.method === 'DELETE') || (pathname === '/v1/account/delete' && req.method === 'POST')) {
    console.log('[account-delete] ▶ Request received:', req.method, pathname);
    const current = await requireSession(req, res);
    if (!current) {
      console.warn('[account-delete] ✗ No valid session — requireSession rejected');
      return;
    }
    console.log('[account-delete] ✓ Session valid, userId:', current.session.userId, 'sessionId:', current.sessionId);

    if (!prisma) {
      console.error('[account-delete] ✗ Database unavailable (prisma is null)');
      return jsonResponse(res, { error: 'Database unavailable' }, 503);
    }

    const body = await parseBody(req);
    console.log('[account-delete] Body received:', JSON.stringify({ confirm: body.confirm, keys: Object.keys(body) }));
    if ((body.confirm || '').trim().toUpperCase() !== 'DELETE') {
      console.warn('[account-delete] ✗ Confirmation mismatch — got:', JSON.stringify(body.confirm));
      return jsonResponse(res, { error: 'Confirmation text must be DELETE' }, 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: current.session.userId },
      select: { id: true, email: true },
    });
    if (!user) {
      console.warn('[account-delete] ✗ User not found in DB for userId:', current.session.userId);
      await sessionStore.destroySession(current.sessionId);
      return jsonResponse(res, { success: true }, 200, {
        'Set-Cookie': clearSessionCookie(),
      });
    }
    console.log('[account-delete] ✓ User found:', user.email, '(id:', user.id, ')');

    const deletionCheck = await validateAccountDeletion(user.id);
    console.log('[account-delete] Validation result:', JSON.stringify(deletionCheck));
    if (!deletionCheck.ok) {
      console.warn('[account-delete] ✗ Validation failed:', JSON.stringify(deletionCheck));
      return jsonResponse(res, deletionCheck, deletionCheck.status || 409);
    }

    console.log('[account-delete] ✓ Validation passed — destroying session, starting deletion');
    await sessionStore.destroySession(current.sessionId);

    // Check if client wants SSE streaming (Accept: text/event-stream)
    const wantsSSE = (req.headers.accept || '').includes('text/event-stream') || body.stream === true;

    if (wantsSSE) {
      // SSE streaming delete with progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Set-Cookie': clearSessionCookie(),
      });

      const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const result = await performAccountDeletion({
        userId: user.id,
        orgIdsToDelete: deletionCheck.orgIdsToDelete || [],
        onProgress: (pct, step) => {
          sendEvent({ progress: pct, step, userId: user.id });
        },
      });

      if (result.ok) {
        sendEvent({ progress: 100, step: 'Account deleted', done: true, success: true });
      } else {
        sendEvent({ progress: -1, step: result.error, done: true, success: false, error: result.error });
      }
      res.end();
      return;
    }

    // Non-streaming: wait for completion, return final result
    const result = await performAccountDeletion({
      userId: user.id,
      orgIdsToDelete: deletionCheck.orgIdsToDelete || [],
    });

    if (!result.ok) {
      return jsonResponse(res, { error: result.error, status: 'failed' }, 500, {
        'Set-Cookie': clearSessionCookie(),
      });
    }

    return jsonResponse(res, {
      success: true,
      status: 'completed',
      deleted_user_id: user.id,
      deleted_email: user.email,
      deleted_org_ids: deletionCheck.orgIdsToDelete || [],
    }, 200, {
      'Set-Cookie': clearSessionCookie(),
    });
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
        target_scope: connector?.target_scope || 'personal',
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

    // Org-scope connectors require connector:manage; personal connectors are open
    const connectorStartBody = await parseBody(req);
    if (connectorStartBody.target_scope === 'organization') {
      const connMem = await getOrgMembership(current.session.userId, current.session.orgId);
      if (connMem) {
        try {
          const auditLogger = await _getAuditLogger();
          assertPermission(req, { resource: 'connector', action: 'manage' }, {
            userRoles: effectiveRoles(connMem),
            orgId: current.session.orgId,
            userId: current.session.userId,
            auditLogger,
          });
        } catch (permErr) {
          return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
        }
      }
    }

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
      // connectorStartBody was already read for the permission check above
      const body = connectorStartBody;
      const returnTo = body.return_to || '/hivemind/app/connectors';
      const rawScope = body.target_scope;
      const rawTeamId = body.team_id || null;

      // Validate and normalise target_scope.
      // 'organization' → requires org_admin or org_owner.
      // 'team'         → requires team_lead on the specified team_id.
      // 'personal'     → no extra permission needed.
      let targetScope = 'personal';
      let resolvedTeamId = null;

      if (rawScope === 'organization') {
        const membership = await getOrgMembership(current.session.userId, current.session.orgId);
        if (!membership || !canManageOrg(membership.role)) {
          return jsonResponse(res, { error: 'Only org admins can set org-scope connectors' }, 403);
        }
        targetScope = 'organization';
      } else if (rawScope === 'team') {
        if (!rawTeamId) {
          return jsonResponse(res, { error: 'team_id is required when target_scope is "team"' }, 400);
        }
        if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
        // Inline team store import — _getTeamStore is const-scoped later in the handler
        const tsModTeam = await import('./teams/team-store.js');
        const orgMembership = await getOrgMembership(current.session.userId, current.session.orgId);
        const orgRole = orgMembership?.role || 'member';
        try {
          await tsModTeam.assertTeamPermission(prisma, {
            teamId: rawTeamId,
            userId: current.session.userId,
            orgRole,
            level: 'lead',
          });
        } catch {
          return jsonResponse(res, { error: 'Only team leads can set team-scope connectors' }, 403);
        }
        targetScope = 'team';
        resolvedTeamId = rawTeamId;
      }

      // Audit-log connector scope selection (fire-and-forget)
      if (prisma && (targetScope === 'organization' || targetScope === 'team')) {
        const auditMod = await import('./audit/audit-logger.js');
        const al = new auditMod.AuditLogger(prisma);
        const fwdHdr = req.headers?.['x-forwarded-for'];
        al.log({
          organizationId: current.session.orgId,
          userId: current.session.userId,
          eventType: 'connector.scope_changed',
          eventCategory: 'connector',
          action: 'start_oauth',
          resourceType: 'connector',
          newValue: { provider, target_scope: targetScope, team_id: resolvedTeamId },
          ipAddress: typeof fwdHdr === 'string' ? fwdHdr.split(',')[0].trim() : (req.socket?.remoteAddress || null),
          userAgent: req.headers?.['user-agent'] || null,
          platformType: 'webapp',
        }).catch(err => console.warn('[audit] connector start log failed:', err.message));
      }

      // Create CSRF-safe stateless state bound to user/org
      const stateId = encodeConnectorState({
        userId: current.session.userId,
        orgId: current.session.orgId,
        provider,
        returnTo,
        targetScope,
        teamId: resolvedTeamId,
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

      // For providers that issue both bot and user tokens (Slack), merge the
      // granted scopes from both sides and stash the user-token in metadata
      // so the bridge can use it for user-only API calls (e.g. search.messages).
      const grantedBotScopes = (tokens.bot_scope || '').split(/[,\s]+/).filter(Boolean);
      const grantedUserScopes = (tokens.user_scope || '').split(/[,\s]+/).filter(Boolean);
      const mergedScopes = grantedBotScopes.length || grantedUserScopes.length
        ? Array.from(new Set([...grantedBotScopes, ...grantedUserScopes]))
        : (providerConfig.scopes || []);

      const providerMetadata = {};
      if (tokens.user_access_token) providerMetadata.user_access_token = tokens.user_access_token;
      if (tokens.user_scope) providerMetadata.user_scope = tokens.user_scope;
      if (tokens.bot_scope) providerMetadata.bot_scope = tokens.bot_scope;
      if (tokens.team_id) providerMetadata.team_id = tokens.team_id;
      if (tokens.team) providerMetadata.team = tokens.team;
      if (tokens.authed_user_id) providerMetadata.authed_user_id = tokens.authed_user_id;

      // Store encrypted tokens
      await connectorStore.upsertConnector({
        userId: authState.userId,
        provider,
        targetScope: authState.targetScope || 'personal',
        teamId: authState.teamId || null,
        accountRef: tokens.email || tokens.account_ref || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        scopes: mergedScopes,
        metadata: providerMetadata,
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
              target_scope: authState.targetScope || 'personal',
              team_id: authState.teamId || null,
              incremental: false,
            }),
          });
          console.log(`[connector] Initial sync enqueued for ${provider}:${authState.userId} → ${syncResponse.status}`);
        } catch (syncError) {
          console.error(`[connector] Initial sync failed for ${provider}:`, syncError.message);
        }
      });

      // Resolve returnTo to an absolute frontend URL. authState.returnTo may
      // already be absolute (set by the connectors page). If it's a bare path
      // we prepend the frontend base — otherwise the redirect lands on the
      // control-plane host (api.hivemind.davinciai.eu:8040) which serves
      // {"error":"Not found"} for /hivemind/* paths.
      const rawReturnTo = authState.returnTo || '/hivemind/app/connectors';
      const isAbsolute = /^https?:\/\//i.test(rawReturnTo);
      const returnTo = isAbsolute ? rawReturnTo : `${defaultFrontendBaseUrl}${rawReturnTo}`;
      const sep = returnTo.includes('?') ? '&' : '?';
      return redirect(res, `${returnTo}${sep}connector_success=${provider}`);
    } catch (tokenError) {
      console.error(`[connector] OAuth exchange failed for ${provider}:`, tokenError.message);
      return redirect(res, `${defaultFrontendBaseUrl}/hivemind/app/connectors?connector_error=${encodeURIComponent(tokenError.message)}`);
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
          target_scope: connector.target_scope || 'personal',
          incremental: body.incremental !== false,
        }),
      });
      return jsonResponse(res, { success: true, message: 'Sync enqueued' });
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 500);
    }
  }

  // ─── Teams & Projects ─────────────────────────────────────
  // Lazy-init TeamStore once prisma is ready (module-level cache).
  const _getTeamStore = async () => {
    if (!prisma) return null;
    if (!_getTeamStore._cache) {
      const mod = await import('./teams/team-store.js');
      _getTeamStore._cache = {
        store: new mod.TeamStore(prisma),
        assertTeamPermission: mod.assertTeamPermission,
        assertProjectPermission: mod.assertProjectPermission,
      };
    }
    return _getTeamStore._cache;
  };

  // Lazy AuditLogger for control-plane. Records team/project/scope mutations.
  const _getAuditLogger = async () => {
    if (!prisma) return null;
    if (!_getAuditLogger._cache) {
      const mod = await import('./audit/audit-logger.js');
      _getAuditLogger._cache = new mod.AuditLogger(prisma);
    }
    return _getAuditLogger._cache;
  };

  // Fire-and-forget helper. Skips on missing prisma.
  async function audit(entry) {
    const a = await _getAuditLogger();
    if (!a) return;
    a.log(entry).catch(err => console.warn('[audit] log failed:', err.message));
  }

  function _reqMeta(req) {
    const fwd = req.headers?.['x-forwarded-for'];
    const ip = typeof fwd === 'string' ? fwd.split(',')[0].trim() : null;
    return {
      ipAddress: ip || req.socket?.remoteAddress || null,
      userAgent: req.headers?.['user-agent'] || null,
      platformType: 'webapp',
    };
  }

  // GET /v1/teams — list teams current user belongs to in current org
  if (pathname === '/v1/teams' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const teams = await ts.store.listTeamsForUser({
        userId: current.session.userId,
        orgId: current.session.orgId,
      });
      return jsonResponse(res, { teams });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/teams — create team (org_admin or team_lead)
  if (pathname === '/v1/teams' && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    const callerRoles = effectiveRoles(callerMem);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'team', action: 'manage' }, {
        userRoles: callerRoles,
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    // keep `admin` as alias for backward compat with the block below
    const admin = callerMem;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const body = await parseBody(req);
    if (!body.name || typeof body.name !== 'string') {
      return jsonResponse(res, { error: 'name is required' }, 400);
    }
    try {
      const team = await ts.store.createTeam({
        orgId: current.session.orgId,
        name: body.name.trim(),
        description: body.description || null,
        createdBy: current.session.userId,
      });
      audit({
        organizationId: current.session.orgId,
        userId: current.session.userId,
        eventType: 'team.created',
        eventCategory: 'team',
        action: 'create',
        resourceType: 'team',
        resourceId: team.id,
        newValue: { name: team.name, slug: team.slug },
        ..._reqMeta(req),
      });
      return jsonResponse(res, { team }, 201);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // Routes scoped to a single team
  const teamIdMatch = pathname.match(/^\/v1\/teams\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (teamIdMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const teamId = teamIdMatch[1];
    const sub = teamIdMatch[2] || null;
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const membership = await getOrgMembership(userId, orgId);
    const orgRole = membership?.role;

    // Sanity: team must belong to current org
    const team = await prisma.team.findFirst({ where: { id: teamId, orgId } });
    if (!team) return jsonResponse(res, { error: 'Team not found' }, 404);

    // GET /v1/teams/:id
    if (!sub && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        return jsonResponse(res, await ts.store.getTeam({ teamId, orgId }));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // PATCH /v1/teams/:id
    if (!sub && req.method === 'PATCH') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        const body = await parseBody(req);
        const updated = await ts.store.updateTeam({ teamId, orgId, data: body });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.updated', eventCategory: 'team', action: 'update',
          resourceType: 'team', resourceId: teamId,
          oldValue: { name: team.name, description: team.description },
          newValue: { name: updated.name, description: updated.description },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { team: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/teams/:id  (archive)
    if (!sub && req.method === 'DELETE') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'admin' });
        const archived = await ts.store.archiveTeam({ teamId, orgId });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.archived', eventCategory: 'team', action: 'delete',
          resourceType: 'team', resourceId: teamId,
          oldValue: { name: team.name },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { team: archived });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 400);
      }
    }
    // GET /v1/teams/:id/members
    if (sub === 'members' && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        return jsonResponse(res, { members: await ts.store.listTeamMembers({ teamId }) });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/teams/:id/members
    if (sub === 'members' && req.method === 'POST') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        const body = await parseBody(req);
        if (!body.user_id) return jsonResponse(res, { error: 'user_id required' }, 400);
        const m = await ts.store.addTeamMember({
          teamId,
          userId: body.user_id,
          role: body.role || 'member',
          addedById: userId,
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.member_added', eventCategory: 'team', action: 'create',
          resourceType: 'team_member', resourceId: teamId,
          newValue: { team_id: teamId, user_id: body.user_id, role: body.role || 'member' },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { member: m }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/teams/:id/members/:userId
    const memberDelMatch = sub && sub.match(/^members\/([0-9a-f-]{36})$/);
    if (memberDelMatch && req.method === 'DELETE') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'lead' });
        await ts.store.removeTeamMember({ teamId, userId: memberDelMatch[1] });
        audit({
          organizationId: orgId, userId,
          eventType: 'team.member_removed', eventCategory: 'team', action: 'delete',
          resourceType: 'team_member', resourceId: teamId,
          oldValue: { team_id: teamId, user_id: memberDelMatch[1] },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 400);
      }
    }
    // GET /v1/teams/:id/projects
    if (sub === 'projects' && req.method === 'GET') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        const projects = await ts.store.listProjectsForUser({ userId, orgId, teamId });
        return jsonResponse(res, { projects });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/teams/:id/projects
    if (sub === 'projects' && req.method === 'POST') {
      try {
        await ts.assertTeamPermission(prisma, { teamId, userId, orgRole, level: 'member' });
        const body = await parseBody(req);
        if (!body.name) return jsonResponse(res, { error: 'name required' }, 400);
        const p = await ts.store.createProject({
          orgId,
          teamId,
          name: body.name.trim(),
          description: body.description || null,
          createdBy: userId,
        });
        audit({
          organizationId: orgId, userId,
          eventType: 'project.created', eventCategory: 'project', action: 'create',
          resourceType: 'project', resourceId: p.id,
          newValue: { name: p.name, slug: p.slug, team_id: teamId },
          ..._reqMeta(req),
        });
        return jsonResponse(res, { project: p }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // Fall through — unmatched team sub-route
    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // ─── Projects ─────────────────────────────────────────────
  // GET /v1/projects — list projects in current org for current user
  if (pathname === '/v1/projects' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    try {
      const projects = await ts.store.listProjectsForUser({
        userId: current.session.userId,
        orgId: current.session.orgId,
      });
      return jsonResponse(res, { projects });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // Routes scoped to a single project
  const projectIdMatch = pathname.match(/^\/v1\/projects\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (projectIdMatch) {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const projectId = projectIdMatch[1];
    const sub = projectIdMatch[2] || null;
    const orgId = current.session.orgId;
    const userId = current.session.userId;
    const membership = await getOrgMembership(userId, orgId);
    const orgRole = membership?.role;

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return jsonResponse(res, { error: 'Project not found' }, 404);

    // GET /v1/projects/:id
    if (!sub && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'member' });
        return jsonResponse(res, await ts.store.getProject({ projectId, orgId }));
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // PATCH /v1/projects/:id
    if (!sub && req.method === 'PATCH') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'owner' });
        const body = await parseBody(req);
        const updated = await ts.store.updateProject({ projectId, data: body });
        return jsonResponse(res, { project: updated });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/projects/:id (archive)
    if (!sub && req.method === 'DELETE') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'owner' });
        await ts.store.archiveProject({ projectId });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // GET /v1/projects/:id/members
    if (sub === 'members' && req.method === 'GET') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'member' });
        const proj = await ts.store.getProject({ projectId, orgId });
        return jsonResponse(res, { members: proj?.members || [] });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // POST /v1/projects/:id/members
    if (sub === 'members' && req.method === 'POST') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'owner' });
        const body = await parseBody(req);
        if (!body.user_id) return jsonResponse(res, { error: 'user_id required' }, 400);
        const m = await ts.store.addProjectMember({
          projectId,
          userId: body.user_id,
          role: body.role || 'contributor',
          addedById: userId,
        });
        return jsonResponse(res, { member: m }, 201);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }
    // DELETE /v1/projects/:id/members/:userId
    const projMemberDel = sub && sub.match(/^members\/([0-9a-f-]{36})$/);
    if (projMemberDel && req.method === 'DELETE') {
      try {
        await ts.assertProjectPermission(prisma, { projectId, userId, orgRole, level: 'owner' });
        await ts.store.removeProjectMember({ projectId, userId: projMemberDel[1] });
        return jsonResponse(res, { success: true });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, err.status || 500);
      }
    }

    return jsonResponse(res, { error: 'Not found' }, 404);
  }

  // PATCH /v1/memories/:id/scope — change memory scope + team + projects
  const memoryScopeMatch = pathname.match(/^\/v1\/memories\/([0-9a-f-]{36})\/scope$/);
  if (memoryScopeMatch && req.method === 'PATCH') {
    const current = await requireSession(req, res);
    if (!current) return;
    const ts = await _getTeamStore();
    if (!ts) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const memoryId = memoryScopeMatch[1];
    const body = await parseBody(req);
    const userId = current.session.userId;
    const orgId = current.session.orgId;

    // Verify caller owns the memory or is org admin
    const memory = await prisma.memory.findFirst({ where: { id: memoryId } });
    if (!memory) return jsonResponse(res, { error: 'Memory not found' }, 404);
    const membership = await getOrgMembership(userId, orgId);
    const isOrgAdmin = membership?.role === 'owner' || membership?.role === 'admin';
    if (memory.userId !== userId && !isOrgAdmin) {
      return jsonResponse(res, { error: 'Forbidden' }, 403);
    }

    const VALID_SCOPES = new Set(['personal', 'project', 'team', 'organization']);
    const data = {};
    if (body.scope) {
      if (!VALID_SCOPES.has(body.scope)) {
        return jsonResponse(res, { error: 'Invalid scope' }, 400);
      }
      data.scope = body.scope;
    }
    if ('primary_team_id' in body) {
      data.primaryTeamId = body.primary_team_id || null;
    }
    if (Object.keys(data).length > 0) {
      await prisma.memory.update({ where: { id: memoryId }, data });
    }
    if (Array.isArray(body.project_ids)) {
      await ts.store.setMemoryProjects({
        memoryId,
        projectIds: body.project_ids,
        addedById: userId,
      });
    }
    const updated = await prisma.memory.findUnique({
      where: { id: memoryId },
      include: { memoryProjects: { include: { project: true } } },
    });
    audit({
      organizationId: orgId, userId,
      eventType: 'memory.scope_changed', eventCategory: 'memory', action: 'update',
      resourceType: 'memory', resourceId: memoryId,
      oldValue: { scope: memory.scope, primary_team_id: memory.primaryTeamId },
      newValue: { scope: updated.scope, primary_team_id: updated.primaryTeamId,
                   project_ids: (updated.memoryProjects || []).map(mp => mp.projectId) },
      ..._reqMeta(req),
    });
    return jsonResponse(res, { memory: updated });
  }

  // ─── End Teams & Projects ─────────────────────────────────

  // ─── Audit + DSR (Compliance) ────────────────────────────
  // GET /v1/audit/logs — org_admin or compliance_admin
  if (pathname === '/v1/audit/logs' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'audit', action: 'read' }, {
        userRoles: effectiveRoles(callerMem),
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    const audit = await _getAuditLogger();
    if (!audit) return jsonResponse(res, { error: 'Audit unavailable' }, 503);
    try {
      const result = await audit.query({
        organizationId: current.session.orgId,
        userId: url.searchParams.get('user_id') || undefined,
        eventCategory: url.searchParams.get('category') || undefined,
        action: url.searchParams.get('action') || undefined,
        resourceType: url.searchParams.get('resource_type') || undefined,
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: parseInt(url.searchParams.get('limit') || '50', 10),
        offset: parseInt(url.searchParams.get('offset') || '0', 10),
      });
      return jsonResponse(res, result);
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // GET /v1/audit/export.csv — streaming CSV (org_admin or compliance_admin)
  if (pathname === '/v1/audit/export.csv' && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem2 = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem2) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'audit', action: 'export' }, {
        userRoles: effectiveRoles(callerMem2),
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    const orgId = current.session.orgId;
    const filters = {
      organizationId: orgId,
      userId: url.searchParams.get('user_id') || undefined,
      action: url.searchParams.get('action') || undefined,
      eventType: url.searchParams.get('event_type') || undefined,
      from: url.searchParams.get('from') ? new Date(url.searchParams.get('from')) : undefined,
      to: url.searchParams.get('to') ? new Date(url.searchParams.get('to')) : undefined,
    };
    const safeDate = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${orgId}-${safeDate}.csv"`);
    res.writeHead(200);
    res.write([
      'id', 'created_at', 'org_id', 'user_id', 'actor_type', 'event_type',
      'event_category', 'action', 'resource_type', 'resource_id',
      'ip_address', 'user_agent', 'metadata_json', 'request_id'
    ].join(',') + '\n');

    const esc = v => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    let cursor = null;
    const where = {
      organizationId: orgId,
      userId: filters.userId,
      action: filters.action,
      eventType: filters.eventType,
      createdAt: (filters.from || filters.to)
        ? { gte: filters.from, lte: filters.to }
        : undefined,
    };
    try {
      while (true) {
        const batch = await prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (batch.length === 0) break;
        for (const r of batch) {
          res.write([
            r.id,
            r.createdAt?.toISOString?.() || '',
            r.organizationId || '',
            r.userId || '',
            r.actorType || '',
            r.eventType || '',
            r.eventCategory || '',
            r.action || '',
            r.resourceType || '',
            r.resourceId || '',
            r.ipAddress || '',
            esc(r.userAgent || ''),
            esc(r.metadata || {}),
            r.requestId || '',
          ].map(esc).join(',') + '\n');
        }
        if (batch.length < 500) break;
        cursor = batch[batch.length - 1].id;
      }
    } catch (err) {
      console.error('[audit-export] failed:', err.message);
    }
    res.end();
    return;
  }

  // ── DSR: data export for a user (GDPR right to portability) ──
  // GET /v1/dsr/user/:userId/export — JSON dump of memories + audit
  const dsrExportMatch = pathname.match(/^\/v1\/dsr\/user\/([0-9a-f-]{36})\/export$/);
  if (dsrExportMatch && req.method === 'GET') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetUserId = dsrExportMatch[1];
    const isSelf = targetUserId === current.session.userId;
    const orgId = current.session.orgId;
    if (!isSelf) {
      const admin = await requireOrgAdmin(req, res, current.session.userId, orgId);
      if (!admin) return;
    }
    try {
      const [memories, auditRows] = await Promise.all([
        prisma.memory.findMany({
          where: { userId: targetUserId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 10000,
        }),
        prisma.auditLog.findMany({
          where: { userId: targetUserId },
          orderBy: { createdAt: 'asc' },
          take: 5000,
        }),
      ]);
      audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'dsr.export', eventCategory: 'compliance', action: 'export',
        resourceType: 'user', resourceId: targetUserId,
        metadata: { target_user_id: targetUserId, memories_count: memories.length },
        ..._reqMeta(req),
      });
      return jsonResponse(res, {
        user_id: targetUserId,
        exported_at: new Date().toISOString(),
        memories,
        audit_logs: auditRows,
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }

  // POST /v1/dsr/user/:userId/erasure — soft-delete user memories
  const dsrErasureMatch = pathname.match(/^\/v1\/dsr\/user\/([0-9a-f-]{36})\/erasure$/);
  if (dsrErasureMatch && req.method === 'POST') {
    const current = await requireSession(req, res);
    if (!current) return;
    const targetUserId = dsrErasureMatch[1];
    const orgId = current.session.orgId;
    const admin = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!admin) return;
    try {
      const result = await prisma.memory.updateMany({
        where: { userId: targetUserId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      audit({
        organizationId: orgId, userId: current.session.userId,
        eventType: 'dsr.erasure', eventCategory: 'compliance', action: 'delete',
        resourceType: 'user', resourceId: targetUserId,
        metadata: { target_user_id: targetUserId, memories_soft_deleted: result.count },
        ..._reqMeta(req),
      });
      return jsonResponse(res, {
        target_user_id: targetUserId,
        memories_soft_deleted: result.count,
        retention_days: 30,
        note: 'Soft-deleted; permanent purge after 30 days via retention cron.',
      });
    } catch (err) {
      return jsonResponse(res, { error: err.message }, 500);
    }
  }
  // ─── End Audit + DSR ─────────────────────────────────────

  // ─── Billing (placeholder, org_owner only) ────────────────
  if (pathname.startsWith('/v1/billing') && (req.method === 'GET' || req.method === 'POST' || req.method === 'PATCH')) {
    const current = await requireSession(req, res);
    if (!current) return;
    const callerMem = await getOrgMembership(current.session.userId, current.session.orgId);
    if (!callerMem) return jsonResponse(res, { error: 'Organization membership not found' }, 404);
    const action = req.method === 'GET' ? 'read' : 'manage';
    try {
      const auditLogger = await _getAuditLogger();
      assertPermission(req, { resource: 'billing', action }, {
        userRoles: effectiveRoles(callerMem),
        orgId: current.session.orgId,
        userId: current.session.userId,
        auditLogger,
      });
    } catch (permErr) {
      return jsonResponse(res, { error: permErr.error || 'Forbidden' }, permErr.status || 403);
    }
    // Billing integration (Stripe etc.) is out of scope for P0-4; return 501
    return jsonResponse(res, { error: 'Billing integration not yet available' }, 501);
  }
  // ─── End Billing ──────────────────────────────────────────

  // POST /v1/connectors/slack/events — Slack Events API webhook
  // Public endpoint (no session). Auth via HMAC signature over raw body.
  // Handles url_verification handshake + message/reaction/pin events.
  if (pathname === '/v1/connectors/slack/events' && req.method === 'POST') {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      console.error('[slack-events] SLACK_SIGNING_SECRET not configured');
      return jsonResponse(res, { error: 'webhook not configured' }, 503);
    }

    // Read raw body for HMAC; reject if too large
    const chunks = [];
    let totalLen = 0;
    const MAX_BODY = 1_000_000; // 1MB
    for await (const chunk of req) {
      totalLen += chunk.length;
      if (totalLen > MAX_BODY) {
        return jsonResponse(res, { error: 'body too large' }, 413);
      }
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');

    // Verify signature: v0=hex(hmac-sha256(secret, "v0:" + ts + ":" + body))
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (!ts || !sig) {
      return jsonResponse(res, { error: 'missing signature headers' }, 400);
    }
    const skewSec = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10));
    if (Number.isNaN(skewSec) || skewSec > 300) {
      return jsonResponse(res, { error: 'stale timestamp' }, 400);
    }
    const crypto = await import('node:crypto');
    const base = `v0:${ts}:${rawBody}`;
    const expected = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
    let sigOk = false;
    try {
      sigOk = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(String(sig), 'utf8'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return jsonResponse(res, { error: 'bad signature' }, 401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(res, { error: 'invalid json' }, 400);
    }

    // 1. URL verification handshake (Slack one-time when subscribing)
    if (payload.type === 'url_verification') {
      return jsonResponse(res, { challenge: payload.challenge });
    }

    // 2. Event callback — ack 200 fast, ingest async
    if (payload.type === 'event_callback') {
      const teamId = payload.team_id;
      const event = payload.event || {};

      // Respond 200 within 3s (Slack retry policy)
      jsonResponse(res, { ok: true });

      // Background ingest (fire-and-forget)
      setImmediate(async () => {
        try {
          if (!connectorStore || !prisma) return;
          // Resolve connector by team_id (multi-tenant fanout)
          const conn = await prisma.platformIntegration.findFirst({
            where: {
              platformType: 'slack',
              isActive: true,
              connectorMetadata: { path: ['provider_metadata', 'team_id'], equals: teamId },
            },
          });
          if (!conn) {
            console.warn(`[slack-events] no connector for team_id=${teamId}`);
            return;
          }

          // Forward to core for ingestion (master-key authed)
          const apiKey = process.env.HIVEMIND_MASTER_API_KEY;
          if (!apiKey) {
            console.error('[slack-events] HIVEMIND_MASTER_API_KEY missing — cannot ingest');
            return;
          }
          await fetch(`${CONFIG.coreApiBaseUrl}/api/connectors/slack/event-ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({
              user_id: conn.userId,
              org_id: conn.orgId || null,
              team_id: teamId,
              event,
              event_type: event.type,
              event_subtype: event.subtype || null,
              event_ts: event.event_ts || event.ts || null,
            }),
          });
        } catch (err) {
          console.error('[slack-events] ingest dispatch failed:', err.message);
        }
      });
      return;
    }

    // Unknown payload type — ack so Slack stops retrying
    return jsonResponse(res, { ok: true });
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

  // ─── SCIM 2.0 endpoints (/scim/v2/*) ──────────────────────────
  if (pathname.startsWith('/scim/v2/')) {
    const auditLoggerForScim = await _getAuditLogger();
    const handled = await handleScimRequest(req, res, prisma, pathname, auditLoggerForScim, CONFIG.publicBaseUrl);
    if (handled) return;
  }

  // ─── /v1/auth/sso-redirect — IdP-initiated login redirect ─────
  // GET /v1/auth/sso-redirect?org=<subdomain>
  // Returns Zitadel auth URL for the org's project, else falls back to default.
  if (pathname === '/v1/auth/sso-redirect' && req.method === 'GET') {
    const slug = url.searchParams.get('org') || '';
    const returnTo = url.searchParams.get('return_to') || CONFIG.postLoginRedirect;

    let projectId = null;
    if (slug && prisma) {
      const cfg = await resolveSsoConfig(prisma, slug);
      if (cfg && cfg.enabled && cfg.zitadelProjectId) {
        projectId = cfg.zitadelProjectId;
      }
    }

    if (!zitadelClient) {
      return jsonResponse(res, { error: 'ZITADEL not configured' }, 503);
    }

    const state = await sessionStore.createAuthState({ returnTo });
    // zitadelClient.buildAuthorizeUrl supports optional projectId via extra param
    const authUrl = zitadelClient.buildAuthorizeUrl(state, {
      ...(projectId ? { resource: projectId } : {}),
    });

    return jsonResponse(res, { auth_url: authUrl, org: slug || null });
  }

  // ─── /v1/orgs/:id/sso — SSO config CRUD ──────────────────────
  const ssoConfigMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/sso$/);
  if (ssoConfigMatch) {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = ssoConfigMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    if (req.method === 'GET') {
      const cfg = await prisma.orgSsoConfig.findUnique({ where: { orgId } });
      if (!cfg) {
        return jsonResponse(res, { sso_config: null });
      }
      return jsonResponse(res, {
        sso_config: {
          org_id: cfg.orgId,
          sso_type: cfg.ssoType,
          zitadel_project_id: cfg.zitadelProjectId,
          saml_idp_metadata_url: cfg.samlIdpMetadataUrl,
          saml_acs_url: cfg.samlAcsUrl,
          subdomain: cfg.subdomain,
          enabled: cfg.enabled,
          jit_provisioning: cfg.jitProvisioning,
          default_role: cfg.defaultRole,
          default_team_id: cfg.defaultTeamId,
          has_scim_token: Boolean(cfg.scimTokenHash),
          scim_token_id: cfg.scimTokenId,
          created_at: cfg.createdAt,
          updated_at: cfg.updatedAt,
          // Derived ACS URL for customer to paste into Okta/Azure AD
          acs_url: cfg.subdomain
            ? `https://${cfg.subdomain}.hivemind.davinciai.eu/saml/acs`
            : null,
        },
      });
    }

    if (req.method === 'PUT') {
      const body = await parseBody(req);
      const data = {};
      if (typeof body.sso_type === 'string') data.ssoType = body.sso_type;
      if (typeof body.zitadel_project_id === 'string') data.zitadelProjectId = body.zitadel_project_id || null;
      if (typeof body.saml_idp_metadata_url === 'string') data.samlIdpMetadataUrl = body.saml_idp_metadata_url || null;
      if (typeof body.subdomain === 'string') {
        const sub = body.subdomain.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        data.subdomain = sub || null;
        data.samlAcsUrl = sub ? `https://${sub}.hivemind.davinciai.eu/saml/acs` : null;
      }
      if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
      if (typeof body.jit_provisioning === 'boolean') data.jitProvisioning = body.jit_provisioning;
      if (typeof body.default_role === 'string') data.defaultRole = body.default_role || 'member';
      if (typeof body.default_team_id === 'string') data.defaultTeamId = body.default_team_id || null;

      const cfg = await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, ...data },
        update: data,
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.config_changed',
        eventCategory: 'security',
        action: 'update',
        resourceType: 'sso_config',
        newValue: data,
        ..._reqMeta(req),
      });

      return jsonResponse(res, {
        success: true,
        sso_config: {
          org_id: cfg.orgId,
          sso_type: cfg.ssoType,
          subdomain: cfg.subdomain,
          enabled: cfg.enabled,
          has_scim_token: Boolean(cfg.scimTokenHash),
          acs_url: cfg.subdomain ? `https://${cfg.subdomain}.hivemind.davinciai.eu/saml/acs` : null,
        },
      });
    }

    return jsonResponse(res, { error: 'Method not allowed' }, 405);
  }

  // ─── POST /v1/orgs/:id/sso/scim-token — generate SCIM token ──
  const scimTokenGenMatch = pathname.match(/^\/v1\/orgs\/([^/]+)\/sso\/scim-token$/);
  if (scimTokenGenMatch) {
    if (!prisma) return jsonResponse(res, { error: 'Database unavailable' }, 503);
    const current = await requireSession(req, res);
    if (!current) return;
    const orgId = scimTokenGenMatch[1];
    const membership = await requireOrgAdmin(req, res, current.session.userId, orgId);
    if (!membership) return;

    if (req.method === 'POST') {
      // Generate token: scim_<32-byte hex>
      const rawToken = `scim_${crypto.randomBytes(32).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenId = crypto.randomUUID().slice(0, 8);

      await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, scimTokenHash: tokenHash, scimTokenId: tokenId },
        update: { scimTokenHash: tokenHash, scimTokenId: tokenId },
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.scim_token_generated',
        eventCategory: 'security',
        action: 'create',
        resourceType: 'scim_token',
        newValue: { token_id: tokenId },
        ..._reqMeta(req),
      });

      return jsonResponse(res, {
        success: true,
        // Returned once — caller must save this immediately
        scim_token: rawToken,
        token_id: tokenId,
        warning: 'Save this token now — it will not be shown again.',
      }, 201);
    }

    if (req.method === 'DELETE') {
      await prisma.orgSsoConfig.upsert({
        where: { orgId },
        create: { orgId, scimTokenHash: null, scimTokenId: null },
        update: { scimTokenHash: null, scimTokenId: null },
      });

      audit({
        organizationId: orgId,
        userId: current.session.userId,
        eventType: 'sso.scim_token_revoked',
        eventCategory: 'security',
        action: 'delete',
        resourceType: 'scim_token',
        ..._reqMeta(req),
      });

      return jsonResponse(res, { success: true });
    }

    return jsonResponse(res, { error: 'Method not allowed' }, 405);
  }

  // ─── JIT Provisioning hook (called after /auth/callback) ──────
  // This is integrated inline in the Zitadel callback handler above.
  // The _jitProvision helper is called at the bottom of /auth/callback.
  // Defined here as a module-level helper for reuse.

  return jsonResponse(res, { error: 'Not found' }, 404);
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`[control-plane] listening on ${CONFIG.port}`);
});
