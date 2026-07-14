import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initMnemeStore } from '../../src/vector/mneme/mneme-init.js';
import {
  loadBinding,
  MnemeMemoryBackend,
  MnemeRelationshipBackend,
  SidecarBackend,
} from '../../src/vector/mneme/amr-store-backend.mjs';

const dim = 8;
const orgId = '00000000-0000-4000-8000-00000000a001';
const otherOrgId = '00000000-0000-4000-8000-00000000b001';
const nativePath = fileURLToPath(new URL('../../src/vector/mneme/singulance-amr.linux-x64-gnu.node', import.meta.url));
const binding = loadBinding(nativePath);
const backend = {
  openStore: (root, collection, dimensions) => binding.MnemeStore.open(root, collection, dimensions),
  MnemeMemoryBackend,
  MnemeRelationshipBackend,
  SidecarBackend,
};
const vector = (index) => Array.from({ length: dim }, (_, position) => position === index ? 1 : 0);

test('native AMR preserves canonical memory, evidence, graph, durability, and tenant routing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-amr-parity-'));
  const postgresCalls = [];
  const realPrisma = {
    memory: {
      findMany: async (args) => { postgresCalls.push(args); return [{ id: 'pg-memory', orgId: otherOrgId }]; },
      count: async () => 1,
    },
    relationship: { findMany: async () => [] },
    knowledgeSegment: { findMany: async () => [] },
    knowledgeDocument: { findMany: async () => [] },
    memoryEvidenceLink: { findMany: async () => [] },
    $transaction: async (fn) => typeof fn === 'function' ? fn(realPrisma) : [],
  };

  try {
    const first = initMnemeStore({ realPrisma, orgId, dim, dataRoot: root, backend });
    const parent = {
      id: '00000000-0000-4000-8000-00000000a101', orgId, userId: 'user-1',
      title: 'Policy document', content: 'Document summary.', memoryType: 'summary',
      layer: 'memory', isLatest: true, tags: ['document-summary'],
      createdAt: new Date().toISOString(),
    };
    const claim = {
      id: '00000000-0000-4000-8000-00000000a102', orgId, userId: 'user-1',
      title: 'Retention period', content: 'Records are retained for seven years.', memoryType: 'fact',
      layer: 'memory', isLatest: true, tags: ['promoted-memory', 'entity:retention-policy'],
      createdAt: new Date().toISOString(),
    };
    await first.storeMemoryUnified(parent, vector(0));
    await first.storeMemoryUnified(claim, vector(1), [{
      id: 'part-of-1', fromId: claim.id, toId: parent.id, type: 'PartOf', confidence: 1,
    }]);
    await first.adapter.knowledgeDocument.create({ data: {
      id: '00000000-0000-4000-8000-00000000a201', orgId, userId: 'user-1',
      title: 'policy.md', parseStatus: 'parsed', createdAt: new Date(),
    } });
    await first.adapter.knowledgeSegment.create({ data: {
      id: '00000000-0000-4000-8000-00000000a202', orgId, userId: 'user-1',
      documentId: '00000000-0000-4000-8000-00000000a201',
      content: 'Records are retained for seven years.', segmentIndex: 0, createdAt: new Date(),
    } });
    await first.adapter.memoryEvidenceLink.create({ data: {
      id: '00000000-0000-4000-8000-00000000a203', memoryId: claim.id,
      documentId: '00000000-0000-4000-8000-00000000a201',
      segmentId: '00000000-0000-4000-8000-00000000a202', linkType: 'supports', confidence: 0.95,
    } });

    const hits = first.store.recallLayer(Float32Array.from(vector(1)), 5, 0);
    assert.equal(JSON.parse(hits[0].text).id, claim.id);
    assert.equal((await first.prisma.memory.findMany({ where: { orgId } })).length, 2);
    assert.equal((await first.prisma.relationship.findMany({ where: { fromMemory: { orgId } } }))[0].type, 'PartOf');
    assert.equal((await first.prisma.knowledgeSegment.findMany({ where: { orgId } }))[0].content, claim.content);
    assert.equal((await first.prisma.memoryEvidenceLink.findMany({ where: { memoryId: claim.id } }))[0].segmentId,
      '00000000-0000-4000-8000-00000000a202');

    const other = await first.prisma.memory.findMany({ where: { orgId: otherOrgId } });
    assert.equal(other[0].id, 'pg-memory');
    assert.equal(postgresCalls.length, 1);

    const reloaded = initMnemeStore({ realPrisma, orgId, dim, dataRoot: root, backend });
    assert.equal((await reloaded.prisma.memory.findMany({ where: { orgId } })).length, 2);
    assert.equal((await reloaded.prisma.relationship.findMany({ where: { fromMemory: { orgId } } }))[0].type, 'PartOf');
    assert.equal((await reloaded.prisma.knowledgeSegment.findMany({ where: { orgId } })).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
