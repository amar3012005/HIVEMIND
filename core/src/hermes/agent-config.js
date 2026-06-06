/**
 * Hermes Agent config contract (Phase 1).
 *
 * Defines + validates the JSON config for one Hermes "external agent brain".
 * 1 runtime = 1 tenant (org); HiveMind MCP is the memory system of record;
 * hm-control owns lifecycle and is the only caller (FE never talks to Hermes).
 *
 * Dormant until later phases wire it into hm-control. Validation uses the ajv
 * already in the dependency tree (no new dep).
 *
 * @module hermes/agent-config
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {object} The JSON Schema (draft-07) for a Hermes Agent config. */
export const HERMES_AGENT_SCHEMA = JSON.parse(
  readFileSync(join(__dirname, 'agent-config.schema.json'), 'utf8'),
);

const _ajv = new Ajv({ allErrors: true, strict: false });
try { addFormats(_ajv); } catch { /* ajv-formats optional; uuid/uri checks degrade to no-op */ }
const _validate = _ajv.compile(HERMES_AGENT_SCHEMA);

/**
 * Validate a Hermes Agent config object.
 * @param {unknown} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateHermesAgentConfig(config) {
  const ok = _validate(config);
  if (ok) return { valid: true, errors: [] };
  const errors = (_validate.errors || []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message}`,
  );
  return { valid: false, errors };
}

/**
 * Reference sample: a "Competitor Watcher" agent (manual trigger, MVP).
 * Matches README §"The Hermes Agent config contract".
 * @type {object}
 */
export const SAMPLE_COMPETITOR_WATCHER = {
  agent_id: '00000000-0000-4000-8000-000000000001',
  name: 'Competitor Watcher',
  tenant_id: 'org_demo',
  hermes_profile: 'org-demo',
  distribution: 'github.com/davinci/hermes-competitor-watcher',
  memory_mode: 'hivemind_mcp',
  capabilities: ['browser', 'web_search'],
  schedule: { type: 'manual' },
  output_routes: [
    { type: 'hivemind_memory', tenant_id: 'org_demo', tags: ['competitor'] },
  ],
  safety_policy: {
    max_tokens_per_run: 100000,
    max_runtime_seconds: 600,
    allowed_domains: ['*'],
    require_approval: ['send', 'purchase', 'form_submit'],
  },
  model: { provider: 'custom', model: 'hermes-default', api_key: 'env:HERMES_MODEL_KEY' },
  soul_ref: 'distribution',
  status: 'active',
};
