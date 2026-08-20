import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSalvageTruncatedJson, buildModelFallbackChain } from '../src/knowledge/enterprise/litellm-client.js';

test('partial JSON salvage is reserved for provider-confirmed output truncation', () => {
  assert.equal(shouldSalvageTruncatedJson('length'), true);
  assert.equal(shouldSalvageTruncatedJson('stop'), false);
  assert.equal(shouldSalvageTruncatedJson(undefined), false);
});

test('admin model policy keeps an explicit cross-model fallback chain', () => {
  assert.deepEqual(
    buildModelFallbackChain({
      requested: ['deepseek/deepseek-v4-flash-0731', 'google/gemini-2.5-flash-lite'],
      policy: { source: 'admin', primary: 'openai/gpt-4.1', secondary: 'google/gemini-2.5-flash' },
    }),
    ['openai/gpt-4.1', 'google/gemini-2.5-flash', 'deepseek/deepseek-v4-flash-0731', 'google/gemini-2.5-flash-lite'],
  );
});

test('caller-selected fallback chain remains unchanged without an admin policy', () => {
  assert.deepEqual(
    buildModelFallbackChain({
      requested: ['deepseek/deepseek-v4-flash-0731', 'google/gemini-2.5-flash-lite'],
      policy: { source: 'caller', primary: 'deepseek/deepseek-v4-flash-0731', secondary: 'openai/gpt-oss-20b:nitro' },
    }),
    ['deepseek/deepseek-v4-flash-0731', 'google/gemini-2.5-flash-lite'],
  );
});
