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
    return [{
      id: 'memory-leak',
      score: 0.91,
      payload: {
        user_id: '00000000-0000-4000-8000-000000000101',
        org_id: '00000000-0000-4000-8000-000000000102',
        project: 'other-project',
        content: 'Should be filtered out'
      }
    }];
  };

  try {
    const result = await hybridSearch.hybridSearch({
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
    assert.equal(result.results.length, 0);
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
        user_id: '00000000-0000-4000-8000-000000000111',
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

test('hybridSearch hard-filters vector results to the requested project scope', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalEnsureCollection = client.ensureCollection;
  const originalSearchMemories = client.searchMemories;

  client.isConnected = async () => true;
  client.ensureCollection = async () => true;
  client.searchMemories = async () => ([
    {
      id: 'wrong-project',
      score: 0.91,
      payload: {
        content: 'Leaked result from another project.',
        project: 'bench/other-project',
        user_id: '00000000-0000-4000-8000-000000000121',
        is_latest: true
      }
    },
    {
      id: 'right-project',
      score: 0.67,
      payload: {
        content: 'Scoped result from the requested project.',
        project: 'bench/requested-project',
        user_id: '00000000-0000-4000-8000-000000000121',
        is_latest: true
      }
    }
  ]);

  try {
    const result = await hybridSearch.hybridSearch({
      query: 'workshop timeline',
      queryVector: [0.1, 0.2, 0.3],
      userId: '00000000-0000-4000-8000-000000000121',
      project: 'bench/requested-project',
      limit: 5,
      weights: { vector: 1, keyword: 0, graph: 0 }
    });

    assert.deepEqual(result.results.map(item => item.id), ['right-project']);
  } finally {
    client.isConnected = originalIsConnected;
    client.ensureCollection = originalEnsureCollection;
    client.searchMemories = originalSearchMemories;
  }
});

test('hybridSearch boosts date-bearing event results for temporal comparisons', async () => {
  const client = getQdrantClient();
  const originalIsConnected = client.isConnected;
  const originalEnsureCollection = client.ensureCollection;
  const originalSearchMemories = client.searchMemories;

  client.isConnected = async () => true;
  client.ensureCollection = async () => true;
  client.searchMemories = async () => ([
    {
      id: 'workshop',
      score: 0.82,
      payload: {
        content: 'I attended the Effective Time Management workshop last Saturday.',
        project: 'bench/requested-project',
        user_id: '00000000-0000-4000-8000-000000000131',
        is_latest: true,
        document_date: '2023-05-28T21:04:00.000Z'
      }
    },
    {
      id: 'webinar',
      score: 0.80,
      payload: {
        content: 'I attended the Data Analysis using Python webinar two months ago.',
        project: 'bench/requested-project',
        user_id: '00000000-0000-4000-8000-000000000131',
        is_latest: true,
        document_date: '2023-03-28T07:17:00.000Z'
      }
    }
  ]);

  try {
    const result = await hybridSearch.hybridSearch({
      query: 'Which event did I attend first, the "Effective Time Management" workshop or the "Data Analysis using Python" webinar?',
      queryVector: [0.1, 0.2, 0.3],
      userId: '00000000-0000-4000-8000-000000000131',
      project: 'bench/requested-project',
      limit: 5,
      weights: { vector: 1, keyword: 0, graph: 0 }
    });

    assert.equal(result.results[0].id, 'webinar');
    assert.ok(result.results[0].score >= result.results[1].score);
  } finally {
    client.isConnected = originalIsConnected;
    client.ensureCollection = originalEnsureCollection;
    client.searchMemories = originalSearchMemories;
  }
});
