import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRecallEmbedding, embeddingCancellationOwnerKey } from '../../src/embeddings/recall-deadline.js';


test('embedding deadline cancels transport and awaits its settlement', async () => {
  let settled = false;
  const result = await boundedRecallEmbedding({ generateEmbedding: (_query, options) => new Promise((resolve) => {
    options.signal.addEventListener('abort', () => setTimeout(() => { settled = true; resolve(null); }, 5), { once: true });
  }) }, 'query', { timeoutMs: 10 });
  assert.equal(result, null);
  assert.equal(settled, true);
});

test('caller cancellation reaches actual transport and waits for settlement', async () => {
  const controller = new AbortController();
  let settled = false;
  const pending = boundedRecallEmbedding({ generateEmbedding: (_query, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => { settled = true; reject(new Error('transport aborted')); }, { once: true });
  }) }, 'query', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort(new Error('disconnected'));
  await assert.rejects(pending, /transport aborted/);
  assert.equal(settled, true);
});

test('already cancelled request starts no embedding transport', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already disconnected'));
  let calls = 0;
  await assert.rejects(boundedRecallEmbedding({ generateEmbedding: async () => { calls++; return [1]; } },
    'query', { signal: controller.signal }), /already disconnected/);
  assert.equal(calls, 0);
});

test('pending embeddings coalesce only under the same cancellation owner', () => {
  const first = new AbortController(); const second = new AbortController();
  assert.equal(embeddingCancellationOwnerKey(first.signal), embeddingCancellationOwnerKey(first.signal));
  assert.notEqual(embeddingCancellationOwnerKey(first.signal), embeddingCancellationOwnerKey(second.signal));
  assert.notEqual(embeddingCancellationOwnerKey(first.signal), embeddingCancellationOwnerKey(null));
});
