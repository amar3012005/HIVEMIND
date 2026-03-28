import test from 'node:test';
import assert from 'node:assert/strict';
import hybridSearch from '../../src/search/hybrid.js';
import { getQdrantClient } from '../../src/vector/qdrant-client.js';

test('hybridSearch forwards project scope into vector and semantic Qdrant filters', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalEnsureCollection = client.ensureCollection;
  const originalSearchMemories = client.searchMemories;

  const seenFilters = [];

  client.isConnected = async () => true;
  client.ensureCollection = async () => true;
  client.searchMemories = async ({ filter }) => {
    seenFilters.push(filter);
    return [];
  };

  try {
    await hybridSearch.hybridSearch({
      query: 'which event came first',
      queryVector: [0.1, 0.2, 0.3],
      userId: '00000000-0000-4000-8000-000000000101',
      orgId: '00000000-0000-4000-8000-000000000102',
      project: 'bench/test-project',
      limit: 5
    });

    assert.equal(seenFilters.length, 2);
    assert.equal(seenFilters[0].must.find(item => item.key === 'project')?.match?.value, 'bench/test-project');
    assert.equal(seenFilters[1].must.find(item => item.key === 'project')?.match?.value, 'bench/test-project');
  } finally {
    client.isConnected = originalIsConnected;
    client.ensureCollection = originalEnsureCollection;
    client.searchMemories = originalSearchMemories;
  }
});

test('hybridSearch falls back to ranked candidates when final score floor removes all results', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalEnsureCollection = client.ensureCollection;
  const originalSearchMemories = client.searchMemories;

  client.isConnected = async () => true;
  client.ensureCollection = async () => true;
  client.searchMemories = async () => ([
    {
      id: 'memory-1',
      score: 0.05,
      payload: {
        content: 'Data Analysis using Python webinar happened before the workshop.',
        project: 'bench/test-project',
        is_latest: true,
        created_at: '2026-03-01T00:00:00.000Z'
      }
    }
  ]);

  try {
    const result = await hybridSearch.hybridSearch({
      query: 'which event came first',
      queryVector: [0.1, 0.2, 0.3],
      userId: '00000000-0000-4000-8000-000000000111',
      project: 'bench/test-project',
      limit: 5,
      weights: { vector: 0.5, keyword: 0.3, graph: 0.2 }
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].id, 'memory-1');
  } finally {
    client.isConnected = originalIsConnected;
    client.ensureCollection = originalEnsureCollection;
    client.searchMemories = originalSearchMemories;
  }
});
