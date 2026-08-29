import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyExplicitRecallControls,
  assessRecallCoverage,
  chooseRecallEscalation,
} from '../../src/agent/chat-recall-policy.js';
import { resolveAnswerModel } from '../../src/agent/react-agent-v2.js';
import { answerStep, buildChatCitationSources, groundedRecallFallback } from '../../src/agent/react-agent-v2.js';

test('explicit document anchor accepts exact document-backed memory coverage', () => {
  const plan = { named_entities: [], source: { document_id: 'doc-1', title: 'HIVEMIND Brochure.pdf' } };
  const memories = [{
    id: 'm1',
    title: 'Brochure summary',
    tags: ['doc-id:doc-1', 'filename:HIVEMIND Brochure.pdf'],
  }];
  const coverage = assessRecallCoverage({ plan, memories, evidence: [] });
  const escalation = chooseRecallEscalation({ plan, coverage, query: 'What does it say about approval?' });
  assert.equal(coverage.source_covered, true);
  assert.equal(coverage.complete, true);
  assert.equal(escalation, null);
});

test('source coverage recognizes promoted memory titles and evidence metadata filenames', () => {
  const plan = { named_entities: [], source: { title: 'Four-Minor Equivalence Plan.pdf' } };
  const memoryCoverage = assessRecallCoverage({
    plan,
    memories: [{ title: 'Four-Minor Equivalence Plan.pdf : Summary', source_metadata: { source_title: 'Four-Minor Equivalence Plan.pdf' } }],
    evidence: [],
  });
  assert.equal(memoryCoverage.source_covered, true);

  const evidenceCoverage = assessRecallCoverage({
    plan,
    memories: [],
    evidence: [{ title: 'Segment 1', source_metadata: {}, metadata: { filename: 'Four-Minor Equivalence Plan.pdf' } }],
  });
  assert.equal(evidenceCoverage.source_covered, true);
});

test('broad entity recall does not narrow to the first retrieved document', () => {
  const coverage = assessRecallCoverage({
    plan: { named_entities: ['Solvis'] },
    memories: [{
      id: 'm1',
      title: 'Solvis brochure summary',
      tags: ['doc-id:solvis-brochure', 'filename:Solvis brochure.pdf'],
    }],
    evidence: [],
  });

  assert.equal(coverage.source_requested, false);
  assert.equal(chooseRecallEscalation({ plan: {}, coverage, query: 'What do you know about Solvis?' }), null);
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

test('entity coverage includes exact source evidence', () => {
  const coverage = assessRecallCoverage({
    plan: { named_entities: ['Mira Chen'] },
    evidence: [{ document_id: 'doc-1', snippet: 'Approval belongs to Mira Chen.' }],
  });
  assert.equal(coverage.entities_covered, 1);
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
  assert.match(answer.response, /could not retrieve a verified passage/i);
  assert.equal(answer.confidence, 0);
  assert.deepEqual(answer.evidence_used, []);
});

test('chat synthesis honors explicit models and maps legacy defaults to Cerebras 120B', () => {
  assert.equal(resolveAnswerModel('custom/provider-model'), 'custom/provider-model');
  assert.equal(resolveAnswerModel('  '), 'cerebras/gpt-oss-120b');
  assert.equal(resolveAnswerModel('gpt-oss-120b'), 'cerebras/gpt-oss-120b');
  assert.equal(resolveAnswerModel('openai/gpt-oss-120b'), 'cerebras/gpt-oss-120b');
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

test('deterministic synthesis fallback never substitutes unrelated recalled passages', () => {
  const evidence = { recall_packets: [{
    sourceSections: [
      { segment_id: 'seg-paolo', content: 'Paolo owns sponsor alignment for the Italy beachhead.' },
      { segment_id: 'seg-noise', content: 'The platform uses a usage-based pricing model.' },
    ],
    citations: [
      { id: 'C1', segment_id: 'seg-paolo', title: 'Italy Sales Guide.pdf' },
      { id: 'C2', segment_id: 'seg-noise', title: 'Pricing Notes.pdf' },
    ],
  }] };
  const answer = groundedRecallFallback(evidence, 'en', 'Who is Paolo?');
  assert.match(answer.response, /Paolo owns sponsor alignment/);
  assert.doesNotMatch(answer.response, /usage-based pricing/);
  assert.deepEqual(answer.claims.flatMap((claim) => claim.citation_ids), ['P1-C1']);

  assert.equal(groundedRecallFallback(evidence, 'en', 'Who is Kruti?'), null);
});

test('empty fast recall is incomplete and escalates once to explain', () => {
  const plan = { user_message: 'what is the most groundbreaking thing with CSI' };
  const coverage = assessRecallCoverage({ plan, memories: [], evidence: [], relationships: [] });

  assert.equal(coverage.evidence_found, false);
  assert.equal(coverage.complete, false);
  assert.equal(chooseRecallEscalation({ plan, coverage, query: plan.user_message }), null);
});

test('a recalled memory is sufficient when no narrower coverage was requested', () => {
  const coverage = assessRecallCoverage({
    plan: {},
    memories: [{ id: 'm1', title: 'CSI integration', content: 'Shared cognitive substrate.' }],
  });

  assert.equal(coverage.evidence_found, true);
  assert.equal(coverage.complete, true);
  assert.equal(chooseRecallEscalation({ coverage, query: 'CSI' }), null);
});

test('complete entity aggregation returns an exact deterministic count without an LLM call', async () => {
  const answer = await answerStep({
    message: 'how many products are there in Solvis',
    history: [],
    evidence: {
      memories: [], evidence: [], recall_packets: [], relationships: [], live: [],
      aggregate: {
        count: 6,
        entity_kind: 'product',
        parent: 'Solvis',
        entities: [{ name: 'SolvisPia' }, { name: 'SolvisMax' }],
      },
      coverage: { aggregate_complete: true },
    },
    plan: {
      requires_complete_coverage: true,
      aggregate: { kind: 'products', parent: 'Solvis' },
    },
    language: 'en',
    model: 'unused', apiKey: 'unused', ctx: {},
  });
  assert.equal(answer.response, 'The canonical registry contains 6 entities associated with Solvis classified as products.');
  assert.equal(answer.grounded, true);
  assert.equal(answer.confidence, 0.99);
  assert.deepEqual(answer.claims[0].citation_ids, ['P1-A1']);
  assert.equal(answer.aggregate_citation_packet.citations[0].source_type, 'entity_aggregate');
});
