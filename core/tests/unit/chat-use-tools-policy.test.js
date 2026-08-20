import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToDecision, getProgressiveTools } from '../../src/agent/chat-progressive-router.js';

test('use_tools false never discloses connected or compound capabilities', () => {
  const names = getProgressiveTools({ useTools: false }).map((tool) => tool.function.name);
  assert.ok(names.includes('hivemind_context'));
  // Native turns preload profile context but must still use the hybrid recall
  // path, so the planner never gets a profile-only bypass capability.
  assert.equal(names.includes('hivemind_profile'), false);
  assert.ok(names.includes('hivemind_memory'));
  assert.equal(names.includes('use_connector'), false);
  assert.equal(names.includes('use_campaign'), false);
  assert.equal(names.includes('compound_plan'), false);
});

test('native planner requests a semantic retrieval expression instead of a copied query', () => {
  const context = getProgressiveTools({ useTools: false })
    .find((tool) => tool.function.name === 'hivemind_context');
  assert.deepEqual(context.function.parameters.properties.native_tool.enum, [
    'hivemind_recall', 'hivemind_at', 'hivemind_diff', 'hivemind_timeline',
    'hivemind_aggregate_entities', 'hivemind_relation_between',
  ]);
  assert.deepEqual(context.function.parameters.properties.temporal_axis.enum, [
    'none', 'valid_time', 'known_time',
  ]);
  const description = context.function.parameters.properties.query_canonical_en.description;
  assert.match(description, /intent-preserving English retrieval expression/);
  assert.match(description, /names\/models\/variants\/categories/);
  assert.deepEqual(
    context.function.parameters.properties.retrieval_shape.enum,
    ['fact', 'inventory', 'overview', 'comparison'],
  );
  assert.deepEqual(
    context.function.parameters.properties.answer_scope.enum,
    ['exhaustive', 'broad', 'bounded'],
  );
  assert.deepEqual(
    context.function.parameters.properties.answer_completion_requirement.enum,
    ['complete_set', 'multi_facet', 'single_answer'],
  );
});

test('semantic exhaustive scope cannot be reduced to a five-item answer window', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_recall', temporal_axis: 'none', operation: 'recall', temporal_semantics: 'none',
    query_original: 'complete account of this person', query_canonical_en: 'all recorded claims about the named person',
    response_language: 'en', mode: 'full', entities: ['Person'], answer_scope: 'exhaustive',
    response_depth: 'standard', retrieval_shape: 'overview', answer_objective: 'Give the complete account.',
    source_title: null, valid_at: null, known_at: null, range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  }, 'Give me the complete account of this person.', 'en', { useTools: false });
  assert.equal(decision.answer_scope, 'exhaustive');
  assert.equal(decision.response_depth, 'comprehensive');
});

test('complete-set commitment protects against a contradictory bounded scope', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_recall', temporal_axis: 'none', operation: 'recall', temporal_semantics: 'none',
    query_original: 'complete retained claims', query_canonical_en: 'all retained claims for named subject',
    response_language: 'en', mode: 'full', entities: ['Person'], answer_scope: 'bounded',
    answer_completion_requirement: 'complete_set', response_depth: 'standard', retrieval_shape: 'fact',
    answer_objective: 'Collect the complete retained set.', source_title: null,
    valid_at: null, known_at: null, range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  }, 'Complete retained claims for this person.', 'en', { useTools: false });
  assert.equal(decision.answer_scope, 'exhaustive');
  assert.equal(decision.response_depth, 'comprehensive');
});

test('semantic broad scope cannot be reduced to a five-item answer window', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_recall', temporal_axis: 'none', operation: 'recall', temporal_semantics: 'none',
    query_original: 'multi-facet overview', query_canonical_en: 'subject facets and related records',
    response_language: 'en', mode: 'explain', entities: ['Subject'], answer_scope: 'broad',
    response_depth: 'standard', retrieval_shape: 'overview', answer_objective: 'Give a useful overview.',
    source_title: null, valid_at: null, known_at: null, range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  }, 'Give a useful overview.', 'en', { useTools: false });
  assert.equal(decision.answer_scope, 'broad');
  assert.equal(decision.response_depth, 'detailed');
});

test('use_tools true discloses connected and compound capabilities', () => {
  const tools = getProgressiveTools({ useTools: true });
  const names = tools.map((tool) => tool.function.name);
  assert.ok(names.includes('use_connector'));
  assert.ok(names.includes('use_campaign'));
  assert.ok(names.includes('compound_plan'));
  assert.equal(names.includes('hivemind_profile'), false);
  const context = tools.find((tool) => tool.function.name === 'hivemind_context');
  assert.equal('native_tool' in context.function.parameters.properties, false);
  const connector = tools.find((tool) => tool.function.name === 'use_connector');
  assert.ok(connector.function.parameters.properties.provider.enum.includes('google-calendar'));
  assert.ok(connector.function.parameters.properties.provider.enum.includes('google-tasks'));
});

test('native profile is an explicit language-independent capability', () => {
  const { decision } = adaptToDecision('hivemind_profile', {
    target: 'organization', query_original: '組織のプロフィールを教えて',
    response_language: 'ja', answer_objective: 'Describe the maintained organization profile.',
  }, '組織のプロフィールを教えて', 'ja', { useTools: false });
  assert.equal(decision.operation, 'profile');
  assert.deepEqual(decision.queries, []);
  assert.equal(decision.profile_target, 'organization');
});

