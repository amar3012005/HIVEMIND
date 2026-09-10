import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  consumeHarnessAdmissionTicket,
  HIVE_HARNESS_TICKET_NONCE_PREFIX,
  mintHarnessAdmissionTicket,
  registerHarnessTicketNonce,
  verifyHarnessAdmissionTicket,
} from '../../src/harness-chat/admission-ticket.js';

const secret = 'test-only-distinct-harness-ticket-secret-at-least-32-bytes';
const orgId = '67503d34-97e9-49a8-8c52-8ee30cc7603e';
const userId = '54f5568b-4d6a-4ae1-9a33-48cb2909d59b';
const otherOrgId = '77503d34-97e9-49a8-8c52-8ee30cc7603e';
const nowMs = Date.parse('2026-09-08T12:00:00.000Z');

function fakeRedis() {
  const values = new Map();
  return {
    values,
    async set(key, value, _ex, _ttl, _nx) {
      if (values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async getdel(key) {
      const value = values.get(key) || null;
      values.delete(key);
      return value;
    },
  };
}

function redisKeys(redis) {
  return redis.values.keys();
}

test('harness admission ticket rejects tampering, expiry, and tenant mismatch', () => {
  const minted = mintHarnessAdmissionTicket({ secret, orgId, userId, variation: 'harness', nowMs });
  assert.equal(verifyHarnessAdmissionTicket(minted.ticket, { secret, expectedOrgId: orgId, expectedUserId: userId, nowMs }).sub, userId);
  assert.throws(() => verifyHarnessAdmissionTicket(`${minted.ticket.slice(0, -1)}x`, { secret, nowMs }), /invalid_ticket_signature/);
  assert.throws(() => verifyHarnessAdmissionTicket(minted.ticket, { secret, nowMs: nowMs + 61_000 }), /expired_ticket/);
  assert.throws(() => verifyHarnessAdmissionTicket(minted.ticket, { secret, expectedOrgId: otherOrgId, nowMs }), /ticket_org_scope_mismatch/);
});

test('registered ticket nonce is consumed exactly once with GETDEL semantics', async () => {
  const redis = fakeRedis();
  const minted = mintHarnessAdmissionTicket({ secret, orgId, userId, variation: 'preview', nowMs });
  await registerHarnessTicketNonce(redis, minted.ticket, minted.claims, { nowMs });
  assert.equal([...redisKeys(redis)][0]?.startsWith(HIVE_HARNESS_TICKET_NONCE_PREFIX), true);
  const claims = await consumeHarnessAdmissionTicket(redis, minted.ticket, { secret, nowMs, expectedOrgId: orgId });
  assert.equal(claims.variation, 'preview');
  await assert.rejects(() => consumeHarnessAdmissionTicket(redis, minted.ticket, { secret, nowMs }), /ticket_already_consumed/);
});

test('ticket encoding matches the cross-repository v1 vector', async () => {
  const vector = JSON.parse(await readFile(new URL('../fixtures/harness-ticket-v1.json', import.meta.url), 'utf8'));
  const minted = mintHarnessAdmissionTicket({
    secret: vector.secret,
    nowMs: vector.now_ms,
    ...vector.input,
  });
  assert.equal(minted.ticket, vector.ticket);
  assert.deepEqual(minted.claims, vector.claims);
});
