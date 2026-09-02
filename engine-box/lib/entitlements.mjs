import crypto from 'node:crypto';

/**
 * A signed entitlement is a control-plane statement, never a remote command.
 * Its effect is deliberately intersected with a local administrator consent
 * record so Cloudflare cannot turn on content egress, a tunnel, support, or
 * updates by changing a flag remotely.
 */
export const ENTITLEMENT_VERSION = 1;

export const ENTITLEMENT_FLAGS = Object.freeze([
  'engine_box_enabled',
  'cloudflare_management',
  'telemetry',
  'tunnel',
  'automatic_updates',
  'support_session',
  'remote_inference',
]);

const LOCAL_CONSENT_FLAGS = new Set([
  'cloudflare_management', 'telemetry', 'tunnel',
  'automatic_updates', 'support_session', 'remote_inference',
]);

export function canonicalizeEntitlement(value) {
  return JSON.stringify(sort(value));
}

export function validateEntitlement(value, { installationId } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('entitlement must be an object');
  if (value.version !== ENTITLEMENT_VERSION) throw new Error('unsupported entitlement version');
  if (!isNonEmpty(value.installation_id)) throw new Error('entitlement installation_id is required');
  if (installationId && value.installation_id !== installationId) throw new Error('entitlement installation does not match this appliance');
  if (!isFuture(value.expires_at)) throw new Error('entitlement is expired or has invalid expires_at');
  if (!['stable', 'canary'].includes(value.release_channel)) throw new Error('entitlement release_channel is invalid');
  for (const flag of ENTITLEMENT_FLAGS) {
    if (typeof value[flag] !== 'boolean') throw new Error(`entitlement ${flag} must be boolean`);
  }
  for (const key of Object.keys(value)) {
    if (!['version', 'installation_id', 'expires_at', 'release_channel', ...ENTITLEMENT_FLAGS].includes(key)) {
      throw new Error(`entitlement contains unsupported field: ${key}`);
    }
  }
  return true;
}

export function verifySignedEntitlement({ entitlement, signature, publicKey, installationId } = {}) {
  try {
    validateEntitlement(entitlement, { installationId });
    if (!signature || !publicKey) return false;
    return crypto.verify(null, Buffer.from(canonicalizeEntitlement(entitlement)), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function resolveEntitlements({ entitlement, localConsent = {}, now = Date.now() } = {}) {
  validateEntitlement(entitlement);
  const expiresAt = Date.parse(entitlement.expires_at);
  if (expiresAt <= now) throw new Error('entitlement is expired');
  const effective = {
    engine_box_enabled: entitlement.engine_box_enabled,
    release_channel: entitlement.release_channel,
    expires_at: entitlement.expires_at,
  };
  for (const flag of ENTITLEMENT_FLAGS) {
    if (flag === 'engine_box_enabled') continue;
    effective[flag] = entitlement[flag] === true
      && LOCAL_CONSENT_FLAGS.has(flag)
      && localConsent[flag] === true;
  }
  return Object.freeze(effective);
}

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
}
function isFuture(value) { const at = Date.parse(value || ''); return Number.isFinite(at) && at > Date.now(); }
function isNonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }
