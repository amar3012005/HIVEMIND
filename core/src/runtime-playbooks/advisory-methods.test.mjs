import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdvisoryProposal, advisoryProposalHash, proposeAdvisoryMethod, readAdvisoryMethods, decideAdvisoryMethod } from './advisory-methods.js';
const principal = { orgId: 'org', userId: 'user', kind: 'human-session' };
const input = { method_id: 'company-research', prior_version: 0, rationale: 'Verified repeated identity ambiguity', evidence_refs: ['artifact:exact-id'],
  body: { title: 'Scoped research', description: 'A local identity method', content: 'Verify the entity first', domains: ['research'], intents: ['identity'], parentGlobalIds: ['global-research'], limitations: 'Only verified entities' } };
function fixture(role = 'admin') {
  const rows = []; const queries = []; let current = 0;
  const db = { userOrganization: { findUnique: async () => ({ role, isActive: true }) },
    $queryRawUnsafe: async (sql, ...args) => {
      queries.push({ sql, args });
      if (sql.startsWith('INSERT')) {
        let row = rows.find(r => r.organization_id === args[1] && r.content_hash === args[9]);
        if (!row) { row = { id: args[0], organization_id: args[1], proposed_by_user_id: args[2], method_id: args[3], prior_version: args[4], version: args[5], body: JSON.parse(args[6]), rationale: args[7], evidence_refs: JSON.parse(args[8]), content_hash: args[9], status: 'pending' }; rows.push(row); }
        return [row];
      }
      if (sql.includes('MAX(version)')) return [{ version: current }];
      if (sql.includes('pg_advisory')) {
        assert.match(sql, /\)::text AS lock_result$/, 'Prisma cannot deserialize PostgreSQL void results');
        return [{ lock_result: '' }];
      }
      if (sql.startsWith('UPDATE')) { const row = rows.find(r => r.organization_id === args[0] && r.id === args[1]); row.status = args[2]; row.approved_by_user_id = args[3]; if (row.status === 'approved') current = row.version; return [row]; }
      if (sql.includes('DISTINCT ON')) return rows.filter(r => r.organization_id === args[0] && r.status === 'approved');
      return rows.filter(r => r.organization_id === args[0] && r.id === args[1]);
    }, $transaction: async fn => fn(db) };
  return { db, rows, queries, setVersion: v => { current = v; } };
}
test('proposal exact-body hash binds tenant, proposer, prior version and evidence', () => {
  const p = normalizeAdvisoryProposal(input); const hash = advisoryProposalHash(principal, p);
  for (const [who, body] of [[{ ...principal, orgId: 'other' }, p], [{ ...principal, userId: 'other' }, p],
    [principal, { ...p, priorVersion: 1 }], [principal, { ...p, body: { ...p.body, content: 'Changed' } }]])
    assert.notEqual(advisoryProposalHash(who, body), hash);
  assert.throws(() => normalizeAdvisoryProposal({ ...input, method_id: 'global-research' }));
  assert.throws(() => normalizeAdvisoryProposal({ ...input, evidence_refs: [] }), /evidence_required/);
});
test('pending preparation is durable and idempotent but cannot be loaded as approved', async () => {
  const f = fixture(); const row = await proposeAdvisoryMethod(f.db, principal, input);
  assert.equal((await proposeAdvisoryMethod(f.db, principal, input)).id, row.id);
  assert.deepEqual(await readAdvisoryMethods(f.db, principal), []);
  assert.equal(f.rows.length, 1); assert.equal(f.rows[0].status, 'pending');
});
test('only a human organization administrator can approve; exact hash/version are enforced', async () => {
  const f = fixture(); const row = await proposeAdvisoryMethod(f.db, principal, input);
  await assert.rejects(decideAdvisoryMethod(f.db, principal, 'bad-id', row.content_hash, true), /invalid_id/);
  await assert.rejects(decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, 'approve'), /invalid_decision/);
  for (const kind of ['runner-service', 'api-key', undefined])
    await assert.rejects(decideAdvisoryMethod(f.db, { ...principal, kind }, row.id, row.content_hash, true), /human_session/);
  await assert.rejects(decideAdvisoryMethod(fixture('member').db, principal, row.id, row.content_hash, true), /not_authorized/);
  await assert.rejects(decideAdvisoryMethod(f.db, principal, row.id, 'changed', true), /hash_mismatch/);
  f.setVersion(1); await assert.rejects(decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, true), /prior_version_conflict/);
  assert.equal(row.status, 'pending'); f.setVersion(0);
  await decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, true);
  assert.equal((await readAdvisoryMethods(f.db, principal))[0].version, 1);
  assert.equal(row.approved_by_user_id, principal.userId);
  assert.equal((await decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, true)).status, 'approved');
  await assert.rejects(decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, false), /already_decided/);
  assert.ok(f.queries.some(q => q.sql.includes('pg_advisory_xact_lock')));
});
test('tenant reads and approval cannot retrieve another tenant proposal; rejection remains unpublished', async () => {
  const f = fixture(); const row = await proposeAdvisoryMethod(f.db, principal, input);
  assert.equal(await readAdvisoryMethods(f.db, { ...principal, orgId: 'other' }, row.id), null);
  await assert.rejects(decideAdvisoryMethod(f.db, { ...principal, orgId: 'other' }, row.id, row.content_hash, true), /not_found/);
  await decideAdvisoryMethod(f.db, principal, row.id, row.content_hash, false);
  assert.deepEqual(await readAdvisoryMethods(f.db, principal), []);
});
