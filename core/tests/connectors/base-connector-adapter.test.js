import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BaseConnectorAdapter } from '../../src/connectors/framework/base-connector-adapter.js';

function makeAdapter(overrides = {}) {
  return new BaseConnectorAdapter({
    providerKey: 'test-provider',
    tokenResolver: async () => 'tok',
    prisma: {},
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
}

describe('BaseConnectorAdapter — constructor', () => {
  it('stores providerKey, prisma, logger, tokenResolver', () => {
    const prisma = {};
    const adapter = makeAdapter({ prisma });
    assert.equal(adapter.providerKey, 'test-provider');
    assert.equal(adapter.prisma, prisma);
  });

  it('defaults supportsWebhooks to false', () => {
    assert.equal(makeAdapter().supportsWebhooks, false);
  });
});

describe('BaseConnectorAdapter — abstract method contracts', () => {
  it('fetchBulk() throws "not implemented"', async () => {
    await assert.rejects(() => makeAdapter().fetchBulk({}), /fetchBulk\(\) not implemented/);
  });

  it('fetchResource() throws "not implemented"', async () => {
    await assert.rejects(() => makeAdapter().fetchResource({}), /fetchResource\(\) not implemented/);
  });

  it('verifyWebhookSignature() throws with code not_supported', () => {
    const err = assert.throws(() => makeAdapter().verifyWebhookSignature(), Error);
    // NOTE: assert.throws doesn't return value in node:test — use try/catch
    try {
      makeAdapter().verifyWebhookSignature();
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.code, 'not_supported');
      assert.match(e.message, /webhooks not supported/);
    }
  });

  it('parseEvent() throws with code not_supported', () => {
    try {
      makeAdapter().parseEvent();
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.code, 'not_supported');
    }
  });

  it('registerWebhook() throws with code not_supported', () => {
    try {
      makeAdapter().registerWebhook();
      assert.fail('should have thrown');
    } catch (e) {
      assert.equal(e.code, 'not_supported');
    }
  });
});

describe('BaseConnectorAdapter — getBearer', () => {
  it('delegates to tokenResolver and returns the token', async () => {
    const adapter = makeAdapter({ tokenResolver: async ({ providerKey }) => `token-for-${providerKey}` });
    const tok = await adapter.getBearer({ userId: 'u1', orgId: 'o1' });
    assert.equal(tok, 'token-for-test-provider');
  });

  it('throws when tokenResolver is not injected', async () => {
    const adapter = makeAdapter({ tokenResolver: undefined });
    await assert.rejects(() => adapter.getBearer({ userId: 'u1', orgId: 'o1' }), /tokenResolver not injected/);
  });
});

describe('BaseConnectorAdapter — normalize()', () => {
  it('returns NormalizedRecord shell with required keys', () => {
    const result = makeAdapter().normalize({ anything: true }, 'page');
    assert.ok('id' in result);
    assert.ok('title' in result);
    assert.ok('body' in result);
    assert.ok('ts' in result);
    assert.ok('refs' in result);
  });

  it('body is a string', () => {
    const { body } = makeAdapter().normalize({}, 'message');
    assert.equal(typeof body, 'string');
  });

  it('refs is an object', () => {
    const { refs } = makeAdapter().normalize({}, 'issue');
    assert.equal(typeof refs, 'object');
    assert.ok(!Array.isArray(refs));
  });
});
