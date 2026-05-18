/**
 * T12 — SlackAdapter tests (RED state)
 * Framework: node:test (native runner)
 * Run: node --test tests/connectors/slack-adapter.test.js
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SlackAdapter } from '../../src/connectors/adapters/slack/slack-adapter.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const SIGNING_SECRET = 'test-slack-signing-secret-32bytes!';

function makeAdapter(tokenValue = 'xoxb-test-token') {
  return new SlackAdapter({
    providerKey: 'slack',
    tokenResolver: async () => tokenValue,
    prisma: {},
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
  });
}

function signRequest(body, timestampS, secret = SIGNING_SECRET) {
  const sigBase = `v0:${timestampS}:${body}`;
  const hex = crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
  return `v0=${hex}`;
}

function mockSlackOk(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, ...body }),
    text: async () => JSON.stringify(body),
  };
}

function mockSlackError(slackError, httpStatus = 200) {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: slackError }),
    text: async () => JSON.stringify({ ok: false, error: slackError }),
  };
}

let originalFetch;
let originalEnv;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.SLACK_SIGNING_SECRET = originalEnv;
});

// ── verifyWebhookSignature ─────────────────────────────────────────────────

test('verifyWebhookSignature: valid HMAC passes and returns true', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const body = 'token=abc&team_id=T123&event={}';
  const sig = signRequest(body, nowS);

  const adapter = makeAdapter();
  const result = adapter.verifyWebhookSignature(
    { 'x-slack-request-timestamp': String(nowS), 'x-slack-signature': sig },
    body,
  );
  assert.equal(result, true);
});

test('verifyWebhookSignature: invalid HMAC throws with code invalid_signature', () => {
  const nowS = Math.floor(Date.now() / 1000);
  const body = 'token=abc';
  const badSig = 'v0=deadbeef1234567890deadbeef1234567890deadbeef1234567890deadbeef12';

  const adapter = makeAdapter();
  assert.throws(
    () =>
      adapter.verifyWebhookSignature(
        { 'x-slack-request-timestamp': String(nowS), 'x-slack-signature': badSig },
        body,
      ),
    (err) => {
      assert.equal(err.code, 'invalid_signature');
      return true;
    },
  );
});

test('verifyWebhookSignature: stale timestamp (>5min) rejected with code replay', () => {
  const staleS = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
  const body = 'stale=1';
  const sig = signRequest(body, staleS);

  const adapter = makeAdapter();
  assert.throws(
    () =>
      adapter.verifyWebhookSignature(
        { 'x-slack-request-timestamp': String(staleS), 'x-slack-signature': sig },
        body,
      ),
    (err) => {
      assert.equal(err.code, 'replay');
      return true;
    },
  );
});

test('verifyWebhookSignature: missing headers throw with code missing_headers', () => {
  const adapter = makeAdapter();
  assert.throws(
    () => adapter.verifyWebhookSignature({}, 'body'),
    (err) => {
      assert.equal(err.code, 'missing_headers');
      return true;
    },
  );
});

// ── parseEvent ─────────────────────────────────────────────────────────────

test('parseEvent: url_verification returns challenge', () => {
  const adapter = makeAdapter();
  const result = adapter.parseEvent({ type: 'url_verification', challenge: 'abc123' });
  assert.deepEqual(result, { urlVerification: true, challenge: 'abc123' });
});

test('parseEvent: event_callback returns expected shape with resourceId = channel-ts', () => {
  const adapter = makeAdapter();
  const payload = {
    type: 'event_callback',
    event_id: 'Ev123',
    team_id: 'T456',
    event: { type: 'message', channel: 'C789', ts: '1700000000.000001', user: 'U111', text: 'hi' },
  };
  const result = adapter.parseEvent(payload);

  assert.equal(result.eventId, 'Ev123');
  assert.equal(result.eventType, 'message');
  assert.equal(result.resourceId, 'C789-1700000000.000001');
  assert.equal(result.type, 'message');
  assert.equal(result.externalId, 'T456');
  assert.equal(result.urlVerification, undefined);
});

// ── fetchBulk ──────────────────────────────────────────────────────────────

test('fetchBulk: with channelId calls conversations.history with correct params', async () => {
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(url.toString());
    return mockSlackOk({ messages: [{ ts: '1.0', text: 'hello', user: 'U1' }], response_metadata: {} });
  };

  const adapter = makeAdapter();
  const { records } = await adapter.fetchBulk({
    userId: 'u1', orgId: 'o1', cursor: null, scope: { channelId: 'C-GENERAL' }, limit: 50,
  });

  assert.ok(fetchedUrls.some(u => u.includes('conversations.history')), 'should call conversations.history');
  assert.ok(fetchedUrls.some(u => u.includes('C-GENERAL')), 'should include channel param');
  assert.equal(records.length, 1);
  assert.equal(records[0].resource_id, 'C-GENERAL-1.0');
});

test('fetchBulk: without channelId lists channels then fetches per-channel (cap 5)', async () => {
  const channels = Array.from({ length: 7 }, (_, i) => ({ id: `C${i}`, name: `ch${i}` }));
  let historyCallCount = 0;

  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr.includes('conversations.list')) {
      return mockSlackOk({ channels, response_metadata: { next_cursor: '' } });
    }
    if (urlStr.includes('conversations.history')) {
      historyCallCount++;
      const ch = urlStr.match(/channel=([^&]+)/)?.[1] ?? 'C?';
      return mockSlackOk({ messages: [{ ts: '1.0', text: 'msg', user: 'U1' }], response_metadata: {} });
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  };

  const adapter = makeAdapter();
  await adapter.fetchBulk({ userId: 'u1', orgId: 'o1', cursor: null, scope: {} });

  assert.ok(historyCallCount <= 5, `should cap at 5 channels, got ${historyCallCount}`);
});

test('fetchBulk: normalizes messages to NormalizedRecord with resource_id = channel-ts', async () => {
  globalThis.fetch = async () =>
    mockSlackOk({ messages: [{ ts: '1700000001.111111', text: 'test msg', user: 'U99' }], response_metadata: {} });

  const adapter = makeAdapter();
  const { records } = await adapter.fetchBulk({
    userId: 'u1', orgId: 'o1', scope: { channelId: 'CTEST' },
  });

  const r = records[0];
  assert.equal(r.resource_id, 'CTEST-1700000001.111111');
  assert.equal(r.resource_type, 'message');
  assert.equal(r.body, 'test msg');
  assert.ok(r.ts);
  assert.equal(r.refs.channel, 'CTEST');
  assert.equal(r.refs.slack_ts, '1700000001.111111');
});

// ── fetchResource ──────────────────────────────────────────────────────────

test('fetchResource: parses channel-ts split correctly on first dash', async () => {
  globalThis.fetch = async (url) => {
    const urlStr = url.toString();
    assert.ok(urlStr.includes('conversations.replies'), 'should call conversations.replies');
    assert.ok(urlStr.includes('channel=C-WITH-DASHES'), 'channel extraction should stop at first dash');
    assert.ok(urlStr.includes('ts=1700000002.000000'), 'ts should be everything after first dash');
    return mockSlackOk({ messages: [{ ts: '1700000002.000000', text: 'reply', user: 'U1' }] });
  };

  const adapter = makeAdapter();
  const record = await adapter.fetchResource({
    userId: 'u1', orgId: 'o1', resourceId: 'C-WITH-DASHES-1700000002.000000',
  });

  assert.equal(record.resource_id, 'C-WITH-DASHES-1700000002.000000');
});

test('fetchResource: throws on invalid resourceId (no dash)', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.fetchResource({ userId: 'u1', orgId: 'o1', resourceId: 'NODASH' }),
    /invalid resourceId/,
  );
});

// ── ok:false error handling ────────────────────────────────────────────────

test('Slack ok:false response is thrown as an error with slackError field', async () => {
  globalThis.fetch = async () => mockSlackError('not_in_channel');

  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.fetchBulk({ userId: 'u1', orgId: 'o1', scope: { channelId: 'C1' } }),
    (err) => {
      assert.equal(err.slackError, 'not_in_channel');
      return true;
    },
  );
});

test('Slack HTTP 5xx response is thrown as an error with status', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => 'Service Unavailable',
  });

  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.fetchBulk({ userId: 'u1', orgId: 'o1', scope: { channelId: 'C1' } }),
    (err) => {
      assert.equal(err.status, 503);
      return true;
    },
  );
});
