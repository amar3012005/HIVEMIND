import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function decodeKey(value) {
  if (!value) return null;
  const key = Buffer.from(String(value), 'base64');
  if (key.length !== 32) throw new Error('PUSH_OUTBOX_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  return key;
}

function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function configuredKeys() {
  const values = [
    process.env.PUSH_OUTBOX_ENCRYPTION_KEY,
    ...String(process.env.PUSH_OUTBOX_DECRYPTION_KEYS || '').split(',').map((v) => v.trim()).filter(Boolean),
  ];
  return values.filter(Boolean).map(decodeKey);
}

export function isSealedOutboxPayload(payload) {
  return payload?.v === 1 && payload?.alg === ALGORITHM
    && typeof payload?.kid === 'string' && typeof payload?.ciphertext === 'string';
}

export function sealOutboxPayload(payload, { key = null, requireEncryption = null } = {}) {
  const resolved = key ? decodeKey(key) : configuredKeys()[0];
  const required = requireEncryption ?? String(process.env.PUSH_OUTBOX_REQUIRE_ENCRYPTION || 'false') === 'true';
  if (!resolved) {
    if (required) throw new Error('outbox encryption is required but no key is configured');
    return payload;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, resolved, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: ALGORITHM,
    kid: keyId(resolved),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function openOutboxPayload(payload, { keys = null } = {}) {
  if (!isSealedOutboxPayload(payload)) return payload;
  const candidates = keys ? keys.map(decodeKey) : configuredKeys();
  const key = candidates.find((candidate) => keyId(candidate) === payload.kid);
  if (!key) throw new Error(`outbox decryption key unavailable for kid=${payload.kid}`);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function redactedOutboxPayload() {
  return { v: 1, redacted: true };
}
