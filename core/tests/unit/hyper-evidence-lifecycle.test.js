import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireEvidenceJob, createEvidenceJob, persistEvidenceJob, prepareEvidenceJob } from '../../src/artifacts/hyper-evidence-lifecycle.js';

function fixture() {
  const artifacts = []; const trials = [];
  const prisma = {
    hyperTurn: { findFirst: async () => ({ id: 'turn' }) },
    sourceArtifact: {
      findFirst: async ({ where }) => artifacts.find((row) => Object.entries(where).every(([key, value]) => row[key] === value || row.payload?.[key] === value)) || null,
      create: async ({ data }) => { const row = { id: '11111111-1111-4111-8111-111111111111', ...data }; artifacts.push(row); return row; },
      update: async ({ where, data }) => { const row = artifacts.find((item) => item.id === where.id); Object.assign(row, data); return row; },
    },
    hyperTrial: {
      findFirst: async ({ where }) => trials.find((row) => row.turnId === where.turnId && row.trialKind === where.trialKind && row.targetRef === where.targetRef) || null,
      create: async ({ data }) => { trials.push(data); return data; },
    },
  };
  const ids = { orgId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333', roomId: '44444444-4444-4444-8444-444444444444', turnId: '55555555-5555-4555-8555-555555555555' };
  return { prisma, ids, artifacts, trials };
}

test('retry resumes the same job and persists exactly one evidence receipt', async () => {
  const f = fixture();
  const job = await createEvidenceJob({ prisma: f.prisma, ...f.ids, request: { route: 'parallel_task', query: 'sovereign AI demand', claim_id: 'claim-1' } });
  const duplicate = await createEvidenceJob({ prisma: f.prisma, ...f.ids, request: { route: 'parallel_task', query: 'sovereign AI demand', claim_id: 'claim-1' } });
  assert.equal(duplicate.id, job.id);
  const scoped = { prisma: f.prisma, ...f.ids, evidenceJobId: job.id };
  await prepareEvidenceJob(scoped);
  let calls = 0;
  const executeResearch = async () => { calls += 1; if (calls === 1) throw new Error('provider_timeout'); return { sources: [{ title: 'EU source', url: 'https://europa.eu/source', snippet: 'Evidence' }] }; };
  await assert.rejects(acquireEvidenceJob({ ...scoped, executeResearch }), /provider_timeout/);
  const acquired = await acquireEvidenceJob({ ...scoped, executeResearch });
  assert.equal(acquired.receipt.sources.length, 1);
  await persistEvidenceJob(scoped);
  const again = await persistEvidenceJob(scoped);
  assert.equal(again.cached, true);
  assert.equal(f.trials.length, 1);
  assert.equal(f.artifacts[0].payload.attempts, 2);
});

test('receipt normalization rejects provider prose without URL evidence', async () => {
  const f = fixture();
  const job = await createEvidenceJob({ prisma: f.prisma, ...f.ids, request: { route: 'web_search', query: 'claim', claim_id: 'claim-2' } });
  const scoped = { prisma: f.prisma, ...f.ids, evidenceJobId: job.id };
  await prepareEvidenceJob(scoped);
  await assert.rejects(acquireEvidenceJob({ ...scoped, executeResearch: async () => ({ answer: 'trust me' }) }), /no_url_receipts/);
  assert.equal(f.trials.length, 0);
});
