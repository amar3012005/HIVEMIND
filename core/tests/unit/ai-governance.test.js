import test from 'node:test';
import assert from 'node:assert/strict';
import { configureAiGovernance, invalidateAiModelPolicyCache, normalizeModelPolicyInput, recordAiUsage, resolveAiModelPolicy, validateModelId } from '../../src/llm/ai-governance.js';

test('model policy input accepts the platform UI camelCase contract', () => {
  assert.deepEqual(normalizeModelPolicyInput({
    useCase: 'chat_synthesis', primaryModel: 'openai/gpt-oss-20b:nitro', secondaryModel: 'openai/gpt-4.1',
  }), {
    useCase: 'chat_synthesis', primaryModel: 'openai/gpt-oss-20b:nitro', secondaryModel: 'openai/gpt-4.1',
  });
  assert.deepEqual(normalizeModelPolicyInput({ policy: {
    use_case: 'chat_planner', primary_model: 'google/gemini-2.5-flash-lite', secondary_model: null,
  } }), {
    useCase: 'chat_planner', primaryModel: 'google/gemini-2.5-flash-lite', secondaryModel: null,
  });
});

test('model policy resolves an admin primary and secondary atomically', async () => {
  configureAiGovernance({ $queryRawUnsafe: async () => [{ use_case: 'chat_synthesis', primary_model: 'openai/gpt-oss-20b:nitro', secondary_model: 'nvidia/nemotron-3.5-lightning:nitro', enabled: true, revision: 7 }] });
  invalidateAiModelPolicyCache();
  const policy = await resolveAiModelPolicy('chat_synthesis', 'ignored/model');
  assert.equal(policy.primary, 'openai/gpt-oss-20b:nitro');
  assert.equal(policy.secondary, 'nvidia/nemotron-3.5-lightning:nitro');
  assert.equal(policy.revision, 7);
  configureAiGovernance(null); invalidateAiModelPolicyCache();
});

test('usage ledger prefers provider-reported cost over catalog estimation', async () => {
  let inserted = null;
  configureAiGovernance({
    $queryRawUnsafe: async () => [{ input_micros_per_million: 100000n, output_micros_per_million: 200000n, cache_read_micros_per_million: 10000n }],
    $executeRawUnsafe: async (...args) => { inserted = args; },
  });
  await recordAiUsage({ usage: { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0042 }, requestedModel: 'openai/test', servedModel: 'openai/test', provider: 'fast-provider', useCase: 'chat_synthesis', idempotencyKey: 'usage-test' });
  assert.ok(inserted);
  assert.equal(inserted[18], 4200n);
  assert.equal(inserted[19], 4200n);
  assert.equal(inserted[20], 'provider_reported');
  configureAiGovernance(null);
});

test('model identifiers reject URLs and credential-like free text', () => {
  assert.equal(validateModelId('openai/gpt-oss-20b:nitro'), 'openai/gpt-oss-20b:nitro');
  assert.throws(() => validateModelId('https://example.com/model'));
  assert.throws(() => validateModelId('secret bearer token'));
});
