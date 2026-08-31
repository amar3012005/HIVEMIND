import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('image vision makes one plain-text evidence call without a JSON schema', async (t) => {
  const originalFetch = globalThis.fetch;
  const original = {
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_AI_GATEWAY_TOKEN,
    gateway: process.env.CLOUDFLARE_AI_GATEWAY_ID,
    model: process.env.HIVEMIND_CLOUDFLARE_VISION_MODEL,
  };
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id';
  process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'gateway-token';
  process.env.CLOUDFLARE_AI_GATEWAY_ID = 'hivemind-prod';
  process.env.HIVEMIND_CLOUDFLARE_VISION_MODEL = 'google/gemini-2.5-flash-lite';

  let requests = 0;
  let requestBody = null;
  let requestUrl = null;
  let requestHeaders = null;
  globalThis.fetch = async (url, options) => {
    requests += 1;
    requestUrl = String(url);
    requestHeaders = options.headers;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'A detailed visual description with exact visible text and spatial relationships.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      CLOUDFLARE_ACCOUNT_ID: original.account,
      CLOUDFLARE_AI_GATEWAY_TOKEN: original.token,
      CLOUDFLARE_AI_GATEWAY_ID: original.gateway,
      HIVEMIND_CLOUDFLARE_VISION_MODEL: original.model,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const { buildImageMemoryPayload } = await import('../../src/services/image-ingest.js');
  const result = await buildImageMemoryPayload({
    imageBuffer: Buffer.from('image-bytes'),
    mimeType: 'image/png',
    filename: 'architecture.png',
    hint: 'System architecture',
    userId: 'user-1',
    orgId: 'org-1',
    projectId: 'project-1',
  });

  assert.equal(requests, 1);
  assert.match(requestUrl, /api\.cloudflare\.com\/client\/v4\/accounts\/account-id\/ai\/v1\/chat\/completions/);
  assert.equal(requestHeaders['cf-aig-gateway-id'], 'hivemind-prod');
  assert.equal(requestBody.model, 'google/gemini-2.5-flash-lite');
  assert.equal(requestBody.response_format, undefined);
  const prompt = requestBody.messages[0].content[0].text;
  assert.match(prompt, /rich plain text/i);
  assert.match(prompt, /Do NOT return JSON/i);
  assert.equal(result.payload.memory_type, 'fact');
  assert.match(result.payload.content, /detailed visual description/i);
  assert.deepEqual(result.payload.project_ids, ['project-1']);
  assert.deepEqual(result.extraction.entities, []);
  assert.equal(result.payload.metadata.evidence_role, 'raw_visual_description');
  assert.equal(result.classification.provider, 'cloudflare-ai-gateway');
});

test('image endpoint delegates to the durable canonical upload lifecycle', async () => {
  const server = await readFile(new URL('../../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("case '/api/ingest/image':");
  const end = server.indexOf("case '/api/ingest':", start);
  const route = server.slice(start, end);

  assert.match(route, /handleKnowledgeUploadRoute/);
  assert.match(route, /rel="successor-version"/);
});
