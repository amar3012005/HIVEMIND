import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentication for Open Dot's model fallback relay
 * (`POST /internal/v1/harness-chat/core/open-dot/model/stream`).
 *
 * Open Dot signs each request with `OPEN_DOT_MODEL_RELAY_SECRET` (at least 32
 * bytes) using the HIVEMIND bridge signature wire format that Open Dot's
 * `hivemind-bridge-signature.ts` already implements:
 * `x-hivemind-bridge-signature` is the lowercase hex HMAC-SHA256 of
 * `METHOD\npath\ntimestamp\nnonce\nsha256hex(body)`, `x-hivemind-bridge-timestamp`
 * is Unix seconds and `x-hivemind-bridge-nonce` is a lowercase UUID. Control
 * accepts a timestamp within `OPEN_DOT_MODEL_RELAY_WINDOW_SECONDS` of its clock
 * and rejects a nonce it has already accepted inside that window.
 *
 * Only signed requests are accepted; the shared `OPEN_DOT_RUNTIME_BRIDGE_TOKEN`
 * bearer is not a relay credential.
 */
export const OPEN_DOT_MODEL_RELAY_PATH = '/internal/v1/harness-chat/core/open-dot/model/stream';
export const OPEN_DOT_MODEL_RELAY_HEADERS = Object.freeze({
  signature: 'x-hivemind-bridge-signature',
  timestamp: 'x-hivemind-bridge-timestamp',
  nonce: 'x-hivemind-bridge-nonce',
});
/** Protocol constant shared with Open Dot's bridge signer. */
export const OPEN_DOT_MODEL_RELAY_WINDOW_SECONDS = 60;

const NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{0,11}$/;
const MEMORY_NONCE_CAPACITY = 100_000;
const memoryNonces = new Map();

/**
 * Builds the exact string Open Dot signs.
 * @param {{ method: string, path?: string, timestamp: string, nonce: string, body: Buffer|string }} input
 * @returns {string} newline-joined signing input
 */
export function openDotModelRelaySigningInput({ method, path = OPEN_DOT_MODEL_RELAY_PATH, timestamp, nonce, body }) {
  return [String(method).toUpperCase(), path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
}

/**
 * Computes the `x-hivemind-bridge-signature` value for a relay request.
 * @param {string} secret relay secret, at least 32 bytes
 * @param {{ method: string, path?: string, timestamp: string, nonce: string, body: Buffer|string }} input
 * @returns {string} lowercase hex HMAC-SHA256
 */
export function signOpenDotModelRelayRequest(secret, input) {
  return createHmac('sha256', secret).update(openDotModelRelaySigningInput(input)).digest('hex');
}

function header(headers, name) {
  const value = headers?.[name];
  return typeof value === 'string' ? value : undefined;
}

function claimMemoryNonce(nonce, expiresAtMs, nowMs) {
  const held = memoryNonces.get(nonce);
  if (held !== undefined && held >= nowMs) return 'replayed';
  if (held === undefined && memoryNonces.size >= MEMORY_NONCE_CAPACITY) {
    for (const [key, expiry] of memoryNonces) if (expiry < nowMs) memoryNonces.delete(key);
    // A full memory refuses new signed requests rather than forgetting live nonces.
    if (memoryNonces.size >= MEMORY_NONCE_CAPACITY) return 'full';
  }
  memoryNonces.set(nonce, expiresAtMs);
  return 'claimed';
}

async function claimNonce(loadRedis, nonce, expiresAtMs, nowMs) {
  // Redis makes the nonce single-use across Control replicas. Without Redis the
  // Control process keeps a bounded in-memory window.
  const redis = await loadRedis();
  if (redis?.set) {
    const ttl = Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000));
    return await redis.set(`open-dot-model-relay:nonce:${nonce}`, '1', 'EX', ttl, 'NX') === 'OK' ? 'claimed' : 'replayed';
  }
  return claimMemoryNonce(nonce, expiresAtMs, nowMs);
}

/**
 * Verifies an Open Dot model relay request.
 * @param {{ headers: Record<string, string|string[]|undefined>, method: string, body: Buffer,
 *   env: Record<string, string|undefined>, loadRedis?: () => Promise<{ set: Function } | null>, nowMs?: number }} input
 *   `loadRedis` runs only for a signed request whose signature is valid.
 * @returns {Promise<{ ok: true, scheme: 'hmac' } | { ok: false, reason: string }>}
 *   `reason` is `nonce_store_full` when the in-memory nonce window is full.
 */
export async function verifyOpenDotModelRelayRequest({ headers, method, body, env, loadRedis = async () => null, nowMs = Date.now() }) {
  const signed = Object.values(OPEN_DOT_MODEL_RELAY_HEADERS).some(name => headers?.[name] !== undefined);
  if (!signed) return { ok: false, reason: 'unauthorized' };
  const secret = env.OPEN_DOT_MODEL_RELAY_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) return { ok: false, reason: 'relay_secret_unconfigured' };
  const signature = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.signature);
  const timestamp = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.timestamp);
  const nonce = header(headers, OPEN_DOT_MODEL_RELAY_HEADERS.nonce);
  if (!signature || !SIGNATURE_RE.test(signature)) return { ok: false, reason: 'invalid_signature' };
  if (!timestamp || !TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: 'invalid_timestamp' };
  if (!nonce || !NONCE_RE.test(nonce)) return { ok: false, reason: 'invalid_nonce' };
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - seconds) > OPEN_DOT_MODEL_RELAY_WINDOW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const expected = createHmac('sha256', secret).update(openDotModelRelaySigningInput({ method, timestamp, nonce, body })).digest();
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) return { ok: false, reason: 'invalid_signature' };
  const claim = await claimNonce(loadRedis, nonce, (seconds + OPEN_DOT_MODEL_RELAY_WINDOW_SECONDS + 1) * 1000, nowMs);
  if (claim === 'full') return { ok: false, reason: 'nonce_store_full' };
  if (claim === 'replayed') return { ok: false, reason: 'replayed_nonce' };
  return { ok: true, scheme: 'hmac' };
}
