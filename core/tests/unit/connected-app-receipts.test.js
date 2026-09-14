import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  readConnectedAppReceipt,
  storeConnectedAppReceipt,
} from '../../src/harness-chat/connected-app-receipts.js';

const owner = {
  userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b',
  orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e',
};
const env = { HIVE_CONNECTED_APP_RECEIPT_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') };

function database() {
  const rows = new Map();
  const model = {
    findUnique: async ({ where }) => [...rows.values()].find((row) => row.sessionId === where.sessionId_callId.sessionId && row.callId === where.sessionId_callId.callId) || null,
    findFirst: async ({ where }) => [...rows.values()].find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
    create: async ({ data }) => { rows.set(data.id, structuredClone(data)); return structuredClone(data); },
    update: async ({ where, data }) => { Object.assign(rows.get(where.id), data); return structuredClone(rows.get(where.id)); },
  };
  const tx = { $executeRawUnsafe: async () => [], connectedAppReceipt: model };
  return { rows, prisma: { $transaction: async (action) => action(tx) } };
}

function input() {
  return {
    session_id: 'session-12345678', turn_id: 4, call_id: 'call-1', provider: 'composio',
    tool: 'GMAIL_FETCH_EMAILS', contract_version: 'schema-v1',
    raw_receipt: { sender: 'rama@example.com', messageText: 'private full body' },
    allowed_fields: ['sender', 'body'],
    approved_projection: { sender: 'rama@example.com', body: 'private full body' },
    projection_policy: 'selected-contract-v1',
  };
}

test('stores only authenticated ciphertext and reads an allowed projection', async () => {
  const db = database();
  const stored = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: input(), env });
  assert.equal(stored.contentBytes > 0, true);
  assert.equal(stored.ciphertext.includes(Buffer.from('private full body')), false);
  assert.equal(Object.hasOwn(stored, 'rawReceipt'), false);
  assert.equal(Object.hasOwn(stored, 'approvedProjection'), false);
  const result = await readConnectedAppReceipt({
    prisma: db.prisma, owner, receiptId: stored.id, sessionId: input().session_id,
    requestedFields: ['body'], env,
  });
  assert.deepEqual(result, { body: 'private full body' });
});

test('denies another session and any field outside the original projection', async () => {
  const db = database();
  const stored = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: input(), env });
  await assert.rejects(() => readConnectedAppReceipt({
    prisma: db.prisma, owner, receiptId: stored.id, sessionId: 'session-87654321',
    requestedFields: ['body'], env,
  }), /receipt_not_found/);
  await assert.rejects(() => readConnectedAppReceipt({
    prisma: db.prisma, owner, receiptId: stored.id, sessionId: input().session_id,
    requestedFields: ['headers'], env,
  }), /receipt_field_not_allowed/);
});

test('same call is idempotent and changed provider output conflicts', async () => {
  const db = database();
  const first = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: input(), env });
  const replay = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: input(), env });
  assert.equal(replay.id, first.id);
  await assert.rejects(() => storeConnectedAppReceipt({
    prisma: db.prisma, owner, input: { ...input(), raw_receipt: { changed: true } }, env,
  }), /receipt_call_conflict/);
});
