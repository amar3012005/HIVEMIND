import test from 'node:test';
import assert from 'node:assert/strict';

import hybridSearch from '../../src/search/hybrid.js';
import { PanoramaSearch } from '../../src/search/panorama-search.js';

test('PanoramaSearch does not force latest-only filtering for historical search', async () => {
  const originalHybridSearch = hybridSearch.hybridSearch;
  let capturedOptions = null;

  hybridSearch.hybridSearch = async (options) => {
    capturedOptions = options;
    return { results: [], metadata: {} };
  };

  try {
    const panorama = new PanoramaSearch();
    await panorama.executeTemporalSearch('timeline of workshop and webinar', {
      userId: '00000000-0000-4000-8000-000000007771',
      orgId: '00000000-0000-4000-8000-000000007772',
      project: 'bench/panorama-test',
      includeExpired: true,
      includeHistorical: true,
      dateRange: null,
      limit: 10,
      weights: { vector: 0.5, keyword: 0.3, graph: 0.2 }
    });

    assert.ok(capturedOptions);
    assert.equal(capturedOptions.project, 'bench/panorama-test');
    assert.equal(capturedOptions.isLatest, undefined);
  } finally {
    hybridSearch.hybridSearch = originalHybridSearch;
  }
});
