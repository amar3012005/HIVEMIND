import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAMPAIGN_IMAGE_MODEL, generateCampaignImage, normalizeImageAspectRatio } from '../../src/campaigns/image-provider.js';

test('campaign image provider uses the low-latency dedicated image model', () => {
  assert.equal(DEFAULT_CAMPAIGN_IMAGE_MODEL, 'openai/gpt-image-1-mini');
});

test('campaign image provider maps channel ratios to supported provider ratios', () => {
  assert.equal(normalizeImageAspectRatio('16:9'), '3:2');
  assert.equal(normalizeImageAspectRatio('4:3'), '3:2');
  assert.equal(normalizeImageAspectRatio('9:16'), '2:3');
  assert.equal(normalizeImageAspectRatio('1:1'), '1:1');
  assert.equal(normalizeImageAspectRatio('4:5'), '4:5');
  assert.equal(normalizeImageAspectRatio('unexpected'), 'auto');
});

test('campaign image provider sends the key visual as an input reference for later shots', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let requestBody;
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }) };
  };
  try {
    await generateCampaignImage({ prompt: 'Shot two', inputReferences: ['data:image/png;base64,a2V5'] });
    assert.deepEqual(requestBody.input_references, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,a2V5' } }]);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test('Muse uses its minimal model-specific request contract', async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }) };
  };
  try {
    await generateCampaignImage({ model: 'meta/muse-image', prompt: 'A test visual', aspectRatio: '4:5' });
    assert.equal(requestBody.aspect_ratio, '4:5');
    assert.equal('quality' in requestBody, false);
    assert.equal('output_format' in requestBody, false);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
