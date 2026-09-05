import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { runDurableComposioAgent } from '../../src/agent/durable-composio-agent.js';
import { reconcileProgressiveApproval } from '../../src/agent/progressive-approval-events.js';

// Opt-in real local PostgreSQL integration. All model/provider calls are
// fixtures; this proves persistence/recovery, not external provider delivery.
// RUN_PROGRESSIVE_POSTGRES_TESTS=1 node --test core/tests/integration/progressive-harness-postgres.test.js
test('progressive harness persists, resumes and isolates runs in real PostgreSQL', { skip: process.env.RUN_PROGRESSIVE_POSTGRES_TESTS !== '1' }, async t => {
  const schema = `progressive_canary_${randomUUID().replaceAll('-', '')}`;
  const base = new URL(process.env.PROGRESSIVE_POSTGRES_URL || `postgresql://${encodeURIComponent(userInfo().username)}@localhost:5432/postgres?host=/tmp`);
  assert.ok(['localhost', '127.0.0.1'].includes(base.hostname), 'Only a local disposable PostgreSQL target is allowed');
  const admin = new PrismaClient({ datasources: { db: { url: base.toString() } } });
  base.searchParams.set('schema', schema);
  const connect = () => new PrismaClient({ datasources: { db: { url: base.toString() } } });
  const clients = [];
  const client = () => { const db = connect(); clients.push(db); return db; };
  const orgId = randomUUID();
  const userId = randomUUID();
  const prior = [process.env.USE_TOOLS_PROGRESSIVE_HARNESS, process.env.USE_TOOLS_PROGRESSIVE_HARNESS_ORGS];
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const db = client();
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".agent_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, user_id uuid NOT NULL,
      conversation_id varchar(160) NOT NULL, goal text NOT NULL, composio_session_id varchar(160),
      status varchar(32) NOT NULL DEFAULT 'running', steps jsonb NOT NULL DEFAULT '[]', scratch jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(org_id, conversation_id))`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".pending_writes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, org_id uuid,
      provider varchar(50) NOT NULL, tool_group varchar(120), tool_name varchar(120) NOT NULL,
      tool_args jsonb NOT NULL, args_hash varchar(64), project_id uuid, connection_id varchar(160),
      trace_id varchar(160), idempotency_key varchar(160) UNIQUE, expires_at timestamptz, preview text,
      status varchar(20) NOT NULL DEFAULT 'draft', result jsonb, error_msg text,
      created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, sent_at timestamptz)`);
    process.env.USE_TOOLS_PROGRESSIVE_HARNESS = 'true';
    process.env.USE_TOOLS_PROGRESSIVE_HARNESS_ORGS = orgId;
    const actions = (...items) => async () => items.shift() || { action: 'done', reason: 'Requested work complete' };
    const search = { action: 'search', query: 'find workspace page tools', reason: 'Discover capability' };
    const draft = { action: 'draft', slug: 'NOTION_CREATE_PAGE', reason: 'Prepare requested draft', outcome_ids: ['page'] };
    const execute = { action: 'execute', slug: 'NOTION_GET_PAGE', reason: 'Read requested page', outcome_ids: ['page'] };
    let providerCalls = 0;
    let releaseProvider;
    let providerEntered;
    let barrier = null;
    const composio = {
      listConnectedAccounts: async () => [{ toolkit: 'notion', status: 'ACTIVE' }],
      discoverSessionTools: async () => {
        const schemas = {
          NOTION_CREATE_PAGE: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required: ['title'] },
          NOTION_GET_PAGE: { type: 'object', additionalProperties: false, properties: {}, required: [] },
        };
        return { sessionId: 'fixture-session', workflowSessionId: 'fixture-workflow',
          tools: Object.entries(schemas).map(([slug, parameters]) => ({ type: 'function', function: { name: `composio_${slug.toLowerCase()}`, parameters }, _composio: { slug, toolkit: 'notion' } })),
          toolSchemas: Object.fromEntries(Object.entries(schemas).map(([slug, input_schema]) => [slug, { toolkit: 'notion', input_schema }])) };
      },
      executeToolsParallel: async (tenant, calls, options) => {
        assert.equal(tenant, orgId);
        assert.equal(options.allowDirectFallback, false);
        providerCalls += calls.length;
        providerEntered?.();
        if (barrier) await barrier;
        return calls.map(() => ({ successful: true, data: { title: 'Persisted fixture evidence' } }));
      },
    };
    const context = (prisma, threadId, kind = 'compose') => ({ prisma, orgId, userId, threadId,
      resolveHarnessIntent: async () => ({ kind, apps: ['notion'], person: '', use_case: 'work with workspace pages', known_fields: '', language: 'de', needs_memory: false,
        outcomes: [{ id: 'page', description: kind === 'compose' ? 'Create page' : 'Read page', kind: kind === 'compose' ? 'draft' : 'read' }] }),
      generateProgressiveToolInputs: async () => ({}),
      localizeProgressiveStatus: async text => text,
      reviewProgressiveArguments: async () => ({ valid: true, issues: [] }),
      synthesizeDurableAnswer: async () => 'Die Ergebnisse sind verfügbar.',
    });
    const first = await runDurableComposioAgent({ message: 'Erstelle eine Seite', prisma: db, composio,
      ctx: { ...context(db, 'pause-resume'), conversationHistory: [{ role: 'assistant', content: 'Current thread project briefing' }], chooseNextAction: actions(search, draft) } });
    assert.equal(first.status, 'needs_input', first.summary);
    assert.equal((await db.agentRun.findUnique({ where: { id: first.run.id } })).status, 'waiting_user');
    await db.$disconnect();
    const resumedDb = client();
    const resumeCtx = { ...context(resumedDb, 'pause-resume'), chooseNextAction: actions(draft) };
    const resumed = await runDurableComposioAgent({ message: 'Erstelle eine Seite', prisma: resumedDb, composio,
      ctx: resumeCtx, choice: { run_id: first.run.id, values: { title: 'Projektplan' } } });
    assert.equal(resumed.status, 'pending', resumed.summary);
    assert.equal(resumed.run.id, first.run.id);
    assert.deepEqual(resumed.run.scratch.conversation_context, [{ role: 'assistant', content: 'Current thread project briefing' }]);
    assert.equal(await resumedDb.pendingWrite.count(), 1);
    const replay = await runDurableComposioAgent({ message: 'Erstelle eine Seite', prisma: resumedDb, composio,
      ctx: resumeCtx, choice: { run_id: first.run.id, values: { title: 'Projektplan' } } });
    assert.equal(replay.status, 'pending', replay.summary);
    assert.equal(await resumedDb.pendingWrite.count(), 1);
    assert.equal(providerCalls, 0, 'Drafts must not call provider writes');
    const storedDraft = await resumedDb.pendingWrite.findFirst();
    assert.equal(storedDraft.status, 'draft');
    assert.equal(storedDraft.toolArgs.title, 'Projektplan');
    await assert.rejects(runDurableComposioAgent({ message: 'Erstelle eine Seite', prisma: resumedDb, composio,
      ctx: { ...resumeCtx, orgId: randomUUID() }, choice: { run_id: first.run.id } }), /durable_resume_not_found/);

    // A disposable canonical receipt fixture, never a real provider send.
    const sentDraft = await resumedDb.pendingWrite.update({ where: { id: storedDraft.id },
      data: { status: 'sent', sentAt: new Date(), result: { fixture: true, provider_receipt: 'local-only' } } });
    await reconcileProgressiveApproval({ prisma: resumedDb, draft: sentDraft });
    const projected = await resumedDb.agentRun.findUnique({ where: { id: first.run.id } });
    assert.equal(projected.status, 'done');
    assert.equal(projected.scratch.approvals[sentDraft.id].status, 'sent');
    const approvalStepCount = projected.steps.filter(step => step.kind === 'approval').length;
    assert.equal(approvalStepCount, 1);
    await reconcileProgressiveApproval({ prisma: resumedDb, draft: sentDraft });
    const duplicateProjection = await resumedDb.agentRun.findUnique({ where: { id: first.run.id } });
    assert.equal(duplicateProjection.steps.filter(step => step.kind === 'approval').length, approvalStepCount);
    for (const terminal of ['cancelled', 'failed']) {
      const pending = await runDurableComposioAgent({ message: 'Erstelle eine Seite', prisma: resumedDb, composio,
        ctx: { ...context(resumedDb, `approval-${terminal}`), chooseNextAction: actions(search, draft),
          generateProgressiveToolInputs: async () => ({ title: 'Terminal fixture' }) } });
      assert.equal(pending.status, 'pending', pending.summary);
      const terminalDraft = await resumedDb.pendingWrite.update({ where: { id: pending.draftIds[0] }, data: { status: terminal } });
      await reconcileProgressiveApproval({ prisma: resumedDb, draft: terminalDraft });
      const terminalRun = await resumedDb.agentRun.findUnique({ where: { id: pending.run.id } });
      assert.equal(terminalRun.status, terminal);
    }

    const otherDb = client();
    const entered = new Promise(resolve => { providerEntered = resolve; });
    barrier = new Promise(resolve => { releaseProvider = resolve; });
    const readCtx = { ...context(resumedDb, 'concurrent-read', 'lookup'), chooseNextAction: actions(search, execute) };
    const firstRead = runDurableComposioAgent({ message: 'Lies die Seite', prisma: resumedDb, composio, ctx: readCtx });
    const enterTimeout = setTimeout(() => releaseProvider(), 10000);
    await Promise.race([entered, firstRead.then(result => { throw new Error(`Read ended before provider: ${result.summary}`); })]);
    const competing = await runDurableComposioAgent({ message: 'Lies die Seite', prisma: otherDb, composio,
      ctx: { ...context(otherDb, 'concurrent-read', 'lookup'), chooseNextAction: actions(search, execute) } });
    releaseProvider();
    clearTimeout(enterTimeout);
    const completed = await firstRead;
    assert.equal(completed.status, 'completed', completed.summary);
    assert.notEqual(competing.status, 'completed', 'A concurrent request must not execute the leased run');
    assert.equal(providerCalls, 1, 'Only the lease owner executes the provider read');
    const persisted = await resumedDb.agentRun.findUnique({ where: { id: completed.run.id } });
    assert.equal(persisted.status, 'done');
    assert.equal(persisted.scratch.read_results.length, 1);
    t.diagnostic(JSON.stringify({ schema, runs: await resumedDb.agentRun.count(), drafts: await resumedDb.pendingWrite.count(), providerFixtureCalls: providerCalls, pausedRunResumed: first.run.id === resumed.run.id, approvalReceiptProjected: projected.status, approvalStepCount }));
  } finally {
    for (const [i, name] of ['USE_TOOLS_PROGRESSIVE_HARNESS', 'USE_TOOLS_PROGRESSIVE_HARNESS_ORGS'].entries()) {
      if (prior[i] === undefined) delete process.env[name]; else process.env[name] = prior[i];
    }
    await Promise.allSettled(clients.map(db => db.$disconnect()));
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
  }
});
