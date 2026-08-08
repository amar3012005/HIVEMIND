import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseSynthesisModel,
  shouldOptimizeRecallQuery,
  summarizeUsage,
} from '../../src/agent/chat-synthesis-policy.js';

test('router canonical query suppresses duplicate query optimization', () => {
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: 'handbag color' }), false);
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: '' }), true);
});

test('DeepSeek shadow is eligible only for native fact recall and never becomes the served compound model', () => {
  const shadow = chooseSynthesisModel({
    operation: 'recall', recallMode: 'fact', useTools: false,
    currentModel: 'cerebras/gpt-oss-120b', shadowEnabled: true, canaryEnabled: false,
  });
  assert.equal(shadow.served, 'cerebras/gpt-oss-120b');
  assert.equal(shadow.shadow, 'deepseek/deepseek-v4-flash-0731');

  const canary = chooseSynthesisModel({
    operation: 'recall', recallMode: 'fact', useTools: false,
    currentModel: 'cerebras/gpt-oss-120b', shadowEnabled: true, canaryEnabled: true,
  });
  assert.equal(canary.served, 'deepseek/deepseek-v4-flash-0731');
  assert.equal(canary.shadow, null);

  const compound = chooseSynthesisModel({
    operation: 'compound', recallMode: 'fact', useTools: true,
    currentModel: 'cerebras/gpt-oss-120b', shadowEnabled: true, canaryEnabled: true,
  });
  assert.equal(compound.served, 'cerebras/gpt-oss-120b');
  assert.equal(compound.shadow, null);
});

test('usage summary separates cached and uncached input from per-stage usage', () => {
  const usage = summarizeUsage({
    router: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } },
    optimizer: { prompt_tokens: 20, completion_tokens: 2 },
    synthesis: { prompt_tokens: 300, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 200 } },
  });
  assert.deepEqual(usage, {
    prompt_tokens: 420,
    completion_tokens: 42,
    total_tokens: 462,
    cached_prompt_tokens: 280,
    uncached_prompt_tokens: 140,
  });
});
