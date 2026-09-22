import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY0_LIFECYCLE_FLAG_KEY, isDayZeroLifecycleEnabled } from '../../src/lifecycle/day0-lifecycle-flag.js';

const env = { HIVEMIND_PUBLIC_ORIGIN: 'https://dev.next.singulancelabs.com', HIVE_HARNESS_EDGE_EVAL_SECRET: 'test-secret' };

test('accepts only the unified pre-onboarding Cloudflare Flagship receipt', async () => {
  let seen;
  const enabled = await isDayZeroLifecycleEnabled({
    orgId: 'org-1', userId: 'user-1', env,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return Response.json({ key: DAY0_LIFECYCLE_FLAG_KEY, source: 'cloudflare-flagship', enabled: true });
    },
  });
  assert.equal(enabled, true);
  assert.equal(seen.url, 'https://dev.next.singulancelabs.com/__hivemind/feature-flags/day0-onboarding');
  assert.equal(seen.init.headers.authorization, 'Bearer test-secret');
});

test('fails closed for a malformed or unavailable flag receipt', async () => {
  const enabled = await isDayZeroLifecycleEnabled({
    orgId: 'org-1', userId: 'user-1', env,
    fetchImpl: async () => Response.json({ key: 'other', enabled: true }),
  });
  assert.equal(enabled, false);
});
