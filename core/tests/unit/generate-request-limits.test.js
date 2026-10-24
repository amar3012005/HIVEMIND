import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveGenerateLimits, resolveGenerateRequest, generateRateLimitKey } from '../../src/middleware/generate-request-limits.js';

const limits = resolveGenerateLimits({});

test('defaults bound prompt size, output tokens and rate', () => {
  assert.deepEqual(limits, { maxPromptChars: 32768, maxTokens: 4096, rpmPerOrg: 30 });
  assert.deepEqual(resolveGenerateLimits({ HIVEMIND_GENERATE_MAX_TOKENS: '512' }).maxTokens, 512);
  assert.throws(() => resolveGenerateLimits({ HIVEMIND_GENERATE_RPM_PER_ORG: '0' }), /positive integer/);
  assert.throws(() => resolveGenerateLimits({ HIVEMIND_GENERATE_MAX_PROMPT_CHARS: 'lots' }), /positive integer/);
});

test('oversized prompts are refused before any provider call', () => {
  assert.deepEqual(resolveGenerateRequest({ prompt: 'x'.repeat(32769) }, limits), { ok: false, status: 413, error: 'prompt exceeds 32768 characters' });
  assert.equal(resolveGenerateRequest({ prompt: '   ' }, limits).status, 400);
  assert.equal(resolveGenerateRequest({ prompt: { toString: () => 'x' } }, limits).status, 400);
});

test('max_tokens is clamped to the cap and must be a positive integer', () => {
  assert.equal(resolveGenerateRequest({ prompt: 'hi', max_tokens: 1_000_000 }, limits).maxTokens, 4096);
  assert.equal(resolveGenerateRequest({ prompt: 'hi', maxTokens: 200 }, limits).maxTokens, 200);
  assert.equal(resolveGenerateRequest({ prompt: 'hi' }, limits).maxTokens, undefined);
  assert.equal(resolveGenerateRequest({ prompt: 'hi', max_tokens: -5 }, limits).status, 400);
  assert.equal(resolveGenerateRequest({ prompt: 'hi', max_tokens: 1.5 }, limits).status, 400);
});

test('generate uses its own per-organization bucket', () => {
  assert.equal(generateRateLimitKey({ orgId: 'org-1', userId: 'u' }), 'generate:org:org-1');
  assert.equal(generateRateLimitKey({ userId: 'u' }), 'generate:user:u');
  assert.equal(generateRateLimitKey({}), null);
});

test('the per-org bucket rejects requests beyond its burst', async () => {
  process.env.RATE_LIMIT_BACKEND = 'memory';
  const { allowOrgRequest } = await import(`../../src/middleware/rate-limit.js?generate=${Math.random()}`);
  const key = generateRateLimitKey({ orgId: `org-${Math.random()}` });
  let allowed = 0;
  for (let i = 0; i < 100; i += 1) if (allowOrgRequest(key, { rpm: 30 })) allowed += 1;
  assert.ok(allowed <= 60 && allowed > 0);
});

test('Core applies the bounds and the rate limit before calling the provider', () => {
  const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("case '/api/generate':"), server.indexOf("case '/api/ingest/image':"));
  const call = route.indexOf('groqClient.generate(');
  assert.ok(route.indexOf('resolveGenerateRequest(body, GENERATE_LIMITS)') < call);
  assert.ok(route.indexOf('rateLimitAllowOrgRequest(generateBucket, { rpm: GENERATE_LIMITS.rpmPerOrg })') < call);
  assert.match(route, /maxTokens: generateRequest\.maxTokens/);
});
