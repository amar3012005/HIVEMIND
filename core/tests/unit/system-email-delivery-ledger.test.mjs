import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemEmailDeliveryReceiptSink, recordCloudflareEmailDeliveryEvent } from '../../src/workspace/system-email-delivery-ledger.js';

test('receipt sink stores a hashed recipient and provider message ID', async () => {
  let call;
  const sink = createSystemEmailDeliveryReceiptSink({
    $queryRawUnsafe: async (sql, ...values) => { call = { sql, values }; return [{ id: 'delivery-1' }]; },
  });
  const result = await sink({
    to: 'person@example.test', templateId: 'activation_lifecycle_reminder',
    rendered: { subject: 'Your team is ready' },
    result: { ok: true, provider: 'cloudflare', deliveryStatus: 'queued', messageId: 'cf-message-1' },
    notification: { orgId: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222' },
  });
  assert.deepEqual(result, { recorded: true, id: 'delivery-1' });
  assert.match(call.sql, /system_email_deliveries/);
  assert.doesNotMatch(call.sql, /person@example\.test/);
  assert.equal(call.values[1], 'pe***@example.test');
  assert.equal(call.values[8], 'cf-message-1');
});

test('Cloudflare event updates only a recognized provider message', async () => {
  let call;
  const result = await recordCloudflareEmailDeliveryEvent({
    $queryRawUnsafe: async (sql, ...values) => { call = { sql, values }; return [{ id: 'delivery-1' }]; },
  }, {
    type: 'cf.email.sending.message.delivered',
    payload: { eventId: 'event-1', messageId: 'cf-message-1', delivery: { status: 'delivered' } },
    metadata: { eventTimestamp: '2026-09-22T21:00:00.000Z' },
  });
  assert.deepEqual(result, { applied: true, id: 'delivery-1', status: 'delivered' });
  assert.match(call.sql, /provider_message_id/);
  assert.equal(call.values[0], 'cf-message-1');
  assert.equal(call.values[1], 'delivered');
});

test('unrecognized queue payload is ignored', async () => {
  const result = await recordCloudflareEmailDeliveryEvent({}, { type: 'other', payload: {} });
  assert.deepEqual(result, { applied: false, reason: 'invalid_event' });
});
