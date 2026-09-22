import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProactiveSchedule,
  isAuthorizedProactiveCognitionRequest,
  normalizeProactiveSettings,
  proactiveCognitionEnabled,
} from '../../src/proactive-cognition/service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const SCHEDULE = '33333333-3333-4333-8333-333333333333';

test('proactive cognition is disabled unless the exact master gate is true', () => {
  assert.equal(proactiveCognitionEnabled({}), false);
  assert.equal(proactiveCognitionEnabled({ HIVEMIND_PROACTIVE_COGNITION_ENABLED: 'TRUE' }), true);
  assert.equal(proactiveCognitionEnabled({ HIVEMIND_PROACTIVE_COGNITION_ENABLED: 'yes' }), false);
});

test('settings normalize safe default quiet hours and explicit consent only', () => {
  assert.deepEqual(normalizeProactiveSettings({}), { enabled: false, timezone: null, quietStartHour: 21, quietEndHour: 8 });
  assert.deepEqual(normalizeProactiveSettings({ enabled: true, timezone: 'Europe/Berlin', quiet_start_hour: 22, quiet_end_hour: 7 }),
    { enabled: true, timezone: 'Europe/Berlin', quietStartHour: 22, quietEndHour: 7 });
});

test('worker authorization is constant-time and rejects absent or wrong tokens', () => {
  const env = { HIVEMIND_PROACTIVE_COGNITION_SECRET: 'same-length-secret' };
  assert.equal(isAuthorizedProactiveCognitionRequest({ headers: { authorization: 'Bearer same-length-secret' } }, env), true);
  assert.equal(isAuthorizedProactiveCognitionRequest({ headers: { authorization: 'Bearer same-length-secrex' } }, env), false);
  assert.equal(isAuthorizedProactiveCognitionRequest({ headers: {} }, env), false);
});

test('shadow evaluation makes one typed JEV decision and never sends email', async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql) {
      calls.push(sql);
      if (sql.includes('FROM "hivemind"."proactive_user_schedules" s')) return [{
        id: SCHEDULE, user_id: USER, org_id: ORG, trigger_key: 'decision_reflection.v1', enabled: true,
        timezone: 'UTC', quiet_start_hour: 21, quiet_end_hour: 8, next_evaluate_at: '2026-09-22T12:00:00.000Z',
        email: 'owner@example.test', display_name: 'Owner',
      }];
      if (sql.includes('FROM "hivemind"."memories"')) return [
        { id: '44444444-4444-4444-8444-444444444444', title: 'Decide enterprise launch sequence', tags: ['launch'], source_type: 'conversation', scope: 'personal', created_at: '2026-09-22T11:00:00.000Z' },
        { id: '55555555-5555-4555-8555-555555555555', title: 'Confirm investor outreach owner', tags: ['fundraising'], source_type: 'conversation', scope: 'personal', created_at: '2026-09-22T10:00:00.000Z' },
      ];
      if (sql.includes('FROM "hivemind"."audit_logs"')) return [];
      if (sql.includes('INSERT INTO "hivemind"."proactive_evaluations"')) return [{ id: '66666666-6666-4666-8666-666666666666' }];
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe() { return 1; },
  };
  const provider = {
    async decideQuestions(input) {
      assert.equal(input.questions.action.type, 'choice');
      assert.equal(input.state.activity.counts.memories, 2);
      return { answers: { action: { choice: 'send_reflection', probabilities: { send_reflection: 0.98 } } }, requestId: 'jev-test' };
    },
  };
  const result = await evaluateProactiveSchedule({
    prisma, scheduleId: SCHEDULE, mode: 'shadow', now: new Date('2026-09-22T12:01:00.000Z'), provider,
    env: {
      CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_AI_GATEWAY_ID: 'gateway',
      CLOUDFLARE_AI_GATEWAY_TOKEN: 'token', JEV_GATEWAY_BYOK_ALIAS: 'custom-openrouter',
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.decision, 'send_reflection');
  assert.equal(calls.some((sql) => sql.includes('proactive_delivery_ledger')), false);
});
