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

test('default planner retries one malformed non-empty provider choice', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousGateway = process.env.CLOUDFLARE_AI_GATEWAY_ENABLED;
  process.env.OPENROUTER_API_KEY = 'local-test-placeholder';
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls++;
    if (calls === 1) return Response.json({ choices: [{ message: { content: 'not-json' } }] });
    assert.match(body.messages[0].content, /Retry: return one non-empty valid JSON object only/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'lookup', apps: [], person: '',
      use_case: 'recall context', known_fields: '', language: 'en', needs_memory: true,
      outcomes: [{ id: 'context', description: 'Recall context', kind: 'memory' }] }) } }] });
  };
  try {
    const intent = await resolveHarnessIntent({ message: 'Recall context' });
    assert.equal(intent.outcomes[0].id, 'context');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousGateway === undefined) delete process.env.CLOUDFLARE_AI_GATEWAY_ENABLED; else process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = previousGateway;
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

test('authenticated subject scope uses the tenant-bound account without clarification', async () => {
  const result = await resolveHarnessIntent({ message: 'show my profile', generateImpl: async () => ({
    kind: 'lookup', apps: ['network'], person: '', subject_scope: 'authenticated_user', use_case: 'retrieve connected account profile',
    known_fields: '', language: 'en', needs_memory: false, unresolved_context: true,
    context_question: 'Which account?', outcomes: [{ id: 'profile', description: 'Retrieve own profile', kind: 'read' }],
  }) });
  assert.equal(result.subject_scope, 'authenticated_user');
  assert.equal(result.unresolved_context, false);
  assert.equal(result.context_question, '');
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

test('valid JSON with an invalid intent contract gets one semantic repair', async () => {
  let calls = 0;
  const intent = await resolveHarnessIntent({ message: 'Find the latest record', generateImpl: async input => {
    if (++calls === 1) return { kind: 'lookup', apps: ['records'], use_case: '', outcomes: [] };
    assert.ok(input.previous_invalid_output);
    return { kind: 'lookup', apps: ['records'], person: '', subject_scope: 'authenticated_user',
      use_case: 'retrieve latest record', known_fields: '', language: 'en', needs_memory: false,
      unresolved_context: false, context_question: '', outcomes: [{ id: 'record', description: 'Retrieve latest record', kind: 'read' }] };
  } });
  assert.equal(intent.outcomes[0].id, 'record');
  assert.equal(calls, 2);
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

test('missing action reason receives neutral host audit metadata', async () => {
  const observation = { intent: { outcomes: [{ id: 'profile', kind: 'read' }] },
    remaining_outcomes: [{ id: 'profile', kind: 'read' }] };
  const action = await chooseProgressiveAction({ observation, generateImpl: async () => ({
    action: 'execute', slug: 'WORKSPACE_GET_PROFILE', outcome_ids: ['profile'],
  }) });
  assert.equal(action.action, 'execute');
  assert.equal(action.reason, 'Planner selected execute');
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

test('invalid fast-model action gets one bounded contract repair', async () => {
  const observation = { intent: { outcomes: [{ id: 'mail', kind: 'read' }] },
    remaining_outcomes: [{ id: 'mail', kind: 'read' }], capabilities: [{ slug: 'MAIL_LIST', authority: 'read' }] };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async input => {
    if (++calls === 1) return { action: 'execute', outcome_ids: ['unknown'], reason: 'Use a reader' };
    assert.equal(input.feedback.code, 'action_contract_invalid');
    assert.equal(input.feedback.issue, 'receipt action missing slug');
    return { action: 'execute', slug: 'MAIL_LIST', outcome_ids: ['mail'], reason: 'Use the discovered reader' };
  } });
  assert.equal(action.action, 'execute');
  assert.equal(calls, 2);
});

test('receipt action ignores irrelevant malformed clarification fields', async () => {
  const action = await chooseProgressiveAction({ observation: { intent: { outcomes: [{ id: 'mail', kind: 'read' }] },
    remaining_outcomes: [{ id: 'mail', kind: 'read' }] }, generateImpl: async () => ({ action: 'execute', slug: 'MAIL_LIST',
    outcome_ids: ['mail'], reason: 'Read mail', fields: { irrelevant: true } }) });
  assert.equal(action.action, 'execute');
  assert.equal(Object.hasOwn(action, 'fields'), false);
});

test('connected account permission clarification is corrected to capability use', async () => {
  const observation = { connected: ['mail'], intent: { apps: ['mail'], outcomes: [{ id: 'mail', kind: 'read' }] },
    remaining_outcomes: [{ id: 'mail', kind: 'read' }], capabilities: [{ slug: 'MAIL_LIST', authority: 'read' }] };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async input => {
    if (++calls === 1) return { action: 'ask_user', question: 'Grant mailbox permission?', fields: ['mail_permission'], reason: 'Need access' };
    assert.equal(input.feedback.code, 'connected_account_already_authorized');
    assert.deepEqual(input.feedback.connected, ['mail']);
    return { action: 'execute', slug: 'MAIL_LIST', outcome_ids: ['mail'], reason: 'Use the connected mailbox' };
  } });
  assert.equal(action.action, 'execute');
  assert.equal(calls, 2);
});

test('planner may refine discovery but gets one bounded correction for an identical query', async () => {
  const observation = { searched: true, capabilities: [{ slug: 'WORKSPACE_READ_RECORDS' }],
    steps: [{ slug: 'COMPOSIO_SEARCH_TOOLS', args: { query: 'read records' } }],
    intent: { outcomes: [{ id: 'records', kind: 'read' }] }, remaining_outcomes: [{ id: 'records', kind: 'read' }] };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async input => {
    if (++calls === 1) return { action: 'search', query: 'read records', reason: 'Find a tool' };
    assert.equal(input.feedback.code, 'capability_search_already_attempted');
    assert.deepEqual(input.feedback.available_slugs, ['WORKSPACE_READ_RECORDS']);
    return { action: 'execute', slug: 'WORKSPACE_READ_RECORDS', reason: 'Use discovered reader', outcome_ids: ['records'] };
  } });
  assert.equal(action.action, 'execute');
  assert.equal(calls, 2);
  await assert.rejects(chooseProgressiveAction({ observation, generateImpl: async () => ({
    action: 'search', query: 'read records', reason: 'Search again',
  }) }), /repeated capability discovery/);
  const refined = await chooseProgressiveAction({ observation, generateImpl: async () => ({
    action: 'search', query: 'list records to resolve the latest record identifier', reason: 'Find prerequisite capability',
  }) });
  assert.equal(refined.action, 'search');
});

