import { getRedisClient } from '../control-plane/session-store.js';

const codeFallback = new Map();
const refreshFallback = new Map();

function codeKey(code) {
  return `oauth:code:${code}`;
}

function refreshKey(refreshHash) {
  return `oauth:refresh:${refreshHash}`;
}

function shouldRequireDurable(config) {
  return config.requireDurableInProduction !== false && process.env.NODE_ENV === 'production';
}

export class OAuthStateStore {
  constructor(config = {}) {
    this.config = {
      codeTtlSeconds: config.codeTtlSeconds ?? 5 * 60,
      refreshTtlSeconds: config.refreshTtlSeconds ?? 30 * 24 * 60 * 60,
      ...config,
    };
  }

  async _redis() {
    if (this.config.redisClient) return this.config.redisClient;
    const client = await getRedisClient(this.config);
    if (!client && shouldRequireDurable(this.config)) {
      throw new Error('Redis-backed OAuth state is required in production');
    }
    return client;
  }

  async storeAuthorizationCode(code, payload) {
    const redis = await this._redis();
    if (redis) {
      await redis.set(codeKey(code), JSON.stringify(payload), 'EX', this.config.codeTtlSeconds);
      return;
    }
    codeFallback.set(code, payload);
  }

  async consumeAuthorizationCode(code) {
    const redis = await this._redis();
    if (redis) {
      const key = codeKey(code);
      const raw = typeof redis.getdel === 'function'
        ? await redis.getdel(key)
        : await redis.eval('local value = redis.call("GET", KEYS[1]); if value then redis.call("DEL", KEYS[1]); end; return value', 1, key);
      if (!raw) return null;
      return JSON.parse(raw);
    }
    const value = codeFallback.get(code) || null;
    codeFallback.delete(code);
    return value;
  }

  async storeRefreshTokenRecord(record) {
    const redis = await this._redis();
    if (redis) {
      const ttl = Math.max(1, Math.ceil((new Date(record.expiresAt).getTime() - Date.now()) / 1000));
      await redis.set(refreshKey(record.refreshHash), JSON.stringify(record), 'EX', ttl);
      return;
    }
    refreshFallback.set(record.refreshHash, record);
  }

  async loadRefreshTokenRecord(refreshHash) {
    const redis = await this._redis();
    if (redis) {
      const raw = await redis.get(refreshKey(refreshHash));
      return raw ? JSON.parse(raw) : null;
    }
    return refreshFallback.get(refreshHash) || null;
  }

  async revokeRefreshToken(refreshHash, revokedAt = new Date().toISOString()) {
    const redis = await this._redis();
    if (redis) {
      const key = refreshKey(refreshHash);
      const raw = await redis.get(key);
      if (!raw) return null;
      const record = JSON.parse(raw);
      const next = { ...record, revokedAt };
      const ttl = Math.max(1, Math.ceil((new Date(record.expiresAt).getTime() - Date.now()) / 1000));
      await redis.set(key, JSON.stringify(next), 'EX', ttl);
      return next;
    }
    const current = refreshFallback.get(refreshHash);
    if (!current) return null;
    const next = { ...current, revokedAt };
    refreshFallback.set(refreshHash, next);
    return next;
  }
}
