import test from 'node:test';
import assert from 'node:assert/strict';
import { collectExternalActionMarkers, projectExternalActionEvent } from '../../src/hq-runtime/external-action-marker.js';

test('collects and deduplicates adapter-owned external action markers', () => {
  const marker = { id: 'provider:one', presentation_type: 'message', provider: 'provider', status: 'sent' };
  const artifacts = [
    { id: 'artifact-1', data: { external_action_marker: marker } },
    { id: 'artifact-2', data: { external_action_markers: [marker, { id: 'provider:two', presentation_type: 'call' }] } },
    { id: 'artifact-3', data: { external_action_marker: { presentation_type: 'message' } } },
  ];
  const result = collectExternalActionMarkers(artifacts);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.id), ['provider:one', 'provider:two']);
});

test('projects one checkpoint carousel event without knowing its business domain', () => {
  const event = projectExternalActionEvent({
    run: { id: 'run-1', playbookId: 'any.playbook', playbookVersion: 3 },
    stage: { id: 'effect-stage' },
    artifacts: [{ id: 'artifact-1', data: { external_action_markers: [
      { id: 'effect-1', presentation_type: 'arbitrary_frame', headline: 'First effect' },
      { id: 'effect-2', presentation_type: 'another_frame', headline: 'Second effect' },
    ] } }],
  });
  assert.equal(event.eventType, 'external_action_committed');
  assert.equal(event.details.item_count, 2);
  assert.match(event.idempotencyKey, /^external-action:run-1:effect-stage:/);
  assert.deepEqual(event.evidenceRefs, ['artifact-1']);
});

test('does not project prose or artifacts without an external effect presentation', () => {
  assert.equal(projectExternalActionEvent({
    run: { id: 'run-1' }, stage: { id: 'stage-1' }, artifacts: [{ id: 'report', data: { text: 'Done' } }],
  }), null);
});
