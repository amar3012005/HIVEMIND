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

// Native employee sessions must retain the same authenticated encrypted receipt contract.
test('native UUID sessions can store and read receipts without widening their owner scope', async () => {
  const db = database();
  const packet = { ...input(), session_id: '618703e8-3867-4bf9-ba71-1d6bd674dad5' };
  const stored = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: packet, env });
  const result = await readConnectedAppReceipt({ prisma: db.prisma, owner, receiptId: stored.id, sessionId: packet.session_id, requestedFields: ['sender'], env });
  assert.equal(result.sender, 'rama@example.com');
  await assert.rejects(() => readConnectedAppReceipt({ prisma: db.prisma, owner: { ...owner, userId: '3e10b102-8472-4c6b-8b60-c28179049932' }, receiptId: stored.id, sessionId: packet.session_id, requestedFields: ['sender'], env }), /receipt_not_found/);
});

test('denies the same user in another organization before decrypting the receipt', async () => {
  const db = database();
  const stored = await storeConnectedAppReceipt({ prisma: db.prisma, owner, input: input(), env });
  await assert.rejects(() => readConnectedAppReceipt({
    prisma: db.prisma, owner: { ...owner, orgId: '93a0d213-30e7-4d8e-b88a-6704f3ccf120' },
    receiptId: stored.id, sessionId: input().session_id, requestedFields: ['body'], env,
  }), /receipt_not_found/);
});

test('another admin reads only approved shared-room receipt fields without changing its original author',async()=>{
  const db=database(),sharedEnv={...env,HIVE_SHARED_ORGANIZATION_AGENTS_ENABLED:'true'};
  const b={...owner,userId:'64f5568b-4d6a-4ae1-9a33-48cb2909d59b'};
  const original=db.prisma.$transaction;
  db.prisma.$transaction=work=>original(tx=>work({...tx,$queryRawUnsafe:async(sql,...args)=> {
    if(sql.includes('set_config')) return [];
    if(sql.includes('organization_agent_storage_scope')) return [{storage_user_id:owner.userId,runtime_session_id:input().session_id}];
    if(sql.includes('FROM hivemind.harness_company_hq')) return [{session_id:input().session_id}];
    return args[0]===input().session_id?[{header:{},preset:'hivemind-hq'}]:[{header:{},preset:'hivemind-chat'}];
  }}));
  const stored=await storeConnectedAppReceipt({prisma:db.prisma,owner,input:input(),env});
  assert.deepEqual(await readConnectedAppReceipt({prisma:db.prisma,owner:b,receiptId:stored.id,sessionId:input().session_id,requestedFields:['body'],env:sharedEnv}),{body:'private full body'});
  assert.equal(db.rows.get(stored.id).userId,owner.userId);
  await assert.rejects(readConnectedAppReceipt({prisma:db.prisma,owner:b,receiptId:stored.id,sessionId:'session-privatebrain',requestedFields:['body'],env:sharedEnv}),/receipt_not_found/);
  await assert.rejects(readConnectedAppReceipt({prisma:db.prisma,owner:b,receiptId:stored.id,sessionId:input().session_id,requestedFields:['token'],env:sharedEnv}),/receipt_field_not_allowed/);
});
