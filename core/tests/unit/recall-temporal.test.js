import test from 'node:test';
import assert from 'node:assert/strict';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { buildHybridSearchFilter, getQdrantClient } from '../../src/vector/qdrant-client.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { RecallRouter, shouldUseTagAnchoredRecall } from '../../src/memory/recall-router.js';

test('valid_at without tags keeps the normal retrieval lane enabled', () => {
  assert.equal(shouldUseTagAnchoredRecall({
    callerTags: false,
    inferredTags: null,
    validAtDate: new Date('2027-06-01T00:00:00.000Z'),
  }), false);
  assert.equal(shouldUseTagAnchoredRecall({
    callerTags: false,
    inferredTags: [],
    validAtDate: new Date('2027-06-01T00:00:00.000Z'),
  }), false);
});

test('valid_at with explicit or inferred tags uses the tag-anchored lane', () => {
  assert.equal(shouldUseTagAnchoredRecall({
    callerTags: true,
    validAtDate: new Date('2027-06-01T00:00:00.000Z'),
  }), true);
  assert.equal(shouldUseTagAnchoredRecall({
    callerTags: false,
    inferredTags: ['gmail'],
    validAtDate: new Date('2027-06-01T00:00:00.000Z'),
  }), true);
});

test('managed batch hydration applies independent valid and known time filters', async () => {
  let where = null;
  const store = new PrismaGraphStore({
    memory: {
      async findMany(args) {
        where = args.where;
        return [];
      },
    },
  });
  const validAt = '2026-01-15T00:00:00.000Z';
  const knownAt = '2026-01-20T00:00:00.000Z';

  await store.getMemories(['memory-1'], { valid_at: validAt, known_at: knownAt });

  assert.deepEqual(where.id, { in: ['memory-1'] });
  assert.deepEqual(where.createdAt, { lte: new Date(knownAt) });
  assert.ok(where.AND.some((condition) => condition.OR?.some((item) => item.validFrom?.lte?.toISOString() === validAt)));
  assert.ok(where.AND.some((condition) => condition.OR?.some((item) => item.validTo?.gt?.toISOString() === validAt)));
});

test('tag fallback preserves guest project authorization instead of widening to the org', async () => {
  let fallbackWhere = null;
  const store = {
    client: {
      memory: {
        async findMany(args) {
          fallbackWhere = args.where;
          return [];
        },
      },
    },
    async searchMemories() { return []; },
    async listRelationships() { return []; },
  };
  const router = new RecallRouter({ persistentMemoryStore: store });

  await router.recall('project policy', { mode: 'fact', tags: ['policy'] }, {
    userId: 'user-1',
    orgId: 'org-1',
    accessContext: { orgRole: 'guest', projectIds: ['project-1'], teamIds: [] },
  });

  assert.ok(fallbackWhere);
  assert.equal(fallbackWhere.orgId, 'org-1');
  assert.ok(fallbackWhere.OR.some((tier) => tier.userId === 'user-1' && tier.scope === 'personal'));
  assert.ok(fallbackWhere.OR.some((tier) => tier.scope === 'project'));
  assert.ok(!fallbackWhere.OR.some((tier) => tier.scope === 'organization'));
});

test('Qdrant temporal filter constrains known and valid time before ranking', () => {
  const validAt = '2026-01-15T00:00:00.000Z';
  const knownAt = '2026-01-20T00:00:00.000Z';
  const filter = buildHybridSearchFilter({
    org_id: '00000000-0000-4000-8000-000000000132',
    is_latest: false,
    valid_at: validAt,
    known_at: knownAt,
  });
  assert.ok(filter.must.some((condition) => condition.key === 'created_at' && condition.range.lte === knownAt));
  assert.ok(filter.must.some((condition) => condition.key === 'is_latest' && condition.match.value === false));
  assert.ok(filter.must.some((condition) => condition.should?.some((candidate) => candidate.key === 'valid_from' && candidate.range.lte === validAt)));
  assert.ok(filter.must.some((condition) => condition.should?.some((candidate) => candidate.key === 'valid_to' && candidate.range.gt === validAt)));
});