test('native tool selection is authoritative over an inconsistent high-level operation', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_at', temporal_axis: 'valid_time', operation: 'recall', temporal_semantics: 'none',
    query_original: 'What was true then?', query_canonical_en: 'workspace truth at 2026-08-08',
    response_language: 'en', mode: 'fact', entities: [], response_depth: 'standard',
    retrieval_shape: 'fact', answer_objective: 'State what was true.', source_title: null,
    valid_at: '2026-08-08', known_at: null, range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  }, 'What was true on 2026-08-08?', 'en', { useTools: false });
  assert.equal(decision.operation, 'timeline');
  assert.equal(decision.native_tool, 'hivemind_at');
  assert.equal(decision.temporal_axis, 'valid_time');
  assert.equal(decision.time.kind, 'snapshot_at');
});

test('native point-in-time axis cannot populate both valid and known time', () => {
  const common = {
    native_tool: 'hivemind_at', operation: 'temporal', temporal_semantics: 'snapshot_at',
    query_original: 'time question', query_canonical_en: 'Solvis at 2026-08-01',
    response_language: 'en', mode: 'fact', entities: [], response_depth: 'standard',
    retrieval_shape: 'fact', answer_objective: 'Answer the snapshot.', source_title: null,
    valid_at: '2026-08-01', known_at: '2026-08-01', range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  };
  const known = adaptToDecision('hivemind_context', { ...common, temporal_axis: 'known_time' }, 'What did we know?', 'en', { useTools: false }).decision;
  assert.equal(known.time.valid_at, null);
  assert.equal(known.time.known_at, '2026-08-01');
  const valid = adaptToDecision('hivemind_context', { ...common, temporal_axis: 'valid_time' }, 'What was true?', 'en', { useTools: false }).decision;
  assert.equal(valid.time.valid_at, '2026-08-01');
  assert.equal(valid.time.known_at, null);
});

test('native aggregate and relation selections compile their required executor inputs', () => {
  const common = {
    operation: 'recall', temporal_semantics: 'none', query_original: 'request',
    response_language: 'en', mode: 'explain', response_depth: 'detailed',
    retrieval_shape: 'inventory', answer_objective: 'answer', source_title: null,
    valid_at: null, known_at: null, range_start: null, range_end: null,
    answer_type: 'relationship',
  };
  const aggregate = adaptToDecision('hivemind_context', {
    ...common, native_tool: 'hivemind_aggregate_entities',
    query_canonical_en: 'Solvis product registry', entities: ['Solvis'], aggregate_kind: 'product',
  }, 'Count every registered Solvis product', 'en', { useTools: false }).decision;
  assert.equal(aggregate.operation, 'aggregate');
  assert.deepEqual(aggregate.aggregate, {
    parent: 'Solvis', kind: 'product', requires_complete_coverage: true,
  });

  const relation = adaptToDecision('hivemind_context', {
    ...common, native_tool: 'hivemind_relation_between',
    query_canonical_en: 'relationship between Solvis and SolvisLea',
    entities: ['Solvis', 'SolvisLea'], aggregate_kind: null,
  }, 'How are Solvis and SolvisLea related?', 'en', { useTools: false }).decision;
  assert.equal(relation.operation, 'relation_between');
  assert.deepEqual(relation.relation, { entities: ['Solvis', 'SolvisLea'] });
});

test('native source reads retain an exact filename supplied as a planner entity', () => {
  const title = 'Solvis Elektrifizierung 2025.pdf';
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_recall', temporal_axis: 'none', operation: 'source_read',
    temporal_semantics: 'none', query_original: `Tell me about ${title}`,
    query_canonical_en: `summary and passages from ${title}`, response_language: 'en',
    mode: 'explain', entities: [title], response_depth: 'standard',
    retrieval_shape: 'overview', answer_objective: 'Summarize the file.', source_title: null,
    valid_at: null, known_at: null, range_start: null, range_end: null,
    aggregate_kind: null, answer_type: 'fact',
  }, `Tell me about ${title}`, 'en', { useTools: false });
  assert.equal(decision.operation, 'source_read');
  assert.deepEqual(decision.source, { title });
});

test('connection-aware tools disclose only active connector providers', () => {
  const tools = getProgressiveTools({ useTools: true, connectedProviders: ['gmail', 'slack', 'unknown-provider'] });
  const connector = tools.find((tool) => tool.function.name === 'use_connector');
  assert.deepEqual(connector.function.parameters.properties.provider.enum, ['gmail', 'slack', 'unknown-provider']);
  assert.ok(tools.some((tool) => tool.function.name === 'compound_plan'));
  assert.ok(tools.some((tool) => tool.function.name === 'hivemind_context'));
});

test('connection-aware tools omit connector execution when no external account is active', () => {
  const tools = getProgressiveTools({ useTools: true, connectedProviders: [] });
  assert.equal(tools.some((tool) => tool.function.name === 'use_connector'), false);
  assert.ok(tools.some((tool) => tool.function.name === 'hivemind_context'));
});

test('a malformed connector decision is downgraded when use_tools is false', () => {
  const { decision } = adaptToDecision('use_connector', {
    provider: 'gmail', intent: 'read', request: 'recent mail', response_language: 'en',
  }, 'Find my recent email', 'en', { useTools: false });
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.tool_groups, ['hivemind-recall']);
});

test('connector router preserves language-independent newest retrieval semantics', () => {
  const { decision } = adaptToDecision('use_connector', {
    provider: 'gmail', intent: 'read', request: 'Worum ging es in meiner letzten E-Mail?', response_language: 'de',
    result_order: 'newest', result_limit: 1, has_explicit_filter: false,
  }, 'Worum ging es in meiner letzten E-Mail?', 'de', { useTools: true });
  assert.equal(decision.operation, 'connector_read');
  assert.deepEqual(decision.connector_retrieval, {
    result_order: 'newest', result_limit: 1, has_explicit_filter: false,
  });
});
