import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchTool, findDirectEntityEdges, findExplicitRelationClaims } from '../../src/agent/tool-registry.js';
import { createDraftApprovalMiddleware } from '../../src/agent/middleware/draft-approval.js';
import { McpClientPool } from '../../src/agent/mcp-client-pool.js';
import { RecallRouter } from '../../src/memory/recall-router.js';

const authCtx = {
  userId: '11111111-1111-1111-1111-111111111111',
  orgId: '22222222-2222-2222-2222-222222222222',
  accessContext: { projectIds: ['33333333-3333-3333-3333-333333333333'], teamIds: [] },
};

test('memory-by-id tools use scoped lookup and correct mutation signatures', async () => {
  const calls = [];
  const store = {
    getMemory() { throw new Error('unscoped getMemory must not be used'); },
    async getMemoryScoped(id, scope) {
      calls.push(['get', id, scope]);
      return id === 'allowed' ? { id, title: 'Scoped', content: 'secret', tags: [] } : null;
    },
    async deleteMemory(id) { calls.push(['delete', id]); },
  };
  const ctx = {
    ...authCtx,
    persistentMemoryStore: store,
    persistentMemoryEngine: {
      async ingestMemory(payload) {
        calls.push(['ingest-update', payload]);
        return { memoryId: 'replacement', operation: 'updated' };
      },
    },
  };

  const denied = await dispatchTool('hivemind_get_memory', { id: 'denied' }, ctx);
  assert.deepEqual(denied, { found: false });
  const allowed = await dispatchTool('hivemind_get_memory', { id: 'allowed' }, ctx);
  assert.equal(allowed.content, 'secret');

  const updated = await dispatchTool('hivemind_update_memory', { id: 'allowed', content: 'new' }, ctx);
  assert.equal(updated.updated, true);
  assert.equal(updated.id, 'replacement');
  const updatePayload = calls.find((call) => call[0] === 'ingest-update')[1];
  assert.deepEqual(updatePayload.relationship, { type: 'Updates', target_id: 'allowed', confidence: 1 });
  assert.equal(updatePayload._authorized_relationship, true);

  const refusedDelete = await dispatchTool('hivemind_delete_memory', { id: 'allowed' }, ctx);
  assert.equal(refusedDelete.deleted, false);
  assert.equal(refusedDelete.error, 'explicit_delete_confirmation_required');
  const deleted = await dispatchTool('hivemind_delete_memory', { id: 'allowed', _approval_token: 'approved' }, { ...ctx, _approvalFlow: true });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(calls.find((call) => call[0] === 'delete'), ['delete', 'allowed']);
});

test('query update resolves an exact authorized tag before semantic recall', async () => {
  const projectId = authCtx.accessContext.projectIds[0];
  let lookupWhere;
  let updatedPayload;
  const memory = {
    id: 'exact-memory', title: 'Launch date', content: 'Old', tags: ['SECURITY_E2E'],
    is_latest: true, scope: 'project', project_ids: [projectId], memory_type: 'fact',
  };
  const ctx = {
    ...authCtx,
    prisma: {
      memory: {
        async findMany({ where }) { lookupWhere = where; return [{ id: memory.id }]; },
      },
    },
    persistentMemoryStore: {
      async getMemoryScoped(id) { return id === memory.id ? memory : null; },
    },
    persistentMemoryEngine: {
      async ingestMemory(payload) { updatedPayload = payload; return { memoryId: 'successor' }; },
    },
  };
  const result = await dispatchTool('hivemind_update_memory', {
    target_query: 'SECURITY_E2E', content: 'New', project_id: projectId,
  }, ctx);
  assert.equal(result.updated, true);
  assert.equal(result.deprecated_id, memory.id);
  assert.equal(lookupWhere.scope, 'project');
  assert.deepEqual(lookupWhere.memoryProjects, { some: { projectId } });
  assert.deepEqual(updatedPayload.relationship, { type: 'Updates', target_id: memory.id, confidence: 1 });
});

test('verified relationships require distinct endpoints bound to different requested entities', () => {
  const entities = ['SolvisPia', 'SolvisMax'];
  const bindings = new Map([
    ['SolvisPia', new Set(['pia-fact', 'shared-memory'])],
    ['SolvisMax', new Set(['max-fact', 'shared-memory'])],
  ]);
  const edges = [
    { from_id: 'shared-memory', to_id: 'unrelated', type: 'Extends' },
    { from_id: 'shared-memory', to_id: 'shared-memory', type: 'Mentions' },
    { from_id: 'pia-fact', to_id: 'max-fact', type: 'Extends' },
  ];
  assert.deepEqual(findDirectEntityEdges(edges, entities, bindings), [edges[2]]);
});

test('relation claims distinguish explicit assertions from mere co-mentions and normalize legacy metadata', () => {
  const rows = [
    { id: 'profile', content: 'User name: Amar Sai Gadde' },
    { id: 'claim', title: { text: 'legacy title' }, content: 'I want to meet Kruti tomorrow.', tags: ['provenance:user-assertion'], source_metadata: { metadata: { entities: ['Kruti'] } } },
    { id: 'noise', content: 'Amar and Kruti appear in this attendee list.' },
  ];
  const claims = findExplicitRelationClaims(rows, ['Amar', 'Kruti'], { requesterProfile: 'Name: Amar Sai Gadde' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].type, 'explicit_user_claim');
  assert.equal(claims[0].resolved_first_person, true);
  assert.equal(claims[0].citation_status, 'user_assertion');
});

