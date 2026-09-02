import crypto from 'crypto';
import { PlatformRegistryClient, registryEventId } from '../control-plane/platform-registry-client.js';

function registryRevision(record) {
  const at = record?.updatedAt || record?.createdAt || new Date();
  return Math.max(1, Math.floor(new Date(at).getTime()));
}

async function mirrorApiKey(record) {
  const client = new PlatformRegistryClient();
  if (!client.enabled) return;
  const event = {
    event_id: registryEventId(), entity_type: 'api_key', entity_id: record.id,
    revision: registryRevision(record), operation: 'upsert',
    payload: {
      user_id: record.userId, org_id: record.orgId, key_hash: record.keyHash,
      key_prefix: record.keyPrefix, expires_at: record.expiresAt?.toISOString?.() || null,
      revoked_at: record.revokedAt?.toISOString?.() || null,
      metadata: { name: record.name, key_kind: record.keyKind, scopes: record.scopes || [], project_id: record.projectId || null, team_id: record.teamId || null, rate_limit_per_minute: record.rateLimitPerMinute || null },
    },
  };
  try {
    await client.mirror(event);
  } catch (error) {
    if (client.mode === 'authoritative') throw error;
    console.warn('[platform-registry] api-key mirror failed', { key_id: record.id, mode: client.mode, error: error.message });
  }
}

export const ENTITLEMENT_SCOPES = [
  'memory:read',
  'memory:write',
  'mcp',
  'web_search',
  'web_research',
  'web_crawl',
  'web_admin',
  'selfhost:bootstrap',
  'selfhost:connect',
];

export function hasEntitlement(principal, entitlement) {
  if (!principal || !Array.isArray(principal.scopes)) return false;
  if (principal.scopes.includes('*')) return true;
  return principal.scopes.includes(entitlement);
}

export function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

export function generateRawApiKey() {
  return `hmk_live_${crypto.randomBytes(24).toString('hex')}`;
}

export async function createPersistedApiKey(prisma, {
  userId,
  orgId = null,
  keyKind = 'personal',
  createdByUserId = userId,
  name,
  description = null,
  scopes = ['memory:read'],
  projectId = null,
  teamId = null,
  expiresAt = null,
  rateLimitPerMinute = 60,
  createdByIp = null,
  userAgent = null
}) {
  if (!prisma) {
    throw new Error('Prisma client unavailable');
  }
  if (!['personal', 'service'].includes(keyKind)) throw new Error('Invalid API key kind');
  const allowedScopes = new Set(ENTITLEMENT_SCOPES);
  const normalizedScopes = [...new Set((Array.isArray(scopes) ? scopes : []).filter((scope) => allowedScopes.has(scope)))];
  if (!normalizedScopes.length) throw new Error('At least one valid API key scope is required');

  const rawKey = generateRawApiKey();
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = hashApiKey(rawKey);

  const record = await prisma.apiKey.create({
    data: {
      userId,
      orgId,
      name: name || 'HIVE-MIND API Key',
      keyKind,
      createdByUserId,
      keyHash,
      keyPrefix,
      description,
      scopes: normalizedScopes,
      projectId,
      teamId,
      expiresAt,
      rateLimitPerMinute,
      createdByIp,
      userAgent
    }
  });

  await mirrorApiKey(record);

  return {
    rawKey,
    record
  };
}

export async function authenticatePersistedApiKey(prisma, apiKey) {
  if (!prisma || !apiKey) {
    return null;
  }

  const keyHash = hashApiKey(apiKey);
  const record = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      user: true,
      organization: true
    }
  });

  if (!record) {
    return null;
  }

  if (record.revokedAt) {
    return null;
  }

  if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  await prisma.apiKey.update({
    where: { id: record.id },
    data: {
      lastUsedAt: new Date(),
      usageCount: {
        increment: 1
      }
    }
  }).catch(() => {});

  return record;
}

export async function listPersistedApiKeys(prisma, userId, orgId = null, { includeServiceKeys = false } = {}) {
  if (!prisma) {
    return [];
  }

  return prisma.apiKey.findMany({
    where: {
      ...(orgId ? { orgId } : {}),
      ...(includeServiceKeys ? { OR: [{ userId }, { keyKind: 'service' }] } : { userId }),
      revokedAt: null
    },
    orderBy: {
      createdAt: 'desc'
    }
  });
}

export async function revokePersistedApiKey(prisma, keyId, userId, { orgId = null, allowServiceKey = false } = {}) {
  if (!prisma) {
    throw new Error('Prisma client unavailable');
  }

  const existing = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      ...(allowServiceKey ? { OR: [{ userId }, { keyKind: 'service', ...(orgId ? { orgId } : {}) }] } : { userId }),
      revokedAt: null
    }
  });

  if (!existing) {
    return null;
  }

  const revoked = await prisma.apiKey.update({
    where: { id: keyId },
    data: {
      revokedAt: new Date()
    }
  });
  await mirrorApiKey(revoked);
  return revoked;
}

/**
 * Resolve live entitlements for an API key by intersecting the key's declared
 * scopes with the principal's current org/team/project memberships.
 *
 * Returns the principal augmented with resolved projectIds, teamIds, and
 * effective scopes.  Callers should use this instead of trusting the key's
 * static scopes alone.
 *
 * @param {object} prisma - Prisma client
 * @param {object} keyRecord - Authenticated API key record from DB
 * @param {object} [accessContext] - Pre-built access context { projectIds, teamIds }
 * @returns {object} Augmented principal
 */
export async function resolveKeyAccess(prisma, keyRecord, accessContext = null) {
  const isServiceKey = keyRecord.keyKind === 'service';
  const principal = {
    keyId: keyRecord.id,
    userId: keyRecord.userId,
    orgId: keyRecord.orgId,
    scopes: keyRecord.scopes || [],
    projectId: keyRecord.projectId || null,
    teamId: keyRecord.teamId || null,
    projectIds: [],
    teamIds: [],
    effectiveScopes: keyRecord.scopes || [],
    isServiceKey,
  };

  // If key is scoped to a specific project/team, use those directly
  if (keyRecord.projectId) {
    principal.projectIds = [keyRecord.projectId];
  }
  if (keyRecord.teamId) {
    principal.teamIds = [keyRecord.teamId];
  }

  // If access context is provided, intersect with live memberships
  if (accessContext && !isServiceKey) {
    // If key has no project scope, inherit all accessible projects
    if (!keyRecord.projectId && !keyRecord.teamId) {
      principal.projectIds = accessContext.projectIds || [];
      principal.teamIds = accessContext.teamIds || [];
    }
  }

  // Organization service keys never inherit the creating member's personal
  // memory visibility. They may operate only on explicit project/team scopes
  // or organization-scoped capability routes guarded by their allow-list.
  if (isServiceKey && !keyRecord.projectId && !keyRecord.teamId) {
    principal.projectIds = [];
    principal.teamIds = [];
  }

  return principal;
}
