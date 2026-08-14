import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMeetingSessionIntegrity } from '../../src/knowledge/meeting-session-contract.js';

test('meeting session completeness requires ready status and every persisted segment index', () => {
  const result = deriveMeetingSessionIntegrity({
    status: 'ready', expectedSegments: 3, segmentCount: 3, maxSegmentIndex: 2, segmentIndexes: [0, 1, 2],
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.missingIndexes, []);
});

test('meeting session reports a gap instead of accepting an empty transcript segment as complete', () => {
  const result = deriveMeetingSessionIntegrity({
    status: 'ready', expectedSegments: 3, segmentCount: 2, maxSegmentIndex: 2, segmentIndexes: [0, 2],
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missingIndexes, [1]);
});

test('meeting session never treats a merely recording session as final', () => {
  const result = deriveMeetingSessionIntegrity({
    status: 'recording', expectedSegments: 1, segmentCount: 1, maxSegmentIndex: 0, segmentIndexes: [0],
  });
  assert.equal(result.complete, false);
});
