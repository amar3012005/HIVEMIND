import assert from 'node:assert/strict';
import test from 'node:test';
import { recallOperatingMemory, saveOperatingMemory, validateOperatingMemory } from './operating-memory.js';

const orgId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('a model cannot forge completed work or trigger receipts', () => {
  const base = { kind: 'task_status', status: 'completed', agent_slug: 'elena', title: 'Done', summary: 'Claimed done', idempotency_key: 'one', run_id: runId };
  assert.throws(() => validateOperatingMemory(base, { orgId, userId }), /runtime_receipt_required/);
  assert.throws(() => validateOperatingMemory({ ...base, kind: 'learning' }, { orgId, userId }), /runtime_status_required/);
  assert.equal(validateOperatingMemory(base, { orgId, userId, source: 'runtime' }).run_id, runId);
});

test('writes are scoped, idempotent, and only expose bounded fields', async () => {
  const calls = [];
  const row = { id: runId, kind: 'learning', status: 'recorded', agent_slug: 'elena', title: 'Lesson', summary: 'Use the primary source', context: {}, room_id: null, run_id: runId, trigger_id: null, created_at: new Date('2026-09-29T10:00:00Z') };
  const prisma = { project: { upsert: async () => ({ id: userId, name: 'Hyper Agents', policy: 'private' }) }, projectMember: { upsert: async () => ({}) }, $queryRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return calls.length === 1 ? [row] : []; } };
  const result = await saveOperatingMemory(prisma, { kind: 'learning', agent_slug: 'elena', title: 'Lesson', summary: 'Use the primary source', status: 'recorded', idempotency_key: 'learning:one', run_id: runId }, { orgId, userId });
  assert.equal(result.ok, true);
  assert.equal(result.memory.project, 'hyper-agents');
  assert.equal(result.memory.agentSlug, 'elena');
  assert.equal(calls[0].args[0], orgId);
  assert.match(calls[0].sql, /ON CONFLICT \(org_id, idempotency_key\) DO NOTHING/);
});

test('recall filters at the database before newest-first pagination', async () => {
  let query;
  const prisma = { $queryRawUnsafe: async (sql, ...args) => { query = { sql, args }; return []; } };
  const result = await recallOperatingMemory(prisma, orgId, { kind: 'task_status', agent_slug: 'elena', status: 'completed', limit: 5 });
  assert.equal(result.count, 0);
  assert.match(query.sql, /project_slug = 'hyper-agents'/);
  assert.match(query.sql, /kind = \$2/);
  assert.match(query.sql, /agent_slug = \$3/);
  assert.match(query.sql, /status = \$4/);
  assert.match(query.sql, /ORDER BY created_at DESC, id DESC LIMIT \$5/);
  assert.deepEqual(query.args, [orgId, 'task_status', 'elena', 'completed', 5]);
});

test('invalid filters and oversized content are rejected', async () => {
  await assert.rejects(() => recallOperatingMemory({}, orgId, { limit: 100 }), /invalid_limit/);
  assert.throws(() => validateOperatingMemory({ kind: 'learning', status: 'recorded', agent_slug: 'elena', title: 'Lesson', summary: 'x'.repeat(2401), idempotency_key: 'x' }, { orgId, userId }), /invalid_memory_content/);
});
