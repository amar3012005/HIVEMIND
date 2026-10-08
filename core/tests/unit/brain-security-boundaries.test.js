import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredSecret, dsrMemoryWhere, dsrAuditWhere, requireDsrTargetMembership } from '../../src/security/brain-boundaries.js';
import { checkedVectorDelete } from '../../src/security/vector-erasure.js';

test('administrative DSR cannot select personal or another organization records', () => {
  assert.deepEqual(dsrMemoryWhere({ userId: 'target', orgId: 'A', self: false }), { userId: 'target', orgId: 'A', scope: 'organization', deletedAt: null });
  assert.deepEqual(dsrAuditWhere({ userId: 'target', orgId: 'A', self: false }), { userId: 'target', organizationId: 'A' });
});
test('self DSR retains personal ownership', () => assert.deepEqual(dsrMemoryWhere({ userId: 'self', orgId: 'A', self: true }), { userId: 'self', scope: 'personal', deletedAt: null }));
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
test('account erasure never disables shared table triggers', () => {
  const source = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function performAccountDeletion'), source.indexOf('async function validateAccountDeletion'));
  assert.ok(!body.includes('DISABLE TRIGGER'));
  assert.ok(body.indexOf('await purgeUserVectors') < body.indexOf('prisma.memory.deleteMany'));
});

import { collectOwnedRecords, exportAccountRecords } from '../../src/security/account-export.js';
test('export pages beyond a single batch without truncation and enforces byte bound', async () => {
  const rows = [{ id: '1', content: 'first' }, { id: '2', content: 'second' }, { id: '3', content: 'third' }];
  const model = { findMany: async q => rows.slice(q.cursor ? rows.findIndex(r => r.id === q.cursor.id) + 1 : 0, (q.cursor ? rows.findIndex(r => r.id === q.cursor.id) + 1 : 0) + q.take) };
  assert.deepEqual(await collectOwnedRecords(model, { where: { userId: 'self' } }, { batchSize: 2 }), rows);
  await assert.rejects(collectOwnedRecords(model, {}, { maxBytes: 1 }), { status: 413 });
});
test('account export uses owner predicates, personal native sessions, and excludes credentials', async () => {
  const calls = [];
  const prisma = { user: { findUnique: async () => ({ id: 'self', email: 'fixture@example.invalid' }) } };
  for (const name of ['memory','knowledgeDocument','knowledgeSegment','userProfile','platformIntegration','harnessSession','harnessSessionEvent','auditLog']) prisma[name] = { findMany: async q => { calls.push({ name, query: q }); return []; } };
  const result = await exportAccountRecords(prisma, 'self');
  for (const { name, query } of calls) assert.equal(name === 'knowledgeSegment' ? query.where.document.userId : query.where.userId, 'self');
  assert.equal(calls.find(c => c.name === 'harnessSession').query.where.scopeKind, 'personal');
  assert.equal(calls.find(c => c.name === 'harnessSessionEvent').query.where.session.scopeKind, 'personal');
  const connectorSelect = calls.find(c => c.name === 'platformIntegration').query.select;
  assert.ok(!connectorSelect.accessTokenEncrypted && !connectorSelect.refreshTokenEncrypted && !connectorSelect.webhookSecretEncrypted);
  assert.equal(result.completeness, 'listed_record_categories');
  assert.ok(result.excluded.includes('original_file_bytes'));
});
test('personal export excludes organization/project documents even when uploaded by requester', async () => {
  const queries = [];
  const prisma = { user: { findUnique: async () => ({ id: 'self' }) } };
  for (const name of ['memory','knowledgeSegment','userProfile','platformIntegration','harnessSession','harnessSessionEvent','auditLog']) prisma[name] = { findMany: async q => { queries.push({ name, q }); return []; } };
  prisma.knowledgeDocument = { findMany: async () => [{ id: 'personal', tags: ['scope-key:personal:self'] }, { id: 'org', tags: ['scope-key:org:A'] }, { id: 'project', tags: ['scope-key:project:P'] }, { id: 'legacy', tags: [] }, { id: 'mixed', tags: ['scope-key:personal:self', 'scope-key:org:A'] }] };
  const result = await exportAccountRecords(prisma, 'self');
  assert.deepEqual(result.documents.map(r => r.id), ['personal']);
  assert.equal(queries.find(x => x.name === 'memory').q.where.scope, 'personal');
  assert.deepEqual(queries.find(x => x.name === 'knowledgeSegment').q.where.documentId.in, ['personal']);
  assert.equal(queries.find(x => x.name === 'auditLog').q.where.organizationId, null);
});

