import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { nativeSessionHash } from './native-principal.js';
import { getRedisClient } from '../control-plane/session-store.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = () => randomBytes(32).toString('base64url');
// Compare bound fields before deleting. A failed proof must not burn another user's grant.
const CONSUME = `local raw=redis.call('GET',KEYS[1]); if not raw then return false end
local rec=cjson.decode(raw); local expected=cjson.decode(ARGV[1]);
for k,v in pairs(expected) do if rec[k]~=v then return false end end
if tonumber(rec.expiresAt)<=tonumber(ARGV[2]) then redis.call('DEL',KEYS[1]); return false end
redis.call('DEL',KEYS[1]); return raw`;
export class MobileAuthStore {
  constructor(config, { redis = () => getRedisClient(config), now = Date.now } = {}) { this.redis = redis; this.now = now; }
  async client() { const client = await this.redis(); if (!client) throw Object.assign(new Error('Native authentication storage unavailable'), { status: 503 }); return client; }
  key(kind, token) { return `cp:mobile-auth:${kind}:${hash(token)}`; }
  async put(kind, payload, seconds) {
    const token = id(); const client = await this.client();
    const saved = await client.set(this.key(kind, token), JSON.stringify({ ...payload, expiresAt: this.now() + seconds * 1000 }), 'EX', seconds, 'NX');
    if (saved !== 'OK') throw Object.assign(new Error('Native authentication grant not saved'), { status: 503 });
    return token;
  }
  async get(kind, token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const raw = await (await this.client()).get(this.key(kind, token));
    const record = raw ? JSON.parse(raw) : null;
    return record?.expiresAt > this.now() ? record : null;
  }
  async bindUser(token, userId) {
    const raw = await (await this.client()).eval(`local raw=redis.call('GET',KEYS[1]); if not raw then return false end
local rec=cjson.decode(raw); if rec.browserUserId and rec.browserUserId~=ARGV[1] then return false end
local ttl=redis.call('PTTL',KEYS[1]); if ttl<=0 then return false end
rec.browserUserId=ARGV[1];local bound=cjson.encode(rec);redis.call('SET',KEYS[1],bound,'PX',ttl);return bound`, 1, this.key('intent', token), userId);
    return raw ? JSON.parse(raw) : null;
  }
  async createNativeSession(payload) {
    const token = randomUUID();
    const redis = await this.client();
    await redis.set(`cp:session:${token}`, JSON.stringify({ ...payload, nativeMobile: true, createdAt: new Date(this.now()).toISOString() }), 'EX', 3600);
    await redis.set(`cp:mobile-native-index:${nativeSessionHash(token)}`, token, 'EX', 3600);
    return token;
  }
  async consume(kind, token, expected) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const raw = await (await this.client()).eval(CONSUME, 1, this.key(kind, token), JSON.stringify(expected), String(this.now()));
    return raw ? JSON.parse(raw) : null;
  }
}
