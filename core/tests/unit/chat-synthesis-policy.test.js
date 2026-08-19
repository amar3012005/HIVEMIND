import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSynthesisFallbackChain,
  chooseSynthesisModel,
  hasGroundingEvidence,
  isCandidateSynthesisAcceptable,
  isFailClosedSynthesisResponse,
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

test('native recall reuses the planner query while missing/tool-enabled queries retain optimization', () => {
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: 'handbag color' }), false);
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: '' }), false);
  assert.equal(shouldOptimizeRecallQuery({ router: 'progressive', canonicalQuery: 'handbag color', useTools: true }), true);
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

test('a server-owned fail-closed response is distinguishable from malformed model output', () => {
  assert.equal(isFailClosedSynthesisResponse({
    grounded: false,
    response: 'I found relevant context, but could not produce a citation-valid answer.',
    claims: [],
    gaps: ['No citation-valid claim could be produced from the final recall packet.'],
  }), true);
  assert.equal(isFailClosedSynthesisResponse({ grounded: false, response: 'opaque', claims: [], gaps: [] }), false);
  assert.equal(isFailClosedSynthesisResponse(null), false);
});

test('grounded candidate validation is required only when the final packet contains evidence', () => {
  assert.equal(hasGroundingEvidence({ memories: [{ id: 'm1' }] }), true);
  assert.equal(hasGroundingEvidence({ evidence: [{ segment_id: 's1' }] }), true);
  assert.equal(hasGroundingEvidence({ recall_packets: [{ facts: [{ id: 'm1' }] }] }), true);
  assert.equal(hasGroundingEvidence({ recall_packets: [{ sourceSections: [{ segment_id: 's1' }] }] }), true);
  assert.equal(hasGroundingEvidence({ memories: [], evidence: [], recall_packets: [] }), false);
});

test('native progressive planning never starts a second query-rewrite call after zero coverage', () => {
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: false }, alreadyOptimized: false }), false);
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: true }, alreadyOptimized: false }), false);
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: false }, alreadyOptimized: true }), false);
  assert.equal(shouldRetryAfterZeroCoverage({ router: 'progressive', canonicalQuery: 'handbag brand', coverage: { evidence_found: false }, alreadyOptimized: false, useTools: true }), true);
});

test('GPT-OSS Nitro is default and Nemotron requires an explicit canary opt-in', () => {
  delete process.env.HIVEMIND_NEMOTRON_SYNTHESIS_ENABLED;
  const native = chooseSynthesisModel({
    operation: 'recall', recallMode: 'fact', useTools: false,
    currentModel: 'openai/gpt-oss-20b:nitro', shadowEnabled: true, canaryEnabled: true,
  });
  assert.equal(native.served, 'openai/gpt-oss-20b:nitro');
  assert.equal(native.shadow, null);
  assert.equal(native.eligible, false);
  assert.equal(native.fallback, 'openai/gpt-oss-20b:nitro');
  assert.equal(native.reasoning, 'provider_default');

  process.env.HIVEMIND_NEMOTRON_SYNTHESIS_ENABLED = 'true';
  const canary = chooseSynthesisModel({ operation: 'recall', recallMode: 'fact', useTools: false,
    currentModel: 'openai/gpt-oss-20b:nitro' });
  assert.equal(canary.served, 'nvidia/nemotron-3.5-lightning:nitro');
  assert.equal(canary.eligible, true);
  delete process.env.HIVEMIND_NEMOTRON_SYNTHESIS_ENABLED;

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
