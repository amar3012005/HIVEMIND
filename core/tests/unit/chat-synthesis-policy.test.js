import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSynthesisFallbackChain,
  chooseSynthesisModel,
  isCandidateSynthesisAcceptable,
  normalizeJsonObject,
  parseJsonObjectContent,
  scheduleShadowEvaluation,
  shouldRetryAfterZeroCoverage,
  shouldOptimizeRecallQuery,
  shouldRunRecallOptimizer,
  summarizeUsage,
} from '../../src/agent/chat-synthesis-policy.js';

test('synthesis fallback chain preserves candidate, requested model, and final safety model without duplicates', () => {
  assert.deepEqual(buildSynthesisFallbackChain({
    served: 'nvidia/nemotron-3.5-lightning:nitro',
    requested: 'openai/gpt-oss-20b:nitro',
    finalFallback: 'openai/gpt-oss-120b',
  }), [
    'nvidia/nemotron-3.5-lightning:nitro',
    'openai/gpt-oss-20b:nitro',
    'openai/gpt-oss-120b',
  ]);
  assert.deepEqual(buildSynthesisFallbackChain({
    served: 'openai/gpt-oss-20b:nitro',
    requested: 'openai/gpt-oss-20b:nitro',
    finalFallback: 'openai/gpt-oss-20b:nitro',
  }), ['openai/gpt-oss-20b:nitro']);
});

test('JSON synthesis normalizes provider nulls and scalars to an object', () => {
  assert.deepEqual(normalizeJsonObject(null), {});
  assert.deepEqual(normalizeJsonObject([]), {});
  assert.deepEqual(normalizeJsonObject('null'), {});
  assert.deepEqual(normalizeJsonObject({ response: 'ok' }), { response: 'ok' });
  assert.deepEqual(parseJsonObjectContent('null'), {});
  assert.deepEqual(parseJsonObjectContent('prefix {"response":"ok"} suffix'), { response: 'ok' });
  assert.deepEqual(parseJsonObjectContent('not JSON'), {});
});

test('every retrieval-bearing turn receives one query optimization pass', () => {
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: 'handbag color' }), true);
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: '' }), true);
  assert.equal(shouldRunRecallOptimizer({ operation: 'recall' }), true);
  assert.equal(shouldRunRecallOptimizer({ operation: 'timeline' }), true);
  assert.equal(shouldRunRecallOptimizer({ operation: 'connector_read' }), false);
});

test('shadow evaluation is scheduled without blocking the served response', async () => {
  let completed;
  const result = new Promise((resolve) => { completed = resolve; });
  const returned = scheduleShadowEvaluation({
    execute: async () => ({ grounded: true, claims: [] }),
    onResult: completed,
  });
  assert.equal(returned, undefined);
  assert.equal((await result).ok, true);
});

test('candidate synthesis must be fully grounded and cited before it can suppress GPT-OSS fallback', () => {
  assert.equal(isCandidateSynthesisAcceptable({ grounded: true, response: 'G ROCHER', claims: [{ grounded: true, citation_ids: ['P1-C1'] }] }), true);
  assert.equal(isCandidateSynthesisAcceptable({ grounded: false, response: 'Unavailable', claims: [] }), false);
  assert.equal(isCandidateSynthesisAcceptable({ grounded: true, response: 'G ROCHER', claims: [{ grounded: true, citation_ids: [] }] }), false);
});

test('progressive canonical query is rewritten only after first recall has zero coverage', () => {
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: false }, alreadyOptimized: false }), true);
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: true }, alreadyOptimized: false }), false);
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: false }, alreadyOptimized: true }), false);
});

test('Nemotron serves only native fact recall and preserves GPT-OSS as fallback', () => {
  const native = chooseSynthesisModel({
    operation: 'recall', recallMode: 'fact', useTools: false,
    currentModel: 'openai/gpt-oss-20b:nitro', shadowEnabled: true, canaryEnabled: true,
  });
  assert.equal(native.served, 'nvidia/nemotron-3.5-lightning:nitro');
  assert.equal(native.shadow, null);
  assert.equal(native.eligible, true);
  assert.equal(native.fallback, 'openai/gpt-oss-20b:nitro');
  assert.equal(native.reasoning, 'disabled');

  const compound = chooseSynthesisModel({
    operation: 'compound', recallMode: 'fact', useTools: true,
    currentModel: 'openai/gpt-oss-20b:nitro', shadowEnabled: true, canaryEnabled: true,
  });
  assert.equal(compound.served, 'openai/gpt-oss-20b:nitro');
  assert.equal(compound.shadow, null);
  assert.equal(compound.eligible, false);
});

test('usage summary separates cached and uncached input from per-stage usage', () => {
  const usage = summarizeUsage({
    router: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 } },
    optimizer: { prompt_tokens: 20, completion_tokens: 2 },
    synthesis: { prompt_tokens: 300, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 } },
  });
  assert.deepEqual(usage, {
    prompt_tokens: 420,
    completion_tokens: 42,
    total_tokens: 462,
    cached_prompt_tokens: 280,
    uncached_prompt_tokens: 140,
    cache_write_prompt_tokens: 100,
    cache_hit_ratio: 0.6667,
  });
});
