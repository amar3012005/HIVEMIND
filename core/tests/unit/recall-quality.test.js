import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareRecallQualityClient } from '../../src/memory/cloudflare-recall-quality-client.js';
import {
  buildHybridSearchFilter,
  fuseRecallRanks,
  recallSparseCollectionName,
} from '../../src/vector/qdrant-client.js';
import { recallSparseVector } from '../../src/vector/recall-sparse.js';

test('Flagship failure and invalid mode preserve legacy recall', async () => {
  const previous = [process.env.CANONICAL_PROJECTION_WORKFLOW_URL, process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET];
  process.env.CANONICAL_PROJECTION_WORKFLOW_URL = 'https://flags.example.test';
  process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = 'test-secret';
  try {
    const client = new CloudflareRecallQualityClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ mode: 'on' }) }) });
    assert.equal(await client.modeFor({ orgId: 'org', userId: 'user' }), 'on');
    const unavailable = new CloudflareRecallQualityClient({ fetchImpl: async () => { throw new Error('down'); }, logger: { warn() {} } });
    assert.equal(await unavailable.modeFor({ orgId: 'org', userId: 'user' }), 'off');
    const invalid = new CloudflareRecallQualityClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ mode: 'bad' }) }) });
    assert.equal(await invalid.modeFor({ orgId: 'org', userId: 'user' }), 'off');
  } finally {
    if (previous[0] === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_URL;
    else process.env.CANONICAL_PROJECTION_WORKFLOW_URL = previous[0];
    if (previous[1] === undefined) delete process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET;
    else process.env.CANONICAL_PROJECTION_WORKFLOW_SECRET = previous[1];
  }
});

test('quality filter widens only to authorized organization, project and team scopes', () => {
  const org = 'org-1';
  const old = buildHybridSearchFilter({ user_id: 'user-1', org_id: org });
  assert.deepEqual(old.must.slice(0, 2), [
    { key: 'user_id', match: { value: 'user-1' } },
    { key: 'org_id', match: { value: org } },
  ]);
  const selected = buildHybridSearchFilter({ quality_v1: true, user_id: 'user-1', org_id: org,
    authorized_project_ids: ['project-1'], authorized_team_ids: ['team-1'], project_ids: ['project-1'] });
  assert.ok(selected.must.some((clause) => clause.key === 'org_id' && clause.match.value === org));
  const branches = selected.must.find((clause) => clause.should)?.should || [];
  assert.equal(branches.length, 4);
  assert.ok(branches.some((clause) => clause.key === 'user_id'));
  assert.ok(branches.some((clause) => clause.key === 'scope' && clause.match.value === 'organization'));
  assert.ok(branches.some((clause) => clause.must?.some((part) => part.key === 'project_ids')));
  assert.ok(branches.some((clause) => clause.must?.some((part) => part.key === 'team_id')));
});

test('sparse lexical projection is deterministic and unicode aware', () => {
  const first = recallSparseVector('Rama leads SINGULANCE Singapore incorporation');
  const second = recallSparseVector('rama leads singulance singapore incorporation');
  assert.deepEqual(first, second);
  assert.equal(first.indices.length, 5);
  assert.deepEqual([...first.indices].sort((a, b) => a - b), first.indices);
  assert.ok(recallSparseVector('München München').values.some((value) => value > 1));
});

test('recall sparse sidecar naming is deterministic and leaves the dense collection untouched', () => {
  assert.equal(
    recallSparseCollectionName('org_00000000-0000-4000-8000-000000000123'),
    'org_00000000-0000-4000-8000-000000000123__recall_sparse_v1',
  );
});

test('cross-collection RRF rewards agreement and preserves payloads', () => {
  const dense = [
    { id: 'semantic-only', score: 0.98, payload: { memory_id: 'semantic-only' } },
    { id: 'shared', score: 0.70, payload: { memory_id: 'shared', content: 'grounded' } },
  ];
  const sparse = [
    { id: 'shared', score: 22, payload: { memory_id: 'shared', content: 'grounded' } },
    { id: 'lexical-only', score: 18, payload: { memory_id: 'lexical-only' } },
  ];
  const fused = fuseRecallRanks([dense, sparse], 3);
  assert.deepEqual(fused.map((point) => point.id), ['shared', 'semantic-only', 'lexical-only']);
  assert.equal(fused[0].score, 1);
  assert.equal(fused[0].payload.content, 'grounded');
  assert.ok(fused.every((point) => point.score > 0 && point.score <= 1));
});
