import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestStepDigest, KnowledgeIngestStepStore } from '../../src/knowledge/ingest-step-store.js';

function stepModel() {
  const rows = new Map();
  const key = (value) => `${value.jobId}:${value.processingVersion}:${value.stageKey}:${value.shardKey}`;
  const identity = (args) => args.where.jobId_processingVersion_stageKey_shardKey || args.where;
  const matches = (row, where) => {
    if (where.status?.not && row.status === where.status.not) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.leaseToken !== undefined && row.leaseToken !== where.leaseToken) return false;
    if (where.OR) {
      const eligible = where.OR.some((part) => {
        if (part.status?.in) return part.status.in.includes(row.status);
        return row.status === part.status && row.leaseUntil < part.leaseUntil.lt;
      });
      if (!eligible) return false;
    }
    return ['jobId', 'processingVersion', 'stageKey', 'shardKey'].every((field) => where[field] === undefined || row[field] === where[field]);
  };
  const apply = (row, data) => {
    for (const [field, value] of Object.entries(data)) {
      row[field] = value && typeof value === 'object' && Object.hasOwn(value, 'increment')
        ? Number(row[field] || 0) + value.increment : value;
    }
  };
  return {
    rows,
    async upsert(args) {
      const id = identity(args);
      const mapKey = key(id);
      if (!rows.has(mapKey)) rows.set(mapKey, { id: `receipt-${rows.size + 1}`, attempt: 0, ...args.create });
      return structuredClone(rows.get(mapKey));
    },
    async findUnique(args) {
      const row = rows.get(key(identity(args)));
      return row ? structuredClone(row) : null;
    },
    async updateMany(args) {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, args.where)) continue;
        apply(row, args.data);
        count += 1;
      }
      return { count };
    },
  };
}

const identity = {
  jobId: '33333333-3333-4333-8333-333333333333', processingVersion: 1,
  stageKey: 'extract', shardKey: 'root',
};

test('successful stage receipts are reused without executing duplicate work', async () => {
  const model = stepModel();
  const store = new KnowledgeIngestStepStore({ prisma: { knowledgeIngestStep: model }, leaseMs: 30_000 });
  let executions = 0;
  const run = () => store.run({ ...identity, input: { object: 'r2/key' } }, async () => {
    executions += 1;
    return { outputRefs: { artifact: 'normalized/1' }, coverage: { succeeded: 4, failed: 0 } };
  });

  const first = await run();
  const replay = await run();
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(executions, 1);
  assert.deepEqual(replay.receipt.outputRefs, { artifact: 'normalized/1' });
});

test('a live lease rejects concurrent delivery, while an expired lease is reclaimable', async () => {
  const model = stepModel();
  const store = new KnowledgeIngestStepStore({ prisma: { knowledgeIngestStep: model }, leaseMs: 30_000 });
  assert.equal((await store.claim({ ...identity, inputDigest: 'one' })).acquired, true);
  const busy = await store.claim({ ...identity, inputDigest: 'one' });
  assert.equal(busy.busy, true);

  const row = [...model.rows.values()][0];
  row.leaseUntil = new Date(Date.now() - 1000);
  const reclaimed = await store.claim({ ...identity, inputDigest: 'one' });
  assert.equal(reclaimed.acquired, true);
  assert.equal(reclaimed.receipt.attempt, 2);
});

test('checkpoint digests are deterministic and sanitize unsafe string bytes', () => {
  assert.equal(ingestStepDigest({ text: 'a\u0000b' }), ingestStepDigest({ text: 'ab' }));
  assert.equal(ingestStepDigest({ a: 1 }), ingestStepDigest({ a: 1 }));
  assert.notEqual(ingestStepDigest({ a: 1 }), ingestStepDigest({ a: 2 }));
});

test('a reclaimed lease fences a late worker result', async () => {
  const model = stepModel();
  const store = new KnowledgeIngestStepStore({ prisma: { knowledgeIngestStep: model }, leaseMs: 30_000 });
  const first = await store.claim({ ...identity, inputDigest: 'same' });
  [...model.rows.values()][0].leaseUntil = new Date(Date.now() - 1000);
  const second = await store.claim({ ...identity, inputDigest: 'same' });

  await assert.rejects(
    store.succeed(identity, first.receipt.leaseToken, { outputRefs: { stale: true } }),
    (error) => error.code === 'INGEST_STAGE_LEASE_LOST',
  );
  await assert.doesNotReject(
    store.succeed(identity, second.receipt.leaseToken, { outputRefs: { winner: true } }),
  );
});

test('a successful receipt rejects changed input within the same processing version', async () => {
  const model = stepModel();
  const store = new KnowledgeIngestStepStore({ prisma: { knowledgeIngestStep: model }, leaseMs: 30_000 });
  await store.run({ ...identity, input: { object: 'one' } }, async () => ({ ok: true }));
  await assert.rejects(
    store.run({ ...identity, input: { object: 'two' } }, async () => ({ ok: true })),
    (error) => error.code === 'INGEST_STAGE_INPUT_MISMATCH',
  );
});