test('actual DSR handlers deny cross-org target and preserve personal data on admin erasure', async () => {
  const source = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const handlers = source.slice(source.indexOf('  // ── DSR:'), source.indexOf('  // ─── End Audit + DSR'));
  const invoke = new Function('deps', `return async function(req,res,pathname) { const { requireSession, requireOrgAdmin, requireDsrTargetMembership, dsrMemoryWhere, dsrAuditWhere, prisma, audit, _reqMeta, jsonResponse, CONFIG, collectOwnedRecords } = deps; ${handlers} }`);
  const actor = '00000000-0000-0000-0000-000000000001';
  const same = '00000000-0000-0000-0000-000000000002';
  const other = '00000000-0000-0000-0000-000000000003';
  const records = [{ id: 'personal', userId: same, orgId: 'A', scope: 'personal', deletedAt: null }, { id: 'organization', userId: same, orgId: 'A', scope: 'organization', deletedAt: null }, { id: 'another-org', userId: same, orgId: 'B', scope: 'organization', deletedAt: null }];
  const match = (row, where) => Object.entries(where).every(([key,value]) => row[key] === value);
  const prisma = {
    userOrganization: { findFirst: async ({ where }) => where.userId === same && where.orgId === 'A' && where.isActive ? { userId: same } : null },
    memory: { findMany: async ({ where }) => records.filter(row => match(row, where)), updateMany: async ({ where, data }) => { const rows = records.filter(row => match(row, where)); rows.forEach(row => Object.assign(row,data)); return { count: rows.length }; } },
    auditLog: { findMany: async () => [] },
  };
  const handler = invoke({ prisma, requireSession: async () => ({ session: { userId: actor, orgId: 'A' } }), requireOrgAdmin: async () => ({ role: 'admin' }), requireDsrTargetMembership, dsrMemoryWhere, dsrAuditWhere, audit: () => {}, _reqMeta: () => ({}), jsonResponse: (res,body,status=200) => Object.assign(res,{ body,status }), CONFIG: { allowedOrigins: ['https://fixture.invalid'] }, collectOwnedRecords });
  const denied = {};
  await handler({ method: 'GET', headers: {} }, denied, `/v1/dsr/user/${other}/export`);
  assert.equal(denied.status,404);
  const exported = {};
  await handler({ method: 'GET', headers: {} }, exported, `/v1/dsr/user/${same}/export`);
  assert.deepEqual(exported.body.memories.map(row => row.id), ['organization']);
  const badOrigin = {};
  await handler({ method: 'POST', headers: { origin: 'https://untrusted.invalid' } }, badOrigin, `/v1/dsr/user/${same}/erasure`);
  assert.equal(badOrigin.status,403);
  const erased = {};
  await handler({ method: 'POST', headers: { origin: 'https://fixture.invalid' } }, erased, `/v1/dsr/user/${same}/erasure`);
  assert.equal(erased.body.memories_soft_deleted,1);
  assert.equal(records.find(row => row.id === 'personal').deletedAt,null);
  assert.equal(records.find(row => row.id === 'another-org').deletedAt,null);
});
test('hosted connection issuance preserves only explicitly authenticated scopes', () => {
  const source = readFileSync(new URL('../../src/mcp/hosted-service.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildConnectionPayload(');
  const end = source.indexOf('\nfunction parseSignedConnectionToken',start);
  const build = new Function('CONFIG', `${source.slice(start,end)}; return buildConnectionPayload;`)({ connectionTtlMs: 1000 });
  assert.deepEqual(build('u','A','s',['memory:read']).scopes,['memory:read']);
  assert.deepEqual(build('u','A','s',undefined).scopes,[]);
  assert.ok(source.includes('scopes: Array.isArray(signedPayload.scopes) ? signedPayload.scopes : []'));
  assert.ok(source.includes('Buffer.byteLength(signature) !== Buffer.byteLength(expected)'));
  assert.ok(!source.includes("req.user?.orgId || req.headers['x-org-id']"));
});

 test('export query contract matches current Prisma schema', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const model = name => schema.split(`model ${name} {`)[1]?.split('\n}')[0];
  for (const name of ['User','Memory','KnowledgeDocument','KnowledgeSegment','UserProfile','PlatformIntegration','HarnessSession','HarnessSessionEvent','AuditLog']) assert.match(model(name) || '', /\bid\s+\w+\s+.*@id/);
  for (const field of ['displayName','avatarUrl','timezone','locale','createdAt','updatedAt']) assert.ok(model('User').split('\n').some(line => line.trim().startsWith(field + ' ')));
  assert.match(model('KnowledgeSegment'), /document\s+KnowledgeDocument\s+@relation/);
  assert.match(model('HarnessSessionEvent'), /session\s+HarnessSession\s+@relation/);
  assert.match(model('AuditLog'), /organizationId\s+String\?/);
});
 test('vector erase requests synchronous completion and avoids unsupported purge promises', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  assert.match(source, /points\/delete\?wait=true/);
  assert.doesNotMatch(source, /permanent purge after 30 days via retention cron/);
});

