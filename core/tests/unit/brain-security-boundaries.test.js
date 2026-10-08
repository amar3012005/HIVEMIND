import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSecret, dsrMemoryWhere, dsrAuditWhere, requireDsrTargetMembership } from '../../src/security/brain-boundaries.js';
import { checkedVectorDelete } from '../../src/security/vector-erasure.js';

test('administrative DSR cannot select personal or another organization records', () => {
  assert.deepEqual(dsrMemoryWhere({ userId: 'target', orgId: 'A', self: false }), { userId: 'target', orgId: 'A', scope: 'organization', deletedAt: null });
  assert.deepEqual(dsrAuditWhere({ userId: 'target', orgId: 'A', self: false }), { userId: 'target', organizationId: 'A' });
});
test('self DSR retains personal ownership', () => assert.deepEqual(dsrMemoryWhere({ userId: 'self', orgId: 'A', self: true }), { userId: 'self', deletedAt: null }));
test('target membership is server checked and inactive targets are denied', async () => {
  let query;
  const prisma = { userOrganization: { findFirst: async q => { query = q; return null; } } };
  assert.equal(await requireDsrTargetMembership(prisma, { userId: 'target', orgId: 'A', self: false }), false);
  assert.deepEqual(query.where, { userId: 'target', orgId: 'A', isActive: true });
});
test('missing, short and known default credentials fail closed', () => {
  for (const value of [undefined, '', 'short', 'default-dev-key-change-in-production-32b', 'default-mcp-secret-key-change-in-production']) assert.throws(() => requiredSecret(value, 'test'), { code: 'SECRET_UNAVAILABLE' });
  assert.equal(requiredSecret('x'.repeat(32), 'test'), 'x'.repeat(32));
});
test('vector erasure rejects remote error, pending and invalid completion', async () => {
  for (const response of [{ ok: false, status: 500 }, { ok: true, status: 200, json: async () => ({ status: 'ok', result: { status: 'acknowledged' } }) }, { ok: true, status: 200, json: async () => ({ status: 'error' }) }]) {
    await assert.rejects(checkedVectorDelete(async () => response, 'https://fixture.invalid', {}), { code: 'VECTOR_ERASURE_INCOMPLETE' });
  }
});
test('completed and already absent vectors are accepted', async () => {
  await checkedVectorDelete(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', result: { status: 'completed' } }) }), 'https://fixture.invalid', {});
  await checkedVectorDelete(async () => ({ status: 404 }), 'https://fixture.invalid', {});
});

import { readFileSync } from 'node:fs';
test('document evidence fails closed without access context or authorized project', () => {
  const source = readFileSync(new URL('../../src/knowledge/evidence-retrieval.js', import.meta.url), 'utf8');
  const start = source.indexOf('  _accessibleDocumentWhere(');
  const end = source.indexOf('\n  _orderAndSlice(', start);
  const Query = new Function(`return class { ${source.slice(start, end)} }`)();
  const query = new Query();
  const where = query._accessibleDocumentWhere({ userId: 'u', orgId: 'A' });
  assert.equal(where.OR.some(clause => clause.tags?.hasSome), false);
  assert.deepEqual(query._accessibleDocumentWhere({ userId: 'u', orgId: 'A', projectId: 'unauthorized' }).id, { in: [] });
  assert.deepEqual(query._accessibleDocumentWhere({ userId: 'u', orgId: 'A', scopeFilter: 'organization' }).id, { in: [] });
  assert.ok(query._accessibleDocumentWhere({ userId: 'u', orgId: 'A', accessContext: { orgRole: 'member', projectIds: ['P'] }, projectId: 'P' }).tags.has.endsWith(':P'));
});
test('MCP absent-scope entrypoints reject instead of granting wildcard', () => {
  const hosted = readFileSync(new URL('../../src/mcp/hosted-service.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  assert.ok(hosted.includes("error: 'explicit_scopes_required'"));
  assert.ok(hosted.includes('if (!options.isMaster && scopes.length === 0) return []'));
  assert.ok(!hosted.includes("connection.scopes || ['*']"));
  assert.ok(!server.includes("connection?.scopes || ['*']"));
  assert.ok(!hosted.includes('scopes.length === 0 || hasAll'));
});
