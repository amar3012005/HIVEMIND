import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_ZERO_REPORT_VERSION } from '../../src/email/templates/day0-company-onboarding.js';
import { startDayZeroOnboardingReport } from '../../src/lifecycle/day0-onboarding-report.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function fakePrisma(company) {
  const writes = [];
  return {
    writes,
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.includes('SELECT id, user_id')) return [{ id: ROOM_ID, user_id: USER_ID, company }];
      if (sql.includes('UPDATE')) {
        writes.push(JSON.parse(args[0]));
        return [{ id: ROOM_ID }];
      }
      throw new Error('unexpected query');
    },
    $executeRawUnsafe: async (sql, ...args) => {
      assert.match(sql, /UPDATE/);
      writes.push(JSON.parse(args[0]));
      return 1;
    },
    digitalEmployee: { findMany: async () => [{ id: 'builder-1', slug: 'mina', name: 'Mina', avatarUrl: null, roleArchetype: 'Builder', persona: 'Builds useful work.' }] },
    user: { findUnique: async () => ({ email: 'owner@example.test' }) },
  };
}

test('Day 0 reissues an older renderer once, retains its receipt, and sends the current artifact', async () => {
  const prisma = fakePrisma({
    company: 'Canary Co',
    website: 'https://canary.example',
    day0_report_email: { version: 'day-0-v2', status: 'sent', sent_at: '2026-09-01T10:00:00.000Z', message_id: 'old-message' },
  });
  let email;
  const started = await startDayZeroOnboardingReport({
    prisma,
    orgId: ORG_ID,
    hqRoomId: ROOM_ID,
    allowVersionedReissue: true,
    renderPdf: async () => Buffer.from('pdf'),
    sendEmail: async (input) => { email = input; return { ok: true, provider: 'cloudflare', deliveryStatus: 'accepted', messageId: 'new-message' }; },
  });

  assert.equal(started.accepted, true);
  assert.equal(started.reissue, true);
  assert.equal((await started.completion).version, DAY_ZERO_REPORT_VERSION);
  assert.equal(email.rendered.report.version, DAY_ZERO_REPORT_VERSION);
  assert.equal(email.notification.data.reissue, true);
  assert.deepEqual(prisma.writes[0].reissued_from, { version: 'day-0-v2', sent_at: '2026-09-01T10:00:00.000Z', message_id: 'old-message', provider: null });
  assert.equal(prisma.writes.at(-1).status, 'sent');
  assert.equal(prisma.writes.at(-1).message_id, 'new-message');
});

test('Day 0 does not resend the current renderer version', async () => {
  const prisma = fakePrisma({ company: 'Canary Co', day0_report_email: { version: DAY_ZERO_REPORT_VERSION, status: 'sent' } });
  const result = await startDayZeroOnboardingReport({ prisma, orgId: ORG_ID, hqRoomId: ROOM_ID, allowVersionedReissue: true });
  assert.deepEqual(result, { ok: true, accepted: false, status: 'sent', version: DAY_ZERO_REPORT_VERSION });
  assert.equal(prisma.writes.length, 0);
});
