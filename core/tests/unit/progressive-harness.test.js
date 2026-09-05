import test from 'node:test';
import assert from 'node:assert/strict';
import { isProgressiveHarnessEnabled, resolveHarnessIntent, chooseProgressiveAction,
  boundedEvidence, buildProgressiveSynthesisMessages, PROGRESSIVE_PROMPT_BUDGETS,
  buildProgressiveConversationContext, reviewProgressiveArguments, PROGRESSIVE_HARNESS_MODEL } from '../../src/agent/progressive-harness.js';

test('flag requires literal true and an explicitly allowed tenant', () => {
  const env = { USE_TOOLS_PROGRESSIVE_HARNESS: 'true', USE_TOOLS_PROGRESSIVE_HARNESS_ORGS: 'org-a, org-b' };
  assert.equal(isProgressiveHarnessEnabled(env, { orgId: 'org-a' }), true);
  assert.equal(isProgressiveHarnessEnabled(env, { orgId: 'org-c' }), false);
  assert.equal(isProgressiveHarnessEnabled(env, {}), false);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS: '1' }, { orgId: 'org-a' }), false);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS_ORGS: '*' }, { orgId: 'org-a' }), false);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS_USERS: 'user-a' }, { orgId: 'org-a', userId: 'user-a' }), true);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS_USERS: 'user-a' }, { orgId: 'org-a', userId: 'user-b' }), false);
});

