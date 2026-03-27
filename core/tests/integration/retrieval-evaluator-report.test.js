import test from 'node:test';
import assert from 'node:assert/strict';
import { RetrievalEvaluator } from '../../src/evaluation/retrieval-evaluator.js';

function createStubEvaluator() {
  const evaluator = Object.create(RetrievalEvaluator.prototype);
  evaluator.config = {
    thresholds: {
      precisionAt5: 0.8,
      recallAt10: 0.7,
      f1Score: 0.75,
      ndcgAt10: 0.75,
      mrr: 0.6,
      latencyP99: 300
    },
    weights: {
      precision: 0.25,
      recall: 0.25,
      ndcg: 0.25,
      mrr: 0.15,
      latency: 0.10
    }
  };
  return evaluator;
}

test('retrieval evaluator surfaces semantic gaps and bottleneck breakdowns', () => {
  const evaluator = createStubEvaluator();

  const noisyResult = {
    query: 'What was decided about the deployment?',
    category: 'technical',
    method: 'quick',
    latencyMs: 120,
    metrics: {
      precisionAt5: 0.2,
      precisionAt10: 0.3,
      precisionAt20: 0.3,
      recallAt5: 0.2,
      recallAt10: 0.8,
      recallAt20: 0.8,
      f1At5: 0.2,
      f1At10: 0.33,
      f1At20: 0.33,
      ndcgAt5: 0.31,
      ndcgAt10: 0.42,
      ndcgAt20: 0.42,
      mrr: 0.5,
      semanticPrecisionAt5: 0.7,
      semanticGapAt5: 0.5,
      firstRelevantRank: 2,
      relevantHitsAt1: 0,
      relevantHitsAt5: 1,
      relevantHitsAt10: 2,
      relevantHitsAt20: 2,
      truePositivesAt10: 2,
      falsePositivesAt10: 8,
      falseNegativesAt10: 0
    },
    diagnostics: evaluator.diagnoseBottlenecks({
      precisionAt5: 0.2,
      recallAt10: 0.8,
      ndcgAt10: 0.42,
      mrr: 0.5,
      latencyMs: 120,
      semanticPrecisionAt5: 0.7,
      semanticGapAt5: 0.5,
      firstRelevantRank: 2
    }, { relevantCount: 2 }),
    passed: { allPassed: false }
  };

  const healthyResult = {
    query: 'What did we learn about the caching strategy?',
    category: 'business',
    method: 'recall',
    latencyMs: 80,
    metrics: {
      precisionAt5: 0.9,
      precisionAt10: 0.9,
      precisionAt20: 0.9,
      recallAt5: 0.8,
      recallAt10: 0.9,
      recallAt20: 0.9,
      f1At5: 0.85,
      f1At10: 0.9,
      f1At20: 0.9,
      ndcgAt5: 0.92,
      ndcgAt10: 0.93,
      ndcgAt20: 0.93,
      mrr: 1,
      semanticPrecisionAt5: 0.9,
      semanticGapAt5: 0,
      firstRelevantRank: 1,
      relevantHitsAt1: 1,
      relevantHitsAt5: 2,
      relevantHitsAt10: 2,
      relevantHitsAt20: 2,
      truePositivesAt10: 2,
      falsePositivesAt10: 0,
      falseNegativesAt10: 0
    },
    diagnostics: {
      primary: { type: 'healthy', severity: 'low', reason: 'Thresholds met' },
      bottlenecks: [{ type: 'healthy', severity: 'low', reason: 'Thresholds met' }]
    },
    passed: { allPassed: true }
  };

  const report = evaluator.generateReport([noisyResult, healthyResult], {
    evaluationId: 'eval-001',
    duration: 1000,
    dataset: 'cross-client',
    methods: ['quick', 'recall'],
    failedQueries: [],
    testQueries: [
      { query: noisyResult.query, category: noisyResult.category, difficulty: 'medium', relevantMemories: ['m1', 'm2'] },
      { query: healthyResult.query, category: healthyResult.category, difficulty: 'easy', relevantMemories: ['m3', 'm4'] }
    ]
  });

  assert.equal(report.summary.totalQueries, 2);
  assert.equal(report.summary.successfulQueries, 2);
  assert.equal(report.summary.semanticPrecisionAt5.mean, 0.8);
  assert.equal(report.summary.semanticGapAt5.mean, 0.25);
  assert.equal(report.bottleneckSummary.top[0].type, 'label_alignment');
  assert.ok(report.bottleneckSummary.counts.label_alignment >= 1);
  assert.ok(report.bottleneckSummary.counts.healthy >= 1);
  assert.equal(report.relevance_benchmark.semantic_precision_at_5, 0.8);
});

test('retrieval evaluator comparison includes semantic precision changes', () => {
  const evaluator = createStubEvaluator();
  const comparison = evaluator.compareReports(
    {
      summary: {
        precisionAt5: { mean: 0.4 },
        semanticPrecisionAt5: { mean: 0.45 },
        recallAt10: { mean: 0.5 },
        f1At10: { mean: 0.42 },
        ndcgAt10: { mean: 0.44 },
        mrr: { mean: 0.3 },
        qualityScore: 55,
        latencyP99: 180
      }
    },
    {
      summary: {
        precisionAt5: { mean: 0.55 },
        semanticPrecisionAt5: { mean: 0.72 },
        recallAt10: { mean: 0.62 },
        f1At10: { mean: 0.58 },
        ndcgAt10: { mean: 0.6 },
        mrr: { mean: 0.5 },
        qualityScore: 72,
        latencyP99: 160
      }
    }
  );

  assert.equal(comparison.assessment, 'improved');
  assert.ok(comparison.improvements.semanticPrecisionAt5);
  assert.equal(comparison.overall.qualityScore.delta, 17);
});
