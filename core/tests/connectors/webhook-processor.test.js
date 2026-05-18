import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebhookProcessor } from '../../src/connectors/framework/webhook-processor.js';
import { AdapterRegistry } from '../../src/connectors/framework/adapter-registry.js';

// ── In-memory Prisma mock ───────────────────────────────────────────────────

function makeRow(overrides = {}) {
  return {
    id: 'evt-1',
    subscriptionId: 'sub-1',
    payload: { event: 'test' },
    attempts: 1,
    ...overrides,
  };
}

function makePrisma({ rows = [], sub = null } = {}) {
  const store = { events: {}, subs: {} };
  if (sub) store.subs[sub.id] = { ...sub };
  return {
    $queryRaw: async () => rows,
    webhookSubscription: {
      findUnique: async ({ where }) => store.subs[where.id] ?? null,
      update: async ({ where, data }) => {
        store.subs[where.id] = { ...store.subs[where.id], ...data };
        return store.subs[where.id];
      },
    },
    webhookEvent: {
      update: async ({ where, data }) => {
        store.events[where.id] = { ...store.events[where.id], ...data };
        return store.events[where.id];
      },
    },
    _store: store,
  };
}

// ── Fake adapter ────────────────────────────────────────────────────────────

class FakeSlackAdapter {
  constructor(ctx) { this.ctx = ctx; }
  async parseEvent(payload) { return { resourceId: 'res-1', type: 'message' }; } // eslint-disable-line no-unused-vars
  async fetchResource() { return { id: 'res-1', title: 'Hi', body: 'body', ts: null, refs: {} }; }
}

function makeProcessor({ rows, sub, adapterClass = FakeSlackAdapter, smartIngestRouter } = {}) {
  const registry = new AdapterRegistry();
  registry.register('slack', adapterClass);

  const defaultSub = sub ?? { id: 'sub-1', provider: 'slack', userId: 'u1', orgId: 'o1', consecutiveFailures: 0 };
  const prisma = makePrisma({ rows: rows ?? [makeRow()], sub: defaultSub });

  const router = smartIngestRouter ?? { route: async () => {} };
  const logger = { info() {}, warn() {}, error() {} };

  const processor = new WebhookProcessor({
    prisma,
    adapterRegistry: registry,
    tokenResolver: async () => 'tok',
    smartIngestRouter: router,
    logger,
    intervalMs: 5000,
  });

  return { processor, prisma };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('WebhookProcessor.tickOnce — empty batch', () => {
  it('returns 0 when no rows claimed', async () => {
    const { processor } = makeProcessor({ rows: [] });
    const count = await processor.tickOnce();
    assert.equal(count, 0);
  });
});

describe('WebhookProcessor.tickOnce — success path', () => {
  it('returns count equal to number of rows processed', async () => {
    const { processor } = makeProcessor({ rows: [makeRow(), makeRow({ id: 'evt-2' })] });
    const count = await processor.tickOnce();
    assert.equal(count, 2);
  });

  it('marks event as processed with processedAt set', async () => {
    const { processor, prisma } = makeProcessor();
    await processor.tickOnce();
    const updated = prisma._store.events['evt-1'];
    assert.equal(updated.status, 'processed');
    assert.ok(updated.processedAt instanceof Date);
  });

  it('resets consecutiveFailures on subscription to 0', async () => {
    const { processor, prisma } = makeProcessor();
    await processor.tickOnce();
    assert.equal(prisma._store.subs['sub-1'].consecutiveFailures, 0);
  });

  it('calls smartIngestRouter.route with userId, orgId, resource, type', async () => {
    const calls = [];
    const router = { route: async (args) => { calls.push(args); } };
    const { processor } = makeProcessor({ smartIngestRouter: router });
    await processor.tickOnce();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 'u1');
    assert.equal(calls[0].orgId, 'o1');
  });
});

describe('WebhookProcessor.tickOnce — dead-letter at MAX_ATTEMPTS', () => {
  class FailingAdapter {
    constructor() {}
    async parseEvent() { throw new Error('parse exploded'); }
  }

  it('sets status dead_lettered when attempts >= MAX_ATTEMPTS (5)', async () => {
    const { processor, prisma } = makeProcessor({
      rows: [makeRow({ attempts: 5 })],
      adapterClass: FailingAdapter,
    });
    await processor.tickOnce();
    assert.equal(prisma._store.events['evt-1'].status, 'dead_lettered');
  });

  it('sets status failed (not dead_lettered) when attempts < MAX_ATTEMPTS', async () => {
    const { processor, prisma } = makeProcessor({
      rows: [makeRow({ attempts: 3 })],
      adapterClass: FailingAdapter,
    });
    await processor.tickOnce();
    assert.equal(prisma._store.events['evt-1'].status, 'failed');
  });

  it('records error message on failed event', async () => {
    const { processor, prisma } = makeProcessor({
      rows: [makeRow({ attempts: 3 })],
      adapterClass: FailingAdapter,
    });
    await processor.tickOnce();
    assert.match(prisma._store.events['evt-1'].error, /parse exploded/);
  });
});

describe('WebhookProcessor.tickOnce — missing subscription', () => {
  it('dead-letters the event when subscription not found and attempts >= MAX_ATTEMPTS', async () => {
    const { processor, prisma } = makeProcessor({
      rows: [makeRow({ subscriptionId: 'ghost-sub', attempts: 5 })],
      sub: null,
    });
    // Override makePrisma sub store is empty; findUnique returns null
    processor.prisma.webhookSubscription.findUnique = async () => null;
    processor.prisma.webhookEvent.update = async ({ where, data }) => {
      processor.prisma._store.events[where.id] = data;
    };
    await processor.tickOnce();
    assert.equal(processor.prisma._store.events['evt-1'].status, 'dead_lettered');
  });
});

describe('WebhookProcessor — adaptive backoff', () => {
  it('doubles interval after 2 consecutive empty ticks', async () => {
    const { processor } = makeProcessor({ rows: [] });
    processor._baseIntervalMs = 5000;
    processor._currentIntervalMs = 5000;
    await processor.tickOnce();
    await processor.tickOnce();
    assert.equal(processor._currentIntervalMs, 10000);
  });

  it('resets interval after a successful tick', async () => {
    const { processor } = makeProcessor({ rows: [makeRow()] });
    processor._currentIntervalMs = 60000;
    await processor.tickOnce();
    assert.equal(processor._currentIntervalMs, processor._baseIntervalMs);
  });
});