test('default intent and action planners use valid POST requests through the real provider adapter', async () => {
  const previousFetch = globalThis.fetch;
  const keys = ['OPENROUTER_API_KEY', 'CLOUDFLARE_AI_GATEWAY_ENABLED', 'DURABLE_NEXT_ACTION_MODEL', 'PROGRESSIVE_HARNESS_MODEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.OPENROUTER_API_KEY = 'local-test-placeholder';
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  process.env.DURABLE_NEXT_ACTION_MODEL = 'google/gemini-2.5-flash-lite';
  delete process.env.PROGRESSIVE_HARNESS_MODEL;
  const replies = [
    { kind: 'lookup', apps: [], person: '', use_case: 'recall project context', known_fields: '', language: 'de', needs_memory: true,
      outcomes: [{ id: 'context', description: 'Recall project context', kind: 'memory' }] },
    { action: 'native', slug: 'HIVEMIND_RECALL', reason: 'Retrieve context', outcome_ids: ['context'] },
    { valid: true, issues: [] },
  ];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    // Native Request construction reproduces the real GET-with-body failure,
    // while the provider adapter itself and planner request remain unmocked.
    const request = new Request(url, init);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    const body = await request.json();
    assert.equal(body.model, PROGRESSIVE_HARNESS_MODEL);
    assert.equal(body.messages[0].role, 'system');
    if (calls === 0) assert.match(body.messages[0].content, /clarification questions are internal steps, not additional outcomes/);
    assert.doesNotThrow(() => JSON.parse(body.messages[1].content));
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] });
  };
  try {
    const intent = await resolveHarnessIntent({ message: 'Was wissen wir über das Projekt?' });
    const action = await chooseProgressiveAction({ observation: { intent, capabilities: [], receipts: [] } });
    assert.equal(action.action, 'native');
    assert.deepEqual(action.outcome_ids, ['context']);
    assert.deepEqual(await reviewProgressiveArguments({ observation: { message: 'Recall context', args: { query: 'project' } } }), { valid: true, issues: [] });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test('conversation context keeps bounded recent user and assistant turns in order', () => {
  const history = [{ role: 'system', content: 'never include' }, ...Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index} ` + '"'.repeat(1600) })),
    { role: 'tool', content: 'never include tool' }, { role: 'assistant', content: [{ text: 'not a string' }] }];
  const result = buildProgressiveConversationContext(history);
  assert.ok(result.length <= 6);
  assert.ok(JSON.stringify(result).length <= 4000);
  assert.ok(result.every(turn => turn.content.length <= 1200 && ['user', 'assistant'].includes(turn.role)));
  assert.match(result.at(-1).content, /^turn-8/);
  const indices = result.map(turn => Number(turn.content.match(/^turn-(\d)/)[1]));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
});

test('intent and synthesis receive conversation evidence independently', async () => {
  const conversationContext = [{ role: 'assistant', content: 'Prior report describes the project status.' }];
  await resolveHarnessIntent({ message: 'Share this', conversationContext, generateImpl: async observation => {
    assert.deepEqual(observation.conversation_context, conversationContext);
    return { kind: 'compose', apps: [], person: '', use_case: 'prepare status update', known_fields: '', language: 'en', needs_memory: false,
      outcomes: [{ id: 'draft', description: 'Share report', kind: 'draft' }] };
  } });
  const messages = buildProgressiveSynthesisMessages({ message: '"'.repeat(4000), conversationContext,
    reads: Array.from({ length: 30 }, () => ({ data: 'x'.repeat(10000) })), recallText: 'Native evidence',
    steps: Array.from({ length: 30 }, () => ({ data: 'y'.repeat(10000) })) });
  const evidence = JSON.parse(messages[1].content);
  assert.deepEqual(evidence.conversation_context, conversationContext);
  assert.equal(evidence.native_memory, 'Native evidence');
  assert.ok(messages[1].content.length <= PROGRESSIVE_PROMPT_BUDGETS.synthesis);
});

test('semantic argument review reports unsupported scope without app rules', async () => {
  const observation = { message: 'Show recent records', args: { query: 'status:pending' } };
  const review = await reviewProgressiveArguments({ observation, generateImpl: async input => {
    assert.deepEqual(input, observation);
    return { valid: false, issues: ['The request did not restrict records to pending status.'] };
  } });
  assert.equal(review.valid, false);
  assert.equal(review.issues.length, 1);
  for (const invalid of [{ valid: true, issues: ['Contradiction'] }, { valid: false, issues: [] }, { valid: 'true', issues: [] },
    { valid: false, issues: ['x'.repeat(201)] }]) {
    await assert.rejects(reviewProgressiveArguments({ observation, generateImpl: async () => invalid }), /violates contract/);
  }
});

test('semantic intent consumes original multilingual input and returns language contract', async () => {
  for (const [message, language] of [['Finde die letzten Nachrichten', 'de'], ['पिछले संदेश खोजें', 'hi'], ['Find recent messages', 'en']]) {
    const result = await resolveHarnessIntent({ message, generateImpl: async input => {
      assert.equal(input.message, message);
      return { kind: 'lookup', apps: ['gmail'], person: '', use_case: 'search recent messages', known_fields: '', language, needs_memory: false,
        outcomes: [{ id: 'messages', description: 'Recent messages', kind: 'read' }] };
    } });
    assert.equal(result.language, language);
    assert.equal(result.kind, 'lookup');
  }
});

test('intent defaults omitted empty metadata without weakening typed outcomes', async () => {
  const result = await resolveHarnessIntent({ message: 'List messages from Rama', generateImpl: async () => ({
    kind: 'lookup', use_case: 'retrieve messages from a specific sender', language: 'en',
    outcomes: [{ id: 'messages', description: 'Messages from the specified sender', kind: 'read' }],
  }) });
  assert.deepEqual(result.apps, []);
  assert.equal(result.person, '');
  assert.equal(result.known_fields, '');
  assert.equal(result.needs_memory, false);
  assert.equal(result.unresolved_context, false);
  assert.equal(result.context_question, '');
});

test('typed outcomes cannot be absent, duplicated or hide a write in a lookup', async () => {
  const intent = { kind: 'lookup', apps: [], person: '', use_case: 'read records', known_fields: '', language: 'en', needs_memory: false };
  for (const outcomes of [undefined, [], [{ id: 'one', kind: 'draft', description: 'write' }],
    [{ id: 'one', kind: 'read', description: 'first' }, { id: 'one', kind: 'read', description: 'second' }]]) {
    await assert.rejects(resolveHarnessIntent({ message: 'Read records', generateImpl: async () => ({ ...intent, outcomes }) }), /typed outcomes/);
  }
});

test('action outcome references must identify one known requested outcome', async () => {
  const observation = { intent: { outcomes: [{ id: 'a', kind: 'read' }, { id: 'b', kind: 'read' }] } };
  const action = { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'Read first page', outcome_ids: ['a'] };
  assert.deepEqual((await chooseProgressiveAction({ observation, generateImpl: async () => action })).outcome_ids, ['a']);
  for (const outcome_ids of [['unknown'], ['a', 'b'], 'a']) {
    await assert.rejects(chooseProgressiveAction({ observation, generateImpl: async () => ({ ...action, outcome_ids }) }), /invalid outcome/);
  }
});

test('intent failures close instead of selecting an app from language keywords', async () => {
  await assert.rejects(resolveHarnessIntent({ message: 'send mail', generateImpl: async () => { throw new Error('offline'); } }), /offline/);
  for (const raw of ['not json', '[]', { kind: 'compose', apps: ['gmail'] }]) {
    await assert.rejects(resolveHarnessIntent({ message: 'send mail', generateImpl: async () => raw }));
  }
});

test('shared discovery and control actions never claim outcome coverage', async () => {
  const observation = { intent: { outcomes: [{ id: 'profile', kind: 'read' }, { id: 'recent_items', kind: 'read' }] } };
  for (const action of [
    { action: 'search', query: 'retrieve account profile and recent items' },
    { action: 'connect', toolkit: 'workspace' },
    { action: 'ask_user', question: 'Which workspace?', fields: ['workspace'] },
    { action: 'done' },
  ]) {
    const result = await chooseProgressiveAction({ observation, generateImpl: async () => ({ ...action,
      reason: 'Shared preparation for requested outcomes', outcome_ids: ['profile', 'recent_items'] }) });
    assert.equal(result.action, action.action);
    assert.equal(Object.hasOwn(result, 'outcome_ids'), false);
  }
});

test('latest answers trigger one bounded corrective plan instead of a repeated clarification', async () => {
  const observation = { message: 'Create a document; title is not supplied yet', fields: { title: 'Current user answer' },
    intent: { outcomes: [{ id: 'document', kind: 'draft' }] } };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async data => {
    if (++calls === 1) return { action: 'ask_user', question: 'What title?', fields: ['title'], reason: 'Old request has no title' };
    assert.equal(data.feedback.code, 'clarification_already_answered');
    assert.equal(data.fields.title, 'Current user answer');
    assert.ok(JSON.stringify(data).length <= PROGRESSIVE_PROMPT_BUDGETS.action);
    return { action: 'draft', slug: 'WORKSPACE_CREATE_DOCUMENT', outcome_ids: ['document'], reason: 'Use supplied title' };
  } });
  assert.equal(action.action, 'draft');
  assert.equal(calls, 2);
});

test('planner gets one bounded correction instead of repeating capability discovery', async () => {
  const observation = { searched: true, capabilities: [{ slug: 'WORKSPACE_READ_RECORDS' }],
    intent: { outcomes: [{ id: 'records', kind: 'read' }] }, remaining_outcomes: [{ id: 'records', kind: 'read' }] };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async input => {
    if (++calls === 1) return { action: 'search', query: 'read records', reason: 'Find a tool' };
    assert.equal(input.feedback.code, 'capabilities_already_discovered');
    assert.deepEqual(input.feedback.available_slugs, ['WORKSPACE_READ_RECORDS']);
    return { action: 'execute', slug: 'WORKSPACE_READ_RECORDS', reason: 'Use discovered reader', outcome_ids: ['records'] };
  } });
  assert.equal(action.action, 'execute');
  assert.equal(calls, 2);
  await assert.rejects(chooseProgressiveAction({ observation, generateImpl: async () => ({
    action: 'search', query: 'read records', reason: 'Search again',
  }) }), /repeated capability discovery/);
});

test('redundant clarification retry is capped and false or zero are supplied answers', async () => {
  let calls = 0;
  await assert.rejects(chooseProgressiveAction({ observation: { fields: { enabled: false, count: 0 } }, generateImpl: async () => {
    calls++;
    return { action: 'ask_user', question: 'Enabled and count?', fields: ['enabled', 'count'], reason: 'Need values' };
  } }), /repeated an answered clarification/);
  assert.equal(calls, 2);
});

test('mixed clarification requests retain only unresolved fields without a retry', async () => {
  let calls = 0;
  const result = await chooseProgressiveAction({ observation: { fields: { title: 'Supplied', destination: '' } }, generateImpl: async () => {
    calls++;
    return { action: 'ask_user', question: 'Titel und Ziel?', fields: ['title', 'destination'], reason: 'Missing destination' };
  } });
  assert.deepEqual(result.fields, ['destination']);
  assert.equal(result.question, 'Titel und Ziel?');
  assert.equal(calls, 1);
});

test('bounded observations remain parseable and preserve both evidence classes', () => {
  const messages = buildProgressiveSynthesisMessages({ message: 'Compare', language: 'de', recallText: 'native '.repeat(10000),
    reads: Array.from({ length: 100 }, () => ({ source: 'external', payload: 'fact'.repeat(10000) })),
    steps: Array.from({ length: 100 }, () => ({ status: 'completed', result: 'ok'.repeat(10000) })), status: 'awaiting_approval' });
  const parsed = JSON.parse(messages[1].content);
  assert.match(parsed.native_memory, /native/);
  assert.equal(parsed.external_reads[0].source, 'external');
  assert.equal(parsed.status, 'awaiting_approval');
  assert.ok(messages[1].content.length <= PROGRESSIVE_PROMPT_BUDGETS.synthesis);
  assert.match(messages[0].content, /never sent/);
  assert.match(messages[0].content, /failures/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(boundedEvidence({ nested: { data: '"'.repeat(100000) } }, 1000))));
});

test('action fixture can continue after a read toward another requested outcome', async () => {
  const action = await chooseProgressiveAction({ observation: { message: 'Find messages and summarize documents',
    receipts: [{ slug: 'READ_MESSAGES', status: 'completed' }], capabilities: [{ slug: 'READ_DOCUMENTS' }] },
  generateImpl: async observation => {
    assert.equal(observation.receipts[0].status, 'completed');
    return { action: 'execute', slug: 'READ_DOCUMENTS', reason: 'The document outcome is still unresolved' };
  } });
  assert.equal(action.slug, 'READ_DOCUMENTS');
});

test('clarification must contain explicit question and fields; invalid actions fail closed', async () => {
  for (const raw of [{ action: 'ask_user', reason: 'missing data' }, { action: 'execute', reason: 'read' },
    { action: 'search', reason: 'discover' }, { action: 'delete', reason: 'unsupported' }]) {
    await assert.rejects(chooseProgressiveAction({ observation: {}, generateImpl: async () => raw }));
  }
  const result = await chooseProgressiveAction({ observation: {}, generateImpl: async () => ({ action: 'ask_user',
    reason: 'Recipient is ambiguous', question: 'Which recipient?', fields: ['recipient'] }) });
  assert.deepEqual(result.fields, ['recipient']);
});
