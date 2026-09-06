import test from 'node:test';
import assert from 'node:assert/strict';

import { runReactAgentV2 } from '../../src/agent/react-agent-v2.js';

test('direct multilingual turn uses one structured parser call and one event contract', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    if (String(_url).includes('/__hivemind/feature-flags/')) {
      return { ok: true, async json() { return { source: 'cloudflare-flagship', enabled: false }; } };
    }
    const request = JSON.parse(options.body);
    calls.push(request);
    if (!request.tool_choice) {
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?' } }],
            usage: { prompt_tokens: 14, completion_tokens: 8, total_tokens: 22 },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { tool_calls: [{ function: {
            name: 'route_chat_turn',
            arguments: JSON.stringify({
              operation: 'direct', confidence: 0.99, response_language: 'hi-IN',
              direct_response: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?',
              queries: [], named_entities: [], recall_mode: 'fact', tool_groups: [],
              side_effect_policy: 'read_only',
            }),
          } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        };
      },
    };
  };
  const events = [];
  try {
    const result = await runReactAgentV2({
      message: 'नमस्ते', language: 'hi-IN', history: [], apiKey: 'test',
      ctx: {
        userId: '11111111-1111-1111-1111-111111111111',
        orgId: '22222222-2222-2222-2222-222222222222',
        accessContext: { projectIds: [], teamIds: [], orgRole: 'member' },
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.response, 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tool_choice.function.name, 'route_chat_turn');
    assert.equal(calls[1].tool_choice, undefined);
    assert.deepEqual(events.map((event) => event.type).filter((type) => ['turn_accepted', 'intent_decided', 'turn_completed'].includes(type)), [
      'turn_accepted', 'intent_decided', 'turn_completed',
    ]);
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.equal(new Set(events.map((event) => event.trace_id)).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('complete aggregate uses one parser call, scoped entity executor, and no answer model', async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (_url) => {
    if (String(_url).includes('/__hivemind/feature-flags/')) {
      return { ok: true, async json() { return { source: 'cloudflare-flagship', enabled: false }; } };
    }
    modelCalls++;
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { tool_calls: [{ function: { name: 'route_chat_turn', arguments: JSON.stringify({
          operation: 'aggregate', confidence: 0.99, response_language: 'en', queries: ['Solvis products'],
          named_entities: ['Solvis'], recall_mode: 'explain', tool_groups: ['hivemind-recall'],
          side_effect_policy: 'read_only', aggregate: { parent: 'Solvis', kind: 'product' },
        }) } }] } }] };
      },
    };
  };
  const prisma = {
    entity: {
      async findMany({ where }) {
        if (!where.entityType) return [{ id: 'parent', canonicalName: 'Solvis' }];
        return [{ id: 'p1', canonicalName: 'SolvisPia', aliases: [] }, { id: 'p2', canonicalName: 'SolvisMax', aliases: [] }];
      },
    },
    entityMention: { async findMany() { return [{ documentId: 'doc-1', memoryId: null }]; } },
  };
  try {
    const result = await runReactAgentV2({
      message: 'How many Solvis products exist?', apiKey: 'test',
      ctx: {
        userId: '33333333-3333-3333-3333-333333333333', orgId: '44444444-4444-4444-4444-444444444444',
        prisma, accessContext: { projectIds: [], teamIds: [], orgRole: 'owner' },
      },
    });
    assert.equal(modelCalls, 1);
    assert.match(result.response, /contains 2 entities associated with Solvis classified as products/);
    assert.equal(result.aggregate.count, 2);
    assert.equal(result.grounded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('connector write is selected by schemas and stops at an org-bound draft', async () => {
  const originalFetch = globalThis.fetch;
  const draftRows = [];
  let modelCalls = 0;
  globalThis.fetch = async (_url, options) => {
    if (String(_url).includes('/__hivemind/feature-flags/')) {
      return { ok: true, async json() { return { source: 'cloudflare-flagship', enabled: false }; } };
    }
    modelCalls++;
    const body = JSON.parse(options.body);
    const isIntent = body.tool_choice?.function?.name === 'route_chat_turn';
    if (isIntent) {
      return { ok: true, async json() { return { choices: [{ message: { tool_calls: [{ function: { name: 'route_chat_turn', arguments: JSON.stringify({
        operation: 'connector_write', confidence: 0.99, response_language: 'fr', queries: [], named_entities: ['lea@example.com'],
        recall_mode: 'fact', tool_groups: ['gmail'], connector_provider: 'gmail', side_effect_policy: 'approval_required',
        failure_response: 'Le connecteur est indisponible pour le moment.',
        acknowledgement: 'Le brouillon attend votre approbation.',
      }) } }] } }] }; } };
    }
    if (modelCalls === 2) {
      return { ok: true, async json() { return { choices: [{ message: { tool_calls: [{ id: 'call-1', function: {
        name: 'gmail_send_email', arguments: JSON.stringify({ to: 'lea@example.com', subject: 'Rapport', body: 'Bonjour Léa' }),
      } }] } }] }; } };
    }
    return { ok: true, async json() { return { choices: [{ message: { content: 'Le brouillon attend votre approbation.' } }] }; } };
  };
  const prisma = {
    nangoConnection: { async findMany() { return [{ providerKey: 'gmail' }]; } },
    pendingWrite: {
      async create({ data }) { draftRows.push(data); return { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ...data }; },
    },
  };
  try {
    const result = await runReactAgentV2({
      message: 'Envoie le rapport à Léa', language: 'fr', apiKey: 'test',
      useTools: true,
      ctx: {
        userId: '55555555-5555-5555-5555-555555555555', orgId: '66666666-6666-6666-6666-666666666666',
        prisma, accessContext: { projectIds: [], teamIds: [], orgRole: 'member' },
      },
    });
    assert.equal(modelCalls, 3);
    assert.equal(draftRows.length, 1);
    assert.equal(draftRows[0].orgId, '66666666-6666-6666-6666-666666666666');
    assert.equal(draftRows[0].toolGroup, 'gmail');
    assert.equal(draftRows[0].toolName, 'gmail_send_email');
    assert.equal(draftRows[0].argsHash.length, 64);
    assert.ok(draftRows[0].expiresAt instanceof Date);
    assert.deepEqual(result.draft_ids, ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
