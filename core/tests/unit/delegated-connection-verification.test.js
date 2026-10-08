import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDelegatedConnection } from '../../src/harness-chat/delegated-connection-verification.js';

function fixture() {
  const claims = { operating_role: 'runtime', operating_session: 'chief', org_id: 'org', sub: 'human' };
  const input = { session_id: 'employee', router_session_id: 'router', toolkits: ['googlesheets'] };
  const witness = { type: 'hivemind/composio-session', data: { subject: 'hivemind:human', routerSessionId: 'router' } };
  const rows = [{ toolkit: 'googlesheets', status: 'ACTIVE' }];
  const calls = [];
  const db = { harnessSession: { findFirst: async () => ({ id: 'employee' }) },
    harnessSessionEvent: { findFirst: async () => ({ payload: witness }) } };
  const args = { db, claims, input, runtime: async () => {}, storage: async (_db, principal) => principal,
    accounts: async (...values) => { calls.push(values); return rows; }, now: () => new Date('2026-10-08T00:00:00Z') };
  return { args, claims, input, witness, rows, calls, db };
}
test('requires fresh matching provider ACTIVE state, never browser flags', async () => {
  const f = fixture(); const result = await verifyDelegatedConnection(f.args);
  assert.equal(result.verified, true); assert.deepEqual(f.calls, [['org', 'human', 'hivemind:human']]);
  assert.equal(result.evidence, 'fresh-provider-account-state');
});
test('disconnected, expired and unrelated accounts cannot resume', async () => {
  for (const status of ['INITIATED', 'EXPIRED', 'FAILED']) {
    const f = fixture(); f.rows[0].status = status; assert.equal((await verifyDelegatedConnection(f.args)).verified, false);
  }
  const f = fixture(); f.rows[0].toolkit = 'slack'; assert.equal((await verifyDelegatedConnection(f.args)).verified, false);
});
test('every required toolkit needs its own active account', async () => {
  const f = fixture(); f.input.toolkits.push('slack'); assert.equal((await verifyDelegatedConnection(f.args)).verified, false);
});
test('rejects employee calls and revoked Runtime authority before provider access', async () => {
  const f = fixture(); f.claims.operating_role = 'employee';
  await assert.rejects(verifyDelegatedConnection(f.args), /runtime_authority_required/); assert.equal(f.calls.length, 0);
  f.claims.operating_role = 'runtime'; f.args.runtime = async () => { throw Error('revoked'); };
  await assert.rejects(verifyDelegatedConnection(f.args), /revoked/); assert.equal(f.calls.length, 0);
});
test('rejects another actor account and changed router session', async () => {
  const f = fixture(); f.witness.data.subject = 'hivemind:other';
  await assert.rejects(verifyDelegatedConnection(f.args), /connection_actor_scope_mismatch/); assert.equal(f.calls.length, 0);
  f.witness.data.subject = 'hivemind:human'; f.witness.data.routerSessionId = 'other';
  await assert.rejects(verifyDelegatedConnection(f.args), /connection_session_witness_required/);
});
test('legacy organization scope requires the exact saved subject witness', async () => {
  const f = fixture(); f.witness.data.subject = 'org'; await verifyDelegatedConnection(f.args);
  assert.deepEqual(f.calls, [['org', 'human', 'org']]);
});
test('foreign, archived or missing room is rejected', async () => {
  const f = fixture(); f.db.harnessSession.findFirst = async () => null;
  await assert.rejects(verifyDelegatedConnection(f.args), /employee_session_not_authorized/); assert.equal(f.calls.length, 0);
});
test('caller cannot submit success flag or choose credential subject', async () => {
  const f = fixture(); f.input.connected = true;
  await assert.rejects(verifyDelegatedConnection(f.args), /invalid_connection_verification/); assert.equal(f.calls.length, 0);
});
