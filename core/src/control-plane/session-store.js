import crypto from 'crypto';

const sessions = new Map();
const states = new Map();
let redisClientPromise = null;
let redisRetryAfter = 0;
const REDIS_RETRY_BACKOFF_MS = 1000;

function buildRedisConfig(config) {
  if (config.redisUrl) {
    return [config.redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000
    }];
  }

  if (!config.redisHost) {
    return null;
  }

  return [{
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword || undefined,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000
  }];
}

async function loadRedis() {
  const mod = await import('ioredis');
  return mod.default;
}

export async function getRedisClient(config) {
  if (!redisClientPromise && Date.now() < redisRetryAfter) {
    return null;
  }

  const redisConfig = buildRedisConfig(config);
  if (!redisConfig) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const Redis = await loadRedis();
      // ioredis auto-connects on construction. Calling .connect() again
      // throws "Redis is already connecting/connected" → catch below
      // would null the promise and every subsequent getSession() would
      // return null silently. Use lazyConnect so .connect() is the FIRST
      // connection attempt and behaves correctly.
      const baseOpts = { lazyConnect: true };
      const client = Array.isArray(redisConfig)
        ? (typeof redisConfig[0] === 'string'
            ? new Redis(redisConfig[0], { ...redisConfig[1], ...baseOpts })
            : new Redis({ ...redisConfig[0], ...baseOpts }))
        : new Redis({ ...redisConfig, ...baseOpts });

      client.on('error', () => {});
      await client.connect();
      await client.ping();
      redisRetryAfter = 0;
      return client;
    })().catch((err) => {
      // Log so silent failures show up in observability instead of just
      // returning null from every subsequent session lookup.
      try { console.warn('[session-store] Redis init failed:', err?.message || err); } catch {}
      redisClientPromise = null;
      redisRetryAfter = Date.now() + REDIS_RETRY_BACKOFF_MS;
      return null;
    });
  }

  return redisClientPromise;
}

function signSessionId(secret, sessionId) {
  return crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
}

function memorySessionKey(sessionId) {
  return `session:${sessionId}`;
}

function memoryStateKey(stateId) {
  return `state:${stateId}`;
}

export function buildSessionCookie(secret, sessionId) {
  return `${sessionId}.${signSessionId(secret, sessionId)}`;
}

export function verifySessionCookie(secret, cookieValue) {
  if (!cookieValue || !cookieValue.includes('.')) {
    return null;
  }

  const [sessionId, signature] = cookieValue.split('.');
  if (!sessionId || !signature) {
    return null;
  }

  const expected = signSessionId(secret, sessionId);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  const matches = crypto.timingSafeEqual(sigBuf, expBuf);
  return matches ? sessionId : null;
}

export class ControlPlaneSessionStore {
  constructor(config) {
    this.config = config;
  }

  async createSession(payload) {
    const sessionId = crypto.randomUUID();
    const record = {
      ...payload,
      createdAt: new Date().toISOString()
    };
    const redis = await getRedisClient(this.config);
    if (redis) {
      await redis.set(`cp:${memorySessionKey(sessionId)}`, JSON.stringify(record), 'EX', this.config.sessionTtlSeconds);
    } else {
      sessions.set(memorySessionKey(sessionId), record);
    }
    return sessionId;
  }

  async getSession(sessionId) {
    if (!sessionId) return null;
    const redis = await getRedisClient(this.config);
    if (redis) {
      const raw = await redis.get(`cp:${memorySessionKey(sessionId)}`);
      return raw ? JSON.parse(raw) : null;
    }
    return sessions.get(memorySessionKey(sessionId)) || null;
  }

  async destroySession(sessionId) {
    const redis = await getRedisClient(this.config);
    if (redis) {
      await redis.del(`cp:${memorySessionKey(sessionId)}`);
    } else {
      sessions.delete(memorySessionKey(sessionId));
    }
  }

  async createAuthState(payload) {
    const stateId = crypto.randomUUID();
    const redis = await getRedisClient(this.config);
    if (redis) {
      await redis.set(`cp:${memoryStateKey(stateId)}`, JSON.stringify(payload), 'EX', this.config.authStateTtlSeconds);
    } else {
      states.set(memoryStateKey(stateId), payload);
    }
    return stateId;
  }

  async consumeAuthState(stateId) {
    const redis = await getRedisClient(this.config);
    if (redis) {
      const key = `cp:${memoryStateKey(stateId)}`;
      const raw = await redis.get(key);
      if (!raw) return null;
      await redis.del(key);
      return JSON.parse(raw);
    }

    const key = memoryStateKey(stateId);
    const payload = states.get(key) || null;
    states.delete(key);
    return payload;
  }
}
