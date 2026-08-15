import test from 'node:test';
import assert from 'node:assert/strict';
import { revokeAuthoritiesForNewInstruction } from '../../src/hq-runtime/authority-revocation.js';

const runtime = { orgId: 'org-1' };

function prismaWith(authorities) {
  return {
    runtimePlaybookAuthority: {
      findMany: async ({ where }) => authorities.filter((row) => {
        if (where.orgId !== row.orgId) return false;
        if (where.status !== row.status) return false;
        if (where.revokedAt !== null && row.revokedAt !== null) return false;
        if (row.revokedAt !== null) return false;
        if (where.run?.status?.notIn?.includes(row.run.status)) return false;
        return true;
      }).map((row) => ({ ...row })),
      updateMany: async ({ where, data }) => {
        const row = authorities.find((item) => item.id === where.id && item.status === where.status && item.revokedAt === where.revokedAt);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
}

function authority(id, { status = 'GRANTED', revokedAt = null, runStatus = 'WAITING_AUTHORITY', gate = 'outbound_messages' } = {}) {
  return {
    id, orgId: 'org-1', gate, status, revokedAt, payload: {},
    runId: `run-${id}`, run: { id: `run-${id}`, playbookId: 'outreach.direct-message', currentStageId: 'deliver_outreach', status: runStatus },
  };
}

test('a new instruction revokes an in-flight GRANTED authority', async () => {
  const rows = [authority('a1')];
  const prisma = prismaWith(rows);
  const result = await revokeAuthoritiesForNewInstruction({ prisma, runtime, instructionId: 'instr-1', instructionBody: 'Stop cold outreach.' });
  assert.deepEqual(result.revoked.map((item) => item.id), ['a1']);
  assert.equal(rows[0].status, 'REVOKED');
  assert.ok(rows[0].revokedAt instanceof Date);
  assert.equal(rows[0].payload.revoked_reason, 'new_operating_instruction');
  assert.equal(rows[0].payload.revoked_by_instruction_id, 'instr-1');
});

test('never touches an authority whose run already reached a terminal state — the action already happened or definitively did not', async () => {
  for (const runStatus of ['COMPLETED', 'TERMINATED', 'FAILED']) {
    const rows = [authority('a1', { runStatus })];
    const prisma = prismaWith(rows);
    const result = await revokeAuthoritiesForNewInstruction({ prisma, runtime, instructionId: 'instr-1' });
    assert.deepEqual(result.revoked, [], `runStatus=${runStatus} must not be touched`);
    assert.equal(rows[0].status, 'GRANTED');
  }
});

test('never touches an authority that is already revoked — idempotent, not a repeat-narration source', async () => {
  const rows = [authority('a1', { status: 'REVOKED', revokedAt: new Date('2026-08-01T00:00:00Z') })];
  const prisma = prismaWith(rows);
  const result = await revokeAuthoritiesForNewInstruction({ prisma, runtime, instructionId: 'instr-1' });
  assert.deepEqual(result.revoked, []);
});

test('revokes multiple in-flight authorities from a single new instruction', async () => {
  const rows = [authority('a1'), authority('a2', { gate: 'outbound_campaigns' })];
  const prisma = prismaWith(rows);
  const result = await revokeAuthoritiesForNewInstruction({ prisma, runtime, instructionId: 'instr-1' });
  assert.deepEqual(result.revoked.map((item) => item.id).sort(), ['a1', 'a2']);
});

test('returns empty without throwing when prisma/runtime/instructionId are missing', async () => {
  assert.deepEqual((await revokeAuthoritiesForNewInstruction({})).revoked, []);
  assert.deepEqual((await revokeAuthoritiesForNewInstruction({ prisma: {}, runtime: {} })).revoked, []);
});
