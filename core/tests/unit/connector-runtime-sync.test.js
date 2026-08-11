// Connector Runtime V1 — Phase 10 sync: durable job store + runtime.startSync.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SyncJobStore } from '../../src/connectors/runtime/sync-job-store.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';

function fakePrisma() {
  const rows = new Map(); let seq = 0;
  return {
    _rows: rows,
    connectorSyncJob: {
      async create({ data }) {
        if (data.idempotencyKey && [...rows.values()].some((r) => r.idempotencyKey === data.idempotencyKey)) { const e = new Error('unique'); e.code = 'P2002'; throw e; }
        const id = `job-${++seq}`; const row = { id, status: 'queued', attempt: 0, maxAttempts: 5, ...data }; rows.set(id, row); return { ...row };
      },
      async findUnique({ where }) {
        if (where.id) return rows.has(where.id) ? { ...rows.get(where.id) } : null;
        if (where.idempotencyKey) { const r = [...rows.values()].find((x) => x.idempotencyKey === where.idempotencyKey); return r ? { ...r } : null; }
        return null;
      },
      async update({ where, data }) { const r = rows.get(where.id); Object.assign(r, data); return { ...r }; },
    },
    // pendingWrite present so buildDefaultHooks installs approval too (not used here)
    pendingWrite: { create() {}, findUnique() { return null; }, updateMany() { return { count: 0 }; }, update() {} },
  };
}

const CTX = { userId: 'u1', orgId: 'o1' };

function runtime(prisma, config) {
  const reg = new ConnectorRegistry();
  reg.register(new GmailPlugin({ execGoogleTool: async () => ({}) }));
  const hooks = { syncStore: new SyncJobStore({ prisma }) };
  return new ConnectorRuntime({ registry: reg, db: {}, config, hooks });
}

test('startSync enqueues a durable job', async () => {
  const prisma = fakePrisma();
  const rt = runtime(prisma, loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_SYNC: '1' }));
  const r = await rt.startSync('gmail', { orgId: 'o1', userId: 'u1', mode: 'initial' });
  assert.ok(r.jobId, 'job created');
  assert.equal(r.status, 'queued');
  assert.equal(prisma._rows.size, 1);
  assert.equal([...prisma._rows.values()][0].connectorId, 'gmail');
});

test('startSync is idempotent (same key → same job, no dup)', async () => {
  const prisma = fakePrisma();
  const rt = runtime(prisma, loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_SYNC: '1' }));
  const a = await rt.startSync('gmail', { orgId: 'o1', userId: 'u1', mode: 'initial', key: 'k1' });
  const b = await rt.startSync('gmail', { orgId: 'o1', userId: 'u1', mode: 'initial', key: 'k1' });
  assert.equal(a.jobId, b.jobId);
  assert.equal(prisma._rows.size, 1);
});

test('startSync gated by CONNECTOR_RUNTIME_SYNC flag', async () => {
  const prisma = fakePrisma();
  const rt = runtime(prisma, loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1' })); // SYNC off
  const r = await rt.startSync('gmail', { orgId: 'o1', userId: 'u1' });
  assert.ok(r.error, 'sync not enabled → error');
  assert.equal(prisma._rows.size, 0);
});

test('startSync rejects unknown connector', async () => {
  const prisma = fakePrisma();
  const rt = runtime(prisma, loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_SYNC: '1' }));
  const r = await rt.startSync('notion', { orgId: 'o1', userId: 'u1' });
  assert.ok(r.error && /unknown connector/.test(r.error));
});

test('fail() retries until maxAttempts then marks failed', async () => {
  const prisma = fakePrisma();
  const store = new SyncJobStore({ prisma });
  const job = await store.enqueue({ orgId: 'o1', userId: 'u1', connectorId: 'gmail', mode: 'initial' });
  // simulate attempts
  prisma._rows.get(job.id).attempt = 1;
  let r = await store.fail(job.id, 'boom'); assert.equal(r.status, 'queued'); // retry
  prisma._rows.get(job.id).attempt = 5;
  r = await store.fail(job.id, 'boom'); assert.equal(r.status, 'failed'); // exhausted
  r = await store.fail(job.id, 'reauth', { reauth: true }); assert.equal(r.status, 'reauth_required');
});
