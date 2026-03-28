import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLongMemEvalReport,
  classifyLongMemEvalBottleneck,
  buildGenerationPrompt,
  buildTemporalEvidenceContext,
  extractTemporalEvidence,
  answerTemporalQuestion,
  mergeRetrievalResults,
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

test('normalizeSearchResults keeps session_date from metadata for temporal evidence', () => {
  const normalized = normalizeSearchResults({
    results: [
      {
        id: 'm1',
        content: 'I attended the workshop.',
        payload: {
          metadata: {
            session_date: '2023/05/28 (Sun) 21:04'
          }
        }
      }
    ]
  });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].date, '2023/05/28 (Sun) 21:04');
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

test('runner merges retrieval results by id and normalized content', () => {
  const merged = mergeRetrievalResults(
    {
      results: [
        { id: 'm1', content: 'Alpha memory snippet', score: 0.9 },
        { id: 'm2', content: 'Beta memory snippet', score: 0.8 }
      ]
    },
    {
      results: [
        { id: 'm2', content: 'Beta memory snippet', score: 0.79 },
        { id: 'm3', content: 'alpha   memory   snippet', score: 0.7 },
        { id: 'm4', content: 'Gamma memory snippet', score: 0.69 }
      ]
    },
    10
  );

  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map(item => item.id), ['m1', 'm2', 'm4']);
});

test('generation prompt asks for a short direct answer without chain-of-thought', () => {
  const prompt = buildGenerationPrompt({
    context: '- (score=0.900) User attended the webinar in March.',
    question: 'Which webinar did I attend first?',
    questionDate: '2023/05/28 (Sun) 06:47',
    systemHint: 'Temporal focus: use the date window.'
  });

  assert.match(prompt, /Return a short direct answer/);
  assert.match(prompt, /Retrieved Memory Context:/);
  assert.match(prompt, /Question: Which webinar did I attend first\?/);
  assert.doesNotMatch(prompt, /step by step/i);
});

test('temporal evidence extractor and comparator answer first-event questions deterministically', () => {
  const evidence = extractTemporalEvidence(
    'Which event did I attend first, the "Effective Time Management" workshop or the "Data Analysis using Python" webinar?',
    [
      {
        id: 'm1',
        content: 'I attended the Effective Time Management workshop last Saturday.',
        date: '2023-05-28T21:04:00.000Z'
      },
      {
        id: 'm2',
        content: 'I attended the Data Analysis using Python webinar two months ago.',
        date: '2023-03-28T07:17:00.000Z'
      }
    ]
  );

  const answer = answerTemporalQuestion(
    'Which event did I attend first, the "Effective Time Management" workshop or the "Data Analysis using Python" webinar?',
    evidence
  );
  const structured = buildTemporalEvidenceContext('Which event did I attend first?', evidence);

  assert.equal(evidence.length, 2);
  assert.equal(answer.answer, 'Data Analysis using Python');
  assert.equal(answer.mode, 'deterministic');
  assert.match(structured, /Structured Temporal Evidence:/);
  assert.match(structured, /2023-03-28/);
});

test('temporal comparator computes explicit day differences from dated evidence', () => {
  const answer = answerTemporalQuestion(
    'How many days before the meeting was the workshop?',
    [
      {
        memoryId: 'workshop',
        matchedTargets: ['workshop'],
        date: new Date('2023-01-10T00:00:00.000Z'),
        snippet: 'Workshop happened on January 10.'
      },
      {
        memoryId: 'meeting',
        matchedTargets: ['meeting'],
        date: new Date('2023-01-17T00:00:00.000Z'),
        snippet: 'Meeting prep was on January 17.'
      }
    ]
  );

  assert.equal(answer.answer, '7');
  assert.equal(answer.mode, 'deterministic');
});
