import test from 'node:test';
import assert from 'node:assert/strict';

test('recall delivery keeps its bounded default and supports internal full-content projection', async () => {
  const router = await import('../../src/memory/recall-router.js');
  assert.equal(typeof router.serializeRecallMemory, 'function');

  const content = `${'prefix '.repeat(80)}late-detail-ZX-91-Q`;
  const memory = { id: 'm1', title: 'Long memory', content, tags: ['fact'], score: 0.91234 };

  const bounded = router.serializeRecallMemory(memory);
  const full = router.serializeRecallMemory(memory, { includeFullContent: true });

  assert.equal(bounded.content.length, 400);
  assert.doesNotMatch(bounded.content, /late-detail-ZX-91-Q/);
  assert.equal(full.content, content);
  assert.match(full.content, /late-detail-ZX-91-Q/);
  assert.equal(full.score, 0.912);
});

test('structured recall permits semantic source resolution only on the bounded recovery attempt', async () => {
  const router = await import('../../src/memory/recall-router.js');
  assert.equal(typeof router.requireFilenameForImplicitSource, 'function');
  assert.equal(router.requireFilenameForImplicitSource({ structured_intent: true }), true);
  assert.equal(router.requireFilenameForImplicitSource({
    structured_intent: true,
    allow_semantic_source_recovery: true,
  }), false);
});

test('semantic recovery preserves a bounded rerank pool when the ordinary relevance floor is empty', async () => {
  const retrieval = await import('../../src/memory/persisted-retrieval.js');
  assert.equal(typeof retrieval.applyRecallRelevanceFloor, 'function');
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    memory: { id: `m-${index}` },
    score: 0.08 - index * 0.001,
    similarityScore: 0.05,
  }));

  assert.deepEqual(retrieval.applyRecallRelevanceFloor(candidates), []);
  const recovered = retrieval.applyRecallRelevanceFloor(candidates, { semanticRecovery: true });
  assert.equal(recovered.length, 24);
  assert.equal(recovered[0].memory.id, 'm-0');
});
