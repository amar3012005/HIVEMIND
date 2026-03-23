import crypto from 'crypto';

export const ENTITLEMENT_SCOPES = [
  'memory:read',
  'memory:write',
  'mcp',
  'web_search',
  'web_crawl',
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
  name,
  description = null,
  scopes = ['memory:read', 'memory:write', 'mcp'],
  expiresAt = null,
  rateLimitPerMinute = 60,
  createdByIp = null,
  userAgent = null
}) {
  if (!prisma) {
    throw new Error('Prisma client unavailable');
  }

  const rawKey = generateRawApiKey();
  const keyPrefix = rawKey.slice(0, 12);
  const keyHash = hashApiKey(rawKey);

  const record = await prisma.apiKey.create({
    data: {
      userId,
      orgId,
      name: name || 'HIVE-MIND API Key',
      keyHash,
      keyPrefix,
      description,
      scopes,
      expiresAt,
      rateLimitPerMinute,
      createdByIp,
      userAgent
    }
  });

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

export async function listPersistedApiKeys(prisma, userId, orgId = null) {
  if (!prisma) {
    return [];
  }

  return prisma.apiKey.findMany({
    where: {
      userId,
      ...(orgId ? { orgId } : {}),
      revokedAt: null
    },
    orderBy: {
      createdAt: 'desc'
    }
  });
}

export async function revokePersistedApiKey(prisma, keyId, userId) {
  if (!prisma) {
    throw new Error('Prisma client unavailable');
  }

  const existing = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      userId,
      revokedAt: null
    }
  });

  if (!existing) {
    return null;
  }

  return prisma.apiKey.update({
    where: { id: keyId },
    data: {
      revokedAt: new Date()
    }
  });
}
