import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBenchmarkContext,
  getLongMemEvalRetrievalPlan
} from '../../src/evaluation/longmemeval-routing.js';

test('temporal questions route to panorama with a temporal window', () => {
  const plan = getLongMemEvalRetrievalPlan({
    question: 'What happened in March 2026?',
    questionType: 'temporal-reasoning'
  });

  assert.equal(plan.route, 'panorama');
  assert.equal(plan.body.include_expired, true);
  assert.equal(plan.body.include_historical, true);
  assert.equal(plan.body.date_range.start, '2026-03-01');
  assert.equal(plan.body.date_range.end, '2026-03-31');
  assert.match(plan.systemHint, /Temporal focus/);
});

test('knowledge update questions route to panorama without dropping history', () => {
  const plan = getLongMemEvalRetrievalPlan({
    question: 'What is the updated answer now?',
    questionType: 'knowledge-update'
  });

  assert.equal(plan.route, 'panorama');
  assert.equal(plan.body.include_expired, true);
  assert.equal(plan.body.include_historical, true);
  assert.match(plan.systemHint, /Knowledge-update focus/);
});

test('benchmark context dedupes repeated memory content and preserves metadata', () => {
  const context = buildBenchmarkContext({
    results: [
      {
        score: 0.91,
        title: 'First memory',
        content: 'Alpha answer from session one.',
        document_date: '2026-03-01',
        memory_type: 'event',
        tags: ['longmemeval']
      },
      {
        score: 0.88,
        title: 'Duplicate memory',
        content: 'Alpha answer from session one.',
        document_date: '2026-03-02',
        memory_type: 'event',
        tags: ['longmemeval']
      },
      {
        score: 0.72,
        title: 'Second memory',
        content: 'Beta answer from session two.',
        document_date: '2026-03-03',
        memory_type: 'fact',
        tags: ['longmemeval']
      }
    ]
  }, { maxItems: 5 });

  assert.match(context, /title=First memory/);
  assert.match(context, /title=Second memory/);
  assert.equal((context.match(/Alpha answer from session one\./g) || []).length, 1);
});

