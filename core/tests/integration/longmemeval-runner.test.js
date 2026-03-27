import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLongMemEvalReport,
  classifyLongMemEvalBottleneck,
  selectContextResults,
  normalizeSearchResults
} from '../../src/evaluation/longmemeval-runner.js';

test('longmemeval runner deduplicates retrieval context snippets', () => {
  const searchResults = {
    results: [
      { id: 'm1', content: 'Shared context about the deployment window.', score: 0.92 },
      { id: 'm2', content: 'Shared context about the deployment window.', score: 0.91 },
      { id: 'm3', content: 'Distinct follow-up about rollback criteria.', score: 0.88 }
    ]
  };

  const normalized = normalizeSearchResults(searchResults);
  const selected = selectContextResults(searchResults, 5);

  assert.equal(normalized.length, 3);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].id, 'm1');
  assert.equal(selected[1].id, 'm3');
});

test('longmemeval report exposes bottlenecks and judge coverage', () => {
  const records = [
    {
      question_id: 'q1',
      question_type: 'temporal-reasoning',
      isAbstention: false,
      hypothesis: 'The answer is March 20.',
      autoeval_label: 'yes',
      retrieval: {
        route: 'panorama',
        query: 'What happened in March?',
        projectResultCount: 3,
        fallbackResultCount: 0,
        resultCount: 3,
        selectedContextCount: 3,
        contextChars: 280,
        searchLatencyMs: 50,
        generationLatencyMs: 140,
        usedGlobalFallback: false,
        topResults: []
      }
    },
    {
      question_id: 'q2_abs',
      question_type: 'knowledge-update',
      isAbstention: true,
      hypothesis: 'I do not know.',
      autoeval_label: 'no',
      retrieval: {
        route: 'panorama',
        query: 'What changed after the update?',
        projectResultCount: 0,
        fallbackResultCount: 0,
        resultCount: 0,
        selectedContextCount: 0,
        contextChars: 0,
        searchLatencyMs: 42,
        generationLatencyMs: 90,
        usedGlobalFallback: false,
        topResults: []
      }
    },
    {
      question_id: 'q3',
      question_type: 'single-session-preference',
      isAbstention: false,
      hypothesis: 'The user preferred the shorter format.',
      autoeval_label: 'no',
      retrieval: {
        route: 'recall',
        query: 'What format was preferred?',
        projectResultCount: 1,
        fallbackResultCount: 4,
        resultCount: 4,
        selectedContextCount: 4,
        contextChars: 180,
        searchLatencyMs: 61,
        generationLatencyMs: 130,
        usedGlobalFallback: true,
        topResults: []
      }
    }
  ];

  const report = buildLongMemEvalReport({
    phase: 'judge',
    dataPath: '/tmp/longmemeval.json',
    totalDatasetSize: 3,
    sample: 3,
    startFrom: 0,
    instances: records,
    records,
    ingestion: {
      totalIngested: 12,
      totalSkipped: 1,
      durationSeconds: 4
    },
    timings: {
      judgeSeconds: 6
    },
    judgeFile: '/tmp/longmemeval.judged.jsonl'
  });

  const abstentionBottleneck = classifyLongMemEvalBottleneck(records[1]);
  const fallbackBottleneck = classifyLongMemEvalBottleneck(records[2]);

  assert.equal(report.kind, 'hivemind.longmemeval-benchmark-report');
  assert.equal(report.summary.judgedQuestions, 3);
  assert.equal(report.summary.judgedAccuracy, 33.33);
  assert.equal(report.summary.retrieval.emptyContextCount, 1);
  assert.equal(report.bottlenecks.counts.abstention_failure, 1);
  assert.equal(report.bottlenecks.counts.scope_fallback, 1);
  assert.equal(report.bottlenecks.top[0].type, 'abstention_failure');
  assert.equal(abstentionBottleneck.type, 'abstention_failure');
  assert.equal(fallbackBottleneck.type, 'scope_fallback');
  assert.equal(report.files.judged, '/tmp/longmemeval.judged.jsonl');
});
