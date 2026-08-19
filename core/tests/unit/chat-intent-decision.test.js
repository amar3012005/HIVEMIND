import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatIntentTool,
  intentDecisionToPlan,
  normalizeIntentDecision,
  parseChatIntent,
} from '../../src/agent/chat-intent-decision.js';

const catalog = [
  { name: 'hivemind-recall', description: 'Scoped memory and evidence', tools: [{ name: 'hivemind_recall', description: 'Recall', readOnly: true }] },
  { name: 'hivemind-memory-write', description: 'Versioned memory writes', tools: [{ name: 'hivemind_save_memory', description: 'Save', readOnly: false }] },
  { name: 'gmail', description: 'Gmail tools', tools: [{ name: 'gmail_search_threads', description: 'Search', readOnly: true }] },
];

function parserFetch(payload, capture = {}) {
  return async (_url, options) => {
    capture.body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { tool_calls: [{ function: { name: 'route_chat_turn', arguments: JSON.stringify(payload) } }] } }],
          usage: { total_tokens: 17 },
        };
      },
    };
  };
}

const base = {
  confidence: 0.99,
  response_language: 'de-DE',
  queries: [],
  named_entities: [],
  recall_mode: 'fact',
  response_depth: 'standard',
  answer_objective: 'Answer the request directly.',
  tool_groups: [],
  side_effect_policy: 'read_only',
};

test('fast parser receives bounded multilingual history and server capability descriptions', async () => {
  const capture = {};
  const { decision, usage } = await parseChatIntent({
    message: 'Was steht in Überprüfung_日本語.pdf über Freigaben?',
    language: 'de-DE',
    history: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Verlauf ${i}` })),
    groupCatalog: catalog,
    model: 'fast-intent-model', apiKey: 'test',
    fetchImpl: parserFetch({
      ...base, operation: 'source_read', queries: ['Freigaben'], named_entities: ['Überprüfung_日本語.pdf'],
      recall_mode: 'explain', tool_groups: ['hivemind-recall'],
      source: { title: 'Überprüfung_日本語.pdf' },
    }, capture),
  });
  assert.equal(decision.operation, 'source_read');
  assert.equal(decision.source.title, 'Überprüfung_日本語.pdf');
  assert.equal(capture.body.messages.slice(1, -1).length, 6);
  assert.equal(capture.body.tool_choice.function.name, 'route_chat_turn');
  assert.match(capture.body.messages[0].content, /hivemind-recall/);
  assert.match(capture.body.messages[0].content, /top-K recall answer cannot certify completeness/);
  assert.match(capture.body.messages[0].content, /useful inventory.*response_depth=detailed/);
  assert.match(capture.body.messages[0].content, /Choose response_depth semantically/);
  assert.equal(usage.total_tokens, 17);
});

test('normalizer enforces discriminated operations and strips unauthorized groups', () => {
  const invalidWrite = normalizeIntentDecision({
    ...base, operation: 'connector_write', connector_provider: 'gmail', tool_groups: ['admin', 'gmail'],
    failure_response: 'Die Verbindung ist derzeit nicht verfügbar.',
    acknowledgement: 'Der Entwurf wartet auf Freigabe.',
  }, { message: '任意の依頼', language: 'ja', allowedGroups: ['gmail'] });
  assert.equal(invalidWrite.operation, 'connector_write');
  assert.deepEqual(invalidWrite.tool_groups, ['gmail']);
  assert.equal(invalidWrite.side_effect_policy, 'approval_required');

  const missingAggregate = normalizeIntentDecision({ ...base, operation: 'aggregate', tool_groups: ['hivemind-recall'] }, {
    message: 'كم عدد المنتجات؟', language: 'ar', allowedGroups: ['hivemind-recall'],
  });
  assert.equal(missingAggregate.operation, 'recall');
  assert.equal(missingAggregate.parser_fallback, 'invalid_intent_combination');
});

test('parser outage fails to unchanged scoped recall and never to a write', async () => {
  const { decision } = await parseChatIntent({
    message: '保存して', language: 'ja', groupCatalog: catalog, model: 'fast', apiKey: 'test',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.queries, ['保存して']);
  assert.equal(decision.side_effect_policy, 'read_only');
  assert.equal(decision.parser_fallback, 'offline');
});

test('intent plan carries aggregate, time, scope, save and continuation structurally', () => {
  const aggregate = normalizeIntentDecision({
    ...base, operation: 'aggregate', queries: ['Solvis'], tool_groups: ['hivemind-recall'],
    aggregate: { parent: 'Solvis', kind: 'product' },
    time: { known_at: '2026-07-01T00:00:00Z' }, scope_filter: 'project',
  }, { message: 'produkter?', language: 'sv', allowedGroups: ['hivemind-recall'] });
  const plan = intentDecisionToPlan(aggregate, 'produkter?');
  assert.equal(plan.requires_complete_coverage, true);
  assert.equal(plan.recall_time.known_at, '2026-07-01T00:00:00Z');
  assert.equal(plan.scope_filter, 'project');
  assert.equal(plan.response_depth, 'standard');
  assert.equal(plan.answer_objective, 'Answer the request directly.');

  const save = normalizeIntentDecision({
    ...base, operation: 'save', tool_groups: [], acknowledgement: 'Gespeichert.', project_prompt: 'Welches Projekt?',
    save: { title: 'Beschluss', content: 'SOLVIS startet im August.', confidence: 0.98 },
    continuation: { kind: 'project_choice', project_hint: 'SOLVIS', selected_scope: 'project' },
  }, { message: 'speichern', language: 'de', allowedGroups: ['hivemind-memory-write'] });
  const savePlan = intentDecisionToPlan(save, 'speichern');
  assert.equal(savePlan.save_intent.content, 'SOLVIS startet im August.');
  assert.equal(savePlan.continuation.project_hint, 'SOLVIS');
  assert.deepEqual(save.tool_groups, ['hivemind-memory-write']);
});

test('a high-confidence user assertion is preserved as attributable memory context', () => {
  const decision = normalizeIntentDecision({
    ...base,
    operation: 'recall', queries: ['Kruti'], named_entities: ['Kruti'],
    tool_groups: ['hivemind-recall'],
    save: {
      title: 'Note about Kruti', content: 'The user made an assertion about Kruti.',
      tags: ['entity:Kruti', 'source:chat'], confidence: 0.91,
      admission_class: 'user_assertion',
    },
  }, { message: 'The user made an assertion about Kruti.', language: 'en', allowedGroups: ['hivemind-recall'] });

  const plan = intentDecisionToPlan(decision, 'The user made an assertion about Kruti.');
  assert.equal(decision.save.admission_class, 'user_assertion');
  assert.equal(plan.auto_save_intent.admission_class, 'user_assertion');
  assert.equal(plan.auto_save_intent.content, 'The user made an assertion about Kruti.');
});

test('intent tool is a closed schema with a required tool call contract', () => {
  const tool = createChatIntentTool(catalog);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.ok(tool.function.parameters.required.includes('operation'));
  assert.ok(tool.function.parameters.required.includes('response_depth'));
  assert.ok(tool.function.parameters.required.includes('answer_objective'));
  assert.match(tool.function.parameters.properties.operation.description, /certified exact count/);
  assert.deepEqual(tool.function.parameters.properties.tool_groups.items.enum, catalog.map((group) => group.name));
});
