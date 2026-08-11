import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTurnEvent, sealTurn } from '../../src/employees/hyper-rooms.js';

function fakePrisma(initial = {}) {
  const row = {
    id: 'turn-1',
    lines: [],
    sealedAt: null,
    status: 'live',
    userMessage: 'Build the requested persona',
    ...initial,
  };
  const hyperTurn = {
    async findUnique() { return { ...row, lines: [...row.lines] }; },
    async update({ data }) { Object.assign(row, data); return { ...row }; },
  };
  return {
    row,
    hyperTurn,
    async $transaction(work) { return work({ hyperTurn }); },
  };
}

test('retried Room events append once by stable delivery id', async () => {
  const prisma = fakePrisma();
  const event = { t: 'final_report', event_id: 'delivery-1', content: 'Grounded result' };
  await appendTurnEvent(prisma, 'turn-1', event);
  await appendTurnEvent(prisma, 'turn-1', event);
  assert.equal(prisma.row.lines.length, 1);
  assert.equal(prisma.row.lines[0].event_id, 'delivery-1');
});

test('seal recovers a canonical final report from durable synthesis', async () => {
  const prisma = fakePrisma({
    lines: [{ t: 'line', kind: 'synthesis', content: '# Audience persona\n\nEvidence-backed result.' }],
  });
  await sealTurn(prisma, 'turn-1', {
    status: 'complete',
    costTokens: 42,
    event: { t: 'seal', event_id: 'seal-1', status: 'complete', cost_tokens: 42 },
  });
  assert.deepEqual(prisma.row.lines.map((line) => line.t), ['line', 'final_report', 'seal']);
  assert.equal(prisma.row.lines[1].content, '# Audience persona\n\nEvidence-backed result.');
  assert.equal(prisma.row.lines[1].recovered_from, 'synthesis');
  assert.equal(prisma.row.status, 'complete');
  assert.equal(prisma.row.costTokens, 42);
});
