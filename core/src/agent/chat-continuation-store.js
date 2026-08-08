import crypto from 'node:crypto';
import Redis from 'ioredis';

const local = new Map();
let redisPromise = null;
const TTL_SECONDS = Math.max(60, Number(process.env.CHAT_CONTINUATION_TTL_SECONDS || 15 * 60));

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

function pruneLocal() {
  const now = Date.now();
  for (const [k, value] of local) if (value.expiresAt <= now) local.delete(k);
}

export async function createChatContinuation(payload) {
  const token = crypto.randomBytes(32).toString('base64url');
  const record = { ...payload, createdAt: Date.now(), expiresAt: Date.now() + TTL_SECONDS * 1000 };
  const client = await redis();
  if (client) await client.set(key(token), JSON.stringify(record), 'EX', TTL_SECONDS);
  else { pruneLocal(); local.set(key(token), record); }
  return { token, expires_at: new Date(record.expiresAt).toISOString() };
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
