import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { MCPIngestionService } from '../../src/connectors/mcp/service.js';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createIngestionPipeline } = require('../../../src/ingestion');
const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

function waitForEvent(eventBus, eventName) {
  return new Promise((resolve) => {
    eventBus.once(eventName, resolve);
  });
}

test('generic MCP ingestion service registers endpoint, inspects tools, and ingests Gmail thread via pipeline', async () => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
  });

  const userId = randomId();
  const orgId = randomId();
  const fixturePath = path.join(__dirname, '../../src/connectors/mcp/fixtures/fake-gmail-server.js');

  service.registerEndpoint({
    name: 'fake-gmail',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: [fixturePath],
    cwd: path.join(__dirname, '../../..'),
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

test('generic MCP ingestion service ingests Linear issues through the shared adapter contract', async () => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
  });

  const userId = randomId();
  const orgId = randomId();
  const fixturePath = path.join(__dirname, '../../src/connectors/mcp/fixtures/fake-linear-server.js');

  service.registerEndpoint({
    name: 'fake-linear',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: [fixturePath],
    cwd: path.join(__dirname, '../../..'),
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

test('generic MCP connector ingest can persist explicit Extends relationships into the graph store', { skip: !prisma }, async () => {
  const pipeline = createIngestionPipeline({ queue: { forceInMemory: true } });
  const registryPath = `/tmp/hivemind-mcp-connectors-${crypto.randomUUID()}.json`;
  const service = new MCPIngestionService({
    ingestionPipeline: pipeline,
    registryPath,
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

  const fixturePath = path.join(__dirname, '../../src/connectors/mcp/fixtures/fake-linear-server.js');
  service.registerEndpoint({
    name: 'fake-linear-rel',
    user_id: userId,
    org_id: orgId,
    transport: 'stdio',
    command: 'node',
    args: [fixturePath],
    cwd: path.join(__dirname, '../../..'),
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
