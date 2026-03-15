import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { queryPersistedMemories, recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { GmailConnector } from '../../src/connectors/gmail.connector.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('persisted query patterns and recall use prisma-backed data', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });

  try {
    const base = await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'integration-query',
      content: 'Kickoff decision: production port is 3000',
      source_metadata: { source_type: 'gmail', source_platform: 'gmail', source_id: 'msg-1' },
      document_date: '2026-03-05T10:00:00.000Z',
      event_dates: ['2026-03-05T10:00:00.000Z']
    });

    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'integration-query',
      content: 'Updated: production port is 3010',
      relationship: { type: 'Updates', target_id: base.memoryId },
      source_metadata: { source_type: 'claude_session', source_platform: 'claude_session', source_id: 'session-1' },
      document_date: '2026-03-12T09:00:00.000Z',
      event_dates: ['2026-03-12T09:00:00.000Z']
    });

    const state = await queryPersistedMemories(store, {
      pattern: 'state_of_union',
      user_id: userId,
      org_id: orgId,
      project: 'integration-query',
      query: 'production port',
      limit: 3
    });

    const byEvent = await queryPersistedMemories(store, {
      pattern: 'event_time',
      user_id: userId,
      org_id: orgId,
      project: 'integration-query',
      event_date: '2026-03-05'
    });

    const recall = await recallPersistedMemories(store, {
      query_context: 'what is the current production port',
      user_id: userId,
      org_id: orgId,
      project: 'integration-query',
      max_memories: 3
    });

    assert.ok(state.length >= 1);
    assert.ok(state[0].history.length >= 2);
    assert.ok(byEvent.length >= 1);
    assert.ok(recall.memories.length >= 1);
    assert.ok(recall.injectionText.includes('<relevant-memories>'));
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

test('persisted recall dedupes near-identical memories and filters low-signal session noise', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });

  try {
    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      content: 'NVIDIA .exe files do not work on Linux. Use distro packages for drivers and nvidia-smi for monitoring.',
      tags: ['linux', 'nvidia', 'drivers'],
      source_metadata: { source_type: 'mcp', source_platform: 'mcp', source_id: 'nvidia-1' }
    });

    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      content: 'NVIDIA .exe files do not work on Linux. Use distro packages for drivers and nvidia-smi for monitoring.',
      tags: ['linux', 'nvidia', 'drivers'],
      source_metadata: { source_type: 'mcp', source_platform: 'mcp', source_id: 'nvidia-2' }
    });

    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'session-memory',
      content: '## Session Summary A long romantic conversation about poetry, distance, and longing with no Linux or NVIDIA content.',
      tags: ['session', 'claude', 'poetry'],
      source_metadata: { source_type: 'text', source_platform: 'session', source_id: 'session-1' }
    });

    const recall = await recallPersistedMemories(store, {
      query_context: 'How do I use NVIDIA software on Linux?',
      user_id: userId,
      org_id: orgId,
      max_memories: 5
    });

    assert.equal(recall.memories.length, 1);
    assert.match(recall.memories[0].content, /NVIDIA \.exe files do not work on Linux/i);
    assert.doesNotMatch(recall.injectionText, /romantic conversation about poetry/i);
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

test('persisted recall respects Gmail source preference and project scoping', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });
  const gmail = new GmailConnector();

  try {
    const normalized = gmail.normalizeThread({
      id: 'thread-1',
      labels: ['inbox', 'project-alpha'],
      messages: [
        {
          id: 'msg-1',
          subject: 'Client deadline confirmation',
          snippet: 'The deployment deadline is March 20 and must stay in Project Alpha.',
          body: 'Please confirm the Project Alpha deployment deadline remains March 20.',
          internalDate: '2026-03-10T09:00:00.000Z',
          from: 'client@example.com',
          to: ['amar@example.com'],
          permalink: 'https://mail.google.com/mail/u/0/#inbox/msg-1'
        }
      ]
    }, {
      user_id: userId,
      org_id: orgId,
      project: 'project-alpha'
    });

    for (const memory of normalized) {
      await engine.ingestMemory(memory);
    }

    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'project-alpha',
      content: 'A generic codex note unrelated to the client email deadline.',
      tags: ['codex'],
      source_metadata: { source_type: 'codex', source_platform: 'codex', source_id: 'codex-1' }
    });

    const recall = await recallPersistedMemories(store, {
      query_context: 'What is the client deployment deadline for Project Alpha?',
      user_id: userId,
      org_id: orgId,
      project: 'project-alpha',
      preferred_project: 'project-alpha',
      preferred_source_platforms: ['gmail'],
      source_platforms: ['gmail', 'codex'],
      max_memories: 3
    });

    assert.ok(recall.memories.length >= 1);
    assert.equal(recall.memories[0].source, 'gmail');
    assert.match(recall.memories[0].content, /March 20/i);
    assert.equal(recall.search_method === 'persisted-hybrid' || recall.search_method === 'persisted-keyword', true);
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
