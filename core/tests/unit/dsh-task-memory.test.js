import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dshTaskMemory } from '../../src/hyperagents/dsh-task-memory.js';
import { validateOperatingMemory } from '../../src/hyperagents/operating-memory.js';

export function taskPacket() {
  const context = { source: 'dsh-turn', completionScope: 'response', sessionId: 'session-d292efdd-4b56-4053-b61c-9cd63a7cd8ff', turn: 1, ownerName: 'Elena', requestedAt: '2026-09-30T17:00:00.000Z', completedAt: '2026-09-30T17:01:00.000Z', requestSeqs: [2], responseSeq: 5, completionSeq: 6, toolReceipts: [{ name: 'research', callId: 'call-1', resultSeq: 4, isError: false }] };
  const key = `dsh-task:${context.sessionId}:${context.turn}:${context.completionSeq}`;
  const hash = createHash('sha256').update(key).digest('hex');
  return { action: 'record_task', agent_slug: 'elena', title: 'Completed campaign blueprint', summary: 'Requested blueprint. Delivered response; external actions require receipts.', idempotency_key: key, run_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`, context };
}

test('signed runner completion is a task record with response-scoped evidence', () => {
  const packet = dshTaskMemory(taskPacket());
  assert.equal(packet.kind, 'task_status');
  assert.equal(packet.status, 'completed');
  const identity = { orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b' };
  assert.equal(validateOperatingMemory(packet, { ...identity, source: 'runtime' }).agentSlug, 'elena');
  assert.throws(() => validateOperatingMemory(packet, { ...identity, source: 'agent' }), /runtime_receipt_required/);
});

test('completion rejects forged identity, invalid chronology and unbounded or injected context', () => {
  for (const change of [
    packet => { packet.run_id = 'forged'; },
    packet => { packet.idempotency_key = 'forged'; },
    packet => { packet.context.orgId = 'another-tenant'; },
    packet => { packet.context.requestedAt = '2026-10-01T17:00:00.000Z'; },
    packet => { packet.context.requestSeqs = [packet.context.responseSeq]; },
    packet => { packet.context.toolReceipts[0].rawArgs = 'secret'; },
    packet => { packet.context.completionScope = 'external-work'; },
    packet => { packet.context.toolReceipts = Array(17).fill(packet.context.toolReceipts[0]); },
  ]) {
    const packet = taskPacket(); change(packet);
    assert.throws(() => dshTaskMemory(packet), /invalid_task_memory/);
  }
});
