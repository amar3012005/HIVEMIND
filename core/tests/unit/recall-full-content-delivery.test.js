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

test('recall delivery preserves wrapped memory IDs from reranker candidates', async () => {
  const router = await import('../../src/memory/recall-router.js');
  const wrapped = {
    memory: { id: 'wrapped-memory', title: 'Wrapped title', content: 'wrapped content', memory_type: 'fact', tags: ['product'] },
    score: 0.91,
  };
  assert.equal(router.recallMemoryRowId(wrapped), 'wrapped-memory');
  assert.deepEqual(router.serializeRecallMemory(wrapped, { includeFullContent: true }), {
    id: 'wrapped-memory', title: 'Wrapped title', content: 'wrapped content', memory_type: 'fact', tags: ['product'],
    score: 0.91, created_at: undefined, valid_at: undefined,
  });
});

test('evidence delivery preserves IDs and provenance across adapter naming conventions', async () => {
  const router = await import('../../src/memory/recall-router.js');
  const snake = router.serializeRecallEvidence({
    segment_id: 'snake-segment', document_id: 'snake-document', document_title: 'Snake source',
    content: 'snake content', page: 7,
  });
  const camel = router.serializeRecallEvidence({
    segmentId: 'camel-segment', documentId: 'camel-document', document: { title: 'Camel source' },
    content: 'camel content', metadata: { startPage: 4 },
  });
  assert.deepEqual(
    [snake.segment_id, snake.document_id, snake.document_title, snake.page],
    ['snake-segment', 'snake-document', 'Snake source', 7],
  );
  assert.deepEqual(
    [camel.segment_id, camel.document_id, camel.document_title, camel.page],
    ['camel-segment', 'camel-document', 'Camel source', 4],
  );
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

test('documented quick recall includes evidence while memory mode remains memory-only', async () => {
  const { shouldRecallEvidence } = await import('../../src/routes/recall.js');
  assert.equal(shouldRecallEvidence('quick'), true);
  assert.equal(shouldRecallEvidence('auto'), true);
  assert.equal(shouldRecallEvidence('hybrid'), true);
  assert.equal(shouldRecallEvidence('memory'), false);
});

test('answer delivery gives complete rank-one evidence before bounded lower-ranked snippets', async () => {
  const { evidenceExcerptForAnswer } = await import('../../src/agent/react-agent-v2.js');
  const full = 'Date 14 October 2026. Bring the blue referral letter, medication list, and blood-pressure diary.';
  assert.equal(evidenceExcerptForAnswer({ content: full, snippet: 'Bring the blue r…' }, 0), full);
  assert.equal(evidenceExcerptForAnswer({ content: full, snippet: 'lower-ranked snippet' }, 1), 'lower-ranked snippet');
});
