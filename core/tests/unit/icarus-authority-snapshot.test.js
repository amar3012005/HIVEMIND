import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authoritySnapshotDigest,
  buildAuthoritySnapshot,
  isIcarusRepoId,
  stableJson,
} from '../../src/icarus/authority-snapshot.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const DECISION = '44444444-4444-4444-8444-444444444444';

test('authority snapshot is canonical, scoped, and digest-bound', () => {
  const snapshot = buildAuthoritySnapshot({
    userId: USER, orgId: ORG, projectId: PROJECT, repoId: 'repo-0123456789abcdef',
    now: new Date('2026-08-21T00:00:00Z'),
    decisions: [{ id: DECISION, version: 7, content: 'Use a redacted receipt only.', tags: ['decision', 'icarus:approved'] }],
  });
  assert.equal(snapshot.scope.org_id, ORG);
  assert.equal(snapshot.decisions[0].status, 'approved');
  assert.equal(snapshot.decisions[0].revision, '7');
  assert.equal(snapshot.digest, authoritySnapshotDigest(snapshot));
  assert.equal(snapshot.expires_at, '2026-08-21T00:05:00.000Z');
});

test('canonical JSON is insertion-order independent and invalid scope is rejected', () => {
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }));
  assert.ok(isIcarusRepoId('repo-0123456789abcdef'));
  assert.ok(!isIcarusRepoId('repo-not-a-fingerprint'));
  assert.throws(() => buildAuthoritySnapshot({
    userId: USER, orgId: ORG, projectId: PROJECT, repoId: 'bad', decisions: [],
  }), /repo_id/);
});
