import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProgressiveRecallView,
  createProgressiveRecallSession,
  expandProgressiveRecall,
  shouldExpandProgressiveRecall,
} from '../../src/agent/progressive-recall-session.js';

const memories = Array.from({ length: 8 }, (_, index) => ({ id: `m${index + 1}`, content: `memory ${index + 1}` }));
const evidence = Array.from({ length: 8 }, (_, index) => ({ segment_id: `e${index + 1}`, content: `evidence ${index + 1}` }));
const rankedCandidates = Array.from({ length: 8 }, (_, index) => [
  { kind: 'evidence', segment_id: `e${index + 1}` },
  { kind: 'memory', memory_id: `m${index + 1}` },
]).flat();

test('reveals five mixed candidates first and expands the same recall without reranking', () => {
  const session = createProgressiveRecallSession({ rankedCandidates, memories, evidence, query: 'pitch deck', maxVisible: 15 });
  const first = applyProgressiveRecallView({ memories, evidence, recall_packets: [] }, session);
  assert.deepEqual(first.evidence.map((row) => row.segment_id), ['e1', 'e2', 'e3']);
  assert.deepEqual(first.memories.map((row) => row.id), ['m1', 'm2']);
  assert.equal(session.delivered_until, 5);

  const secondSession = expandProgressiveRecall(session);
  const second = applyProgressiveRecallView({ memories, evidence, recall_packets: [] }, secondSession);
  assert.equal(second.memories.length + second.evidence.length, 10);
  assert.equal(secondSession.recall_id, session.recall_id);
  assert.deepEqual(secondSession.candidates, session.candidates);
});

test('expands only on an explicit relevant-but-incomplete synthesis decision', () => {
  const session = createProgressiveRecallSession({ rankedCandidates, memories, evidence, query: 'small detail' });
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'sufficient' }, session), false);
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'query_mismatch' }, session), false);
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'relevant_but_incomplete' }, session), true);
});

test('packet restriction prevents citations to unrevealed rows', () => {
  const session = createProgressiveRecallSession({ rankedCandidates, memories, evidence, query: 'citation safety' });
  const packet = {
    facts: memories,
    sourceSections: evidence,
    citations: [
      ...memories.map((row, index) => ({ id: `M${index + 1}`, memory_id: row.id })),
      ...evidence.map((row, index) => ({ id: `E${index + 1}`, segment_id: row.segment_id })),
    ],
  };
  const view = applyProgressiveRecallView({ memories, evidence, recall_packets: [packet] }, session);
  assert.equal(view.recall_packets[0].citations.length, 5);
  assert.equal(view.recall_packets[0].citations.some((citation) => citation.memory_id === 'm8'), false);
  assert.equal(view.recall_packets[0].citations.some((citation) => citation.segment_id === 'e8'), false);
});

test('fallback interleaves lanes instead of comparing incompatible scores', () => {
  const session = createProgressiveRecallSession({ memories: memories.slice(0, 3), evidence: evidence.slice(0, 3), query: 'fallback' });
  assert.equal(session.degraded_order, true);
  assert.deepEqual(session.candidates.slice(0, 4).map((row) => row.kind), ['evidence', 'memory', 'evidence', 'memory']);
});
