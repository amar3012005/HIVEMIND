import test from 'node:test';
import assert from 'node:assert/strict';

import hybridSearch from '../../src/search/hybrid.js';
import { PanoramaSearch } from '../../src/search/panorama-search.js';

test('PanoramaSearch does not force latest-only filtering for historical search', async () => {
  const originalHybridSearch = hybridSearch.hybridSearch;
  const capturedOptions = [];

  hybridSearch.hybridSearch = async (options) => {
    capturedOptions.push(options);
    if (capturedOptions.length <= 2) {
      return { results: [], metadata: {} };
    }
    return { results: [], metadata: {} };
  };

  try {
    const panorama = new PanoramaSearch();
    panorama.fallbackProjectSearch = async () => ([
      {
        id: 'scoped-result',
        project: 'bench/panorama-test',
        user_id: '00000000-0000-4000-8000-000000007771',
        org_id: '00000000-0000-4000-8000-000000007772',
        score: 0.9
      }
    ]);
    const result = await panorama.executeTemporalSearch('timeline of workshop and webinar', {
      userId: '00000000-0000-4000-8000-000000007771',
      orgId: '00000000-0000-4000-8000-000000007772',
      project: 'bench/panorama-test',
      includeExpired: true,
      includeHistorical: true,
      dateRange: null,
      limit: 10,
      weights: { vector: 0.5, keyword: 0.3, graph: 0.2 }
    });

    assert.equal(capturedOptions.length, 2);
    assert.equal(capturedOptions[0].project, 'bench/panorama-test');
    assert.equal(capturedOptions[0].isLatest, undefined);
    assert.equal(capturedOptions[0].vectorScoreThreshold, 0.12);
    assert.equal(capturedOptions[0].finalScoreThreshold, 0.05);
    assert.equal(capturedOptions[1].vectorScoreThreshold, 0);
    assert.equal(capturedOptions[1].finalScoreThreshold, 0);
    assert.deepEqual(result.results.map((item) => item.id), ['scoped-result']);
  } finally {
    hybridSearch.hybridSearch = originalHybridSearch;
  }
});
