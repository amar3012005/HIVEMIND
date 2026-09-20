import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_OPTIONS,
  DecisionGateway,
  chooseCapability,
  chooseComposioAction,
  chooseHiveRecallPolicy,
  createDecisionTurnState,
  createOpenRouterJevProvider,
  projectComposioDiscovery,
  translateRecallPolicy,
} from '../../src/agent/decision-gateway.js';
import { runSelectedReadProof } from '../../src/agent/decision-gateway-reference.js';
import { createDecisionRuntimeAdapter } from '../../src/agent/decision-gateway-adapters.js';

function choiceProvider(sequence) {
  let index = 0;
  return {
    async decideChoice() { return sequence[index++]; },
    async decideQuestions() { return sequence[index++]; },
  };
}

function discovery({ gmailConnected = true, instagramConnected = true } = {}) {
  return {
    sessionId: 'trs_decision_test',
    toolkitConnectionStatuses: {
      gmail: { has_active_connection: gmailConnected },
      instagram: { has_active_connection: instagramConnected },
    },
    tools: [
      {
        type: 'function',
        function: { name: 'composio_gmail_fetch_emails', description: 'Fetch Gmail messages. Sort by internalDate.',
          parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } },
        _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', read_only: true },
      },
      {
        type: 'function',
        function: { name: 'composio_instagram_send_text_message', description: 'Send in an existing Instagram conversation.',
          parameters: { type: 'object', required: ['recipient_id', 'text'], properties: { recipient_id: { type: 'string' }, text: { type: 'string' } } } },
        _composio: { slug: 'INSTAGRAM_SEND_TEXT_MESSAGE', toolkit: 'instagram', read_only: false },
      },
    ],
  };
}

test('OpenRouter provider maps opaque option keys back to stable capability ids', async () => {
  const requests = [];
  const provider = createOpenRouterJevProvider({ apiKey: 'test-key', fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ answers: { decision: { type: 'choice', choice: 'option_1', probabilities: { option_0: 0.03, option_1: 0.94, option_2: 0.03 } } }, usage: { total_tokens: 42 } }), { status: 200 });
  } });
  const result = await provider.decideChoice({ state: { request: 'remember this' },
    options: CAPABILITY_OPTIONS.slice(0, 3), instructions: 'choose', signal: null });
  assert.equal(result.choice, 'hivemind_context');
  assert.equal(result.probability, 0.94);
  assert.ok(Math.abs(result.margin - 0.91) < 1e-9);
  assert.equal(requests[0].model, '~typesafe/jev-latest');
  assert.equal(requests[0].questions.decision.type, 'choice');
});

test('explicit operational app intent bypasses the initial decision call', async () => {
  let calls = 0;
  const gateway = new DecisionGateway({ provider: { async decideChoice() { calls += 1; throw new Error('should not run'); } } });
  const turn = createDecisionTurnState('turn-explicit-app');
  const result = await chooseCapability({ gateway, turn, userQuery: 'Find my last Gmail from Rama',
    appMentions: ['gmail'], operationalAppIntent: true, fallback: async () => 'fallback' });
  assert.equal(result.choice, 'composio_search');
  assert.equal(result.source, 'deterministic');
  assert.equal(calls, 0);
});

test('provider failure falls back in the same turn and opens the turn circuit', async () => {
  let providerCalls = 0;
  let fallbackCalls = 0;
  const gateway = new DecisionGateway({ provider: { async decideChoice() { providerCalls += 1; throw new Error('provider_401'); } } });
  const turn = createDecisionTurnState('turn-fallback');
  const fallback = async ({ reason }) => { fallbackCalls += 1; return { selected: 'current_selector', reason }; };
  const first = await gateway.choose({ turn, stage: 'capability', userQuery: 'hello', options: CAPABILITY_OPTIONS,
    instructions: 'choose', fallback });
  const second = await gateway.choose({ turn, stage: 'hivemind_meta_selection', userQuery: 'hello', options: CAPABILITY_OPTIONS,
    instructions: 'choose again', fallback });
  assert.equal(first.source, 'fallback');
  assert.equal(second.source, 'fallback');
  assert.equal(providerCalls, 1);
  assert.equal(fallbackCalls, 2);
  assert.equal(turn.fallbackReason, 'provider_401');
});

