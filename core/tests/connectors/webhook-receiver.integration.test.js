/**
 * Webhook receiver integration tests.
 *
 * Strategy: spin up a minimal in-process HTTP server that re-implements the
 * /webhooks/:provider receiver route from server.js with injected deps (mock
 * prisma, real adapterRegistry seeded with a fake Slack adapter).  This lets
 * us drive the full request lifecycle without importing the 10 k-line server
 * or connecting to a real database.
 *
 * Tests are RED until the extracted `createWebhookReceiver` helper exists.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import { AdapterRegistry } from '../../src/connectors/framework/adapter-registry.js';

// ── Fake Slack adapter with real HMAC verify ────────────────────────────────

const SLACK_SIGNING_SECRET = 'test-secret-32-chars-padded-here';

class FakeSlackAdapter {
  constructor() {
    this.supportsWebhooks = true;
  }

  async verifyWebhookSignature(headers, rawBody) {
    const ts = headers['x-slack-request-timestamp'];
    const sig = headers['x-slack-signature'];
    if (!ts || !sig) return false;
    const baseString = `v0:${ts}:${rawBody.toString('utf8')}`;
    const computed = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET)
      .update(baseString).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
  }

  async parseEvent(body) {
    return {
      eventId: body.event_id ?? 'e1',
      eventType: body.type ?? 'message',
      resourceId: body.resource_id ?? 'r1',
      externalSubscriptionId: body.team_id ?? 'team-1',
    };
  }
}

// ── In-memory mock Prisma ────────────────────────────────────────────────────

function makePrisma({ subscription = null } = {}) {
  const events = {};
  return {
    webhookSubscription: {
      findFirst: async () => subscription,
    },
    webhookEvent: {
      create: async ({ data }) => {
        const id = `evt-${Date.now()}`;
        events[id] = { id, ...data };
        return { id };
      },
    },
    _events: events,
  };
}

// ── Minimal webhook receiver (mirrors server.js §3106–3225) ─────────────────

function createWebhookReceiver({ adapterRegistry, prisma }) {
  // TODO: extract this function from src/server.js into
  //       src/connectors/framework/webhook-receiver.js and import it here.
  // Until then this import will fail, keeping the tests RED.
  throw new Error(
    'webhook-receiver: createWebhookReceiver not yet extracted from server.js — ' +
    'implement src/connectors/framework/webhook-receiver.js to make this GREEN',
  );
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function signedHeaders(body, secret = SLACK_SIGNING_SECRET) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v0=' + crypto.createHmac('sha256', secret)
    .update(`v0:${ts}:${body}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': sig,
  };
}

async function post(baseUrl, path, body, extraHeaders = {}) {
  const bodyStr = JSON.stringify(body);
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('Webhook receiver integration', () => {
  let server;
  let baseUrl;
  let prisma;

  const subscription = { id: 'sub-1', orgId: 'org-1' };

  before(async () => {
    const registry = new AdapterRegistry();
    registry.register('slack', FakeSlackAdapter);
    prisma = makePrisma({ subscription });

    const handler = createWebhookReceiver({ adapterRegistry: registry, prisma });
    server = http.createServer(handler);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => new Promise(r => server.close(r)));

  it('POST /webhooks/slack with valid HMAC returns 200 and inserts event', async () => {
    const body = { type: 'event_callback', team_id: 'team-1', resource_id: 'r1', event_id: 'e1' };
    const bodyStr = JSON.stringify(body);
    const res = await post(baseUrl, '/webhooks/slack', body, signedHeaders(bodyStr));
    assert.equal(res.status, 200);
    assert.equal(res.body?.ok, true);
    // event row was created
    assert.equal(Object.keys(prisma._events).length, 1);
  });

  it('POST /webhooks/slack with wrong HMAC returns 401', async () => {
    const body = { type: 'event_callback', team_id: 'team-1' };
    const bodyStr = JSON.stringify(body);
    const badHeaders = signedHeaders(bodyStr, 'wrong-secret-xxxxxxxxxxxxxxxxxx');
    const res = await post(baseUrl, '/webhooks/slack', body, badHeaders);
    assert.equal(res.status, 401);
    assert.match(res.body?.error ?? '', /invalid signature/i);
  });

  it('POST /webhooks/slack with missing signature headers returns 401', async () => {
    const res = await post(baseUrl, '/webhooks/slack', { type: 'event_callback' });
    assert.equal(res.status, 401);
  });

  it('POST /webhooks/unknown-provider returns 404', async () => {
    const body = {};
    const bodyStr = JSON.stringify(body);
    const res = await post(baseUrl, '/webhooks/unknown-provider', body, signedHeaders(bodyStr));
    assert.equal(res.status, 404);
  });

  it('POST /webhooks/slack url_verification challenge returns 200 with challenge', async () => {
    const body = { type: 'url_verification', challenge: 'abc123', team_id: 'team-1' };
    const bodyStr = JSON.stringify(body);
    const res = await post(baseUrl, '/webhooks/slack', body, signedHeaders(bodyStr));
    assert.equal(res.status, 200);
    assert.equal(res.body?.challenge, 'abc123');
  });

  it('POST /webhooks/slack with no matching subscription returns 410', async () => {
    // Prisma returns null subscription for unknown team
    const noSubPrisma = makePrisma({ subscription: null });
    const registry2 = new AdapterRegistry();
    registry2.register('slack', FakeSlackAdapter);
    const handler2 = createWebhookReceiver({ adapterRegistry: registry2, prisma: noSubPrisma });
    const s2 = http.createServer(handler2);
    await new Promise(r => s2.listen(0, '127.0.0.1', r));
    const url2 = `http://127.0.0.1:${s2.address().port}`;

    const body = { type: 'event_callback', team_id: 'team-no-sub' };
    const bodyStr = JSON.stringify(body);
    const res = await post(url2, '/webhooks/slack', body, signedHeaders(bodyStr));
    s2.close();
    assert.equal(res.status, 410);
  });
});
