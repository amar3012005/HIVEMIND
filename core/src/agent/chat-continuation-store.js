import crypto from 'node:crypto';
import Redis from 'ioredis';

const local = new Map();
let redisPromise = null;
const TTL_SECONDS = Math.max(60, Number(process.env.CHAT_CONTINUATION_TTL_SECONDS || 15 * 60));
const LEASE_SECONDS = Math.max(15, Number(process.env.CHAT_CONTINUATION_LEASE_SECONDS || 2 * 60));

async function redis() {
  if (redisPromise) return redisPromise;
  const url = process.env.REDIS_URL || process.env.HIVEMIND_OAUTH_REDIS_URL || null;
  const host = process.env.REDIS_HOST || null;
  if (!url && !host) return null;
  redisPromise = (async () => {
    const client = url
      ? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1500 })
      : new Redis({
          host, port: Number(process.env.REDIS_PORT || 6379),
          password: process.env.REDIS_PASSWORD || undefined,
          lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1500,
        });
    client.on('error', () => {});
    await client.connect();
    await client.ping();
    return client;
  })().catch(() => null);
  return redisPromise;
}

function key(token) {
  return `chat:continuation:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function pruneLocal() {
  const now = Date.now();
  for (const [k, value] of local) if (value.expiresAt <= now) local.delete(k);
}

export async function createChatContinuation(payload, { prisma = null, durable = false, parentTurnId = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const record = { ...payload, createdAt: Date.now(), expiresAt: Date.now() + TTL_SECONDS * 1000 };
  if (durable && prisma?.durableChatContinuation) {
    await prisma.durableChatContinuation.create({
      data: {
        tokenHash: tokenHash(token), parentTurnId,
        orgId: payload.orgId, userId: payload.userId,
        payload: record, expiresAt: new Date(record.expiresAt),
      },
    });
    return { token, expires_at: new Date(record.expiresAt).toISOString(), durable: true };
  }
  const client = await redis();
  if (client) await client.set(key(token), JSON.stringify(record), 'EX', TTL_SECONDS);
  else { pruneLocal(); local.set(key(token), record); }
  return { token, expires_at: new Date(record.expiresAt).toISOString() };
}

/**
 * Claim a durable continuation without consuming it. A failed Core process can
 * retry after lease expiry; successful execution explicitly settles the claim.
 */
export async function claimDurableChatContinuation(token, { prisma, userId, orgId }) {
  if (!token || typeof token !== 'string' || !prisma?.durableChatContinuation) return null;
  const hash = tokenHash(token);
  const leaseToken = crypto.randomUUID();
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const claimed = await prisma.$transaction(async (tx) => {
    const updated = await tx.durableChatContinuation.updateMany({
      where: {
        tokenHash: hash, orgId, userId, expiresAt: { gt: now }, consumedAt: null,
        OR: [
          { status: 'pending' },
          { status: 'claimed', leaseExpiresAt: { lt: now } },
        ],
      },
      data: { status: 'claimed', leaseToken, leaseExpiresAt, updatedAt: now },
    });
    if (updated.count !== 1) return null;
    return tx.durableChatContinuation.findUnique({ where: { tokenHash: hash } });
  });
  if (!claimed) return null;
  return { record: claimed.payload, continuationId: claimed.id, leaseToken };
}

export async function settleDurableChatContinuation({ prisma, continuationId, leaseToken }) {
  if (!prisma?.durableChatContinuation || !continuationId || !leaseToken) return false;
  const result = await prisma.durableChatContinuation.updateMany({
    where: { id: continuationId, leaseToken, status: 'claimed', consumedAt: null },
    data: { status: 'consumed', consumedAt: new Date(), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() },
  });
  return result.count === 1;
}

export async function releaseDurableChatContinuation({ prisma, continuationId, leaseToken }) {
  if (!prisma?.durableChatContinuation || !continuationId || !leaseToken) return false;
  const result = await prisma.durableChatContinuation.updateMany({
    where: { id: continuationId, leaseToken, status: 'claimed', consumedAt: null },
    data: { status: 'pending', leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() },
  });
  return result.count === 1;
}

export async function consumeChatContinuation(token, { userId, orgId }) {
  if (!token || typeof token !== 'string') return null;
  const storageKey = key(token);
  const client = await redis();
  let record = null;
  if (client) {
    const raw = await client.get(storageKey);
    if (raw) { await client.del(storageKey); record = JSON.parse(raw); }
  } else {
    pruneLocal(); record = local.get(storageKey) || null; local.delete(storageKey);
  }
  if (!record || record.expiresAt <= Date.now()) return null;
  if (record.userId !== userId || record.orgId !== orgId) return null;
  return record;
}
