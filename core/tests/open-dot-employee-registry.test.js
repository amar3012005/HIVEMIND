import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOpenDotEmployee, createOpenDotEmployee, verifyOpenDotBinding } from '../src/employees/open-dot-registry.js';
import { employeeCanDispatch, nativeLifecycle } from '../src/employees/native-lifecycle.js';

const employeeId = '11111111-1111-4111-8111-111111111111';
const principal = { userId: '22222222-2222-4222-8222-222222222222', orgId: '33333333-3333-4333-8333-333333333333' };

test('Open Dot creation is canonical, idempotent, and held in provisioning until verified binding', async () => {
  let row = null;
  const tx = { $queryRawUnsafe: async () => [], digitalEmployee: {
    findUnique: async () => row,
    create: async ({ data }) => { row = { ...data, archivedAt: null }; return row; },
  } };
  const db = { userOrganization: { findUnique: async () => ({ isActive: true, role: 'owner' }) }, $transaction: async fn => fn(tx) };
  const input = { operation: 'create', creation_key: 'creation-abc', name: 'Researcher',
    persona: 'Review evidence.', role: 'Analyst', avatar_url: 'https://example.com/avatar.png' };
  const first = await createOpenDotEmployee(db, principal, input);
  assert.equal(first.replayed, false);
  assert.equal(nativeLifecycle(first.employee).phase, 'provisioning');
  assert.equal(first.open_dot_employee.execution_state, 'pending');
  assert.equal(employeeCanDispatch(first.employee), false);
  assert.equal((await createOpenDotEmployee(db, principal, input)).replayed, true);
  await assert.rejects(createOpenDotEmployee(db, principal, { ...input, name: 'Different' }), /creation_key_content_conflict/);
  const nonAdminDb = { ...db, userOrganization: { findUnique: async () => ({ isActive: true, role: 'member' }) } };
  await assert.rejects(createOpenDotEmployee(nonAdminDb, principal, { ...input, creation_key: 'member-attempt' }), /administrator_membership_required/);
});

test('fixed Dot proof and adoption preserve the exact canonical employee identity and permissions', async () => {
  const row = { id: employeeId, orgId: principal.orgId, createdBy: principal.userId, name: 'Existing', slug: 'existing',
    persona: 'Keep this persona.', roleArchetype: 'Analyst', avatarUrl: 'https://example.com/avatar.png',
    status: 'active', archivedAt: null, tools: ['hivemind_recall'], enabledConnectors: ['existing-connector'],
    policyRules: { appearance: { seed: 'existing' }, native_lifecycle: { version: 1, phase: 'active', kind: 'durable', revision: 4, profile_revision: 2 } } };
  let saved;
  const tx = { $queryRawUnsafe: async sql => {
    if (sql.includes('information_schema.tables')) return [{ table_schema: 'public' }];
    if (sql.includes('pg_roles')) return [{ rolsuper: true, rolbypassrls: false }];
    return [];
  }, hyperAgentOperatingMemory: { findFirst: async () => null }, digitalEmployee: {
    findFirst: async ({ where }) => where.id === employeeId && where.orgId === principal.orgId ? row : null,
    update: async ({ data }) => { saved = data; Object.assign(row, data); return row; },
  } };
  const db = { userOrganization: { findUnique: async () => ({ isActive: true, role: 'admin' }) }, $transaction: async fn => fn(tx) };
  const returnedProof = { organizationId: principal.orgId, userId: principal.userId, employeeId, dotId: 'dot-existing', creationKey: 'adopt-abc' };
  let request;
  const proof = await verifyOpenDotBinding({ employeeId, creationKey: returnedProof.creationKey, principal,
    sessionCookie: 'session.id.signature', fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(returnedProof), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal(request.url, `https://dots.singulancelabs.com/api/hivemind/employees/${employeeId}/binding`);
  assert.deepEqual(Object.keys(request.options.headers).sort(), ['Accept','Cookie']);
  assert.equal(request.options.headers.Cookie, 'hm_cp_session=session.id.signature');
  assert.equal(request.options.redirect, 'error');
  const result = await bindOpenDotEmployee(db, principal, { operation: 'adopt', employee_id: employeeId,
    creation_key: proof.creationKey, expected_binding_revision: 0 }, { proof, now: 0 });
  assert.equal(result.open_dot_employee.state, 'bound');
  assert.equal(result.open_dot_employee.execution_state, 'pending');
  assert.equal(result.open_dot_employee.binding_revision, 1);
  const replay = await bindOpenDotEmployee(db, principal, { operation: 'adopt', employee_id: employeeId,
    creation_key: proof.creationKey, expected_binding_revision: 0 }, { proof, now: 0 });
  assert.equal(replay.replayed, true);
  await assert.rejects(bindOpenDotEmployee(db, principal, { operation: 'adopt', employee_id: employeeId,
    creation_key: proof.creationKey, expected_binding_revision: 1 }, { proof, now: 0 }), /open_dot_binding_revision_conflict/);
  assert.deepEqual(saved, { policyRules: { ...row.policyRules, open_dot_employee: result.open_dot_employee } });
  assert.equal(row.persona, 'Keep this persona.');
  assert.equal(row.avatarUrl, 'https://example.com/avatar.png');
  assert.deepEqual(row.tools, ['hivemind_recall']);
  assert.deepEqual(row.enabledConnectors, ['existing-connector']);
  assert.equal(employeeCanDispatch(row), false);
  await assert.rejects(bindOpenDotEmployee(db, principal, { operation: 'adopt', employee_id: employeeId,
    creation_key: 'different-key', expected_binding_revision: 0 }, { proof, now: 0 }), /open_dot_binding_unverified|open_dot_employee_already_bound/);
  await assert.rejects(verifyOpenDotBinding({ employeeId, creationKey: returnedProof.creationKey, principal,
    sessionCookie: 'session.id.signature', fetchImpl: async () => new Response(JSON.stringify({ ...returnedProof,
      userId: '44444444-4444-4444-8444-444444444444' }), { status: 200 }) }), /open_dot_binding_unverified/);
});
