import test from 'node:test';
import assert from 'node:assert/strict';

import { buildUnifiedRecallResults } from '../../src/memory/unified-recall-results.js';

test('projects one authoritative mixed ranking without losing compatibility rows', () => {
  const memories = [
    { id: 'm1', content: 'memory one', score: 0.91, scope: 'personal' },
    { id: 'm2', content: 'memory two', score: 0.84 },
  ];
  const evidence = [
    { segment_id: 'e1', content: 'evidence one', score: 0.72, document_title: 'Deck.pdf' },
    { segment_id: 'e2', snippet: 'evidence two', score: 0.61 },
  ];
  const results = buildUnifiedRecallResults({
    memories,
    evidence,
    rankedCandidates: [
      { kind: 'evidence', segment_id: 'e1', rank: 1, score: 0.97 },
      { kind: 'memory', memory_id: 'm1', rank: 2, score: 0.93 },
      { kind: 'evidence', segment_id: 'e2', rank: 3, score: 0.79 },
      { kind: 'memory', memory_id: 'm2', rank: 4, score: 0.75 },
    ],
  });

  assert.deepEqual(results.map((row) => `${row.kind}:${row.id}`), [
    'evidence:e1', 'memory:m1', 'evidence:e2', 'memory:m2',
  ]);
  assert.deepEqual(results.map((row) => row.rank), [1, 2, 3, 4]);
  assert.equal(results[0].score, 0.97);
  assert.equal(results[0].citation_id, 'evidence:e1');
  assert.equal(results[1].citation_id, 'memory:m1');
});

test('filters unavailable ranked ids and interleaves remaining scoped rows', () => {
  const results = buildUnifiedRecallResults({
    memories: [{ id: 'allowed-memory', content: 'allowed' }],
    evidence: [{ segment_id: 'allowed-evidence', content: 'allowed evidence' }],
    rankedCandidates: [{ kind: 'memory', memory_id: 'out-of-scope', rank: 1, score: 0.99 }],
  });
  assert.deepEqual(results.map((row) => row.id), ['allowed-evidence', 'allowed-memory']);
  assert.deepEqual(results.map((row) => row.rank), [1, 2]);
});
