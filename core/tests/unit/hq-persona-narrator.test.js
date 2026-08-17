import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyOwnerByEmail } from '../../src/hq-runtime/persona-narrator.js';

function baseRuntime(overrides = {}) {
  return {
    id: 'runtime-1', orgId: 'org-1', ownerUserId: 'user-1',
    emailUpdatesEnabled: true, emailThreadTo: null, emailThreadSubject: null,
    emailThreadMessageId: null,
    ...overrides,
  };
}

function prismaWith({ owner = { email: 'owner@example.com' }, org = { name: 'Acme' }, runtimeRows = [] } = {}) {
  return {
    user: { findUnique: async () => owner },
    organization: { findUnique: async () => org },
    hqRuntime: {
      updateMany: async ({ where, data }) => {
        const row = runtimeRows.find((r) => r.id === where.id);
        if (row) {
          for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === 'object' && 'increment' in value
              ? (row[key] || 0) + value.increment
              : value;
          }
        }
        return { count: row ? 1 : 0 };
      },
    },
  };
}

test('notifyOwnerByEmail is a no-op when email updates are disabled for this runtime', async () => {
  const sendEmail = async () => { throw new Error('must never be called'); };
  const result = await notifyOwnerByEmail(
    { prisma: prismaWith(), runtime: baseRuntime({ emailUpdatesEnabled: false }), kind: 'activation' },
    { sendEmail },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.error, 'updates_disabled');
});

test('notifyOwnerByEmail resolves the owner\'s real email when no thread recipient is persisted yet', async () => {
  let sentTo = null;
  const sendEmail = async (args) => { sentTo = args.to; return { ok: true, messageId: '<root@x>' }; };
  await notifyOwnerByEmail(
    { prisma: prismaWith({ owner: { email: 'founder@singulancelabs.com' } }), runtime: baseRuntime(), kind: 'activation' },
    { sendEmail },
  );
  assert.equal(sentTo, 'founder@singulancelabs.com');
});

test('notifyOwnerByEmail is a no-op when no owner email can be resolved at all', async () => {
  const sendEmail = async () => { throw new Error('must never be called'); };
  const result = await notifyOwnerByEmail(
    { prisma: prismaWith({ owner: null }), runtime: baseRuntime(), kind: 'activation' },
    { sendEmail },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.error, 'no_owner_email');
});

test('the FIRST send persists the thread root (subject + Message-ID) on the runtime row', async () => {
  const runtimeRows = [baseRuntime()];
  const sendEmail = async () => ({ ok: true, messageId: '<root-message-id@singulancelabs.com>' });
  await notifyOwnerByEmail(
    { prisma: prismaWith({ runtimeRows }), runtime: runtimeRows[0], kind: 'activation' },
    { sendEmail },
  );
  assert.equal(runtimeRows[0].emailThreadMessageId, '<root-message-id@singulancelabs.com>');
  assert.equal(runtimeRows[0].emailThreadSentCount, 1);
  assert.ok(runtimeRows[0].emailThreadSubject);
});

test('every send AFTER the first references the ORIGINAL root message and reuses its subject — real thread continuity, not a fresh chain each time', async () => {
  const runtimeRows = [baseRuntime({
    emailThreadMessageId: '<root@x>', emailThreadSubject: 'Acme — I\'m awake and getting to work',
  })];
  let capturedThread = null;
  let capturedSubject = null;
  const sendEmail = async (args) => {
    capturedThread = args.thread;
    capturedSubject = args.vars.subject;
    return { ok: true, messageId: '<second-send@x>' };
  };
  await notifyOwnerByEmail(
    { prisma: prismaWith({ runtimeRows }), runtime: runtimeRows[0], kind: 'popup', title: 'Approval required', summary: 'Needs a decision.' },
    { sendEmail },
  );
  assert.deepEqual(capturedThread, { inReplyTo: '<root@x>' });
  assert.equal(capturedSubject, 'Acme — I\'m awake and getting to work');
  // The root Message-ID must never be overwritten by a later send's id.
  assert.equal(runtimeRows[0].emailThreadMessageId, '<root@x>');
  assert.equal(runtimeRows[0].emailThreadSentCount, 1);
});

