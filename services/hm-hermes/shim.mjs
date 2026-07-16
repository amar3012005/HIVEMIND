#!/usr/bin/env node
/**
 * hm-hermes shim — bridge between hm-control and the local Hermes gateway.
 *
 * STATUS: Phase 2 = stub (gateway boots via the image's default `gateway run`;
 * this shim is NOT the entrypoint yet). Phase 4 completes it: hm-control calls
 * runOnce(agent_id, payload) → this shim resolves the tenant profile, POSTs the
 * job to the local Hermes gateway (OpenAI-compatible API on :8642 with
 * API_SERVER_KEY), and streams status/logs back to hm-control.
 *
 * Contract it will satisfy (see TASKS/hermes-runtime/README.md §config contract):
 *   IN  : { agent_id, hermes_profile, payload, callback_url }
 *   OUT : POST job → gateway; relay {status, logs} to callback_url / hm-control.
 *
 * Kept dependency-free + side-effect-free on import so the image stays clean
 * until Phase 4 wires the real loop.
 *
 * @module hm-hermes/shim
 */

const GATEWAY_URL = process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642';
const API_KEY = process.env.API_SERVER_KEY || '';

/**
 * Phase 4 will implement: dispatch one job to the local Hermes gateway.
 * @param {{ agent_id: string, hermes_profile: string, payload: object }} _job
 * @returns {Promise<{ status: string }>}
 */
export async function runOnce(_job) {
  // PHASE-4 TODO: POST to `${GATEWAY_URL}` (OpenAI-compatible) with Bearer
  // API_KEY, select profile via header/body, stream status back to hm-control.
  throw new Error('hm-hermes shim.runOnce not implemented until Phase 4');
}

// No top-level execution: the container entrypoint is the image default
// (`gateway run`). This file is import-only until Phase 4 makes it the shim
// process. Exporting config so Phase 4 + tests can introspect.
export const SHIM_CONFIG = { gatewayUrl: GATEWAY_URL, hasApiKey: Boolean(API_KEY) };