test('low-confidence Jev choice uses the existing selector', async () => {
  const gateway = new DecisionGateway({ provider: choiceProvider([{ choice: 'direct_answer', probability: 0.55, margin: 0.06 }]) });
  const turn = createDecisionTurnState('turn-low-confidence');
  const result = await gateway.choose({ turn, stage: 'capability', userQuery: 'ambiguous', options: CAPABILITY_OPTIONS,
    instructions: 'choose', fallback: async () => ({ selected: 'legacy-recall' }) });
  assert.equal(result.source, 'fallback');
  assert.equal(result.value.selected, 'legacy-recall');
  assert.equal(result.reason, 'decision_probability_below_threshold');
});

test('Composio projection rejects execution when Jev selects a disconnected tool', async () => {
  const gateway = new DecisionGateway({ provider: choiceProvider([{
    choice: 'use:GMAIL_FETCH_EMAILS', probability: 0.96, margin: 0.9,
  }]) });
  const turn = createDecisionTurnState('turn-disconnected');
  const result = await chooseComposioAction({ gateway, turn, userQuery: 'Read Gmail', discovery: discovery({ gmailConnected: false }),
    fallback: async ({ reason }) => ({ selected: 'current-composio-selector', reason }) });
  assert.equal(result.source, 'fallback');
  assert.match(result.reason, /disconnected:gmail/);
  assert.equal(turn.disabled, true);
});

