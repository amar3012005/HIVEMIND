import { createPublicKey, verify } from 'node:crypto';

export const EDGE_CAPABILITIES = Object.freeze([
  'cloudflare_edge',
  'cloudflare_tunnel',
  'cloudflare_telemetry',
  'cloudflare_ai_gateway',
  'cloudflare_updates',
  'cloudflare_support_session',
]);

export const DEFAULT_EDGE_CAPABILITIES = Object.freeze(Object.fromEntries(EDGE_CAPABILITIES.map((key) => [key, false])));

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizedFlags(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('flags must be an object');
  const flags = { ...DEFAULT_EDGE_CAPABILITIES };
  for (const [key, enabled] of Object.entries(input)) {
    if (!EDGE_CAPABILITIES.includes(key)) throw new Error(`unknown capability: ${key}`);
    if (typeof enabled !== 'boolean') throw new Error(`capability ${key} must be boolean`);
    flags[key] = enabled;
  }
  return flags;
}

export function verifySignedEdgeEntitlement({ envelope, organizationId, publicKey, now = new Date() }) {
  try {
    const document = envelope?.document;
    if (!document || document.version !== 1 || document.organization_id !== organizationId) throw new Error('organization mismatch');
    const expiresAt = new Date(document.expires_at);
    const issuedAt = new Date(document.issued_at);
    if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(issuedAt.getTime()) || expiresAt <= now || expiresAt <= issuedAt) throw new Error('invalid validity');
    if (!document.nonce || String(document.nonce).length < 16) throw new Error('invalid nonce');
    const flags = normalizedFlags(document.flags);
    if (!publicKey || !envelope?.signature) throw new Error('missing signature');
    const valid = verify(null, Buffer.from(stableJson(document)), createPublicKey(publicKey), Buffer.from(envelope.signature, 'base64'));
    if (!valid) throw new Error('invalid signature');
    return { valid: true, organizationId, expiresAt, flags };
  } catch (error) {
    return { valid: false, reason: error.message, flags: { ...DEFAULT_EDGE_CAPABILITIES } };
  }
}

export function resolveEdgeCapabilities({ featureEnabled, entitlement }) {
  if (featureEnabled !== true || entitlement?.valid !== true) return { ...DEFAULT_EDGE_CAPABILITIES };
  return { ...DEFAULT_EDGE_CAPABILITIES, ...entitlement.flags };
}
