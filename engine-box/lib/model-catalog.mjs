import crypto from 'node:crypto';
import { assertCloudEgressAllowed } from './runtime-contract.mjs';

const EXECUTIONS = new Set(['local', 'customer_gateway', 'cloudflare_gateway']);
const CAPABILITIES = new Set(['embedding', 'rerank', 'extraction', 'chat', 'vision']);

export function validateModelCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.routes)) throw new Error('invalid model catalog');
  const ids = new Set();
  for (const route of catalog.routes) {
    if (!route?.routeId || ids.has(route.routeId)) throw new Error('model routes require unique routeId values');
    ids.add(route.routeId);
    if (!CAPABILITIES.has(route.capability)) throw new Error(`unsupported capability for ${route.routeId}`);
    if (!EXECUTIONS.has(route.execution)) throw new Error(`unsupported execution for ${route.routeId}`);
    if (route.capability === 'embedding' && (!Number.isInteger(route.dimension) || route.dimension < 1)) {
      throw new Error(`embedding route ${route.routeId} requires dimension`);
    }
    if (route.execution === 'cloudflare_gateway' && route.dataEgress !== 'opt_in') {
      throw new Error(`Cloudflare route ${route.routeId} must be opt_in`);
    }
  }
  return catalog;
}

export function selectModelRoute(catalog, capability, options = {}) {
  validateModelCatalog(catalog);
  const candidates = catalog.routes.filter((route) => route.capability === capability);
  const preferred = options.routeId ? candidates.filter((route) => route.routeId === options.routeId) : candidates;
  const route = preferred.find((item) => item.execution === 'local')
    || preferred.find((item) => item.execution === 'customer_gateway')
    || preferred.find((item) => item.execution === 'cloudflare_gateway');
  if (!route) throw new Error(`no model route for ${capability}`);
  assertCloudEgressAllowed(route, options);
  return { ...route, egressConsent: route.execution === 'cloudflare_gateway' ? options.consent === true : false };
}

export function verifySignedCatalog({ catalog, signature, publicKey }) {
  validateModelCatalog(catalog);
  if (!signature || !publicKey) return false;
  const payload = Buffer.from(canonicalize(catalog));
  return crypto.verify(null, payload, publicKey, Buffer.from(signature, 'base64'));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
