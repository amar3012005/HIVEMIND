import test from 'node:test';
import assert from 'node:assert/strict';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { getQdrantClient } from '../../src/vector/qdrant-client.js';

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
    // Wide retrieval has a production floor of 150; temporal queries may widen
    // beyond it, but must never regress to the former 40-candidate pool.
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