test('a failed send still never throws out of notifyOwnerByEmail', async () => {
  const sendEmail = async () => { throw new Error('network down'); };
  const result = await notifyOwnerByEmail(
    { prisma: prismaWith(), runtime: baseRuntime(), kind: 'popup', title: 'x', summary: 'y' },
    { sendEmail },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'network down');
});

test('an approval_required popup with run_id/gate mints an approval token and uses the WITH-BUTTON template', async () => {
  const runtimeRows = [baseRuntime()];
  let sentTemplateId = null; let sentVars = null;
  const sendEmail = async (args) => { sentTemplateId = args.templateId; sentVars = args.vars; return { ok: true, messageId: '<m@x>' }; };
  const mintApprovalToken = async ({ runId, gate }) => (runId === 'run-1' && gate === 'outbound_messages' ? 'minted-token-abc' : null);
  await notifyOwnerByEmail(
    {
      prisma: prismaWith({ runtimeRows }), runtime: runtimeRows[0], kind: 'popup',
      title: 'Approval required: Qualify outreach prospects', summary: 'Needs a decision.',
      details: { run_id: 'run-1', gate: 'outbound_messages' },
    },
    { sendEmail, mintApprovalToken },
  );
  assert.equal(sentTemplateId, 'runtime_persona_approval_update');
  assert.equal(sentVars.approveUrl, 'https://next.singulancelabs.com/hivemind/approve/minted-token-abc');
});

test('a popup with no run_id/gate (capability_required, decision_required) never gets a button — falls back to the plain template', async () => {
  let sentTemplateId = null; let sentVars = null;
  const sendEmail = async (args) => { sentTemplateId = args.templateId; sentVars = args.vars; return { ok: true, messageId: '<m@x>' }; };
  const mintApprovalToken = async () => { throw new Error('must never be called without run_id/gate'); };
  await notifyOwnerByEmail(
    { prisma: prismaWith(), runtime: baseRuntime(), kind: 'popup', title: 'x', summary: 'y', details: { provider: 'x' } },
    { sendEmail, mintApprovalToken },
  );
  assert.equal(sentTemplateId, 'runtime_persona_update');
  assert.equal(sentVars.approveUrl, undefined);
});

test('a failed token mint falls back to the plain template rather than sending a dead button', async () => {
  let sentTemplateId = null;
  const sendEmail = async (args) => { sentTemplateId = args.templateId; return { ok: true, messageId: '<m@x>' }; };
  const mintApprovalToken = async () => null;
  await notifyOwnerByEmail(
    { prisma: prismaWith(), runtime: baseRuntime(), kind: 'popup', title: 'x', summary: 'y', details: { run_id: 'run-1', gate: 'outbound_messages' } },
    { sendEmail, mintApprovalToken },
  );
  assert.equal(sentTemplateId, 'runtime_persona_update');
});

test('activation and growth_plan kinds never attempt to mint an approval token, even if details were somehow passed', async () => {
  const mintApprovalToken = async () => { throw new Error('must never be called for a non-popup kind'); };
  const sendEmail = async () => ({ ok: true, messageId: '<m@x>' });
  await notifyOwnerByEmail(
    { prisma: prismaWith(), runtime: baseRuntime(), kind: 'activation', details: { run_id: 'run-1', gate: 'outbound_messages' } },
    { sendEmail, mintApprovalToken },
  );
});

test('missing prisma/runtime never throws', async () => {
  assert.deepEqual((await notifyOwnerByEmail({ prisma: null, runtime: null, kind: 'activation' })), { ok: false, skipped: true, error: 'missing_args' });
});
