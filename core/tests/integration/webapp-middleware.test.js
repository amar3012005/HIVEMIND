import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildWebappContextResponse,
  buildWebappSavePayload,
  buildPromptEnvelope
} from '../../src/integrations/webapp-middleware.js';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';

const prisma = getPrismaClient();

function randomId() {
  return crypto.randomUUID();
}

test('webapp middleware builds prompt envelope from recall context', async () => {
  const recall = {
    search_method: 'persisted-hybrid',
    memories: [{ id: 'm1', content: 'Deployment runs on Hetzner.' }],
    injectionText: '<relevant-memories>\n- Deployment runs on Hetzner.\n</relevant-memories>'
  };

  const prepared = buildWebappContextResponse(recall, {
    query: 'Where does deployment run?',
    platform: 'chatgpt',
    project: 'atlas',
    preferredSources: ['chatgpt'],
    preferredTags: ['deploy'],
    maxMemories: 3
  });

  const envelope = buildPromptEnvelope({
    platform: 'chatgpt',
    user_prompt: 'Where does deployment run?'
  }, prepared.context);

  assert.equal(prepared.platform, 'chatgpt');
  assert.equal(prepared.search_method, 'persisted-hybrid');
  assert.match(prepared.context.system_prompt, /HIVE-MIND memory/i);
  assert.equal(envelope.messages[0].role, 'system');
  assert.equal(envelope.messages[1].role, 'user');
});

test('webapp store payload normalizes camelCase and snake_case inputs', async () => {
  const payload = buildWebappSavePayload({
    platform: 'Gemini',
    content: 'Store this output',
    memoryType: 'lesson',
    importanceScore: 0.8,
    title: 'Gemini lesson',
    tags: ['gemini', 'webapp'],
    conversation_id: 'conv-1',
    session_id: 'sess-1'
  }, {
    userId: '00000000-0000-4000-8000-000000000001',
    orgId: '00000000-0000-4000-8000-000000000002'
  });

  assert.equal(payload.memory_type, 'lesson');
  assert.equal(payload.importance_score, 0.8);
  assert.equal(payload.source_platform, 'gemini');
  assert.ok(payload.tags.includes('webapp'));
  assert.ok(payload.tags.includes('gemini'));
});

test('webapp recall contract works against persisted memory store', { skip: !prisma }, async () => {
  const userId = randomId();
  const orgId = randomId();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });

  const store = new PrismaGraphStore(prisma);
  const engine = new MemoryGraphEngine({ store });

  try {
    await engine.ingestMemory({
      user_id: userId,
      org_id: orgId,
      project: 'webapp-atlas',
      content: 'Project Atlas deployment runs on Hetzner with blue-green rollout.',
      memory_type: 'fact',
      title: 'Atlas deployment',
      tags: ['deploy', 'atlas'],
      source_metadata: {
        source_type: 'webapp',
        source_platform: 'chatgpt',
        source_id: 'msg-1'
      }
    });

    const recall = await recallPersistedMemories(store, {
      query_context: 'Where does Project Atlas deploy?',
      user_id: userId,
      org_id: orgId,
      project: 'webapp-atlas',
      preferred_project: 'webapp-atlas',
      preferred_source_platforms: ['chatgpt'],
      preferred_tags: ['deploy'],
      max_memories: 3
    });

    const prepared = buildWebappContextResponse(recall, {
      query: 'Where does Project Atlas deploy?',
      platform: 'chatgpt',
      project: 'webapp-atlas',
      preferredSources: ['chatgpt'],
      preferredTags: ['deploy'],
      maxMemories: 3
    });

    assert.equal(prepared.context.memories.length, 1);
    assert.match(prepared.context.injection_text, /Hetzner/i);
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
