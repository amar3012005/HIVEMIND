import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { verifyOpenDotRuntimeBridgeAuthorization } from './open-dot-runtime-employee-operation.js';

/**
 * Authentication for Open Dot's model fallback relay
 * (`POST /internal/v1/harness-chat/core/open-dot/model/stream`).
 *
 * Open Dot signs each request with `OPEN_DOT_MODEL_RELAY_SECRET` (HMAC-SHA256,
 * at least 32 bytes). The signed string binds the method, the fixed relay path,
 * a Unix-seconds timestamp, a single-use nonce and the SHA-256 of the exact
 * request body bytes. Control accepts a timestamp within
 * `OPEN_DOT_MODEL_RELAY_MAX_SKEW_SECONDS` of its clock and rejects a repeated
 * nonce for `OPEN_DOT_MODEL_RELAY_NONCE_TTL_SECONDS`.
 *
 * During rollout Control also accepts the legacy `Authorization: Bearer
 * OPEN_DOT_RUNTIME_BRIDGE_TOKEN`. A request that carries any signature header
 * is verified only as a signed request and never falls back to the bearer.
 */
export const OPEN_DOT_MODEL_RELAY_PATH = '/internal/v1/harness-chat/core/open-dot/model/stream';
export const OPEN_DOT_MODEL_RELAY_SIGNATURE_VERSION = 'hivemind-open-dot-model-relay.v1';
export const OPEN_DOT_MODEL_RELAY_HEADERS = Object.freeze({
  timestamp: 'x-hivemind-relay-timestamp',
  nonce: 'x-hivemind-relay-nonce',
  signature: 'x-hivemind-relay-signature',
});
export const OPEN_DOT_MODEL_RELAY_MAX_SKEW_SECONDS = 300;
export const OPEN_DOT_MODEL_RELAY_NONCE_TTL_SECONDS = 2 * OPEN_DOT_MODEL_RELAY_MAX_SKEW_SECONDS;

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/;
const MEMORY_NONCE_LIMIT = 10_000;
const memoryNonces = new Map();

/**
 * Builds the exact string Open Dot signs.
 * @param {{ method: string, timestamp: string, nonce: string, body: Buffer|string }} input
 * @returns {string} newline-joined signing input
 */
export function openDotModelRelaySigningInput({ method, timestamp, nonce, body }) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return [OPEN_DOT_MODEL_RELAY_SIGNATURE_VERSION, String(method).toUpperCase(), OPEN_DOT_MODEL_RELAY_PATH,
    timestamp, nonce, bodyHash].join('\n');
}

/**
 * Computes the `x-hivemind-relay-signature` value for a request.
 * @param {string} secret relay secret, at least 32 bytes
 * @param {{ method: string, timestamp: string, nonce: string, body: Buffer|string }} input
 * @returns {string} `v1=<hex HMAC-SHA256>`
 */
export function signOpenDotModelRelayRequest(secret, input) {
  return `v1=${createHmac('sha256', secret).update(openDotModelRelaySigningInput(input)).digest('hex')}`;
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? undefined : value;
}

function claimMemoryNonce(nonce, nowMs) {
  for (const [key, expiresAt] of memoryNonces) {
    if (expiresAt > nowMs && memoryNonces.size < MEMORY_NONCE_LIMIT) break;
    memoryNonces.delete(key);
  }
  if ((memoryNonces.get(nonce) ?? 0) > nowMs) return false;
  memoryNonces.set(nonce, nowMs + OPEN_DOT_MODEL_RELAY_NONCE_TTL_SECONDS * 1000);
  return true;
}

async function claimNonce(loadRedis, nonce, nowMs) {
  // Redis makes the nonce single-use across Control replicas. Without Redis the
  // single Control process keeps a bounded in-memory window.
  const redis = await loadRedis();
  if (redis?.set) {
    const stored = await redis.set(`open-dot-model-relay:nonce:${nonce}`, '1', 'EX',
      OPEN_DOT_MODEL_RELAY_NONCE_TTL_SECONDS, 'NX');
    return stored === 'OK';
  }
  return claimMemoryNonce(nonce, nowMs);
}

/**
 * Verifies an Open Dot model relay request.
 * @param {{ headers: Record<string, string|string[]|undefined>, method: string, body: Buffer,
 *   env: Record<string, string|undefined>, loadRedis?: () => Promise<{ set: Function } | null>, nowMs?: number }} input
 *   `loadRedis` runs only for a signed request whose signature is valid.
 * @returns {Promise<{ ok: true, scheme: 'hmac'|'legacy-bearer' } | { ok: false, reason: string }>}
 */
export async function verifyOpenDotModelRelayRequest({ headers, method, body, env, loadRedis = async () => null, nowMs = Date.now() }) {
  const timestamp = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.timestamp);
  const nonce = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.nonce);
  const signature = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.signature);
  const signed = [OPEN_DOT_MODEL_RELAY_HEADERS.timestamp, OPEN_DOT_MODEL_RELAY_HEADERS.nonce,
    OPEN_DOT_MODEL_RELAY_HEADERS.signature].some(name => headers?.[name] !== undefined);
  if (!signed) {
    return verifyOpenDotRuntimeBridgeAuthorization(headers?.authorization, env.OPEN_DOT_RUNTIME_BRIDGE_TOKEN)
      ? { ok: true, scheme: 'legacy-bearer' } : { ok: false, reason: 'unauthorized' };
  }
  const secret = env.OPEN_DOT_MODEL_RELAY_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) return { ok: false, reason: 'relay_secret_unconfigured' };
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > OPEN_DOT_MODEL_RELAY_MAX_SKEW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'invalid_nonce' };
  const presented = typeof signature === 'string' ? SIGNATURE_RE.exec(signature) : null;
  if (!presented) return { ok: false, reason: 'invalid_signature' };
  const expected = createHmac('sha256', secret)
    .update(openDotModelRelaySigningInput({ method, timestamp, nonce, body })).digest();
  if (!timingSafeEqual(Buffer.from(presented[1], 'hex'), expected)) return { ok: false, reason: 'invalid_signature' };
  if (!await claimNonce(loadRedis, nonce, nowMs)) return { ok: false, reason: 'replayed_nonce' };
  return { ok: true, scheme: 'hmac' };
}
