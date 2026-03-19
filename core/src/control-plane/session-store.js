import crypto from 'crypto';
import Redis from 'ioredis';

const sessions = new Map();
const states = new Map();
let redisClientPromise = null;

function buildRedisConfig(config) {
  if (config.redisUrl) {
    return [config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    }];
  }

  if (!config.redisHost) {
    return null;
  }

  return [{
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  }];
}

async function getRedisClient(config) {
  const redisConfig = buildRedisConfig(config);
  if (!redisConfig) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = Array.isArray(redisConfig)
        ? new Redis(...redisConfig)
        : new Redis(redisConfig);

      client.on('error', () => {});
      if (client.status === 'wait') {
        await client.connect();
      }
      await client.ping();
      return client;
    })().catch(() => {
      redisClientPromise = null;
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
  const matches = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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
