import test from 'node:test';
import assert from 'node:assert/strict';

import { ThreeTierRetrieval } from '../../src/search/three-tier-retrieval.js';

test('ThreeTierRetrieval insightForge filters out results outside the requested project', async () => {
  const retrieval = new ThreeTierRetrieval({
    llmClient: { generate: async () => '' }
  });

  retrieval.insightForgeEngine = {
    analyze: async () => ({
      subQueries: [],
      results: [
        {
          id: 'wrong-project',
          payload: {
            user_id: '00000000-0000-4000-8000-000000000201',
            org_id: '00000000-0000-4000-8000-000000000202',
            project: 'other-project'
          }
        },
        {
          id: 'right-project',
          payload: {
            user_id: '00000000-0000-4000-8000-000000000201',
            org_id: '00000000-0000-4000-8000-000000000202',
            project: 'bench/target-project'
          }
        }
      ],
      semanticFacts: [],
      entityInsights: [],
      relationshipChains: [],
      synthesis: null
    })
  };

  const result = await retrieval.insightForge('which event came first', {
    userId: '00000000-0000-4000-8000-000000000201',
    orgId: '00000000-0000-4000-8000-000000000202',
    project: 'bench/target-project',
    includeAnalysis: false
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'right-project');
});