test('save refuses a caller project outside the authorized project set', async () => {
  const result = await dispatchTool('hivemind_save_memory', {
    title: 'Fact', content: 'A sufficiently detailed durable fact for a project.',
    tags: ['entity:Fact', 'topic:test'],
    project_id: '44444444-4444-4444-4444-444444444444',
  }, {
    ...authCtx,
    persistentMemoryEngine: {},
    buildRoutedIngestPayloads: async () => [],
  });
  assert.equal(result.saved, false);
  assert.equal(result.error, 'project_access_denied');
});

test('save preserves user-assertion provenance for grounded synthesis', async () => {
  let persisted;
  const result = await dispatchTool('hivemind_save_memory', {
    title: 'A user-authored note about Kruti',
    content: 'The user recorded an assertion about Kruti.',
    tags: ['entity:kruti'],
    _memory_admission: 'user_assertion',
  }, {
    ...authCtx,
    persistentMemoryEngine: {},
    buildRoutedIngestPayloads: async (payload) => [payload],
    ingestRoutedPayload: async (payload) => {
      persisted = payload;
      return { memoryId: 'assertion-memory' };
    },
  });
  assert.equal(result.saved, true);
  assert.equal(persisted.source_metadata.metadata.memory_admission, 'user_assertion');
  assert.ok(persisted.tags.includes('provenance:user-assertion'));
});

test('recall rejects an inaccessible request project before touching storage', async () => {
  let touched = false;
  const router = new RecallRouter({
    persistentMemoryStore: { searchMemories: async () => { touched = true; return []; } },
    evidenceRetrieval: null,
    prisma: null,
  });
  const result = await router.recall('private project', {}, {
    ...authCtx,
    projectId: '44444444-4444-4444-4444-444444444444',
  });
  assert.equal(result.trace.error, 'project_access_denied');
  assert.equal(touched, false);
});

test('draft approval token is bound to the active organisation', async () => {
  let executed = false;
  const middleware = createDraftApprovalMiddleware({
    prisma: {
      pendingWrite: {
        findUnique: async () => ({
          id: 'draft-1', status: 'approved', toolName: 'gmail_send_email',
          userId: authCtx.userId, orgId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        }),
      },
    },
  });
  const response = await middleware({
    tool_call: { tool: { name: 'gmail_send_email', groupName: 'gmail', readOnly: false, external: true } },
    args: { _approval_token: 'draft-1' },
    ctx: authCtx,
  }, async () => { executed = true; return { status: 'ok' }; });
  assert.equal(response.status, 'error');
  assert.equal(response.meta.error, 'invalid_approval_token');
  assert.equal(executed, false);
});

test('external draft is expiry/hash/group bound and atomically single-use', async () => {
  let row;
  let claims = 0;
  let executions = 0;
  const prisma = {
    pendingWrite: {
      async create({ data }) {
        row = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', ...data };
        return row;
      },
      async findUnique() { return { ...row, status: 'approved' }; },
      async updateMany() { claims++; return { count: claims === 1 ? 1 : 0 }; },
      async update() { return row; },
    },
  };
  const middleware = createDraftApprovalMiddleware({ prisma });
  const tool = { name: 'gmail_send_email', groupName: 'gmail', readOnly: false, external: true };
  const args = { to: 'lea@example.com', subject: 'Report', body: 'Attached.' };
  const draft = await middleware({ tool_call: { tool }, args, ctx: authCtx }, async () => {
    throw new Error('draft must not execute');
  });
  assert.equal(draft.status, 'draft_created');
  assert.equal(row.orgId, authCtx.orgId);
  assert.equal(row.toolGroup, 'gmail');
  assert.equal(row.argsHash.length, 64);
  assert.ok(new Date(row.expiresAt).getTime() > Date.now());

  const approvedArgs = { ...args, _approval_token: row.id };
  const first = await middleware({ tool_call: { tool }, args: approvedArgs, ctx: authCtx }, async () => {
    executions++;
    return { status: 'ok', meta: { raw: { sent: true } } };
  });
  assert.equal(first.status, 'ok');
  const replay = await middleware({ tool_call: { tool }, args: approvedArgs, ctx: authCtx }, async () => {
    executions++;
    return { status: 'ok' };
  });
  assert.equal(replay.status, 'error');
  assert.equal(executions, 1);
});

test('MCP connector cache identity includes organisation', () => {
  const pool = new McpClientPool({ prisma: {} });
  assert.notEqual(
    pool._cacheKey('user', 'org-a', 'notion'),
    pool._cacheKey('user', 'org-b', 'notion'),
  );
});

test('entity aggregation counts distinct products only after complete scoped coverage', async () => {
  const entityCalls = [];
  const prisma = {
    entity: {
      findMany: async ({ where }) => {
        entityCalls.push(where);
        if (!where.entityType) return [{ id: 'parent-1', canonicalName: 'Solvis' }];
        return [
          { id: 'product-1', canonicalName: 'SolvisPia', aliases: [] },
          { id: 'product-2', canonicalName: 'SolvisMax', aliases: [] },
        ];
      },
    },
    entityMention: {
      findMany: async () => [
        { documentId: 'doc-1', memoryId: null },
        { documentId: 'doc-2', memoryId: null },
      ],
    },
  };
  const result = await dispatchTool('hivemind_aggregate_entities', {
    parent_name: 'Solvis', entity_kind: 'products', limit: 100,
  }, { ...authCtx, projectId: authCtx.accessContext.projectIds[0], prisma });
  assert.equal(result.count, 2);
  assert.equal(result.entity_kind, 'product');
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.entities.map((entity) => entity.name), ['SolvisPia', 'SolvisMax']);
  assert.equal(entityCalls[1].orgId, authCtx.orgId);
  assert.equal(entityCalls[1].mentions.some.OR[0].documentId.in[0], 'doc-1');
});
