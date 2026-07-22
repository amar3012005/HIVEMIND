// Connector Runtime V1 — Phase 10 sync WORKER drain tests.
// Verifies drainSyncOnce/_runSyncJob e2e with fakes (no DB/network):
// lease → plugin.sync() batches → ingestSource per record → complete telemetry;
// idle → drained:0; plugin without sync() → fail; ingest error → counted, job
// still completes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { ConnectorPlugin } from '../../src/connectors/runtime/connector-plugin.js';

function fakeStore(jobs) {
  const calls = { markRunning: [], complete: [], fail: [] };
  const q = [...jobs];
  return {
    calls,
    async leaseNext() { return q.shift() || null; },
    async markRunning(id, opts) { calls.markRunning.push({ id, opts }); },
    async complete(id, t) { calls.complete.push({ id, t }); },
    async fail(id, msg, o) { calls.fail.push({ id, msg, o }); },
  };
}

class SyncPlugin extends ConnectorPlugin {
  constructor(batches, { connected = true } = {}) {
    super({ id: 'demo', version: '1.0.0', displayName: 'Demo', authProvider: 'none', syncMode: 'poll',
      tools: [{ name: 'demo__read', description: 'd', inputSchema: { type: 'object' }, access: 'read', approval: 'never', allowedSurfaces: ['sync', 'mcp'] }] });
    this._batches = batches; this._connected = connected;
  }
  async getConnection() { return { connected: this._connected }; }
  async executeTool() { return { ok: true }; }
  async *sync() { for (const b of this._batches) yield b; }
}

function runtimeWith(plugin, store, ingested) {
  const registry = new ConnectorRegistry();
  if (plugin) registry.register(plugin);
  return new ConnectorRuntime({
    registry, db: {},
    hooks: { syncStore: store, ingestSource: async (env) => { ingested.push(env); } },
  });
}

test('drainSyncOnce: lease → sync batches → ingest each → complete with telemetry', async () => {
  const ingested = [];
  const store = fakeStore([{ id: 'j1', connectorId: 'demo', userId: 'u1', orgId: 'o1', mode: 'initial', projectIds: [] }]);
  const plugin = new SyncPlugin([
    { records: [{ userId: 'u1', orgId: 'o1', content: 'a' }, { userId: 'u1', orgId: 'o1', content: 'b' }], cursor: 'c1' },
    { records: [{ userId: 'u1', orgId: 'o1', content: 'c' }], cursor: 'c2' },
  ]);
  const runtime = runtimeWith(plugin, store, ingested);
  const r = await runtime.drainSyncOnce('worker-1');
  assert.equal(r.drained, 1);
  assert.equal(ingested.length, 3, 'all 3 records ingested via canonical front door');
  assert.equal(store.calls.complete.length, 1);
  assert.deepEqual(store.calls.complete[0].t, { processed: 3, imported: 3, failed: 0, cursor: 'c2' });
  assert.equal(store.calls.fail.length, 0);
});

test('drainSyncOnce idle → drained:0 (safe when no jobs)', async () => {
  const runtime = runtimeWith(new SyncPlugin([]), fakeStore([]), []);
  assert.deepEqual(await runtime.drainSyncOnce(), { drained: 0 });
});

test('plugin without sync() → job fails gracefully (never throws)', async () => {
  const ingested = [];
  const store = fakeStore([{ id: 'j2', connectorId: 'nosync', userId: 'u1', orgId: 'o1', mode: 'initial', projectIds: [] }]);
  class NoSync extends ConnectorPlugin {
    constructor() { super({ id: 'nosync', version: '1.0.0', displayName: 'N', authProvider: 'none', syncMode: 'none',
      tools: [{ name: 'nosync__x', description: 'd', inputSchema: { type: 'object' }, access: 'read', approval: 'never', allowedSurfaces: ['mcp'] }] }); }
    async executeTool() { return {}; }
  }
  const runtime = runtimeWith(new NoSync(), store, ingested);
  await runtime.drainSyncOnce();
  assert.equal(store.calls.fail.length, 1);
  assert.match(store.calls.fail[0].msg, /no sync/);
});

test('not-connected → job fails with reauth-safe handling, provider not iterated', async () => {
  const store = fakeStore([{ id: 'j3', connectorId: 'demo', userId: 'u1', orgId: 'o1', mode: 'initial', projectIds: [] }]);
  const plugin = new SyncPlugin([{ records: [{ content: 'x' }] }], { connected: false });
  const ingested = [];
  const runtime = runtimeWith(plugin, store, ingested);
  await runtime.drainSyncOnce();
  assert.equal(ingested.length, 0);
  assert.equal(store.calls.fail.length, 1);
});

test('ingest error is counted but the job still completes (per-record isolation)', async () => {
  const store = fakeStore([{ id: 'j4', connectorId: 'demo', userId: 'u1', orgId: 'o1', mode: 'initial', projectIds: [] }]);
  const plugin = new SyncPlugin([{ records: [{ content: 'ok' }, { content: 'boom' }], cursor: 'z' }]);
  const registry = new ConnectorRegistry(); registry.register(plugin);
  const runtime = new ConnectorRuntime({
    registry, db: {},
    hooks: { syncStore: store, ingestSource: async (env) => { if (env.content === 'boom') throw new Error('ingest fail'); } },
  });
  await runtime.drainSyncOnce();
  assert.equal(store.calls.complete.length, 1);
  assert.deepEqual(store.calls.complete[0].t, { processed: 2, imported: 1, failed: 1, cursor: 'z' });
});
