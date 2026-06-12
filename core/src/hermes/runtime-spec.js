/**
 * Hermes per-tenant runtime spec (Phase 6a — pods-per-client contract).
 *
 * PLACEMENT DECISION (frozen 6a): hm-hermes-manager is a **Node module inside
 * hm-control** (core/src/hermes/*), NOT a separate service. Rationale: single
 * deploy boundary; reuses the existing hm-control-client.js (runOnce/checkHealth
 * already accept {baseUrl, apiKey}) + control-plane-server.js auth/org-scoping;
 * no new container to operate. (A Python FastAPI sidecar mirroring
 * employees-service was the alternative — rejected for MVP: extra boundary, no
 * benefit on a single host.)
 *
 * This module only DEFINES + VALIDATES the runtime spec and derives the
 * canonical per-tenant names/ports. No Docker calls, no prod, no DB — those land
 * in 6b (registry) / 6c (orchestrator). Dormant until wired (6d/6e).
 *
 * @module hermes/runtime-spec
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {object} JSON Schema (draft-07) for a Hermes per-tenant runtime. */
export const HERMES_RUNTIME_SCHEMA = JSON.parse(
  readFileSync(join(__dirname, 'runtime-spec.schema.json'), 'utf8'),
);

const _ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
try { addFormats(_ajv); } catch { /* formats optional */ }
const _validate = _ajv.compile(HERMES_RUNTIME_SCHEMA);

/** Default container networks (existing — see Phase 2 deploy). */
export const DEFAULT_NETWORKS = ['hmtest'];
/** Base host port; per-tenant port = BASE + hash(tenant) % RANGE. */
const PORT_BASE = Number(process.env.HERMES_PORT_BASE || 18600);
const PORT_RANGE = Number(process.env.HERMES_PORT_RANGE || 300);

/** Sanitize a tenant id into a docker-name-safe slug. */
function slug(tenantId) {
  return String(tenantId).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Deterministic, stable host port for a tenant (no collisions across restarts). */
export function deriveGatewayPort(tenantId) {
  let h = 0;
  const s = slug(tenantId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PORT_BASE + (h % PORT_RANGE);
}

/**
 * Build a canonical runtime spec for a tenant from minimal inputs.
 * Pure — no side effects. (Persisted by 6b, realized by 6c.)
 * @param {{ tenant_id: string, org_id?: string, mcp_url?: string, networks?: string[], resource_limits?: object }} input
 * @returns {object} a HermesRuntimeSpec (validate before use).
 */
export function buildRuntimeSpec(input) {
  const t = slug(input.tenant_id);
  return {
    tenant_id: input.tenant_id,
    container_name: `hm-hermes-${t}`,
    image: process.env.HERMES_IMAGE || 'nousresearch/hermes-agent:latest',
    volume_name: `hermes-state-${t}`,
    gateway_port: deriveGatewayPort(input.tenant_id),
    dashboard_port: null,
    networks: input.networks || DEFAULT_NETWORKS,
    resource_limits: input.resource_limits || { cpus: '2', memory: '4G', shm_size: '1g' },
    mcp_url: input.mcp_url || (process.env.HIVEMIND_API_URL ? `${process.env.HIVEMIND_API_URL}/api/mcp` : 'https://core.hivemind.davinciai.eu:8050/api/mcp'),
    api_key_ref: 'env:HERMES_API_SERVER_KEY',
    mcp_token_ref: null,
    org_id: input.org_id || input.tenant_id,
    status: 'pending',
    container_host: null,
    created_at: null,
    updated_at: null,
  };
}

/**
 * Validate a runtime spec.
 * @param {unknown} spec
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRuntimeSpec(spec) {
  const ok = _validate(spec);
  if (ok) return { valid: true, errors: [] };
  return { valid: false, errors: (_validate.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
}

/** Reference sample. */
export const SAMPLE_RUNTIME_SPEC = buildRuntimeSpec({ tenant_id: 'org_demo', org_id: 'org_demo' });
