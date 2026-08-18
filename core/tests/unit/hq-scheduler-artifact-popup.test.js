import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedArtifactPopupState } from '../../src/hq-runtime/scheduler.js';

test('a research_decision checkpoint acceptance is popup-worthy', () => {
  const { refs, popupWorthy } = acceptedArtifactPopupState('ACCEPTED', [
    { id: 'artifact-1', key: 'research_decision' },
  ]);
  assert.deepEqual(refs, [{ id: 'artifact-1', key: 'research_decision' }]);
  assert.equal(popupWorthy, true);
});

test('routine checkpoint keys (campaign_status, campaign_capability_status) are NOT popup-worthy — avoids flooding the terminal', () => {
  const { popupWorthy } = acceptedArtifactPopupState('ACCEPTED', [
    { id: 'artifact-1', key: 'campaign_status' },
    { id: 'artifact-2', key: 'campaign_capability_status' },
  ]);
  assert.equal(popupWorthy, false);
});

test('a mix of routine and popup-worthy artifacts still counts as popup-worthy', () => {
  const { popupWorthy } = acceptedArtifactPopupState('ACCEPTED', [
    { id: 'artifact-1', key: 'campaign_status' },
    { id: 'artifact-2', key: 'research_decision' },
  ]);
  assert.equal(popupWorthy, true);
});

test('non-ACCEPTED phases (STARTED, REJECTED) never carry refs or popup-worthiness', () => {
  assert.deepEqual(acceptedArtifactPopupState('STARTED', [{ id: 'a', key: 'research_decision' }]), { refs: [], popupWorthy: false });
  assert.deepEqual(acceptedArtifactPopupState('REJECTED', [{ id: 'a', key: 'research_decision' }]), { refs: [], popupWorthy: false });
});

test('no artifacts is never popup-worthy', () => {
  assert.deepEqual(acceptedArtifactPopupState('ACCEPTED', []), { refs: [], popupWorthy: false });
  assert.deepEqual(acceptedArtifactPopupState('ACCEPTED', undefined), { refs: [], popupWorthy: false });
});
