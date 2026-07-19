import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('image vision makes one plain-text evidence call without a JSON schema', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalGroqKey = process.env.GROQ_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.GROQ_API_KEY;

  let requests = 0;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requests += 1;
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'A detailed visual description with exact visible text and spatial relationships.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqKey;
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
  assert.equal(requestBody.response_format, undefined);
  const prompt = requestBody.messages[0].content[0].text;
  assert.match(prompt, /rich, detailed plain text/i);
  assert.match(prompt, /Do NOT return JSON/i);
  assert.equal(result.payload.memory_type, 'summary');
  assert.match(result.payload.content, /detailed visual description/i);
  assert.deepEqual(result.payload.project_ids, ['project-1']);
  assert.deepEqual(result.extraction.entities, []);
  assert.equal(result.payload.metadata.evidence_role, 'raw_visual_description');
});

test('image endpoint sends visual prose through canonical document ingestion', async () => {
  const server = await readFile(new URL('../../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("case '/api/ingest/image':");
  const end = server.indexOf("case '/api/ingest':", start);
  const route = server.slice(start, end);

  assert.match(route, /ingestCanonicalPayload\(payload/);
  assert.match(route, /sourceType:\s*'api'/);
  assert.match(route, /platform:\s*'image-upload'/);
  assert.match(route, /mode:\s*'document'/);
  assert.equal(route.includes('buildRoutedIngestPayloads(payload'), false);
  assert.equal(route.includes('ingestRoutedPayload(routed'), false);
});
