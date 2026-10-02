import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayGeminiModel, ChatProviderError, retryableChatError } from '../../src/knowledge/enterprise/chat-contract.js';

test('Gemini model normalization accepts logical, native and already prefixed model IDs', () => {
  for (const model of ['google/gemini-2.5-flash-lite', 'gemini-2.5-flash-lite', 'google-ai-studio/gemini-2.5-flash-lite', 'google-ai-studio/google/gemini-2.5-flash-lite']) {
    assert.equal(gatewayGeminiModel(model), 'google-ai-studio/gemini-2.5-flash-lite');
  }
});
test('unchanged provider admission and request failures are not retryable', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const error = new ChatProviderError(status, 'provider rejected request');
    assert.equal(error.status, status);
    assert.equal(retryableChatError(error), false);
  }
  assert.equal(retryableChatError(new Error('Missing or invalid Authorization header')), false);
});
test('timeouts, rate limits, network failures and provider outages retain retry', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(retryableChatError(new ChatProviderError(status, 'temporary failure')), true);
  assert.equal(retryableChatError(new Error('Network error: connection reset')), true);
});
