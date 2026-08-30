import test from 'node:test';
import assert from 'node:assert/strict';
import { assertChatRoute } from '../../src/knowledge/enterprise/litellm-client.js';

test('chat extraction rejects an embeddings provider base URL before network I/O', () => {
  assert.throws(
    () => assertChatRoute({
      base: 'https://embeddings.singulancelabs.com/v1',
      provider: 'litellm',
    }),
    /invalid chat route: custom-bge-embeddings/,
  );
});

test('chat extraction accepts the OpenRouter provider route', () => {
  const route = { base: 'https://openrouter.ai/api/v1', provider: 'openrouter' };
  assert.equal(assertChatRoute(route), route);
});