test('erasure preserves identity until durable source inventory is reconciled', async () => {
  const { requireReconciledSourceErasure } = await import('../../src/security/account-erasure-inventory.js');
  const queries = [];
  const database = count => Object.fromEntries(['knowledgeDocument','sourceArtifact','knowledgeIngestJob'].map(name => [name, { count: async query => { queries.push(query); return count; } }]));
  await assert.rejects(requireReconciledSourceErasure(database(1), 'self'), { code: 'SOURCE_ERASURE_RECONCILIATION_REQUIRED' });
  await requireReconciledSourceErasure(database(0), 'self');
  for (const query of queries) assert.deepEqual(query.where, { userId: 'self' });
});

test('original-file inventory admits only referenced personal sources without storage locations', async () => {
  const prisma = { user: { findUnique: async () => ({ id: 'self' }) } };
  for (const name of ['memory','knowledgeSegment','userProfile','platformIntegration','harnessSession','harnessSessionEvent','auditLog']) prisma[name] = { findMany: async () => [] };
  prisma.knowledgeDocument = { findMany: async () => [{ id: 'd', sourceArtifactId: 's', tags: ['scope-key:personal:self'] }] };
  let sourceQuery;
  prisma.sourceArtifact = { findMany: async query => { sourceQuery = query; return [{ id: 's', artifactType: 'upload', sizeBytes: 42n, documents: [{ tags: ['scope-key:personal:self'] }] }, { id: 'mixed', documents: [{ tags: ['scope-key:personal:self', 'scope-key:org:A'] }] }]; } };
  const result = await exportAccountRecords(prisma, 'self');
  assert.deepEqual(sourceQuery.where, { userId: 'self', id: { in: ['s'] }, documents: { every: { userId: 'self', tags: { has: 'scope-key:personal:self' } } } });
  assert.equal(sourceQuery.select.storageLocation, undefined);
  assert.equal(sourceQuery.select.payload, undefined);
  assert.equal(result.originalFileInventory[0].bytesIncluded, false);
  assert.equal(result.originalFileInventory[0].availability, 'not_verified');
  assert.equal(result.documents[0].sourceArtifactId, undefined);
  assert.equal(result.originalFileInventory.length, 1);
  assert.equal(result.originalFileInventory[0].documents, undefined);
});