test('unchanged capability catalog forces tool use instead of endless refined searches', async () => {
  const observation = { searched: true, capabilities: [{ slug: 'PEOPLE_SEARCH', authority: 'read' }],
    steps: [{ slug: 'COMPOSIO_SEARCH_TOOLS', summary: '3 capabilities discovered' },
      { slug: 'COMPOSIO_SEARCH_TOOLS', summary: '3 capabilities discovered' }],
    intent: { outcomes: [{ id: 'draft', kind: 'draft' }] }, remaining_outcomes: [{ id: 'draft', kind: 'draft' }] };
  let calls = 0;
  const action = await chooseProgressiveAction({ observation, generateImpl: async input => {
    if (++calls === 1) return { action: 'search', query: 'find named recipient', reason: 'Search again' };
    assert.equal(input.feedback.code, 'capability_catalog_unchanged');
    return { action: 'execute', slug: 'PEOPLE_SEARCH', outcome_ids: [], reason: 'Use available resolver' };
  } });
  assert.equal(action.action, 'execute');
  assert.equal(calls, 2);
});

test('redundant clarification retry is capped and false or zero are supplied answers', async () => {
  let calls = 0;
  await assert.rejects(chooseProgressiveAction({ observation: { fields: { enabled: false, count: 0 } }, generateImpl: async () => {
    calls++;
    return { action: 'ask_user', question: 'Enabled and count?', fields: ['enabled', 'count'], reason: 'Need values' };
  } }), /repeated an answered clarification/);
  assert.equal(calls, 2);
});

test('named entity factual identifiers trigger one resolver search before clarification', async () => {
  let calls = 0;
  const result = await chooseProgressiveAction({ observation: { intent: { person: 'Rama', outcomes: [{ id: 'draft', kind: 'draft' }] },
    receipts: [], capabilities: [{ slug: 'MESSAGE_CREATE', authority: 'write' }], remaining_outcomes: [{ id: 'draft', kind: 'draft' }] },
  generateImpl: async input => {
    calls++;
    if (calls === 1) return { action: 'ask_user', question: 'What is the address?', fields: ['recipient_email'], reason: 'Missing address' };
    assert.equal(input.feedback.code, 'named_entity_identifier_unresolved');
    return { action: 'search', query: 'find a person destination identifier in connected account data', reason: 'Resolve destination from evidence' };
  } });
  assert.equal(result.action, 'search');
  assert.equal(calls, 2);
});

test('provider identifiers trigger upstream discovery before clarification even when optional scope is omitted', async () => {
  let calls = 0;
  const result = await chooseProgressiveAction({ observation: { searched: true,
    intent: { subject_scope: 'authenticated_user', outcomes: [{ id: 'latest', kind: 'read' }] },
    receipts: [], capabilities: [{ slug: 'NETWORK_GET_ITEM', authority: 'read' }],
    remaining_outcomes: [{ id: 'latest', kind: 'read' }] },
  generateImpl: async input => {
    calls++;
    if (calls === 1) return { action: 'ask_user', question: 'What is the item URN?', fields: ['item_urn'], reason: 'Missing identifier' };
    assert.equal(input.feedback.code, 'factual_identifier_unresolved');
    return { action: 'search', query: 'list authenticated account items to identify the most recent item', reason: 'Resolve identifier from account' };
  } });
  assert.equal(result.action, 'search');
  assert.equal(calls, 2);
});

test('repeated provider identifier clarification becomes one generic upstream search', async () => {
  let calls = 0;
  const result = await chooseProgressiveAction({ observation: { searched: true,
    intent: { subject_scope: 'authenticated_user', outcomes: [{ id: 'latest', kind: 'read' }] }, receipts: [],
    capabilities: [{ slug: 'NETWORK_GET_ITEM', authority: 'read' }], remaining_outcomes: [{ id: 'latest', kind: 'read' }] },
  generateImpl: async () => {
    calls++;
    return { action: 'ask_user', question: 'Provide item ID?', fields: ['item_id'], reason: 'Need provider identifier' };
  } });
  assert.equal(result.action, 'search');
  assert.match(result.query, /list authenticated account records/);
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
