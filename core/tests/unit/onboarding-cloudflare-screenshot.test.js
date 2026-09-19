import test from 'node:test';
import assert from 'node:assert/strict';
import { cfCaptureScreenshot, isAcceptableHomepageScreenshot } from '../../src/onboarding/cloudflare-research.js';

function png({ width = 1440, height = 900, size = 24_000 } = {}) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('homepage screenshot quality gate rejects blank-sized and undersized captures', () => {
  assert.equal(isAcceptableHomepageScreenshot(png(), 'image/png'), true);
  assert.equal(isAcceptableHomepageScreenshot(png({ size: 1000 }), 'image/png'), false);
  assert.equal(isAcceptableHomepageScreenshot(png({ width: 800 }), 'image/png'), false);
  assert.equal(isAcceptableHomepageScreenshot(png(), 'text/html'), false);
});

test('Cloudflare capture waits for live render readiness and retries rejected frames', async () => {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account';
  process.env.CLOUDFLARE_API_TOKEN = 'token';
  const calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    const bytes = calls.length === 1 ? png({ size: 1000 }) : png();
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };
  const result = await cfCaptureScreenshot('https://example.com', { request, retryDelays: [0, 1], sleep: async () => {} });
  assert.match(result, /^data:image\/png;base64,/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, 'screenshot');
  assert.deepEqual(calls[0].body.gotoOptions.waitUntil, ['domcontentloaded', 'networkidle2']);
  assert.deepEqual(calls[0].body.viewport, { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false });
  assert.match(calls[0].body.waitForSelector.selector, /data-hivemind-capture-ready/);
  assert.match(calls[0].body.addScriptTag[0].content, /document\.fonts/);
  assert.match(calls[0].body.addScriptTag[0].content, /requestAnimationFrame/);
  assert.match(calls[0].body.addScriptTag[0].content, /blockingConsent/);
});
