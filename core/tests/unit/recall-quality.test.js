import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareRecallQualityClient } from '../../src/memory/cloudflare-recall-quality-client.js';
import { buildHybridSearchFilter } from '../../src/vector/qdrant-client.js';
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
