import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackAwakeningNarration } from '../../src/hq-runtime/awakening-narrator.js';
import { compactCompanyOperatingContext, summarizeBaselineResult, summarizeGrowthPlanResult } from '../../src/hq-runtime/native-engine.js';

test('HQ awakening fallback is specific to loaded company facts', () => {
  const narration = fallbackAwakeningNarration({
    company: { company: 'Boozit', website: 'https://boozit.example', location: 'Landshut, Germany' },
    objective: 'Build a qualified venue pipeline', capabilities: ['google-maps'], restart: false,
  });
  assert.match(narration, /Boozit at https:\/\/boozit\.example/);
  assert.match(narration, /Landshut, Germany/);
  assert.match(narration, /Build a qualified venue pipeline/);
  assert.match(narration, /google-maps/);
});

test('baseline acknowledgement names concrete platform and performance metrics', () => {
  const result = summarizeBaselineResult({
    website: { mapped_pages: 5 },
    social_presence: {
      followers: [
        { platform: 'instagram', currentFollowers: 51 },
        { platform: 'linkedin', currentFollowers: 22 },
        { platform: 'twitter', currentFollowers: 0 },
      ],
      totals: { impressions: 4101, reach: 1387, likes: 124, clicks: 1 },
    },
  });
  assert.match(result.summary, /Instagram: 51 followers/);
  assert.match(result.summary, /Linkedin: 22 followers/);
  assert.match(result.summary, /X: 0 followers/);
  assert.match(result.summary, /4,101 impressions/);
});

test('baseline acknowledgement never presents absent metrics as measured zero', () => {
  const result = summarizeBaselineResult({ website: {}, social_presence: { totals: {} } });
  assert.match(result.summary, /Website pages were not observed/);
  assert.match(result.summary, /impressions not observed/);
  assert.equal(result.details.website_pages, null);
  assert.doesNotMatch(result.summary, /0 impressions|0 website page/);
});

test('baseline acknowledgement treats a limited fallback website result as unobserved', () => {
  const result = summarizeBaselineResult({
    website: { provider: 'fallback', mapped_pages: 0, limitation: 'No usable first-party pages' },
    social_presence: { totals: {} },
  });
  assert.match(result.summary, /Website pages were not observed/);
  assert.equal(result.details.website_pages, null);
});

test('growth plan acknowledgement names constraints and ordered specialist work', () => {
  const result = summarizeGrowthPlanResult({ plan: {
    constraints: [{ type: 'reach' }, { type: 'pipeline' }],
    operating_queue: [{ title: 'Audit search position', room_tag: 'seo' }, { title: 'Qualify prospects', room_tag: 'outreach' }],
  }, committed: { todo_ids: ['one', 'two'] } });
  assert.match(result.summary, /reach, pipeline/);
  assert.match(result.summary, /1\. Audit search position -> seo/);
  assert.match(result.summary, /2\. Qualify prospects -> outreach/);
});

test('Room lifecycle receives a compact company snapshot without dashboard history', () => {
  const compact = compactCompanyOperatingContext({
    company: 'GreenLeaf', website: 'https://greenleaf.example', company_location: 'Leeds',
    mission: 'Serve the neighborhood.',
    tasks: Array.from({ length: 50 }, (_, index) => ({ id: index, detail: 'not execution context' })),
    research: Array.from({ length: 50 }, (_, index) => ({ id: index, snippet: 'not execution context' })),
    profile: { industry: 'Bakery', icp: 'Local households', capabilities: ['Bread'], risks: ['Supply'] },
  });
  assert.equal(compact.name, 'GreenLeaf');
  assert.equal(compact.location, 'Leeds');
  assert.equal(Object.hasOwn(compact, 'tasks'), false);
  assert.equal(Object.hasOwn(compact, 'research'), false);
  assert.ok(JSON.stringify(compact).length < 2000);
});
