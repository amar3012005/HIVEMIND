import test from 'node:test';
import assert from 'node:assert/strict';
import hybridSearch from '../../src/search/hybrid.js';
import { InsightForge } from '../../src/search/insight-forge.js';

test('InsightForge scopes sub-query searches by project', async () => {
  const originalHybridSearch = hybridSearch.hybridSearch;
  const calls = [];

  hybridSearch.hybridSearch = async (options) => {
    calls.push(options);
    return { results: [] };
  };

  try {
    const forge = new InsightForge({ llmClient: { generate: async () => '' } });
    await forge.searchSubQueries(
      [
        { id: 'sq-1', query: 'first event', focus: 'temporal', weight: 0.5 },
        { id: 'sq-2', query: 'second event', focus: 'temporal', weight: 0.5 }
      ],
      {
        userId: '00000000-0000-4000-8000-000000001231',
        orgId: '00000000-0000-4000-8000-000000001232',
        project: 'benchmark-project',
        limit: 4
      }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].project, 'benchmark-project');
    assert.equal(calls[1].project, 'benchmark-project');
  } finally {
    hybridSearch.hybridSearch = originalHybridSearch;
  }
});

test('InsightForge scopes graph relationship expansion by project', async () => {
  const calls = [];
  const forge = new InsightForge({
    llmClient: { generate: async () => '' },
    graphStore: {
      getRelatedMemories: async (_memoryId, options) => {
        calls.push(options);
        return [];
      }
    }
  });

  await forge.buildRelationshipChains(
    [
      { id: 'entity-a', name: 'Workshop' },
      { id: 'entity-b', name: 'Webinar' }
    ],
    [
      { id: 'memory-1', content: 'Workshop happened first.' },
      { id: 'memory-2', content: 'Webinar happened later.' }
    ],
    {
      userId: '00000000-0000-4000-8000-000000001231',
      orgId: '00000000-0000-4000-8000-000000001232',
      project: 'benchmark-project'
    }
  );

  assert.ok(calls.length > 0);
  assert.equal(calls[0].project, 'benchmark-project');
  assert.equal(calls[0].user_id, '00000000-0000-4000-8000-000000001231');
});
