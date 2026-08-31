import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWebsiteScreenshotWithPlaywright } from '../../src/onboarding/company-research.js';

test('onboarding website preview requests one shallow Playwright screenshot', async () => {
  const calls = [];
  const screenshot = 'data:image/jpeg;base64,ZmFrZQ==';
  const runtime = {
    async crawl(options) {
      calls.push(options);
      return { pages: [{ url: 'https://example.com/', screenshot }] };
    },
  };

  assert.equal(await captureWebsiteScreenshotWithPlaywright('https://example.com', { runtime }), screenshot);
  assert.deepEqual(calls, [{
    urls: ['https://example.com'],
    depth: 0,
    pageLimit: 1,
    captureScreenshot: true,
  }]);
});

test('onboarding website preview fails closed when Playwright cannot render', async () => {
  const runtime = { crawl: async () => { throw new Error('renderer unavailable'); } };
  assert.equal(await captureWebsiteScreenshotWithPlaywright('https://example.com', { runtime }), null);
});
