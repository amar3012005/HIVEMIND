import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProgressiveApproval } from '../../src/agent/progressive-approval-events.js';

function fixture() {
  const run = { id: 'run', orgId: 'org', userId: 'user', status: 'waiting_approval', updatedAt: new Date(), steps: [],
    scratch: { harness_version: 'progressive-v1', preserved: { detail: 42 }, draft_ids: ['d1', 'd2'],
      intent: { outcomes: [{ id: 'o1', kind: 'draft' }, { id: 'o2', kind: 'draft' }] },
      draft_receipts: [{ draft_id: 'd1', successful: true, outcome_ids: ['o1'] }, { draft_id: 'd2', successful: true, outcome_ids: ['o2'] }] } };
  let writes = 0;
  const prisma = { agentRun: {
    findFirst: async () => structuredClone(run),
    updateMany: async ({ where, data }) => {
      assert.equal(where.id, 'run');
      assert.equal(where.orgId, 'org');
      assert.equal(where.userId, 'user');
      if (+where.updatedAt !== +run.updatedAt) return { count: 0 };
      writes++;
      Object.assign(run, structuredClone(data), { updatedAt: new Date(+run.updatedAt + 1) });
      return { count: 1 };
    },
  } };
  const draft = (id = 'd1', status = 'sent') => ({ id, status, traceId: 'run', orgId: 'org', userId: 'user', toolArgs: { _harness_version: 'progressive-v1' } });
  return { prisma, run, draft, writes: () => writes };
}

test('all canonical sent receipts complete covered outcomes once', async () => {
  const f = fixture();
  assert.equal((await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft() })).status, 'waiting_approval');
  const last = await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2') });
  assert.equal(last.status, 'done');
  assert.equal(f.run.steps.length, 2);
  assert.deepEqual(f.run.scratch.preserved, { detail: 42 });
  const duplicate = await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2') });
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.writes(), 2);
});

test('failed, expired and cancelled approvals never become done', async () => {
  for (const terminal of ['failed', 'expired', 'cancelled']) {
    const f = fixture();
    await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d1', terminal) });
    await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2', 'sent') });
    assert.equal(f.run.status, terminal === 'cancelled' ? 'cancelled' : 'failed');
  }
});

test('uncovered requested outcome prevents completion despite sent drafts', async () => {
  const f = fixture();
  f.run.scratch.intent.outcomes.push({ id: 'missing-read', kind: 'read' });
  await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d1') });
  await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2') });
  assert.equal(f.run.status, 'waiting_approval');
});

test('scope mismatch, unknown draft and legacy approval cannot project receipts', async () => {
  for (const alter of [d => ({ ...d, orgId: 'foreign' }), d => ({ ...d, userId: 'foreign' }),
    d => ({ ...d, id: 'unknown' }), d => ({ ...d, toolArgs: {} })]) {
    const f = fixture();
    const result = await reconcileProgressiveApproval({ prisma: f.prisma, draft: alter(f.draft()) });
    assert.equal(result.reconciled, false);
    assert.equal(f.writes(), 0);
  }
});

test('active lease preserved and duplicate receipt can reconcile after execution releases it', async () => {
  const f = fixture();
  f.run.status = 'running';
  const lease = { owner: 'worker', until: Date.now() + 30000 };
  f.run.scratch.lease = lease;
  await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d1') });
  await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2') });
  assert.equal(f.run.status, 'running');
  assert.deepEqual(f.run.scratch.lease, lease);
  f.run.scratch.lease = null;
  assert.equal((await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft('d2') })).status, 'done');
  assert.equal(f.run.steps.length, 2);
});

test('CAS conflict retries using fresh scratch and preserves competing updates', async () => {
  const f = fixture();
  const save = f.prisma.agentRun.updateMany;
  let conflict = true;
  f.prisma.agentRun.updateMany = async args => {
    if (conflict) {
      conflict = false;
      f.run.scratch.competitor = 'preserved';
      f.run.updatedAt = new Date(+f.run.updatedAt + 1);
      return { count: 0 };
    }
    return save(args);
  };
  const result = await reconcileProgressiveApproval({ prisma: f.prisma, draft: f.draft() });
  assert.equal(result.reconciled, true);
  assert.equal(f.run.scratch.competitor, 'preserved');
  assert.equal(f.run.steps.length, 1);
});
