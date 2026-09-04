import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENABLE_TOOLS_HITL_FLAGSHIP_KEY,
  isEnableToolsHitlEnabled,
  isEnableToolsHitlEnvEnabled,
} from '../../src/agent/enable-tools-hitl-flag.js';

test('enable-tools HITL env gate is fail-closed', () => {
  assert.equal(isEnableToolsHitlEnvEnabled({}), false);
  assert.equal(isEnableToolsHitlEnvEnabled({ ENABLE_TOOLS_HITL: 'false' }), false);
  assert.equal(isEnableToolsHitlEnvEnabled({ ENABLE_TOOLS_HITL: 'true' }), true);
});

test('enable-tools HITL requires Flagship enabled:true from cloudflare-flagship', async () => {
  const env = { ENABLE_TOOLS_HITL: 'true', ENABLE_TOOLS_HITL_FLAG_URL: 'https://flags.test/enable-tools-hitl' };
  assert.equal(await isEnableToolsHitlEnabled(env, { flagshipEnabled: false }), false);
  assert.equal(await isEnableToolsHitlEnabled(env, { flagshipEnabled: true }), true);
  const off = await isEnableToolsHitlEnabled(env, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ key: ENABLE_TOOLS_HITL_FLAGSHIP_KEY, enabled: false, source: 'cloudflare-flagship' }),
    }),
  });
  assert.equal(off, false);
  const on = await isEnableToolsHitlEnabled(env, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ key: ENABLE_TOOLS_HITL_FLAGSHIP_KEY, enabled: true, source: 'cloudflare-flagship' }),
    }),
  });
  assert.equal(on, true);
  const missing = await isEnableToolsHitlEnabled({ ENABLE_TOOLS_HITL: 'true' }, {
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  assert.equal(missing, false);
  const wrongSource = await isEnableToolsHitlEnabled(env, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ key: ENABLE_TOOLS_HITL_FLAGSHIP_KEY, enabled: true, source: 'local' }),
    }),
  });
  assert.equal(wrongSource, false);
});
