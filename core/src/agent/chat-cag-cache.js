import { createHash } from 'node:crypto';
import Redis from 'ioredis';

const DEFAULT_TTL_MS = 120_000;
const MAX_ENTRIES = 250;
const REDIS_VALUE_MAX_CHARS = 1_000_000;

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function buildProjectionCacheKey({ orgId, userId, projectIds = [], scope, query, budget, memories = [] } = {}) {
  const payload = {
    v: 1,
    orgId: String(orgId || ''),
    userId: String(userId || ''),
    projectIds: [...projectIds].map(String).sort(),
    scope: String(scope || ''),
    query: String(query || '').normalize('NFKC').toLocaleLowerCase(),
    budget: Number(budget) || 0,
    memories: memories.map((memory) => ({ id: String(memory?.id || ''), content: digest(memory?.content) })),
  };
  return `hm:chat:cag:projection:${digest(JSON.stringify(payload))}`;
}

export class ChatProjectionCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = MAX_ENTRIES, redisClient = null } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.redisClient = redisClient;
    this.entries = new Map();
  }

  _setLocal(key, value) {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { expiresAt: Date.now() + this.ttlMs, value: structuredClone(value) });
  }

  async get(key) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now()) return structuredClone(entry.value);
    if (entry) {
      this.entries.delete(key);
    }
    if (!this.redisClient) return null;
    try {
      const raw = await this.redisClient.get(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      // Projection results are arrays only. Do not let an unexpected shared
      // cache value enter the evidence pipeline.
      if (!Array.isArray(value)) return null;
      this._setLocal(key, value);
      return structuredClone(value);
    } catch {
      return null;
    }
  }

  async set(key, value) {
    this._setLocal(key, value);
    if (!this.redisClient) return;
    try {
      const encoded = JSON.stringify(value);
      if (encoded.length <= REDIS_VALUE_MAX_CHARS) {
        await this.redisClient.set(key, encoded, 'EX', Math.max(1, Math.ceil(this.ttlMs / 1000)));
      }
    } catch {
      // The local tier is intentionally sufficient during a Redis blip.
    }
  }
}

let sharedCache;
let sharedRedis;
let redisInitTried = false;

async function getRedisClient() {
  if (sharedRedis) return sharedRedis;
  if (redisInitTried) return null;
  redisInitTried = true;
  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;
  if (!url && !host) return null;
  try {
    const client = url
      ? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
      : new Redis({
          host,
          port: Number(process.env.REDIS_PORT || 6379),
          password: process.env.REDIS_PASSWORD || undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
    client.on('error', () => {});
    await client.connect();
    await client.ping();
    sharedRedis = client;
    return client;
  } catch {
    return null;
  }
}

export function getSharedChatProjectionCache() {
  if (!sharedCache) {
    // Do not make a chat turn wait for Redis availability. The cache starts
    // local-only and is upgraded asynchronously when Redis is configured.
    sharedCache = new ChatProjectionCache();
    void getRedisClient().then((client) => { if (client) sharedCache.redisClient = client; });
  }
  return sharedCache;
}
