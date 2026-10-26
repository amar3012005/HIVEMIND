import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRecallRoute } from '../../src/routes/recall.js';

const PLAN = {
  legacy: false, mode: 'fact', requested_mode: 'auto', operation: 'recall',
  source: { requested: false, document_id: null, title: null },
  time: { mode: 'current', valid_at: null, known_at: null, range: null },
  max_graph_hops: 0, latency_budget_ms: 2000,
};
const ACCESS = { projectIds: [], teamIds: ['team-1'] };
const QUERY = 'confidential Solvis roadmap question';

function evaluator(result) {
  return { evaluate: async () => result };
}

async function runRoute({ trace, memories, quality, reliability, captured }) {
  let response = null;
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    await handleRecallRoute({
      req: {}, res: {}, body: { query_context: QUERY, mode: 'auto' },
      userId: 'user-1', orgId: 'org-1', prisma: null,
      jsonResponse: (_res, body, status = 200) => { response = { body, status }; },
      ensurePersistedMemoryOrFail: () => true,
      rateLimitAllowOrgRequest: () => true,
      buildAccessContext: async () => ACCESS,
      rewriteQuery: (query) => ({ expanded: query, entities: [], stripped: query }),
      expandTemporalQuery: () => ({ dateRange: null }),
      detectQueryIntent: () => 'fact',
      computeDynamicWeights: () => null,
      isUuidLike: () => false,
      recallPersistedMemories: async () => { throw new Error('legacy recall must not run'); },
      persistentMemoryStore: {},
      recallReliabilityClient: reliability,
      recallQualityClient: quality,
      recallRuntime: {
        resolvePlan: () => PLAN,
        recall: async (query, options, ctx) => {
          captured.push({ query, options, ctx });
          return {
            memories, evidence: [], ranked_candidates: [], live: [], relationships: [],
            trace: { recall_plan: PLAN, ...trace },
          };
        },
        loadGraph: async () => ({ items: [] }),
        buildPacket: (input) => ({ facts: input.facts }),
      },
    });
  } finally {
    console.log = originalLog;
  }
  return { response, logged };
}

test('embedding timeout serves lexical results degraded, unscored and without a 503', async () => {
  const captured = [];
  const { response, logged } = await runRoute({
    trace: { embedding_unavailable: true, embedding_status: 'timeout' },
    memories: [{ id: 'm1', content: 'lexical hit' }],
    quality: evaluator({ mode: 'off', status: 'skipped_timeout' }),
    reliability: evaluator({ enabled: false, status: 'skipped_timeout' }),
    captured,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.memories.length, 1);
  assert.equal(response.body.memories[0].id, 'm1');
  assert.equal(response.body.retrieval, 'lexical_fallback');
  assert.equal(response.body.degraded, true);
  assert.equal(response.body.absence_conclusive, false);
  assert.equal(response.body.evaluation, 'skipped_timeout');
  assert.equal(response.body.retrieval_trace.embedding_status, 'timeout');
  assert.equal(response.body.retrieval_trace.recall_quality_mode, 'off');
  assert.equal(response.body.retrieval_trace.reliability_v1, false);

  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[recall\] route=\/api\/recall retrieval=lexical_fallback embedding=timeout evaluation=skipped_timeout status=200 latency_ms=\d+$/);
  assert.ok(!logged[0].includes('Solvis'), 'log line must not carry query text');
});

test('an outage with no lexical result stays a 503 and is logged with status 503', async () => {
  let response = null;
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    await handleRecallRoute({
      req: {}, res: {}, body: { query_context: QUERY, mode: 'auto' },
      userId: 'user-1', orgId: 'org-1', prisma: null,
      jsonResponse: (_res, body, status = 200) => { response = { body, status }; },
      ensurePersistedMemoryOrFail: () => true,
      rateLimitAllowOrgRequest: () => true,
      buildAccessContext: async () => ACCESS,
      rewriteQuery: (query) => ({ expanded: query, entities: [], stripped: query }),
      expandTemporalQuery: () => ({ dateRange: null }),
      detectQueryIntent: () => 'fact',
      computeDynamicWeights: () => null,
      isUuidLike: () => false,
      recallPersistedMemories: async () => { throw new Error('legacy recall must not run'); },
      persistentMemoryStore: {},
      recallRuntime: {
        resolvePlan: () => PLAN,
        recall: async () => {
          throw Object.assign(new Error('no lexical result'), { code: 'MEMORY_RETRIEVAL_UNAVAILABLE' });
        },
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'memory_retrieval_unavailable');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[recall\] route=\/api\/recall retrieval=failed embedding=unknown evaluation=\w+ status=503 latency_ms=\d+$/);
});

test('normal path reports hybrid retrieval, no degradation and evaluated ok', async () => {
  const captured = [];
  const { response, logged } = await runRoute({
    trace: { embedding_unavailable: false, embedding_status: 'ok' },
    memories: [{ id: 'm2', content: 'vector and lexical hit' }],
    quality: evaluator({ mode: 'shadow', status: 'ok' }),
    reliability: evaluator({ enabled: true, status: 'ok' }),
    captured,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.retrieval, 'hybrid');
  assert.equal(response.body.degraded, false);
  assert.equal(response.body.absence_conclusive, true);
  assert.equal(response.body.evaluation, 'ok');
  assert.equal(response.body.retrieval_trace.embedding_status, 'ok');
  assert.equal(response.body.retrieval_trace.recall_quality_mode, 'shadow');
  assert.equal(response.body.retrieval_trace.reliability_v1, true);
  assert.equal(captured[0].options.recall_quality_mode, 'shadow');
  assert.equal(captured[0].options.reliability_v1, true);
  assert.match(logged[0], /retrieval=hybrid embedding=ok evaluation=ok status=200/);
});

test('evaluation timeout alone keeps retrieval unchanged and reports skipped_timeout', async () => {
  const captured = [];
  const { response } = await runRoute({
    trace: { embedding_unavailable: false, embedding_status: 'ok' },
    memories: [{ id: 'm3', content: 'vector hit' }],
    quality: evaluator({ mode: 'off', status: 'skipped_timeout' }),
    reliability: evaluator({ enabled: false, status: 'ok' }),
    captured,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.memories[0].id, 'm3');
  assert.equal(response.body.retrieval, 'hybrid');
  assert.equal(response.body.degraded, false);
  assert.equal(response.body.evaluation, 'skipped_timeout');
});

test('fallback keeps the caller tenant, user and access context unchanged', async () => {
  const captured = [];
  await runRoute({
    trace: { embedding_unavailable: true, embedding_status: 'timeout' },
    memories: [],
    quality: null,
    reliability: null,
    captured,
  });
  assert.equal(captured.length, 1);
  const { ctx, options } = captured[0];
  assert.equal(ctx.orgId, 'org-1');
  assert.equal(ctx.userId, 'user-1');
  assert.equal(ctx.accessContext, ACCESS);
  assert.equal(ctx.projectId, null);
  assert.equal(options.explicit_mode, true);
  assert.equal(options.recall_quality_mode, 'off');
});

test('clients without evaluate() still work and report their result as ok', async () => {
  const captured = [];
  const { response } = await runRoute({
    trace: { embedding_unavailable: false, embedding_status: 'ok' },
    memories: [{ id: 'm4', content: 'legacy client' }],
    quality: { modeFor: async () => 'on' },
    reliability: { enabledFor: async () => true },
    captured,
  });
  assert.equal(response.body.evaluation, 'ok');
  assert.equal(captured[0].options.recall_quality_mode, 'on');
  assert.equal(captured[0].options.reliability_v1, true);
});
