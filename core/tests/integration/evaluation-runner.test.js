import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildReportEnvelope,
  loadBaseline,
  saveReport,
  selectQueries
} from '../../src/evaluation/run-evaluation.js';

test('evaluation runner selects the cross-client dataset explicitly', () => {
  const queries = selectQueries({
    dataset: 'cross-client',
    category: null,
    difficulty: null,
    sample: null
  });

  assert.ok(queries.length >= 1);
  assert.ok(queries.every(query => query.category === 'cross-client'));
});

test('evaluation runner writes and reloads a machine-readable baseline bundle', () => {
  const bundle = buildReportEnvelope({
    schemaVersion: '2026-03-19',
    summary: {
      qualityScore: 88,
      latencyP99: 120,
      totalQueries: 3,
      successfulQueries: 3,
      failedQueries: 0,
      precisionAt5: { mean: 1 },
      recallAt10: { mean: 1 },
      f1At10: { mean: 1 },
      ndcgAt10: { mean: 1 },
      mrr: { mean: 1 }
    },
    bySearchMethod: {},
    byCategory: {},
    methods: ['quick']
  }, {
    dataset: 'cross-client',
    category: null,
    difficulty: null,
    sample: null,
    method: 'quick',
    userId: 'user-1',
    orgId: 'org-1'
  }, {
    assessment: 'improved'
  });

  const filename = path.join(os.tmpdir(), `hivemind-eval-baseline-${Date.now()}.json`);
  saveReport(bundle, filename);
  const loaded = loadBaseline(filename);

  assert.equal(bundle.kind, 'hivemind.retrieval-evaluation.bundle');
  assert.equal(bundle.dataset, 'cross-client');
  assert.equal(bundle.comparison.assessment, 'improved');
  assert.equal(loaded.summary.qualityScore, 88);
  assert.equal(loaded.methods[0], 'quick');

  fs.unlinkSync(filename);
});