test('connected read exposes only the Jev-selected schema to the chat model and returns an answer', async () => {
  const gateway = new DecisionGateway({ provider: choiceProvider([{
    choice: 'use:GMAIL_FETCH_EMAILS', probability: 0.97, margin: 0.93,
  }]) });
  const turn = createDecisionTurnState('turn-read-e2e');
  const modelCalls = [];
  const result = await runSelectedReadProof({
    gateway, turn, userQuery: 'What is the date of my latest email from Rama?', discovery: discovery(),
    fallbackSelect: async () => ({ selected: 'current-selector' }),
    async modelCall(input) {
      modelCalls.push(input);
      if (input.phase === 'tool_call') return { tool_calls: [{ id: 'call-1', function: {
        name: 'composio_gmail_fetch_emails', arguments: JSON.stringify({ query: 'from:Rama', max_results: 5 }),
      } }] };
      return { content: 'The latest email from Rama was on September 19, 2026.' };
    },
    async executeTool({ slug, args }) {
      assert.equal(slug, 'GMAIL_FETCH_EMAILS');
      assert.equal(args.query, 'from:Rama');
      return { successful: true, data: { messages: [{ internalDate: '2026-09-19T14:42:00Z', subject: 'Update' }] } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[0].tools.length, 1);
  assert.equal(modelCalls[0].tools[0]._composio.slug, 'GMAIL_FETCH_EMAILS');
  assert.equal(modelCalls[1].tools.length, 0);
  assert.match(result.answer, /September 19, 2026/);
});

test('write selection produces approval_required before any tool execution', async () => {
  const gateway = new DecisionGateway({ provider: choiceProvider([{
    choice: 'use:INSTAGRAM_SEND_TEXT_MESSAGE', probability: 0.98, margin: 0.95,
  }]) });
  const turn = createDecisionTurnState('turn-write');
  let executed = false;
  const result = await runSelectedReadProof({ gateway, turn, userQuery: 'Send Rama an Instagram message', discovery: discovery(),
    fallbackSelect: async () => null, modelCall: async () => { throw new Error('model must not run'); },
    executeTool: async () => { executed = true; } });
  assert.equal(result.status, 'approval_required');
  assert.equal(executed, false);
});

test('HIVE recall policy returns semantic filters and translates for both runtimes', async () => {
  const provider = choiceProvider([{ answers: {
    retrieval: { type: 'choice', choice: 'evidence', probabilities: { fast_fact: 0, balanced: 0.01, evidence: 0.98, exhaustive: 0.01 } },
    ordering: { type: 'choice', choice: 'newest', probabilities: { relevance: 0.01, newest: 0.98, oldest: 0.01 } },
    temporal_axis: { type: 'choice', choice: 'valid_time', probabilities: { none: 0.01, valid_time: 0.98, known_time: 0.01 } },
    include_superseded: { type: 'noul', noul: 0.92 },
  } }]);
  const gateway = new DecisionGateway({ provider });
  const turn = createDecisionTurnState('turn-recall');
  const result = await chooseHiveRecallPolicy({ gateway, turn, userQuery: 'What was our latest valid decision at the end of August?',
    fallback: async () => ({ selected: 'current-recall' }) });
  assert.equal(result.source, 'jev');
  assert.deepEqual(translateRecallPolicy(result.policy, 'core'), {
    mode: 'explain', sort: 'date_desc', include_superseded: true, temporal_axis: 'valid_time',
  });
  assert.deepEqual(translateRecallPolicy(result.policy, 'harness'), {
    mode: 'evidence', sort: 'date_desc', include_superseded: true, temporal_axis: 'valid_time',
  });
});

test('uncertain recall dimension falls back before filters reach either runtime', async () => {
  const provider = choiceProvider([{ answers: {
    retrieval: { type: 'choice', choice: 'balanced', probabilities: { fast_fact: 0.08, balanced: 0.76, evidence: 0.14, exhaustive: 0.02 } },
    ordering: { type: 'choice', choice: 'relevance', probabilities: { relevance: 0.96, newest: 0.02, oldest: 0.02 } },
    temporal_axis: { type: 'choice', choice: 'none', probabilities: { none: 0.98, valid_time: 0.01, known_time: 0.01 } },
    include_superseded: { type: 'noul', noul: 0.02 },
  } }]);
  const gateway = new DecisionGateway({ provider });
  const turn = createDecisionTurnState('turn-recall-uncertain');
  const result = await chooseHiveRecallPolicy({ gateway, turn, userQuery: 'Find our decision',
    fallback: async ({ reason }) => ({ selected: 'current-recall', reason }) });
  assert.equal(result.source, 'fallback');
  assert.match(result.reason, /retrieval_probability_below_threshold/);
  assert.equal(turn.disabled, true);
});

test('projection retains only bounded decision fields and authoritative schema privately', () => {
  const projected = projectComposioDiscovery(discovery());
  assert.equal(projected.tools.length, 2);
  assert.equal(projected.tools[0].authority, 'read');
  assert.equal(projected.tools[1].authority, 'write');
  assert.equal(projected.tools[1].required_fields[0], 'recipient_id');
});

test('Harness and Legacy adapters share decisions while translating their native recall contracts', async () => {
  const answer = { answers: {
    retrieval: { type: 'choice', choice: 'evidence', probabilities: { fast_fact: 0, balanced: 0, evidence: 1, exhaustive: 0 } },
    ordering: { type: 'choice', choice: 'newest', probabilities: { relevance: 0, newest: 1, oldest: 0 } },
    temporal_axis: { type: 'choice', choice: 'none', probabilities: { none: 1, valid_time: 0, known_time: 0 } },
    include_superseded: { type: 'noul', noul: 0.01 },
  } };
  const make = runtime => createDecisionRuntimeAdapter({ runtime,
    gateway: new DecisionGateway({ provider: choiceProvider([answer]) }),
    turnId: `turn-${runtime}`, fallbacks: { default: async ({ reason }) => ({ selected: 'current_selector', reason }) } });
  const harness = await make('harness').hiveRecall({ userQuery: 'Show the latest supported decision' });
  const legacy = await make('legacy').hiveRecall({ userQuery: 'Show the latest supported decision' });
  assert.equal(harness.translated.mode, 'evidence');
  assert.equal(legacy.translated.mode, 'explain');
  assert.equal(harness.translated.sort, 'date_desc');
  assert.equal(legacy.translated.sort, 'date_desc');
});
