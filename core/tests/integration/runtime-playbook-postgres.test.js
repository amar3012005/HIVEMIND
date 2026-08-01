import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  GenericStageExecutor,
  PostgresRuntimeStore,
  PredicateEngine,
  RuntimePlaybookRegistry,
  createJsonPlaybookSource,
} from '../../src/runtime-playbooks/index.js';

const fixturePath = fileURLToPath(new URL('../../src/runtime-playbooks/fixtures/greenleaf-order-operations.v1.json', import.meta.url));
const databaseUrl = process.env.RUNTIME_PLAYBOOK_TEST_DATABASE_URL;

test('GreenLeaf lifecycle persists and resumes through PostgreSQL checkpoints', { skip: !databaseUrl }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const orgId = '11111111-1111-4111-8111-111111111111';
  try {
    const registry = new RuntimePlaybookRegistry();
    await registry.load([createJsonPlaybookSource([fixturePath])]);
    const store = new PostgresRuntimeStore({ prisma, leaseMs: 30_000 });
    const director = {
      async execute({ stage_id: stageId }) {
        return { artifacts: ({
          capture_request: [{ id: 'request-1', key: 'request_record', data: {
            request_id: 'GL-2001', customer_contact: 'customer@example.test',
            items: [{ sku: 'LOAF-1', quantity: 2 }], cancelled: false,
          } }],
          confirm_terms: [{ id: 'confirmation-1', key: 'confirmation_record', data: {
            request_ref: 'request-1', confirmed_at: '2026-08-01T10:00:00.000Z',
          } }],
          fulfill_request: [{ id: 'fulfillment-1', key: 'fulfillment_record', data: {
            request_ref: 'request-1', state: 'fulfilled', completed_at: '2026-08-01T11:00:00.000Z',
          } }],
          notify_customer: [{ id: 'receipt-1', key: 'notification_receipt', data: {
            provider_receipt_id: 'provider-42', status: 'accepted',
          } }],
        })[stageId] || [] };
      },
    };
    const executor = new GenericStageExecutor({
      registry, predicates: new PredicateEngine(), store, director, workerId: 'postgres-test-worker',
    });
    const created = await executor.createRun({
      orgId,
      playbookId: 'greenleaf.order-operations',
      playbookVersion: 1,
      idempotencyKey: 'greenleaf-postgres-2001',
      trigger: { request: 'two loaves' },
    });
    const duplicate = await executor.createRun({
      orgId,
      playbookId: 'greenleaf.order-operations',
      playbookVersion: 1,
      idempotencyKey: 'greenleaf-postgres-2001',
      trigger: { request: 'ignored duplicate' },
    });
    assert.equal(duplicate.id, created.id);

    let run = await executor.run(created.id, { orgId });
    assert.equal(run.status, 'WAITING_AUTHORITY');
    await executor.grantAuthority(run.id, orgId, 'commit_terms');
    run = await executor.run(run.id, { orgId });
    assert.equal(run.status, 'WAITING_EVENT');
    run = await executor.run(run.id, {
      orgId,
      event: { type: 'fulfillment.completed', data: { request_ref: 'request-1' } },
    });
    assert.equal(run.status, 'WAITING_AUTHORITY');
    await executor.grantAuthority(run.id, orgId, 'external_write');
    run = await executor.run(run.id, { orgId });
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.terminalState, 'notified');

    const [checkpoints, artifacts, authorities] = await Promise.all([
      prisma.runtimePlaybookCheckpoint.findMany({ where: { runId: run.id }, orderBy: { sequence: 'asc' } }),
      prisma.runtimePlaybookArtifact.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } }),
      prisma.runtimePlaybookAuthority.findMany({ where: { runId: run.id }, orderBy: { grantedAt: 'asc' } }),
    ]);
    assert.deepEqual(checkpoints.map((row) => row.sequence), checkpoints.map((_, index) => index + 1));
    assert.equal(checkpoints.at(-1).phase, 'TERMINAL');
    assert.equal(artifacts.length, 4);
    assert.deepEqual(authorities.map((row) => row.gate), ['commit_terms', 'external_write']);
    await assert.rejects(
      () => store.loadRun(run.id, '22222222-2222-4222-8222-222222222222'),
      /runtime_run_not_found/,
    );
  } finally {
    await prisma.runtimePlaybookRun.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.$disconnect();
  }
});
