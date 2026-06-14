import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitionLoop } from '../../src/memory/cognition-loop.js';

// Stub `this` for dreamRetentionForOrg. No QDRANT_URL in test env → vector purge
// is a no-op (evicted=0); we assert the dead-targeting + hard-delete logic.
function ctx(deadRows) {
  const calls = { memoryDelete: [], relDelete: 0 };
  return {
    calls,
    logger: { log() {}, warn() {} },
    prisma: {
      memory: {
        findMany: async () => deadRows,
        deleteMany: async ({ where }) => { calls.memoryDelete.push(where.id.in); return { count: where.id.in.length }; },
      },
      relationship: { deleteMany: async () => { calls.relDelete++; return {}; } },
    },
  };
}
const run = (c, opts) => CognitionLoop.prototype.dreamRetentionForOrg.call(c, 'org', opts);

test('retention dry-run reports dead count, mutates nothing', async () => {
  const c = ctx([{ id: 'd1', deletedAt: null }, { id: 'd2', deletedAt: new Date() }]);
  const res = await run(c, { apply: false });
  assert.equal(res.deadDreams, 2);
  assert.equal(res.apply, false);
  assert.equal(res.hardDeleted, 0);
  assert.equal(c.calls.memoryDelete.length, 0, 'no deleteMany on dry-run');
});

test('retention apply hard-deletes only the soft-deleted dead dreams (keeps superseded rows)', async () => {
  // d1 superseded (isLatest false, deletedAt null) → keep row, purge vector only.
  // d2 soft-deleted → hard-delete row.
  const c = ctx([{ id: 'd1', deletedAt: null }, { id: 'd2', deletedAt: new Date() }]);
  const res = await run(c, { apply: true });
  assert.equal(res.deadDreams, 2);
  assert.equal(res.hardDeleted, 1, 'only the soft-deleted row is reclaimed');
  assert.deepEqual(c.calls.memoryDelete, [['d2']], 'superseded d1 NOT hard-deleted');
});

test('retention no-op when nothing dead', async () => {
  const c = ctx([]);
  const res = await run(c, { apply: true });
  assert.equal(res.deadDreams, 0);
  assert.equal(res.evicted, 0);
  assert.equal(c.calls.memoryDelete.length, 0);
});
