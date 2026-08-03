import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFirstLifeExperience } from '../../src/hq-runtime/routes.js';

test('first-life experience projects persisted recognition and one startable recommendation', () => {
  const result = projectFirstLifeExperience({
    runtime: { epoch: 'epoch-3' },
    firstLife: {
      status: 'AWAITING_START', recommended_todo_id: 'todo-1', waiting_reason: 'initial_start_decision',
      items: [
        { todo_id: 'todo-1', title: 'Empfohlene Bewegung', objective: 'Belegte Arbeit.', status: 'PROPOSED', recommended: true, response_locale: 'de-DE' },
        { todo_id: 'todo-2', title: 'Weitere Chance', objective: 'Bleibt vorgeschlagen.', status: 'PROPOSED', recommended: false, response_locale: 'de-DE' },
      ],
    },
    growthBrief: { primary_constraint: { statement: 'Belegte Einschraenkung' } },
    tasks: [
      { id: 'todo-1', expected_outcome: 'Ein messbares Ergebnis', success_measure: 'Ein Signal' },
      { id: 'todo-2', expected_outcome: 'Neue Evidenz' },
    ],
    recognitionEvents: [{
      sequence: 4n,
      title: 'website',
      summary: 'not_observed',
      details: { source_key: 'website', status: 'not_observed', facts: { website: null, page_count: null }, artifact_id: 'artifact-1' },
      evidenceRefs: ['artifact-1'],
      createdAt: new Date('2026-08-03T10:00:00Z'),
    }],
  });

  assert.equal(result.epoch, 'epoch-3');
  assert.equal(result.phase, 'AWAITING_START');
  assert.equal(result.can_start, true);
  assert.equal(result.recognition[0].status, 'not_observed');
  assert.equal(result.recognition[0].artifact_id, 'artifact-1');
  assert.equal(result.opportunities.length, 2);
  assert.equal(result.recommendation.todo_id, 'todo-1');
  assert.equal(result.recommendation.expected_outcome, 'Ein messbares Ergebnis');
});