test('temporal comparison recall widens candidate pools and lowers vector threshold', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalHybridSearch = client.hybridSearch;

  const vectorCalls = [];
  const lexicalCalls = [];

  client.isConnected = async () => true;
  client.hybridSearch = async (_query, options) => {
    vectorCalls.push(options);
    return [];
  };

  const store = {
    async searchMemories(options) {
      lexicalCalls.push(options);
      return [];
    },
    async listRelationships() {
      return [];
    }
  };

  try {
    await recallPersistedMemories(store, {
      query_context: 'Which event did I attend first, the workshop or the webinar?',
      user_id: '00000000-0000-4000-8000-000000000121',
      org_id: '00000000-0000-4000-8000-000000000122',
      project: 'bench/test-project',
      max_memories: 5
    });

    assert.equal(lexicalCalls.length, 1);
    // Wide retrieval is fixed at the production ceiling: enough for long-tail
    // matches without allowing caller limits to scale work with corpus size.
    assert.equal(lexicalCalls[0].n_results, 150);
    // Temporal expansion may add a second indexed lane. Every lane remains
    // bounded by the same wide pool and at least one uses the loose threshold.
    assert.ok(vectorCalls.length >= 1);
    assert.ok(vectorCalls.every((call) => call.limit === 150));
    assert.ok(vectorCalls.some((call) => call.score_threshold <= 0.18));
  } finally {
    client.isConnected = originalIsConnected;
    client.hybridSearch = originalHybridSearch;
  }
});

test('candidate generation never exceeds the 150-result ceiling', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalHybridSearch = client.hybridSearch;
  const vectorCalls = [];
  const lexicalCalls = [];

  client.isConnected = async () => true;
  client.hybridSearch = async (_query, options) => {
    vectorCalls.push(options);
    return [];
  };
  const store = {
    async searchMemories(options) { lexicalCalls.push(options); return []; },
    async listRelationships() { return []; },
  };

  try {
    await recallPersistedMemories(store, {
      query_context: 'high-volume bounded recall',
      user_id: '00000000-0000-4000-8000-000000000121',
      org_id: '00000000-0000-4000-8000-000000000122',
      max_memories: 50,
      entity_filter_mode: 'off', query_expansion: false, tiered_view: false,
    });
    assert.ok(vectorCalls.length >= 1);
    assert.ok(vectorCalls.every((call) => call.limit <= 150));
    assert.ok(lexicalCalls.every((call) => call.n_results <= 150));
    assert.ok(lexicalCalls.length >= 1);
    assert.ok(lexicalCalls.every((call) => call.lexical_only === true),
      'the orchestrated lexical lane must not repeat semantic vector recall');
  } finally {
    client.isConnected = originalIsConnected;
    client.hybridSearch = originalHybridSearch;
  }
});

test('bi-temporal snapshots prefilter vector hydration and lexical retrieval', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalHybridSearch = client.hybridSearch;
  const hydrations = [];
  const lexicalCalls = [];
  const userId = '00000000-0000-4000-8000-000000000131';
  const orgId = '00000000-0000-4000-8000-000000000132';
  const validAt = '2026-01-15T00:00:00.000Z';
  const knownAt = '2026-01-20T00:00:00.000Z';

  client.isConnected = async () => true;
  client.hybridSearch = async (_query, options) => [{
    id: 'old-version',
    score: 0.9,
    payload: { memory_id: 'old-version', org_id: orgId },
    _options: options,
  }];

  const historical = {
    id: 'old-version', user_id: userId, org_id: orgId, scope: 'personal',
    title: 'Historical policy', content: 'The historical policy required approval.',
    tags: ['entity:policy'], memory_type: 'fact', is_latest: false,
    created_at: '2026-01-10T00:00:00.000Z',
    valid_from: '2026-01-01T00:00:00.000Z', valid_to: '2026-02-01T00:00:00.000Z',
    importance_score: 0.8,
  };
  const store = {
    async getMemories(ids, temporal) {
      hydrations.push({ ids, temporal });
      return new Map([['old-version', historical]]);
    },
    async searchMemories(options) {
      lexicalCalls.push(options);
      return [historical];
    },
    async listRelationships() { return []; },
  };

  try {
    const result = await recallPersistedMemories(store, {
      query_context: 'historical approval policy', user_id: userId, org_id: orgId,
      max_memories: 5, valid_at: validAt, known_at: knownAt,
      entity_filter_mode: 'off', query_expansion: false, tiered_view: false,
    });
    assert.ok(hydrations.length >= 1);
    assert.ok(hydrations.every((call) => call.temporal.valid_at === validAt && call.temporal.known_at === knownAt));
    assert.equal(lexicalCalls[0].valid_at, validAt);
    assert.equal(lexicalCalls[0].known_at, knownAt);
    assert.equal(lexicalCalls[0].is_latest, undefined);
    assert.ok(result.memories.some((memory) => memory.id === 'old-version'));
  } finally {
    client.isConnected = originalIsConnected;
    client.hybridSearch = originalHybridSearch;
  }
});
