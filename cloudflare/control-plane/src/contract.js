export const EDGE_CAPABILITIES = Object.freeze([
  'cloudflare_edge',
  'cloudflare_tunnel',
  'cloudflare_telemetry',
  'cloudflare_ai_gateway',
  'cloudflare_updates',
  'cloudflare_support_session',
]);

export const DEFAULT_EDGE_CAPABILITIES = Object.freeze(
  Object.fromEntries(EDGE_CAPABILITIES.map((capability) => [capability, false])),
);

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeCapabilityFlags(flags = {}) {
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) throw new Error('flags must be an object');
  const unknown = Object.keys(flags).filter((key) => !EDGE_CAPABILITIES.includes(key));
  if (unknown.length) throw new Error(`unknown capability: ${unknown[0]}`);
  return Object.freeze({
    ...DEFAULT_EDGE_CAPABILITIES,
    ...Object.fromEntries(Object.entries(flags).map(([key, value]) => {
      if (typeof value !== 'boolean') throw new Error(`capability ${key} must be boolean`);
      return [key, value];
    })),
  });
}

export function validateEntitlement(document, now = new Date()) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('document must be an object');
  if (document.version !== 1) throw new Error('unsupported entitlement version');
  if (!ORGANIZATION_ID.test(String(document.organization_id || ''))) throw new Error('invalid organization_id');
  if (!document.nonce || typeof document.nonce !== 'string' || document.nonce.length < 16) throw new Error('invalid nonce');
  const issued = new Date(document.issued_at);
  const expires = new Date(document.expires_at);
  if (Number.isNaN(issued.getTime()) || Number.isNaN(expires.getTime()) || expires <= issued) throw new Error('invalid entitlement validity');
  if (expires <= now) throw new Error('entitlement expired');
  if (issued.getTime() - now.getTime() > 5 * 60_000) throw new Error('entitlement issued in the future');
  return { ...document, flags: normalizeCapabilityFlags(document.flags) };
}

export function containsContentBearingFields(value, path = '') {
  if (!value || typeof value !== 'object') return false;
  const forbidden = /(?:content|prompt|document|memory|embedding|query|answer|profile|citation|message|transcript)/i;
  return Object.entries(value).some(([key, nested]) => forbidden.test(`${path}.${key}`) || containsContentBearingFields(nested, `${path}.${key}`));
}

export function validateLifecycleEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object');
  if (containsContentBearingFields(event)) throw new Error('content-bearing telemetry is forbidden');
  const allowed = new Set(['installation_id', 'organization_id', 'event', 'state', 'release', 'schema_version', 'occurred_at', 'error_code']);
  for (const key of Object.keys(event)) if (!allowed.has(key)) throw new Error(`unsupported telemetry field: ${key}`);
  if (!ORGANIZATION_ID.test(String(event.organization_id || ''))) throw new Error('invalid organization_id');
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(String(event.installation_id || ''))) throw new Error('invalid installation_id');
  if (!/^[a-z][a-z0-9._-]{0,79}$/i.test(String(event.event || ''))) throw new Error('invalid lifecycle event');
  if (event.state && !/^(ready|degraded|offline|installing|updating|rolled_back|failed)$/i.test(event.state)) throw new Error('invalid lifecycle state');
  return Object.freeze({ ...event, occurred_at: event.occurred_at || new Date().toISOString() });
}
