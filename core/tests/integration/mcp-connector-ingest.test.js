import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { MCPIngestionService } from '../../src/connectors/mcp/service.js';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';

const require = createRequire(import.meta.url);
const { createIngestionPipeline } = require('../../../src/ingestion');
const prisma = getPrismaClient();

test.after(async () => {
  await prisma?.$disconnect?.();
});

function randomId() {
  return crypto.randomUUID();
}

function waitForEvent(eventBus, eventName) {
  return new Promise((resolve) => {
    eventBus.once(eventName, resolve);
  });
}

function createStubRunner({ tools = [], execute }) {
  return {
    async inspect() {
      return { tools, resources: [], prompts: [] };
    },
    async execute(endpoint, operation) {
      return execute(endpoint, operation);
    }
  };
}

function gmailThreadResult() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          thread: {
            id: 'thread-mcp-1',
            labels: ['INBOX', 'IMPORTANT'],
            messages: [
              {
                id: 'msg-1',
                subject: 'MCP launch update',
                snippet: 'Shared rollout notes',
                body: 'We enabled the Gmail MCP connector for the launch thread.',
                internalDate: '2026-03-18T11:00:00.000Z',
                from: 'ops@hivemind.dev',
                to: ['team@hivemind.dev']
              }
            ]
          }
        })
      }
    ]
  };
}

function linearIssuesResult() {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          issues: [
            {
              id: 'issue-1',
              identifier: 'HM-1',
              title: 'Connector orchestration hardening',
              description: 'Track retries and replay primitives for MCP ingestion.',
              url: 'https://linear.app/hivemind/issue/HM-1',
              team: { key: 'HM' },
              state: { name: 'In Progress' },
              labels: [{ name: 'roadmap' }],
              createdAt: '2026-03-18T11:00:00.000Z',
              updatedAt: '2026-03-19T09:00:00.000Z'
            }
          ]
        })
      }
    ]
  };
}

test('generic MCP ingestion service registers endpoint, inspects tools, and ingests Gmail thread via pipeline', async (t) => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  t.after(async () => {
    await pipeline.close();
  });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
    runner: createStubRunner({
      tools: [{ name: 'gmail_get_thread' }],
      async execute(endpoint, operation) {
        assert.equal(endpoint.name, 'fake-gmail');
        assert.equal(operation.name, 'gmail_get_thread');
        return gmailThreadResult();
      }
    })
  });

  const userId = randomId();
  const orgId = randomId();

  service.registerEndpoint({
    name: 'fake-gmail',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: ['noop'],
    adapter_type: 'gmail',
    default_project: 'project-mcp',
    default_tags: ['mcp-ingest'],
  });

  const inspection = await service.inspectEndpoint('fake-gmail', { user_id: userId, org_id: orgId });
  assert.ok(inspection.tools.some(tool => tool.name === 'gmail_get_thread'));

  const completion = waitForEvent(pipeline.eventBus, 'memory.ingested');
  const result = await service.ingestFromEndpoint({
    endpoint_name: 'fake-gmail',
    operation: {
      type: 'tool',
      name: 'gmail_get_thread',
      arguments: { threadId: 'thread-mcp-1' }
    },
    user_id: userId,
    org_id: orgId,
    project: 'project-mcp',
    tags: ['gmail', 'project-mcp'],
  });

  const ingested = await completion;

  assert.equal(result.endpoint_name, 'fake-gmail');
  assert.equal(result.adapter, 'gmail');
  assert.ok(result.accepted_jobs.length >= 1);
  assert.equal(ingested.source_type, 'text');
  assert.ok(Array.isArray(result.accepted_jobs));
  assert.equal(result.accepted_jobs[0].project, 'project-mcp');
});

