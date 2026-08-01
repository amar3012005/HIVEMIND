import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __test, acceptZernioWebhook, verifyZernioWebhook } from '../../src/campaigns/zernio-webhook.js';

function signature(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('Zernio webhook verifies the exact raw request body', () => {
  const body = Buffer.from('{"id":"event-a","event":"webhook.test"}');
  assert.doesNotThrow(() => verifyZernioWebhook(body, signature(body, 'secret-a'), 'secret-a'));
  assert.throws(() => verifyZernioWebhook(Buffer.from(`${body} `), signature(body, 'secret-a'), 'secret-a'), {
    code: 'campaign_webhook_signature_invalid',
  });
});

test('Zernio webhook persists once and acknowledges duplicates', async () => {
  const previous = process.env.ZERNIO_WEBHOOK_SECRET;
  process.env.ZERNIO_WEBHOOK_SECRET = 'secret-a';
  const body = Buffer.from(JSON.stringify({ id: 'event-a', event: 'webhook.test', account: { profileId: { _id: 'profile-a' } } }));
  let created = false;
  const updates = [];
  const prisma = { zernioWebhookEvent: {
    async create({ data }) {
      if (created) throw Object.assign(new Error('unique'), { code: 'P2002' });
      created = true;
      assert.equal(data.providerProfileId, 'profile-a');
      return { id: 'local-event-a', ...data };
    },
    async update(value) { updates.push(value); return value; },
  } };
  try {
    const first = await acceptZernioWebhook({ prisma, rawBody: body, signature: signature(body, 'secret-a') });
    const duplicate = await acceptZernioWebhook({ prisma, rawBody: body, signature: signature(body, 'secret-a') });
    assert.deepEqual(first, { accepted: true, duplicate: false, event_id: 'event-a' });
    assert.deepEqual(duplicate, { accepted: true, duplicate: true, event_id: 'event-a' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates[0].data.status, 'IGNORED');
  } finally {
    if (previous === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET; else process.env.ZERNIO_WEBHOOK_SECRET = previous;
  }
});

test('Zernio webhook rejects invalid signatures before persistence', async () => {
  const previous = process.env.ZERNIO_WEBHOOK_SECRET;
  process.env.ZERNIO_WEBHOOK_SECRET = 'secret-a';
  let writes = 0;
  try {
    await assert.rejects(() => acceptZernioWebhook({
      prisma: { zernioWebhookEvent: { async create() { writes += 1; } } },
      rawBody: Buffer.from('{}'), signature: 'bad',
    }), { code: 'campaign_webhook_signature_invalid' });
    assert.equal(writes, 0);
  } finally {
    if (previous === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET; else process.env.ZERNIO_WEBHOOK_SECRET = previous;
  }
});

test('published and comment events join back to the tenant campaign action', async () => {
  const updates = []; const campaignEvents = [];
  const prisma = {
    zernioOrgProfile: { async findUnique() { return { orgId: 'org-a' }; } },
    zernioWebhookEvent: { async update(value) { updates.push(value); return value; } },
    campaignAction: {
      async findFirst({ where }) {
        assert.equal(where.campaign.orgId, 'org-a');
        assert.deepEqual(where.externalId.in, ['post-a']);
        return { id: 'action-a', campaignId: 'campaign-a', executedAt: null, campaign: { orgId: 'org-a' } };
      },
      async update(value) { updates.push(value); return value; },
    },
    campaignEvent: { async create({ data }) { campaignEvents.push(data); return data; } },
  };
  await __test.processAcceptedEvent({
    prisma, eventId: 'event-local', providerProfileId: 'profile-a', eventType: 'comment.received',
    payload: { account: { profileId: 'profile-a', platform: 'twitter' }, comment: { id: 'comment-a', postId: 'post-a', text: 'Interested', authorName: 'Buyer' } },
  });
  assert.equal(campaignEvents[0].eventType, 'campaign_provider_comment_received');
  assert.equal(campaignEvents[0].data.comment.text, 'Interested');
  assert.equal(updates.at(-1).data.status, 'PROCESSED');
});
