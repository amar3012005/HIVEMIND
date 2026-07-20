import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChatIntentTool,
  intentDecisionToPlan,
  normalizeIntentDecision,
  parseChatIntent,
} from '../../src/agent/chat-intent-decision.js';

const GROUPS = [
  { name: 'hivemind-recall', description: 'Recall and graph', tools: [] },
  { name: 'hivemind-memory-write', description: 'Versioned writes', tools: [] },
];

const CASES = [
  ['en', 'Remember that SolvisPia launches in March 2027'],
  ['de', 'Merke dir, dass SolvisPia im Maerz 2027 startet'],
  ['fr', 'Souviens-toi que SolvisPia sera lance en mars 2027'],
  ['es', 'Recuerda que SolvisPia se lanza en marzo de 2027'],
  ['hi', 'याद रखो कि SolvisPia मार्च 2027 में लॉन्च होगा'],
  ['ar', 'تذكر أن SolvisPia سيطلق في مارس 2027'],
];

test('router contract selects save in six languages with one structured call', async () => {
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  try {
    for (const [language, message] of CASES) {
      let calls = 0;
      const result = await parseChatIntent({
      message,
      language,
      groupCatalog: GROUPS,
      projectCatalog: [{ id: 'project-1', name: 'SOLVIS', slug: 'solvis', description: 'Heating products' }],
      model: 'google/gemini-2.5-flash-lite',
      apiKey: 'test',
      fetchImpl: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        assert.equal(request.tool_choice.function.name, 'route_chat_turn');
        assert.match(request.messages[0].content, /Authorized projects/);
        assert.match(request.messages[0].content, /operation=relation_between/);
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { tool_calls: [{ function: {
                name: 'route_chat_turn',
                arguments: JSON.stringify({
                  operation: 'save', confidence: 0.96, response_language: language,
                  query_original: message,
                  query_canonical_en: 'SolvisPia launches in March 2027',
                  queries: [], named_entities: ['SolvisPia'], recall_mode: 'fact',
                  tool_groups: ['hivemind-memory-write'], side_effect_policy: 'read_only',
                  save: {
                    title: 'SolvisPia launch', content: 'SolvisPia launches in March 2027.',
                    memory_type: 'event', project_id: 'project-1', entities: ['SolvisPia'],
                    event_time: '2027-03-01T00:00:00.000Z', confidence: 0.96,
                  },
                  project_prompt: 'Choose a project.', acknowledgement: 'Saved.',
                }),
              } }] } }],
            };
          },
        };
      },
      });
      assert.equal(calls, 1);
      assert.equal(result.decision.operation, 'save');
      assert.equal(result.decision.save.project_id, 'project-1');
      assert.deepEqual(result.decision.save.entities, ['SolvisPia']);
      assert.equal(intentDecisionToPlan(result.decision, message).sub_queries.length, 0);
    }
  } finally {
    if (previousOpenRouterKey == null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  }
});

test('relation and query-based update are first-class, language-neutral operations', () => {
  const allowedGroups = GROUPS.map((group) => group.name);
  const relation = normalizeIntentDecision({
    operation: 'relation_between', confidence: 0.95, response_language: 'de',
    query_original: 'Wie haengen SolvisPia und SolvisMax zusammen?',
    query_canonical_en: 'relationship between SolvisPia and SolvisMax',
    queries: [], named_entities: ['SolvisPia', 'SolvisMax'], recall_mode: 'full',
    tool_groups: [], side_effect_policy: 'read_only',
    relation: { entities: ['SolvisPia', 'SolvisMax'] },
  }, { message: 'Wie haengen SolvisPia und SolvisMax zusammen?', language: 'de', allowedGroups });
  assert.equal(relation.operation, 'relation_between');
  assert.equal(relation.recall_mode, 'explain');
  assert.ok(relation.tool_groups.includes('hivemind-recall'));
  assert.deepEqual(intentDecisionToPlan(relation, relation.query_original).relation_intent.entities, ['SolvisPia', 'SolvisMax']);

  const update = normalizeIntentDecision({
    operation: 'update', confidence: 0.97, response_language: 'fr', queries: [], named_entities: ['SolvisPia'],
    recall_mode: 'fact', tool_groups: [], side_effect_policy: 'read_only',
    update: { target_query: 'SolvisPia launch date', content: 'SolvisPia launches in April 2027.' },
    acknowledgement: 'Mis a jour.',
  }, { message: 'Mets a jour la date', language: 'fr', allowedGroups });
  assert.equal(update.operation, 'update');
  assert.equal(update.update.target_query, 'SolvisPia launch date');
  assert.ok(update.tool_groups.includes('hivemind-memory-write'));
});

test('implicit saves require confidence 0.80 and full remains explicit-only', () => {
  const allowedGroups = GROUPS.map((group) => group.name);
  const low = normalizeIntentDecision({
    operation: 'recall', confidence: 0.9, response_language: 'en', queries: ['launch'],
    named_entities: [], recall_mode: 'full', tool_groups: ['hivemind-recall'], side_effect_policy: 'read_only',
    save: { title: 'Launch', content: 'The launch is in March.', confidence: 0.79 },
  }, { message: 'The launch is in March', language: 'en', allowedGroups });
  assert.equal(low.recall_mode, 'explain');
  assert.equal(intentDecisionToPlan(low, 'The launch is in March').auto_save_intent, null);

  const high = normalizeIntentDecision({ ...low, save: { ...low.save, confidence: 0.80 } }, {
    message: 'The launch is in March', language: 'en', allowedGroups,
  });
  assert.equal(intentDecisionToPlan(high, 'The launch is in March').auto_save_intent.confidence, 0.80);
  assert.ok(createChatIntentTool(GROUPS).function.parameters.properties.relation);
});
