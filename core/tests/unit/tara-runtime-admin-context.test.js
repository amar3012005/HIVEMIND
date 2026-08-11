import test from 'node:test';
import assert from 'node:assert/strict';

import { runtimeAdminEvidenceBriefing } from '../../src/tara/grok-runtime.js';

test('runtime admin briefing carries persisted baseline truth and limitations', () => {
  const briefing = runtimeAdminEvidenceBriefing({
    company: { name: 'GreenLeaf Bakery', location: 'Leeds', mission: 'Bake local bread.' },
    baseline: {
      id: 'baseline-1',
      as_of: '2026-08-09T12:00:00.000Z',
      website_pages: null,
      social_accounts: 2,
      recent_posts: 0,
      data_gaps: ['Website was not observed.'],
    },
    request: { instruction: 'Grow repeat local orders.' },
  });

  assert.match(briefing, /GreenLeaf Bakery/);
  assert.match(briefing, /baseline-1/);
  assert.match(briefing, /Website was not observed/);
  assert.match(briefing, /Grow repeat local orders/);
  assert.match(briefing, /Do not invent missing values/);
});

test('runtime admin briefing remains useful without optional baseline metrics', () => {
  const briefing = runtimeAdminEvidenceBriefing({ company: { name: 'Acme' }, baseline: {} });
  const payload = briefing.slice(briefing.indexOf('{'), briefing.lastIndexOf('}') + 1);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.baseline.website_pages, null);
  assert.equal(parsed.baseline.social_accounts, null);
  assert.equal(parsed.baseline.recent_posts, null);
});
