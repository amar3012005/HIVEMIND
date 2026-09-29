import assert from 'node:assert/strict';
import test from 'node:test';
import { recallOperatingMemory, recordTriggerDefinition, saveOperatingMemory, validateOperatingMemory } from './operating-memory.js';

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
  assert.match(query.sql, /successor\.context->>'supersedesId' = m\.id::text/);
  assert.match(query.sql, /kind = \$2/);
  assert.match(query.sql, /agent_slug = \$3/);
  assert.match(query.sql, /status = \$4/);
  assert.match(query.sql, /ORDER BY m\.created_at DESC, m\.id DESC LIMIT \$5/);
  assert.deepEqual(query.args, [orgId, 'task_status', 'elena', 'completed', 5]);
});

test('task query searches before pagination and ranks across all private history', async () => {
  let query;
  const prisma = { $queryRawUnsafe: async (sql, ...args) => { query = { sql, args }; return []; } };
  await recallOperatingMemory(prisma, orgId, { kind: 'learning', query: 'Hannover insurer official source evidence', limit: 5 });
  assert.match(query.sql, /to_tsvector\('simple', m\.title \|\| ' ' \|\| m\.summary\) @@ to_tsquery\('simple', \$3\)/);
  assert.match(query.sql, /ORDER BY ts_rank\(/);
  assert.deepEqual(query.args, [orgId, 'learning', 'hannover | insurer | official | source | evidence', 5]);
});

test('supersession is constrained to the same organization, kind, and employee', async () => {
  const earlier = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const calls = [];
  const row = { id: runId, kind: 'learning', status: 'recorded', agent_slug: 'elena', title: 'Correction',
    summary: 'Use the verified receipt', context: { supersedesId: earlier }, room_id: null, run_id: runId,
    trigger_id: null, created_at: new Date() };
  const prisma = { project: { upsert: async () => ({ id: userId, name: 'Hyper Agents', policy: 'private' }) },
    projectMember: { upsert: async () => ({}) },
    $queryRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return calls.length === 1 ? [{ id: earlier }] : [row]; } };
  const result = await saveOperatingMemory(prisma, { kind: 'learning', agent_slug: 'elena', title: 'Correction',
    summary: 'Use the verified receipt', idempotency_key: 'learning:correction', run_id: runId,
    supersedes_id: earlier }, { orgId, userId });
  assert.equal(result.memory.supersedesId, earlier);
  assert.match(calls[0].sql, /org_id = \$2::uuid.*project_slug = 'hyper-agents'/s);
  assert.match(calls[0].sql, /kind = \$3 AND agent_slug = \$4/);
  assert.equal(calls[1].args.at(-1), JSON.stringify({ supersedesId: earlier }));
});

test('invalid filters and oversized content are rejected', async () => {
  await assert.rejects(() => recallOperatingMemory({}, orgId, { limit: 100 }), /invalid_limit/);
  assert.throws(() => validateOperatingMemory({ kind: 'learning', status: 'recorded', agent_slug: 'elena', title: 'Lesson', summary: 'x'.repeat(2401), idempotency_key: 'x' }, { orgId, userId }), /invalid_memory_content/);
  assert.throws(() => validateOperatingMemory({ kind: 'learning', agent_slug: 'elena', title: 'Lesson', summary: 'x', idempotency_key: 'x', context: { supersedesId: runId } }, { orgId, userId }), /reserved_memory_context_key/);
});

test('a durable trigger definition is attributed to its selected employee', async () => {
  const rows = [];
  const prisma = {
    digitalEmployee: { findFirst: async () => ({ slug: 'elena' }) },
    project: { upsert: async () => ({ id: userId, name: 'Hyper Agents', policy: 'private' }) },
    projectMember: { upsert: async () => ({}) },
    $queryRawUnsafe: async (_sql, ...args) => { rows.push(args); return [{
      id: runId, kind: 'trigger_status', status: 'active', agent_slug: 'elena', title: 'Durable trigger created',
      summary: 'Scheduled daily task: Research competitors', room_id: null, run_id: null,
      trigger_id: runId, context: {}, created_at: new Date(),
    }]; },
  };
  await recordTriggerDefinition(prisma, { id: runId, org_id: orgId, user_id: userId,
    employee_id: userId, kind: 'daily', task: 'Research competitors', status: 'active', version: 1 });
  assert.equal(rows[0][3], 'trigger_status');
  assert.equal(rows[0][5], 'elena');
});

test('a paused trigger records a new version without overwriting its earlier state', async () => {
  const rows = [];
  const prisma = {
    digitalEmployee: { findFirst: async () => ({ slug: 'elena' }) },
    project: { upsert: async () => ({ id: userId, name: 'Hyper Agents', policy: 'private' }) },
    projectMember: { upsert: async () => ({}) },
    $queryRawUnsafe: async (_sql, ...args) => { rows.push(args); return [{
      id: runId, kind: 'trigger_status', status: 'paused', agent_slug: 'elena',
      title: 'Durable trigger updated', summary: 'Scheduled daily task: Research competitors',
      room_id: null, run_id: null, trigger_id: runId, context: {}, created_at: new Date(),
    }]; },
  };
  await recordTriggerDefinition(prisma, { id: runId, org_id: orgId, user_id: userId,
    employee_id: userId, kind: 'daily', task: 'Research competitors', status: 'paused', version: 2 });
  assert.equal(rows[0][2], `trigger-definition:${runId}:v2`);
  assert.equal(rows[0][4], 'paused');
});