test('generic MCP ingestion service ingests Linear issues through the shared adapter contract', async (t) => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  t.after(async () => {
    await pipeline.close();
  });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
    runner: createStubRunner({
      tools: [{ name: 'list_issues' }],
      async execute(endpoint, operation) {
        assert.equal(endpoint.name, 'fake-linear');
        assert.equal(operation.name, 'list_issues');
        return linearIssuesResult();
      }
    })
  });

  const userId = randomId();
  const orgId = randomId();

  service.registerEndpoint({
    name: 'fake-linear',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: ['noop'],
    adapter_type: 'linear',
    default_project: 'linear-platform',
    default_tags: ['mcp-ingest', 'linear'],
  });

  const inspection = await service.inspectEndpoint('fake-linear', { user_id: userId, org_id: orgId });
  assert.ok(inspection.tools.some(tool => tool.name === 'list_issues'));

  const completion = waitForEvent(pipeline.eventBus, 'memory.ingested');
  const result = await service.ingestFromEndpoint({
    endpoint_name: 'fake-linear',
    operation: {
      type: 'tool',
      name: 'list_issues',
      arguments: { team: 'HM' }
    },
    user_id: userId,
    org_id: orgId,
    project: 'linear-platform',
    tags: ['roadmap'],
  });

  const ingested = await completion;

  assert.equal(result.endpoint_name, 'fake-linear');
  assert.equal(result.adapter, 'linear');
  assert.ok(result.accepted_jobs.length >= 1);
  assert.equal(result.accepted_jobs[0].project, 'linear-platform');
  assert.equal(ingested.source_type, 'text');
  assert.ok(Array.isArray(result.raw_result.content));
});

test('generic MCP ingestion service reports endpoint health and tool visibility', async (t) => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  t.after(async () => {
    await pipeline.close();
  });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
    runner: createStubRunner({
      tools: [{ name: 'list_issues' }],
      async execute() {
        return linearIssuesResult();
      }
    })
  });

  const userId = randomId();
  const orgId = randomId();

  service.registerEndpoint({
    name: 'fake-linear-status',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: ['noop'],
    adapter_type: 'linear',
  });

  const status = await service.listEndpointStatuses({ user_id: userId, org_id: orgId });

  assert.equal(status.total, 1);
  assert.equal(status.healthy, 1);
  assert.equal(status.unhealthy, 0);
  assert.equal(status.statuses[0].name, 'fake-linear-status');
  assert.equal(status.statuses[0].healthy, true);
  assert.equal(status.statuses[0].health_grade, 'idle');
  assert.ok(status.statuses[0].tool_count >= 1);
});

test('generic MCP ingestion service tracks orchestration jobs and supports retry and replay primitives', async () => {
  let executeCount = 0;
  const pipeline = {
    async ingest(payload) {
      return { jobId: `queued-${payload.source_id || executeCount}` };
    }
  };
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath: `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`,
    jobStorePath: `/tmp/hivemind-mcp-jobs-${crypto.randomUUID()}.json`,
    runner: {
      async inspect() {
        return { tools: [{ name: 'list_issues' }], resources: [], prompts: [] };
      },
      async execute() {
        executeCount += 1;
        if (executeCount === 1) {
          throw new Error('temporary upstream failure');
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                { id: 'issue-1', identifier: 'HM-1', title: 'Connector job tracking' }
              ])
            }
          ]
        };
      }
    }
  });

  const userId = randomId();
  const orgId = randomId();
  service.registerEndpoint({
    name: 'fake-linear-jobs',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: ['noop'],
    adapter_type: 'linear',
  });

  await assert.rejects(() => service.ingestFromEndpoint({
    endpoint_name: 'fake-linear-jobs',
    operation: {
      type: 'tool',
      name: 'list_issues',
      arguments: { team: 'HM' }
    },
    user_id: userId,
    org_id: orgId,
    project: 'jobs-project',
    tags: ['roadmap'],
  }), /temporary upstream failure/);

  const failedJob = service.listJobs({ user_id: userId, org_id: orgId })[0];
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.endpoint_name, 'fake-linear-jobs');

  const retried = await service.retryJob(failedJob.id, { user_id: userId, org_id: orgId });
  assert.ok(retried.job_id);
  assert.equal(retried.status, 'queued');

  const jobs = service.listJobs({ user_id: userId, org_id: orgId });
  const latestJob = jobs[0];
  assert.equal(latestJob.status, 'queued');
  assert.equal(latestJob.can_retry, false);
  assert.equal(latestJob.can_replay, true);
  assert.ok(latestJob.accepted_jobs.length >= 1);

  const replayed = await service.retryJob(latestJob.id, { user_id: userId, org_id: orgId }, { replay: true });
  assert.equal(replayed.status, 'queued');

  const status = await service.listEndpointStatuses({ user_id: userId, org_id: orgId });
  assert.equal(status.statuses[0].total_jobs, 3);
  assert.equal(status.statuses[0].failed_jobs, 1);
  assert.equal(status.statuses[0].queued_jobs, 2);
  assert.equal(status.statuses[0].retryable_jobs, 1);
  assert.equal(status.statuses[0].replayable_jobs, 2);
  assert.equal(status.statuses[0].last_job_status, 'queued');
  assert.equal(status.statuses[0].health_grade, 'warning');
  assert.equal(status.statuses[0].last_error, 'temporary upstream failure');
  assert.ok(status.statuses[0].last_failure_at);
  assert.ok(status.statuses[0].last_success_at);
});

