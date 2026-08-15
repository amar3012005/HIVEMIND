import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProgressiveRecallView,
  collapseNativeOnlyCompoundDecision,
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

test('use_tools native-only compound plans collapse to the identical native recall path', () => {
  const decision = collapseNativeOnlyCompoundDecision({
    operation: 'compound',
    subtasks: [
      { authority: 'read', tool_groups: ['hivemind-recall'], message: 'pitch deck' },
      { authority: 'read', tool_groups: ['hivemind-recall'], message: 'latest pitch deck' },
    ],
  }, 'What do you think about my latest pitch deck?');
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
  assert.equal(decision.subtasks, undefined);
  assert.equal(decision._native_compound_collapsed, true);
});

test('a compound plan containing any external toolkit remains on the governed compound path', () => {
  const original = {
    operation: 'compound',
    subtasks: [
      { authority: 'read', tool_groups: ['hivemind-recall'], message: 'company details' },
      { authority: 'write', tool_groups: ['gmail'], message: 'email them' },
    ],
  };
  assert.equal(collapseNativeOnlyCompoundDecision(original, 'email company details'), original);
});

test('multiple native read groups collapse even when the planner aliases the recall capability', () => {
  const decision = collapseNativeOnlyCompoundDecision({
    operation: 'compound',
    subtasks: [
      { authority: 'read', output_kind: 'knowledge', tool_groups: ['hivemind-recall'], message: 'deck' },
      { authority: 'read', output_kind: 'generic', tool_groups: ['hivemind-projects'], message: 'latest deck' },
    ],
  }, 'review latest deck');
  assert.equal(decision.operation, 'recall');
  assert.equal(decision._native_compound_collapsed, true);
});

test('read-only capabilities win over a hallucinated write label in a native analysis plan', () => {
  const decision = collapseNativeOnlyCompoundDecision({
    operation: 'compound',
    subtasks: [
      { authority: 'read', output_kind: 'knowledge', tool_groups: ['hivemind-recall'], message: 'retrieve deck' },
      { authority: 'write', output_kind: 'document', tool_groups: ['hivemind-recall'], message: 'give feedback' },
    ],
  }, 'review latest deck');
  assert.equal(decision.operation, 'recall');
  assert.equal(decision._native_compound_collapsed, true);
});

test('native memory writes remain on the governed compound path', () => {
  const original = {
    operation: 'compound',
    subtasks: [{ authority: 'write', tool_groups: ['hivemind-memory-write'], message: 'save this' }],
  };
  assert.equal(collapseNativeOnlyCompoundDecision(original, 'save this'), original);
});

test('expands only on an explicit relevant-but-incomplete synthesis decision', () => {
  const session = createProgressiveRecallSession({ rankedCandidates, memories, evidence, query: 'small detail' });
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'sufficient' }, session), false);
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'query_mismatch' }, session), false);
  assert.equal(shouldExpandProgressiveRecall({ context_status: 'relevant_but_incomplete' }, session), false);
  assert.equal(shouldExpandProgressiveRecall({
    context_status: 'relevant_but_incomplete',
    claims: [{ text: 'The first page establishes the project.', grounded: true, citation_ids: ['P1-C1'] }],
  }, session), true);
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
