import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptToDecision } from '../../src/agent/chat-progressive-router.js';
import { intentDecisionToPlan } from '../../src/agent/chat-intent-decision.js';
import { isMemoryInDateRange, selectEventRangeCandidates } from '../../src/memory/temporal-range.js';

test('activity during yesterday compiles to an event-time recall window, not time travel', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    operation: 'temporal_range',
    query_original: 'what did we do yesterday',
    query_canonical_en: 'work completed',
    response_language: 'en',
    mode: 'explain',
    entities: [],
    range_start: '2026-08-08',
    range_end: '2026-08-08',
    valid_at: null,
    known_at: null,
    source_title: null,
    aggregate_kind: null,
    answer_type: 'event',
  }, 'what did we do yesterday', 'en');

  assert.equal(decision.operation, 'recall');
  assert.deepEqual(decision.time, {
    valid_at: null,
    known_at: null,
    range: {
      start: '2026-08-08T00:00:00.000Z',
      end: '2026-08-08T23:59:59.999Z',
    },
    kind: 'event_range',
  });

  const plan = intentDecisionToPlan(decision, 'what did we do yesterday');
  assert.equal(plan.needs_time_travel, false);
  assert.deepEqual(plan.time.range, decision.time.range);
});

test('decisions in the last seven days retain the typed event range and decision boost', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    operation: 'temporal_range',
    query_original: 'what decisions did we take in last 7 days',
    query_canonical_en: 'decisions taken',
    response_language: 'en',
    mode: 'explain',
    entities: [],
    range_start: '2026-08-03T00:00:00.000Z',
    range_end: '2026-08-09T23:59:59.999Z',
    valid_at: null,
    known_at: null,
    source_title: null,
    aggregate_kind: null,
    answer_type: 'decision',
  }, 'what decisions did we take in last 7 days', 'en');

  const plan = intentDecisionToPlan(decision, 'what decisions did we take in last 7 days');
  assert.equal(plan.needs_time_travel, false);
  assert.equal(plan.answer_type, 'decision');
  assert.equal(plan.time.kind, 'event_range');
});

test('a partially populated event window expands to the full resolved UTC day', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    operation: 'temporal_range', query_canonical_en: 'activity', response_language: 'de',
    mode: 'explain', entities: [], range_start: '2026-08-08T09:15:00Z', range_end: null,
    valid_at: null, known_at: null, source_title: null, aggregate_kind: null, answer_type: 'event',
  }, 'Was haben wir gestern gemacht?', 'de');
  assert.deepEqual(decision.time.range, {
    start: '2026-08-08T00:00:00.000Z',
    end: '2026-08-08T23:59:59.999Z',
  });
});

test('snapshot diff retains the existing bi-temporal tool path', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    operation: 'diff',
    query_original: 'what changed between August 3 and August 9',
    query_canonical_en: 'workspace changes',
    response_language: 'en',
    mode: 'explain',
    entities: [],
    range_start: '2026-08-03',
    range_end: '2026-08-09',
    valid_at: null,
    known_at: null,
    source_title: null,
    aggregate_kind: null,
    answer_type: 'event',
  }, 'what changed between 2026-08-03 and 2026-08-09', 'en');

  const plan = intentDecisionToPlan(decision, 'what changed between 2026-08-03 and 2026-08-09');
  assert.equal(decision.operation, 'timeline');
  assert.equal(decision.time.kind, 'snapshot_diff');
  assert.equal(plan.needs_time_travel, true);
});

test('semantic event-window contract corrects an inconsistent diff operation', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    operation: 'diff', temporal_semantics: 'event_window',
    query_canonical_en: 'decisions taken', response_language: 'en', mode: 'explain', entities: [],
    range_start: '2026-08-03', range_end: '2026-08-09', valid_at: null, known_at: null,
    source_title: null, aggregate_kind: null, answer_type: 'decision',
  }, 'what decisions did we take in last 7 days', 'en');
  const plan = intentDecisionToPlan(decision, 'what decisions did we take in last 7 days');
  assert.equal(decision.operation, 'recall');
  assert.equal(decision.time.kind, 'event_range');
  assert.equal(plan.needs_time_travel, false);
});

test('event-window semantics remain authoritative when native tool is ordinary recall', () => {
  const { decision } = adaptToDecision('hivemind_context', {
    native_tool: 'hivemind_recall', operation: 'recall', temporal_semantics: 'event_window',
    query_canonical_en: 'decisions during the last seven days', response_language: 'en',
    mode: 'explain', entities: [], range_start: '2026-08-13', range_end: '2026-08-19',
    valid_at: null, known_at: null, source_title: null, aggregate_kind: null,
    answer_type: 'decision', response_depth: 'standard', retrieval_shape: 'inventory',
    answer_objective: 'List decisions made during the window.',
  }, 'What decisions did we make in the last 7 days?', 'en', { useTools: false });
  assert.equal(decision.operation, 'recall');
  assert.equal(decision.time.kind, 'event_range');
  assert.deepEqual(decision.time.range, {
    start: '2026-08-13T00:00:00.000Z',
    end: '2026-08-19T23:59:59.999Z',
  });
});

test('event windows match canonical temporal tags even when record time is outside the window', () => {
  const memory = {
    created_at: '2026-08-09T10:00:00.000Z',
    tags: ['entity:deployment', 'ts:2026-08-08', 'time:friday'],
  };
  assert.equal(isMemoryInDateRange(memory, {
    start: '2026-08-08T00:00:00.000Z',
    end: '2026-08-08T23:59:59.999Z',
  }), true);
  assert.equal(isMemoryInDateRange(memory, {
    start: '2026-08-07T00:00:00.000Z',
    end: '2026-08-07T23:59:59.999Z',
  }), false);
});

test('large event windows stay bounded and prioritize the planner-selected memory type', () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    id: `m-${index}`,
    memory_type: index % 10 === 0 ? 'decision' : 'fact',
  }));
  const selected = selectEventRangeCandidates(rows, 'decision', 60);
  assert.equal(selected.length, 60);
  assert.equal(selected.slice(0, 50).every((row) => row.memory_type === 'decision'), true);
  assert.equal(new Set(selected.map((row) => row.id)).size, 60);
});
