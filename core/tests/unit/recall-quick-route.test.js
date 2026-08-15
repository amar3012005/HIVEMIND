import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRecallRoute } from '../../src/routes/recall.js';

test('quick recall uses one bounded parallel runtime and preserves public response fields', async () => {
  const calls = [];
  let response = null;
  const plan = {
    legacy: false,
    mode: 'fact',
    requested_mode: 'quick',
    operation: 'recall',
    source: { requested: false, document_id: null, title: null },
    time: { mode: 'current', valid_at: null, known_at: null, range: null },
    max_graph_hops: 0,
    latency_budget_ms: 2000,
  };
  await handleRecallRoute({
    req: {}, res: {}, body: { query: 'Solvis products', mode: 'quick' },
    userId: 'user-1', orgId: 'org-1', prisma: null,
    jsonResponse: (_res, body, status = 200) => { response = { body, status }; },
    ensurePersistedMemoryOrFail: () => true,
    rateLimitAllowOrgRequest: () => true,
    buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    rewriteQuery: (query) => ({ expanded: query, entities: [], stripped: query }),
    expandTemporalQuery: () => ({ dateRange: null }),
    detectQueryIntent: () => 'fact',
    computeDynamicWeights: () => null,
    isUuidLike: () => false,
    recallPersistedMemories: async () => { throw new Error('legacy recall must not run'); },
    persistentMemoryStore: {},
    recallRuntime: {
      resolvePlan: () => plan,
      recall: async (query, options) => {
        calls.push({ query, options });
        return {
          memories: [{ id: 'm1', content: 'memory' }],
          evidence: [{ segment_id: 'e1', content: 'evidence' }],
          ranked_candidates: [
            { kind: 'evidence', segment_id: 'e1', rank: 1 },
            { kind: 'memory', memory_id: 'm1', rank: 2 },
          ],
          live: [],
          trace: { recall_plan: plan, rerank_passes: 1 },
        };
      },
      loadGraph: async () => ({ items: [] }),
      buildPacket: (input) => ({ facts: input.facts, sourceSections: input.sourceSections }),
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.limit, 15);
  assert.equal(response.status, 200);
  assert.equal(response.body.mode_used, 'quick');
  assert.equal(response.body.search_method, 'hybrid');
  assert.equal(response.body.recall_plan.requested_mode, 'quick');
  assert.equal(response.body.results.length, 2);
  assert.equal(typeof response.body.timing_ms, 'number');
});
