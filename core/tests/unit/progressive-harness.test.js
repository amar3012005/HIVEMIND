import test from 'node:test';
import assert from 'node:assert/strict';
import { isProgressiveHarnessEnabled, resolveHarnessIntent, chooseProgressiveAction,
  boundedEvidence, buildProgressiveSynthesisMessages, PROGRESSIVE_PROMPT_BUDGETS } from '../../src/agent/progressive-harness.js';

test('flag requires literal true and an explicitly allowed tenant', () => {
  const env = { USE_TOOLS_PROGRESSIVE_HARNESS: 'true', USE_TOOLS_PROGRESSIVE_HARNESS_ORGS: 'org-a, org-b' };
  assert.equal(isProgressiveHarnessEnabled(env, { orgId: 'org-a' }), true);
  assert.equal(isProgressiveHarnessEnabled(env, { orgId: 'org-c' }), false);
  assert.equal(isProgressiveHarnessEnabled(env, {}), false);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS: '1' }, { orgId: 'org-a' }), false);
  assert.equal(isProgressiveHarnessEnabled({ ...env, USE_TOOLS_PROGRESSIVE_HARNESS_ORGS: '*' }, { orgId: 'org-a' }), false);
});

test('default intent and action planners use valid POST requests through the real provider adapter', async () => {
  const previousFetch = globalThis.fetch;
  const keys = ['OPENROUTER_API_KEY', 'CLOUDFLARE_AI_GATEWAY_ENABLED', 'DURABLE_NEXT_ACTION_MODEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.OPENROUTER_API_KEY = 'local-test-placeholder';
  process.env.CLOUDFLARE_AI_GATEWAY_ENABLED = 'false';
  process.env.DURABLE_NEXT_ACTION_MODEL = 'google/gemini-2.5-flash-lite';
  const replies = [
    { kind: 'lookup', apps: [], person: '', use_case: 'recall project context', known_fields: '', language: 'de', needs_memory: true,
      outcomes: [{ id: 'context', description: 'Recall project context', kind: 'memory' }] },
    { action: 'native', slug: 'HIVEMIND_RECALL', reason: 'Retrieve context', outcome_ids: ['context'] },
  ];
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    // Native Request construction reproduces the real GET-with-body failure,
    // while the provider adapter itself and planner request remain unmocked.
    const request = new Request(url, init);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    const body = await request.json();
    assert.equal(body.model, 'google/gemini-2.5-flash-lite');
    assert.equal(body.messages[0].role, 'system');
    assert.doesNotThrow(() => JSON.parse(body.messages[1].content));
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[calls++]) } }] });
  };
  try {
    const intent = await resolveHarnessIntent({ message: 'Was wissen wir über das Projekt?' });
    const action = await chooseProgressiveAction({ observation: { intent, capabilities: [], receipts: [] } });
    assert.equal(action.action, 'native');
    assert.deepEqual(action.outcome_ids, ['context']);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
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
