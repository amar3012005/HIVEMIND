import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaraGrokRuntime, taraGrokEnabled } from '../../src/tara/grok-runtime.js';
import { resolveTaraProviderCandidates } from '../../src/tara/provider-policy.js';

const previous = process.env.TARA_GROK_ENABLED;
test.after(() => {
  if (previous === undefined) delete process.env.TARA_GROK_ENABLED;
  else process.env.TARA_GROK_ENABLED = previous;
});

test('runtime rejects direct Grok selection when disabled', async () => {
  process.env.TARA_GROK_ENABLED = 'false';
  assert.equal(taraGrokEnabled(), false);

  const current = {
    defaultProvider: 'deepgram', revision: 1, deepgramConfig: {}, grokConfig: {},
  };
  const prisma = {
    taraRuntimeConfig: {
      upsert: async () => current,
      update: async () => { throw new Error('must not update disabled provider'); },
    },
  };
  const handler = createTaraGrokRuntime({ prisma });
  let reply;
  const handled = await handler({
    pathname: '/api/tara/runtime-config', method: 'PATCH',
    body: { expected_revision: 1, default_provider: 'grok' },
    req: { headers: {} }, res: {}, userId: 'user-1', orgId: 'org-1',
    url: new URL('https://core.example/api/tara/runtime-config'),
    jsonResponse: (_res, body, status = 200) => { reply = { body, status }; },
  });
  assert.equal(handled, true);
  assert.deepEqual(reply, { body: { error: 'provider_disabled', provider: 'grok' }, status: 409 });
});

test('provider policy never probes Grok when disabled', async () => {
  process.env.TARA_GROK_ENABLED = 'false';
  const probes = [];
  const runtime = {
    defaultProvider: 'grok', revision: 3,
    deepgramConfig: { provider_order: ['grok', 'deepgram'] },
    grokConfig: { provider_order: ['grok'] },
  };
  const prisma = {
    taraRuntimeConfig: { findUnique: async () => runtime },
    capabilityAdapterState: {
      findUnique: async () => null,
      upsert: async () => ({}),
    },
  };
  const result = await resolveTaraProviderCandidates({
    prisma, orgId: 'org-1',
    fetchImpl: async (url) => {
      probes.push(String(url));
      return { ok: true, json: async () => ({ telephony: true }) };
    },
  });
  assert.equal(result.selected?.provider, 'deepgram');
  assert.deepEqual(result.candidates.map((item) => item.provider), ['deepgram']);
  assert.equal(probes.length, 1);
  assert.match(probes[0], /tara-deepgram/);
});
