import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityApprovalToken, previewApprovalToken, consumeApprovalToken } from '../../src/hq-runtime/approval-links.js';

function approvalRow(overrides = {}) {
  return {
    token: 'tok-1', orgId: 'org-1', runtimeId: 'runtime-1', kind: 'authority',
    runId: 'run-1', gate: 'outbound_messages', title: 'Approval required: X',
    summary: 'Needs a decision.', orgName: 'Acme', usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function prismaWith({ approvals = [], run = null } = {}) {
  return {
    hqApprovalToken: {
      create: async ({ data }) => { const row = { ...data }; approvals.push(row); return row; },
      findUnique: async ({ where }) => approvals.find((a) => a.token === where.token) || null,
      updateMany: async ({ where, data }) => {
        const row = approvals.find((a) => a.token === where.token && a.usedAt === where.usedAt);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    runtimePlaybookRun: { findFirst: async () => run },
  };
}

function serviceWith({ stage = { id: 'deliver_outreach', authority_gate: 'outbound_messages', input_refs: [] } } = {}) {
  const grants = [];
  return {
    registry: { get: () => ({ stages: [stage] }) },
    grantAuthority: async (runId, orgId, gate, opts) => { grants.push({ runId, orgId, gate, opts }); return { id: 'grant-1' }; },
    _grants: grants,
  };
}

test('createAuthorityApprovalToken mints a real token and persists it', async () => {
  const approvals = [];
  const prisma = prismaWith({ approvals });
  const token = await createAuthorityApprovalToken({
    prisma, runtime: { id: 'runtime-1', orgId: 'org-1' }, orgName: 'Acme',
    runId: 'run-1', gate: 'outbound_messages', title: 'Approval required: X', summary: 'Needs a decision.',
  });
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].gate, 'outbound_messages');
});

test('createAuthorityApprovalToken returns null (never throws) without runId/gate', async () => {
  const prisma = prismaWith();
  assert.equal(await createAuthorityApprovalToken({ prisma, runtime: { id: 'r', orgId: 'o' } }), null);
});

test('previewApprovalToken reports not_found for an unknown token', async () => {
  const result = await previewApprovalToken({ prisma: prismaWith(), token: 'nope' });
  assert.equal(result.status, 'not_found');
});

test('previewApprovalToken reports used / expired without ever mutating anything', async () => {
  const approvals = [approvalRow({ token: 'used-tok', usedAt: new Date() })];
  const usedResult = await previewApprovalToken({ prisma: prismaWith({ approvals }), token: 'used-tok' });
  assert.equal(usedResult.status, 'used');

  const expiredApprovals = [approvalRow({ token: 'expired-tok', expiresAt: new Date(Date.now() - 1000) })];
  const expiredResult = await previewApprovalToken({ prisma: prismaWith({ approvals: expiredApprovals }), token: 'expired-tok' });
  assert.equal(expiredResult.status, 'expired');
});

test('previewApprovalToken reports stale when the underlying run already moved on — an honest outcome, not an error', async () => {
  const approvals = [approvalRow()];
  const prisma = prismaWith({ approvals, run: { id: 'run-1', status: 'COMPLETED' } });
  const result = await previewApprovalToken({ prisma, token: 'tok-1' });
  assert.equal(result.status, 'stale');
});

test('previewApprovalToken reports ready when the checkpoint genuinely still needs a decision', async () => {
  const approvals = [approvalRow()];
  const run = { id: 'run-1', status: 'WAITING_AUTHORITY' };
  const result = await previewApprovalToken({ prisma: prismaWith({ approvals, run }), token: 'tok-1' });
  assert.equal(result.status, 'ready');
  assert.equal(result.title, 'Approval required: X');
});

test('consumeApprovalToken actually grants the authority via service.grantAuthority — the SAME primitive the session-gated route uses', async () => {
  const approvals = [approvalRow()];
  const run = { id: 'run-1', status: 'WAITING_AUTHORITY', playbookId: 'p', playbookVersion: 1, scopeKey: 'global', currentStageId: 'deliver_outreach' };
  const service = serviceWith();
  const result = await consumeApprovalToken({
    prisma: prismaWith({ approvals, run }), token: 'tok-1', runtimePlaybooks: service,
  });
  assert.equal(result.ok, true);
  assert.equal(service._grants.length, 1);
  assert.equal(service._grants[0].gate, 'outbound_messages');
  assert.equal(approvals[0].usedAt !== null, true, 'the token must be marked used');
});

test('consumeApprovalToken is single-use — a second call on the same token is rejected, never a double grant', async () => {
  const approvals = [approvalRow()];
  const run = { id: 'run-1', status: 'WAITING_AUTHORITY', playbookId: 'p', playbookVersion: 1, scopeKey: 'global', currentStageId: 'deliver_outreach' };
  const service = serviceWith();
  const prisma = prismaWith({ approvals, run });
  const first = await consumeApprovalToken({ prisma, token: 'tok-1', runtimePlaybooks: service });
  const second = await consumeApprovalToken({ prisma, token: 'tok-1', runtimePlaybooks: service });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, 'used');
  assert.equal(service._grants.length, 1, 'must never grant twice');
});

test('consumeApprovalToken refuses a stale checkpoint (run already moved on) without granting anything', async () => {
  const approvals = [approvalRow()];
  const run = { id: 'run-1', status: 'COMPLETED' };
  const service = serviceWith();
  const result = await consumeApprovalToken({ prisma: prismaWith({ approvals, run }), token: 'tok-1', runtimePlaybooks: service });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'stale');
  assert.equal(service._grants.length, 0);
});

test('consumeApprovalToken refuses when the stage no longer matches the gate the token was minted for', async () => {
  const approvals = [approvalRow()];
  const run = { id: 'run-1', status: 'WAITING_AUTHORITY', playbookId: 'p', playbookVersion: 1, scopeKey: 'global', currentStageId: 'deliver_outreach' };
  const service = serviceWith({ stage: { id: 'deliver_outreach', authority_gate: 'outbound_campaigns' } });
  const result = await consumeApprovalToken({ prisma: prismaWith({ approvals, run }), token: 'tok-1', runtimePlaybooks: service });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'stale');
  assert.equal(service._grants.length, 0);
});

test('consumeApprovalToken never throws on an unknown token', async () => {
  const result = await consumeApprovalToken({ prisma: prismaWith(), token: 'nope', runtimePlaybooks: serviceWith() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_found');
});