test('generic MCP connector ingest can persist explicit Extends relationships into the graph store', { skip: !prisma }, async (t) => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  t.after(async () => {
    await pipeline.close();
  });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
    runner: createStubRunner({
      tools: [{ name: 'list_issues' }],
      async execute(endpoint, operation) {
        assert.equal(endpoint.name, 'fake-linear-rel');
        assert.equal(operation.name, 'list_issues');
        return linearIssuesResult();
      }
    })
  });

  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });
  const base = await engine.ingestMemory({
    user_id: userId,
    org_id: orgId,
    project: 'project-mcp-rel',
    content: 'Initial project MCP launch note',
    source_metadata: { source_type: 'mcp', source_platform: 'mcp', source_id: 'seed-1' }
  });

  service.registerEndpoint({
    name: 'fake-linear-rel',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: ['noop'],
    adapter_type: 'linear',
    default_project: 'project-mcp-rel',
    default_tags: ['mcp-ingest', 'linear'],
  });

  try {
    const completion = waitForEvent(pipeline.eventBus, 'memory.ingested');
    const result = await service.ingestFromEndpoint({
      endpoint_name: 'fake-linear-rel',
      operation: {
        type: 'tool',
        name: 'list_issues',
        arguments: { team: 'HM' }
      },
      relationship: {
        type: 'Extends',
        target_id: base.memoryId
      },
      user_id: userId,
      org_id: orgId,
      project: 'project-mcp-rel',
      tags: ['roadmap'],
    });

    const ingested = await completion;
    const persistedRelationships = await prisma.relationship.findMany({
      where: {
        toId: base.memoryId,
        type: 'Extends',
        fromMemory: { userId }
      }
    });

    assert.ok(result.accepted_jobs.length >= 1);
    assert.equal(result.accepted_jobs[0].relationship_type, 'Extends');
    assert.ok(ingested.edges_created >= 1);
    assert.ok(persistedRelationships.length >= 1);
  } finally {
    await prisma.derivationJob.deleteMany({
      where: {
        OR: [
          { sourceMemory: { userId } },
          { targetMemory: { userId } }
        ]
      }
    });
    await prisma.relationship.deleteMany({
      where: {
        OR: [
          { fromMemory: { userId } },
          { toMemory: { userId } }
        ]
      }
    });
    await prisma.sourceMetadata.deleteMany({ where: { memory: { userId } } });
    await prisma.codeMemoryMetadata.deleteMany({ where: { memory: { userId } } });
    await prisma.memoryVersion.deleteMany({ where: { memory: { userId } } });
    await prisma.memory.deleteMany({ where: { userId } });
    await prisma.userOrganization.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
  }
});
