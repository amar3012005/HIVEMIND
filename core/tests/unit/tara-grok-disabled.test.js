import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaraGrokRuntime, resolveTaraPublicWebsocketUrl } from '../../src/tara/grok-runtime.js';
import { resolveTaraProviderCandidates } from '../../src/tara/provider-policy.js';

test('browser voice sessions use the configured public Core origin, not the Docker proxy host', () => {
  const wsUrl = resolveTaraPublicWebsocketUrl(
    { headers: { host: 'core:3000' } },
    '',
    '/voice-grok/voice',
    'https://core.dev.next.singulancelabs.com',
  );
  assert.equal(wsUrl, 'wss://core.dev.next.singulancelabs.com/voice-grok/voice');
});

test('runtime rejects Grok selection when Flagship denies the authenticated user', async () => {

  const current = {
    defaultProvider: 'deepgram', revision: 1, deepgramConfig: {}, grokConfig: {},
  };
  const prisma = {
    taraRuntimeConfig: {
      upsert: async () => current,
      update: async () => { throw new Error('must not update disabled provider'); },
    },
  };
  const handler = createTaraGrokRuntime({ prisma, isGrokAdmitted: async () => false });
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

test('outbound provider policy never probes Grok without its own admission contract', async () => {
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
