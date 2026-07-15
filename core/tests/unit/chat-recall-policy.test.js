import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExplicitRecallControls,
  assessRecallCoverage,
  chooseRecallEscalation,
} from '../../src/agent/chat-recall-policy.js';
import { answerStep, buildChatCitationSources } from '../../src/agent/react-agent-v2.js';

test('document anchor with no exact source evidence produces one explain escalation', () => {
  const plan = { named_entities: [] };
  const memories = [{
    id: 'm1',
    title: 'Brochure summary',
    tags: ['doc-id:doc-1', 'filename:HIVEMIND Brochure.pdf'],
  }];
  const coverage = assessRecallCoverage({ plan, memories, evidence: [] });
  const escalation = chooseRecallEscalation({ plan, coverage, query: 'What does it say about approval?' });
  assert.equal(coverage.source_covered, false);
  assert.deepEqual(escalation, {
    reason: 'source_coverage',
    args: {
      query: 'What does it say about approval?',
      mode: 'explain',
      limit: 12,
      source_document_id: 'doc-1',
    },
  });
});

test('matching source evidence ends retrieval without another escalation', () => {
  const plan = { named_entities: [] };
  const memories = [{ id: 'm1', tags: ['doc-id:doc-1'] }];
  const evidence = [{ id: 'e1', document_id: 'doc-1', content: 'Human approval is required.' }];
  const coverage = assessRecallCoverage({ plan, memories, evidence });
  assert.equal(coverage.complete, true);
  assert.equal(chooseRecallEscalation({ plan, coverage, query: 'approval' }), null);
});

test('temporal escalation uses typed time and never requests full mode', () => {
  const plan = { named_entities: [], time: { known_at: '2026-01-01T00:00:00.000Z' } };
  const coverage = assessRecallCoverage({ plan, memories: [], evidence: [] });
  const escalation = chooseRecallEscalation({ plan, coverage, query: 'What was known then?' });
  assert.equal(escalation.args.mode, 'explain');
  assert.deepEqual(escalation.args.time, { known_at: '2026-01-01T00:00:00.000Z' });
});

test('ordinary titled memories do not trigger document hydration', () => {
  const plan = { named_entities: [] };
  const coverage = assessRecallCoverage({
    plan,
    memories: [{ id: 'm1', title: 'Current pricing', content: 'The price is EUR 79.' }],
    evidence: [],
  });
  assert.equal(coverage.source_requested, false);
  assert.equal(chooseRecallEscalation({ plan, coverage, query: 'price' }), null);
});

test('explicit chat recall controls win without erasing inferred fields when absent', () => {
  const inferred = { recall_mode: 'fact', source: { title: 'inferred.pdf' }, time: { valid_at: 'old' } };
  assert.deepEqual(applyExplicitRecallControls(inferred, {}), inferred);

  const controlled = applyExplicitRecallControls(inferred, {
    mode: 'full',
    source: { document_id: 'doc-1', title: ' Exact.pdf ' },
    time: { known_at: '2026-07-01T00:00:00Z' },
  });
  assert.equal(controlled.explicit_recall_mode, 'full');
  assert.deepEqual(controlled.source, { document_id: 'doc-1', title: 'Exact.pdf' });
  assert.deepEqual(controlled.time, { known_at: '2026-07-01T00:00:00Z' });
});

test('entity coverage includes exact source evidence without requiring a graph edge', () => {
  const coverage = assessRecallCoverage({
    plan: { named_entities: ['Human Approval'], needs_traverse: false },
    memories: [],
    evidence: [{ document_title: 'Policy.pdf', content: 'Human approval is mandatory.' }],
    relationships: [],
  });
  assert.equal(coverage.entities_covered, 1);
  assert.equal(coverage.graph_requested, false);
  assert.equal(coverage.complete, true);
});

test('source-specific chat fails closed when the single escalation still has no source passage', async () => {
  const answer = await answerStep({
    message: 'What does Policy.pdf say?',
    history: [],
    evidence: {
      coverage: { source_requested: true, source_covered: false },
      memories: [{ id: 'unrelated', title: 'Other document', content: 'Unrelated summary' }],
      evidence: [], relationships: [], recall_packets: [], live: [], synthesis_chains: [],
    },
    plan: {}, model: 'unused', apiKey: 'unused', ctx: {},
  });
  assert.equal(answer.response, 'No grounded workspace evidence found');
  assert.equal(answer.confidence, 0);
  assert.deepEqual(answer.evidence_used, []);
});

test('validated claim citations become server-owned public document sources', () => {
  const sources = buildChatCitationSources([{
    sourceSections: [{
      segment_id: 'seg-1',
      document_id: 'doc-1',
      document_title: 'Policy.pdf',
      content: 'Every action requires human approval.',
      score: 0.91,
    }],
    citations: [{ id: 'C1', segment_id: 'seg-1', document_id: 'doc-1', title: 'Policy.pdf' }],
  }], [{ text: 'Approval is required.', grounded: true, citation_ids: ['P1-C1'] }]);

  assert.deepEqual(sources, [{
    id: 'seg-1',
    citation_id: 'P1-C1',
    segment_id: 'seg-1',
    document_id: 'doc-1',
    title: 'Policy.pdf',
    snippet: 'Every action requires human approval.',
    page: null,
    source_type: 'document_evidence',
    score: 0.91,
  }]);
});
