/**
 * Engine Box's small, dependency-free runtime contract. It is intentionally
 * separate from hosted Core boot code so appliance safety can be tested before
 * any expensive service is started.
 */
export const ENGINE_BOX_API_VERSION = 'v1';

export const EXCLUDED_CAPABILITIES = new Set([
  'voice', 'tara', 'employees', 'hyperagents', 'connectors', 'web_search',
]);

export const REQUIRED_LOCAL_SERVICES = [
  'postgres', 'qdrant', 'redis', 'core', 'ingestion', 'hm_extract', 'mcp',
];

export function createEngineBoxRuntimeConfig(env = process.env) {
  const mode = String(env.ENGINE_BOX_MODE || '').toLowerCase();
  if (mode !== 'true' && mode !== '1') {
    return { enabled: false, apiVersion: ENGINE_BOX_API_VERSION, excluded: [] };
  }
  const requested = String(env.ENGINE_BOX_ENABLE || 'ingestion,recall,chat,mcp,temporal,graph')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const forbidden = requested.filter((capability) => EXCLUDED_CAPABILITIES.has(capability));
  if (forbidden.length) {
    throw new Error(`Engine Box cannot enable hosted-only capabilities: ${forbidden.join(', ')}`);
  }
  return {
    enabled: true,
    apiVersion: ENGINE_BOX_API_VERSION,
    capabilities: requested,
    excluded: [...EXCLUDED_CAPABILITIES],
    sovereignByDefault: env.ENGINE_BOX_SOVEREIGN !== 'false',
  };
}

export function evaluateReadiness({ services = {}, modelRoute, license } = {}) {
  const missing = REQUIRED_LOCAL_SERVICES.filter((name) => services[name] !== 'ready');
  const localModelReady = modelRoute?.execution === 'local' || modelRoute?.execution === 'customer_gateway';
  const cloudModelReady = modelRoute?.execution === 'cloudflare_gateway' && modelRoute?.egressConsent === true;
  const lease = evaluateLease(license);
  if (missing.length || (!localModelReady && !cloudModelReady)) {
    return { state: 'UNAVAILABLE', missing, reason: missing.length ? 'local_dependency_unavailable' : 'model_route_unavailable', lease };
  }
  if (lease.mode === 'read_only') return { state: 'DEGRADED', missing: [], reason: 'license_expired_read_only', lease };
  return { state: 'READY', missing: [], reason: null, lease };
}

export function evaluateLease(license = {}, now = Date.now()) {
  const expiresAt = Date.parse(license.expiresAt || '');
  if (!Number.isFinite(expiresAt)) return { valid: false, mode: 'read_only', reason: 'missing_or_invalid_lease' };
  if (expiresAt <= now) return { valid: false, mode: 'read_only', expiresAt: new Date(expiresAt).toISOString(), reason: 'lease_expired' };
  return { valid: true, mode: 'full', expiresAt: new Date(expiresAt).toISOString() };
}

export function assertCloudEgressAllowed(route, { consent = false } = {}) {
  if (route?.execution !== 'cloudflare_gateway') return true;
  if (consent === true) return true;
  throw new Error('Cloudflare AI Gateway route requires recorded customer content-egress consent');
}
