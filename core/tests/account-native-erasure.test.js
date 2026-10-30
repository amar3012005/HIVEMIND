import test from 'node:test';
import assert from 'node:assert/strict';
import { eraseNativeAccount, nativeErasureRequest } from '../src/security/account-native-erasure.js';

const operationId = '11111111-1111-4111-8111-111111111111', workerId = '22222222-2222-4222-8222-222222222222';
const scope = { organizations: [{ orgId: 'org-a', disposition: 'delete_exclusive', storageMode: 'managed', remainingMembers: [] }] };
const withEnv = async run => {
  const before = [process.env.ACCOUNT_ERASURE_NATIVE_URL, process.env.ACCOUNT_ERASURE_NATIVE_TOKEN];
  process.env.ACCOUNT_ERASURE_NATIVE_URL = 'https://controller.example/v1/account-erasure'; process.env.ACCOUNT_ERASURE_NATIVE_TOKEN = 't'.repeat(40);
  try { return await run(); } finally { [process.env.ACCOUNT_ERASURE_NATIVE_URL, process.env.ACCOUNT_ERASURE_NATIVE_TOKEN] = before; if (before[0] === undefined) { delete process.env.ACCOUNT_ERASURE_NATIVE_URL; delete process.env.ACCOUNT_ERASURE_NATIVE_TOKEN; } }
};

test('the request states the account and its organizations (contract 2) without private ownership details', () => {
  assert.deepEqual(nativeErasureRequest({ operationId, workerId, userId: 'user-a', scope }),
    { contract: 2, operationId, workerId, userId: 'user-a', organizations: [{ orgId: 'org-a', disposition: 'delete_exclusive' }] });
  // Without a snapshot the request is the earlier contract, which the controller answers from its own copy of the operation.
  assert.deepEqual(nativeErasureRequest({ operationId, workerId }), { operationId, workerId });
  assert.deepEqual(nativeErasureRequest({ operationId, workerId, userId: 'user-a', scope: {} }), { operationId, workerId });
});

test('the receipt Core checks is unchanged: a contract 1 receipt and a contract 2 receipt are both accepted', async () => {
  const receipt = { verified: true, userId: 'user-a', operationId, credentialsRemoved: true, nativeRecordsRemoved: true, computersRemoved: true };
  const sent = [];
  const fetcher = reply => async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(reply), { status: 200 }); };
  await withEnv(async () => {
    assert.deepEqual(await eraseNativeAccount({ operationId, workerId, userId: 'user-a', scope }, fetcher({ ...receipt, contract: 2 })), { ...receipt, contract: 2 });
    assert.deepEqual(await eraseNativeAccount({ operationId, workerId, userId: 'user-a', scope }, fetcher(receipt)), receipt);
    assert.equal(sent[0].contract, 2);
    await assert.rejects(eraseNativeAccount({ operationId, workerId, userId: 'user-a', scope }, fetcher({ ...receipt, computersRemoved: false })), /Native cleanup is not verified/);
    await assert.rejects(eraseNativeAccount({ operationId, workerId, userId: 'user-a', scope }, fetcher({ ...receipt, operationId: '33333333-3333-4333-8333-333333333333' })), /not verified/);
  });
});
