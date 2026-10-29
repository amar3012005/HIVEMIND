import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readRetentionConfig, dryRunWebIntelRetention, trimWebIntelJobs, startWebIntelRetentionScheduler,
  formatRetentionSummary, TRIM_BATCH_SQL, DRY_RUN_SQL, TRIMMED_BYTES_FLOOR,
} from '../../src/web/web-job-retention.js';
import { WebJobStore } from '../../src/web/web-job-store.js';

const NOW = new Date('2026-10-29T00:00:00Z');

test('config defaults to 30 days, bounded batches, and can be disabled', () => {
  const cfg = readRetentionConfig({});
  assert.equal(cfg.retentionDays, 30);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.batchSize, 25);
  assert.equal(readRetentionConfig({ HIVEMIND_WEB_JOB_RETENTION_DAYS: '14' }).retentionDays, 14);
  assert.equal(readRetentionConfig({ HIVEMIND_WEB_JOB_RETENTION_DAYS: '0' }).enabled, false);
  assert.equal(readRetentionConfig({ HIVEMIND_WEB_JOB_RETENTION_ENABLED: 'false' }).enabled, false);
  assert.equal(readRetentionConfig({ HIVEMIND_WEB_JOB_RETENTION_BATCH: '99999' }).batchSize, 500);
  assert.equal(readRetentionConfig({ HIVEMIND_WEB_JOB_RETENTION_DAYS: 'junk' }).retentionDays, 30);
});

test('trim SQL touches only the heavy jsonb columns of finished jobs', () => {
  const setClause = TRIM_BATCH_SQL.match(/SET([\s\S]*?)FROM picked/)[1];
  const assigned = [...setClause.matchAll(/(?:^|\n) {0,6}(\w+) = /g)].map((m) => m[1]);
  assert.deepEqual(assigned, ['result', 'progress', 'provider_attempts']);
  assert.match(TRIM_BATCH_SQL, /status IN \('succeeded', 'failed'\)/);
  assert.match(TRIM_BATCH_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(TRIM_BATCH_SQL, /LIMIT \$2/);
  assert.ok(!/updated_at\s*=/.test(setClause), 'updated_at must not change');
  assert.match(DRY_RUN_SQL, new RegExp(`> ${TRIMMED_BYTES_FLOOR}`));
});

test('trim runs bounded batches and sums bytes freed', async () => {
  const calls = [];
  const prisma = {
    $queryRawUnsafe: async (sql, cutoff, limit) => {
      calls.push({ cutoff, limit });
      return Array.from({ length: limit }, () => ({ before_bytes: 2000, after_bytes: 100 }));
    },
  };
  const r = await trimWebIntelJobs(prisma, { retentionDays: 30, batchSize: 5, maxBatches: 3, now: NOW });
  assert.equal(calls.length, 3);
  assert.equal(r.trimmed, 15);
  assert.equal(r.bytesFreed, 15 * 1900);
  assert.equal(r.more, true);
  assert.equal(calls[0].cutoff.toISOString(), '2026-09-29T00:00:00.000Z');
  assert.match(formatRetentionSummary(r, 30), /^\[web-intel-retention\] trimmed=15 freed_bytes=28500 /);
});

test('trim stops at the first short batch', async () => {
  let n = 0;
  const prisma = { $queryRawUnsafe: async () => (n++ === 0 ? [{ before_bytes: 5000, after_bytes: 8 }, { before_bytes: 3000, after_bytes: 8 }] : []) };
  const r = await trimWebIntelJobs(prisma, { retentionDays: 30, batchSize: 5, maxBatches: 8, now: NOW });
  assert.equal(r.batches, 1);
  assert.equal(r.trimmed, 2);
  assert.equal(r.more, false);
});

test('dry run aggregates by status without writing', async () => {
  const prisma = { $queryRawUnsafe: async (sql) => { assert.ok(!/\bUPDATE\s+hivemind/i.test(sql)); return [{ status: 'succeeded', rows: 61, bytes: '64489006' }, { status: 'failed', rows: 2, bytes: 4000 }]; } };
  const r = await dryRunWebIntelRetention(prisma, { retentionDays: 30, now: NOW });
  assert.equal(r.rows, 63);
  assert.equal(r.bytes, 64493006);
  assert.equal(r.byStatus.succeeded.rows, 61);
});

test('scheduler logs one summary line per run, never overlaps, and is inert when disabled', async () => {
  const logs = [];
  const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
  let release; const gate = new Promise((r) => { release = r; });
  const prisma = { $queryRawUnsafe: async () => { await gate; return []; } };
  assert.equal(startWebIntelRetentionScheduler({ prisma, logger, env: { HIVEMIND_WEB_JOB_RETENTION_DAYS: '0' } }), null);
  assert.equal(startWebIntelRetentionScheduler({ prisma: null, logger, env: {} }), null);
  const s = startWebIntelRetentionScheduler({ prisma, logger, env: {} });
  const first = s.runOnce();
  assert.equal(await s.runOnce(), null, 'overlapping run is skipped');
  release(); await first; s.stop();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /trimmed=0/);
});

test('scheduler failure is logged and does not throw', async () => {
  const logs = [];
  const s = startWebIntelRetentionScheduler({ prisma: { $queryRawUnsafe: async () => { throw new Error('db down'); } }, logger: { log() {}, warn: (m) => logs.push(m) }, env: {} });
  assert.equal(await s.runOnce(), null); s.stop();
  assert.match(logs[0], /run failed: db down/);
});

test('markSaved records capped, de-duplicated memory ids in the job request', async () => {
  let updated;
  const prisma = { webIntelJob: {
    findUnique: async () => ({ id: 'j', request: { query: 'q' } }),
    update: async ({ data }) => { updated = data; return { id: 'j', request: data.request }; },
  } };
  const store = new WebJobStore({ prisma });
  await store.markSaved('j', Array.from({ length: 15 }, (_, i) => `m${i % 12}`));
  assert.equal(updated.request.query, 'q');
  assert.equal(updated.request.saved_memory_ids.length, 10);
  assert.equal(await store.markSaved('j', []), null);
});

test('accounting selects never include the trimmed columns', async () => {
  const seen = [];
  const prisma = { webIntelJob: { findMany: async (q) => { seen.push(q.select); return []; } }, webIntelUsageSettlement: { findMany: async () => [{ jobId: 'a' }] } };
  const store = new WebJobStore({ prisma });
  await store._all({ orgId: 'o' }); await store.list({ orgId: 'o' }); await store.getUsage({ orgId: 'o' });
  for (const select of seen) for (const col of ['result', 'progress', 'providerAttempts']) assert.ok(!select[col], `${col} selected`);
});
