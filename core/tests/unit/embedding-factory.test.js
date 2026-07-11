import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmbeddingProviders } from '../../src/embeddings/factory.js';

test('explicit embedding provider configuration wins', () => {
  assert.deepEqual(resolveEmbeddingProviders({
    EMBEDDING_PROVIDER: 'litellm',
    EMBEDDING_FALLBACK_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key'
  }), { primary: 'litellm', fallback: 'openrouter' });
});

test('unconfigured provider uses available OpenRouter credentials', () => {
  assert.deepEqual(resolveEmbeddingProviders({ OPENROUTER_API_KEY: 'test-key' }), {
    primary: 'openrouter',
    fallback: undefined
  });
});

test('unconfigured provider prefers LiteLLM and adds OpenRouter fallback', () => {
  assert.deepEqual(resolveEmbeddingProviders({
    LITELLM_API_KEY: 'test-key',
    OPENROUTER_API_KEY: 'fallback-key'
  }), { primary: 'litellm', fallback: 'openrouter' });
});
