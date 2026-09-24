import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY0_LIFECYCLE_FLAG_KEY, DAY0_REPORT_ONEPAGE_FLAG_KEY, isDayZeroOnePageReportEnabled } from '../../src/lifecycle/day0-lifecycle-flag.js';

const env = { HIVEMIND_PUBLIC_ORIGIN: 'https://next.singulancelabs.com', HIVE_HARNESS_EDGE_EVAL_SECRET: 'test-secret' };

test('accepts the authenticated tenant-scoped Cloudflare report-theme receipt', async () => {
  let seen;
  const enabled = await isDayZeroOnePageReportEnabled({
    orgId: 'org-1', userId: 'user-1', env,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init, body: JSON.parse(init.body) };
      return Response.json({
        key: DAY0_LIFECYCLE_FLAG_KEY,
        source: 'cloudflare-flagship',
        report_flag_key: DAY0_REPORT_ONEPAGE_FLAG_KEY,
        report_onepage_enabled: true,
      });
    },
  });
  assert.equal(enabled, true);
  assert.equal(seen.url, 'https://next.singulancelabs.com/__hivemind/feature-flags/day0-onboarding');
  assert.equal(seen.init.headers.authorization, 'Bearer test-secret');
  assert.deepEqual(seen.body, { org_id: 'org-1', user_id: 'user-1' });
});

test('keeps the existing PDF renderer for missing, malformed, or unavailable receipts', async () => {
  for (const fetchImpl of [
    async () => Response.json({ key: DAY0_LIFECYCLE_FLAG_KEY, source: 'cloudflare-flagship', report_onepage_enabled: true }),
    async () => Response.json({ key: DAY0_LIFECYCLE_FLAG_KEY, source: 'cloudflare-flagship', report_flag_key: 'other', report_onepage_enabled: true }),
    async () => new Response('unavailable', { status: 503 }),
    async () => { throw new Error('network_down'); },
  ]) {
    assert.equal(await isDayZeroOnePageReportEnabled({ orgId: 'org-1', userId: 'user-1', env, fetchImpl }), false);
  }
});
