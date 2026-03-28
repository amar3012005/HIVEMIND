import test from 'node:test';
import assert from 'node:assert/strict';

import hybridSearch from '../../src/search/hybrid.js';
import { getQdrantClient } from '../../src/vector/qdrant-client.js';

test('hybridSearch forwards project scope into vector and semantic retrieval', async () => {
  const qdrant = getQdrantClient();
  const originalSearchMemories = qdrant.searchMemories;
  const calls = [];

  qdrant.searchMemories = async ({ filter }) => {
    calls.push(filter);
    return [];
  };

  try {
    await hybridSearch.hybridSearch({
      query: 'compare workshop and webinar dates',
      userId: '00000000-0000-4000-8000-000000009991',
      orgId: '00000000-0000-4000-8000-000000009992',
      project: 'bench/isolation-test',
      limit: 5,
      weights: { vector: 1, keyword: 0, graph: 0 }
    });

    assert.ok(calls.length >= 1);
    for (const filter of calls) {
      assert.ok(filter.must.some((clause) => clause.key === 'project' && clause.match?.value === 'bench/isolation-test'));
    }
  } finally {
    qdrant.searchMemories = originalSearchMemories;
  }
});
