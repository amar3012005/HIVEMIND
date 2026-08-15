import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAnswerContextStatus, normalizeAnswerCoverage } from '../../src/agent/chat-answer-coverage.js';

test('semantic answer coverage makes an omitted supported detail observable without keyword rules', () => {
  const coverage = normalizeAnswerCoverage([
    { request: 'the first requested detail', status: 'supported', citation_ids: ['P1-C1'] },
    { request: 'the second requested detail', status: 'unsupported', citation_ids: [] },
    { request: '', status: 'supported', citation_ids: ['P1-C2'] },
  ]);
  assert.deepEqual(coverage, [
    { request: 'the first requested detail', status: 'supported', citation_ids: ['P1-C1'] },
    { request: 'the second requested detail', status: 'unsupported', citation_ids: [] },
  ]);
  assert.equal(deriveAnswerContextStatus({ context_status: 'sufficient', coverage }), 'relevant_but_incomplete');
  assert.equal(deriveAnswerContextStatus({ context_status: 'sufficient', gaps: ['one detail is missing'] }), 'relevant_but_incomplete');
  assert.equal(deriveAnswerContextStatus({ context_status: 'sufficient', coverage: coverage.slice(0, 1) }), 'sufficient');
  assert.equal(deriveAnswerContextStatus({ context_status: 'query_mismatch', coverage }), 'query_mismatch');
});
