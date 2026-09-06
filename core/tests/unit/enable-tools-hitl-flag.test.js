import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENABLE_TOOLS_HITL_FLAGSHIP_KEY,
  isEnableToolsHitlEnabled,
} from '../../src/agent/enable-tools-hitl-flag.js';

test('enable-tools HITL is controlled only by Flagship and fails closed', async () => {
  const env = { ENABLE_TOOLS_HITL: 'false', ENABLE_TOOLS_HITL_FLAG_URL: 'https://flags.test/enable-tools-hitl' };
  assert.equal(await isEnableToolsHitlEnabled(env, { flagshipEnabled: false }), false);
  assert.equal(await isEnableToolsHitlEnabled({}, { flagshipEnabled: true }), true);
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
  const missing = await isEnableToolsHitlEnabled({}, {
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
