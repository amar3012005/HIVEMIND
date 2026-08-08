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
