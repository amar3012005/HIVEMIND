import assert from 'node:assert/strict';
import test from 'node:test';
import { startDayZeroLifecycle } from '../../src/lifecycle/day0-lifecycle.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function prismaFor(email = 'owner@example.com') {
  const writes = [];
  return {
    writes,
    user: { findUnique: async () => ({ email }) },
    $executeRawUnsafe: async (...args) => { writes.push(args); return 1; },
  };
}

test('Day 0 is gated by the tenant-scoped Cloudflare lifecycle flag', async () => {
  const result = await startDayZeroLifecycle({
    prisma: prismaFor(), orgId: ORG_ID, hqRoomId: ROOM_ID, userId: USER_ID,
    isEnabled: async () => false,
  });
  assert.deepEqual(result, { ok: true, accepted: false, skipped: true, reason: 'feature_disabled' });
});

test('a server-owned Day 0 completion advances activation and persists the admitted Day 1 schedule', async () => {
  const calls = [];
  const prisma = prismaFor();
  const started = await startDayZeroLifecycle({
      prisma, orgId: ORG_ID, hqRoomId: ROOM_ID, userId: USER_ID,
      startReport: async () => ({
        ok: true, accepted: true, reissue: false, ownerId: USER_ID, orgId: ORG_ID, hqRoomId: ROOM_ID,
        company: { onboarded_at: '2026-09-16T00:00:00.000Z' },
        completion: Promise.resolve({ ok: true, status: 'sent' }),
      }),
      advanceActivation: async (input) => { calls.push(['activation', input]); },
      scheduleDayOne: async (input) => { calls.push(['day1', input]); return {
        ok: true, admitted: true, target_at: '2026-09-17T00:00:00.000Z', instance_id: 'd1-room',
      }; },
      isEnabled: async () => true,
  });
  assert.equal((await started.completion).status, 'sent');
  assert.deepEqual(calls.map(([name]) => name), ['activation', 'day1']);
  assert.equal(calls[0][1].reason, 'day0_delivered');
  assert.equal(calls[1][1].hqRoomId, ROOM_ID);
  assert.equal(prisma.writes.length, 1);
  const persisted = JSON.parse(prisma.writes[0][1]);
  assert.equal(persisted.status, 'scheduled');
  assert.equal(persisted.workflow_instance_id, 'd1-room');
  assert.equal(persisted.target_at, '2026-09-17T00:00:00.000Z');
});

test('a failed Day 1 admission leaves no misleading scheduled receipt', async () => {
  const prisma = prismaFor();
  const started = await startDayZeroLifecycle({
    prisma, orgId: ORG_ID, hqRoomId: ROOM_ID, userId: USER_ID,
    startReport: async () => ({
      ok: true, accepted: true, reissue: false, ownerId: USER_ID, orgId: ORG_ID, hqRoomId: ROOM_ID,
      company: { onboarded_at: '2026-09-16T00:00:00.000Z' },
      completion: Promise.resolve({ ok: true, status: 'sent' }),
    }),
    advanceActivation: async () => {},
    scheduleDayOne: async () => ({ ok: false, reason: 'workflow_unavailable' }),
    isEnabled: async () => true,
  });
  await started.completion;
  assert.equal(prisma.writes.length, 0);
});

test('an existing Day 0 claim is not re-scheduled by dashboard or onboarding retries', async () => {
  const result = await startDayZeroLifecycle({
      prisma: prismaFor(), orgId: ORG_ID, hqRoomId: ROOM_ID, userId: USER_ID,
      startReport: async () => ({ ok: true, accepted: false, status: 'sending' }),
      advanceActivation: async () => assert.fail('must not advance'),
      scheduleDayOne: async () => assert.fail('must not schedule'),
      isEnabled: async () => true,
  });
  assert.equal(result.status, 'sending');
});
