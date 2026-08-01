import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient } from '@prisma/client';

import { createProductionEmailLifecycleService } from '../../src/hq-runtime/langgraph/email-lifecycle-service.js';

const databaseUrl = process.env.HQ_LANGGRAPH_TEST_DATABASE_URL || '';

test('production lifecycle binds workflow artifacts to approval and durable checkpoint state', {
  skip: !databaseUrl,
}, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const orgId = randomUUID();
  const ownerUserId = randomUUID();
  const runtimeId = randomUUID();
  const todoId = randomUUID();
  let service;
  let workflowId;
  try {
    await prisma.hqRuntime.create({
      data: {
        id: runtimeId, orgId, ownerUserId,
        objective: 'Test governed outreach lifecycle', state: 'WAITING',
        authorityPolicy: { internal_autonomy: true, external_writes: 'approval_required' },
      },
    });
    await prisma.hqTodo.create({
      data: {
        id: todoId, runtimeId, orgId, title: 'Deliver test outreach',
        objective: 'Send only after approval', kind: 'email_delivery', status: 'PENDING',
      },
    });
    const workflow = await prisma.hqWorkflow.create({
      data: {
        runtimeId, orgId, todoId, kind: 'outreach_lifecycle', title: 'Test outreach',
        objective: 'Prove approval checkpoint', status: 'WAITING',
        authorityPolicy: { internal_autonomy: true, external_writes: 'approval_required' },
      },
    });
    workflowId = workflow.id;
    const discovery = await prisma.hqWorkflowStep.create({
      data: { workflowId, orgId, stepKey: '01_discovery', title: 'Discover', kind: 'outreach_discovery', status: 'COMPLETED', position: 0 },
    });
    const drafting = await prisma.hqWorkflowStep.create({
      data: { workflowId, orgId, stepKey: '02_drafting', title: 'Draft', kind: 'email_drafting', status: 'COMPLETED', position: 1, dependsOn: ['01_discovery'] },
    });
    await prisma.hqWorkflowStep.create({
      data: { workflowId, orgId, stepKey: '03_delivery', title: 'Deliver', kind: 'email_delivery', status: 'PENDING', position: 2, dependsOn: ['02_drafting'], input: { todo_id: todoId } },
    });
    await prisma.hqWorkflowArtifact.create({
      data: {
        workflowId, stepId: discovery.id, orgId, artifactKey: '01:prospects', artifactType: 'prospect_records',
        payload: { records: [{ prospect_id: 'prospect-1', company: 'Example AG', email: 'buyer@example.test', fit_reason: 'Verified regulated buyer', outreach_angle: 'Relevant sovereign AI use case', source_url: 'https://example.test' }], persisted_count: 1 },
        sourceRefs: ['https://example.test'],
      },
    });
    await prisma.hqWorkflowArtifact.create({
      data: {
        workflowId, stepId: drafting.id, orgId, artifactKey: '02:drafts', artifactType: 'email_drafts',
        payload: { records: [{ prospect_id: 'prospect-1', to: 'buyer@example.test', subject: 'A specific sovereign AI idea', body: 'A concise grounded draft.', evidence_refs: ['https://example.test'] }] },
        sourceRefs: ['https://example.test'],
      },
    });

    service = await createProductionEmailLifecycleService({ prisma });
    const started = await service.maybeStartForAcceptedWork({ runtime: { id: runtimeId, orgId }, workflowId });
    assert.equal(started.stepStatus, 'WAITING_FOR_APPROVAL');
    const approvals = await service.listPendingApprovals({ organizationId: orgId });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].drafts.length, 1);
    assert.equal(approvals[0].drafts[0].to, 'buyer@example.test');
    const snapshot = await service.getState({ organizationId: orgId, executionId: workflowId });
    assert.equal(snapshot.values.status, 'READY_FOR_APPROVAL');

    const rejected = await service.approve({ organizationId: orgId, executionId: workflowId, approved: false });
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.stepStatus, 'BLOCKED');
    assert.equal((await prisma.outboundAction.count({ where: { orgId } })), 0);
    const duplicateDecision = await service.approve({ organizationId: orgId, executionId: workflowId, approved: false });
    assert.equal(duplicateDecision.alreadyResolved, true);
    assert.equal((await prisma.outboundAction.count({ where: { orgId } })), 0);
    await service.deleteCheckpoints({ organizationId: orgId, executionId: workflowId });
  } finally {
    if (service) await service.close();
    if (workflowId) await prisma.hqWorkflow.deleteMany({ where: { id: workflowId, orgId } });
    await prisma.hqTodo.deleteMany({ where: { runtimeId, orgId } });
    await prisma.hqRuntime.deleteMany({ where: { id: runtimeId, orgId } });
    await prisma.$disconnect();
  }
});
