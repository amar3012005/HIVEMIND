import { fileURLToPath } from 'node:url';
import { initMnemeStore } from '../../src/vector/mneme/mneme-init.js';
import {
  loadBinding,
  MnemeMemoryBackend,
  MnemeRelationshipBackend,
  SidecarBackend,
} from '../../src/vector/mneme/amr-store-backend.mjs';

const phase = process.argv[2];
const dataRoot = process.argv[3];
const dim = 8;
const orgId = '00000000-0000-4000-8000-00000000a001';
const otherOrgId = '00000000-0000-4000-8000-00000000b001';
const claimId = '00000000-0000-4000-8000-00000000a102';
const replacementId = '00000000-0000-4000-8000-00000000a103';
const nativeFilename = process.platform === 'darwin' && process.arch === 'arm64'
  ? 'singulance-amr.darwin-arm64.node'
  : process.platform === 'linux' && process.arch === 'x64'
    ? 'singulance-amr.linux-x64-gnu.node'
    : null;
if (!nativeFilename) throw new Error(`unsupported AMR test platform: ${process.platform}-${process.arch}`);
const nativePath = fileURLToPath(new URL(`../../src/vector/mneme/${nativeFilename}`, import.meta.url));
const binding = loadBinding(nativePath);
const backend = {
  openStore: (root, collection, dimensions) => binding.MnemeStore.open(root, collection, dimensions),
  MnemeMemoryBackend,
  MnemeRelationshipBackend,
  SidecarBackend,
};
const vector = (index) => Array.from({ length: dim }, (_, position) => position === index ? 1 : 0);
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
const state = initMnemeStore({ realPrisma, orgId, dim, dataRoot, backend });

if (phase === 'write') {
  const parent = {
    id: '00000000-0000-4000-8000-00000000a101', orgId, userId: 'user-1',
    title: 'Policy document', content: 'Document summary.', memoryType: 'summary',
    layer: 'memory', isLatest: true, tags: ['document-summary'], createdAt: new Date().toISOString(),
  };
  const claim = {
    id: claimId, orgId, userId: 'user-1',
    title: 'Retention period', content: 'Records are retained for seven years.', memoryType: 'fact',
    layer: 'memory', isLatest: true, tags: ['promoted-memory', 'entity:retention-policy'],
    createdAt: new Date().toISOString(),
  };
  await state.storeMemoryUnified(parent, vector(0));
  await state.storeMemoryUnified(claim, vector(1), [{
    id: 'part-of-1', fromId: claim.id, toId: parent.id, type: 'PartOf', confidence: 1,
  }]);
  await state.adapter.knowledgeDocument.create({ data: {
    id: '00000000-0000-4000-8000-00000000a201', orgId, userId: 'user-1',
    title: 'policy.md', parseStatus: 'parsed', createdAt: new Date(),
  } });
  await state.adapter.knowledgeSegment.create({ data: {
    id: '00000000-0000-4000-8000-00000000a202', orgId, userId: 'user-1',
    documentId: '00000000-0000-4000-8000-00000000a201',
    content: claim.content, segmentIndex: 0, createdAt: new Date(),
  } });
  await state.adapter.memoryEvidenceLink.create({ data: {
    id: '00000000-0000-4000-8000-00000000a203', memoryId: claim.id,
    documentId: '00000000-0000-4000-8000-00000000a201',
    segmentId: '00000000-0000-4000-8000-00000000a202', linkType: 'supports', confidence: 0.95,
  } });
  state.store.flush();
  process.stdout.write(JSON.stringify({ memories: 2, relationships: 1, segments: 1, evidenceLinks: 1 }));
} else if (phase === 'read') {
  const memories = await state.prisma.memory.findMany({ where: { orgId } });
  const relationships = await state.prisma.relationship.findMany({ where: { fromMemory: { orgId } } });
  const segments = await state.prisma.knowledgeSegment.findMany({ where: { orgId } });
  const evidence = await state.prisma.memoryEvidenceLink.findMany({
    where: { memoryId: '00000000-0000-4000-8000-00000000a102' },
  });
  const hits = state.store.recallLayer(Float32Array.from(vector(1)), 5, 0);
  const other = await state.prisma.memory.findMany({ where: { orgId: otherOrgId } });
  process.stdout.write(JSON.stringify({
    memories: memories.length,
    relationshipType: relationships[0]?.type,
    segmentContent: segments[0]?.content,
    evidenceSegmentId: evidence[0]?.segmentId,
    recalledId: JSON.parse(hits[0].text).id,
    otherTenantId: other[0]?.id,
    postgresCalls: postgresCalls.length,
  }));
} else if (phase === 'mutate') {
  await state.adapter.memory.update({ where: { id: claimId }, data: { isLatest: false } });
  await state.storeMemoryUnified({
    id: replacementId, orgId, userId: 'user-1', title: 'Updated retention period',
    content: 'Records are retained for eight years.', memoryType: 'fact', layer: 'memory',
    isLatest: true, tags: ['promoted-memory', 'entity:retention-policy'], createdAt: new Date().toISOString(),
  }, vector(2), [{
    id: 'updates-1', fromId: replacementId, toId: claimId, type: 'Updates', confidence: 1,
  }]);
  state.store.flush();
  process.stdout.write(JSON.stringify({ updated: true }));
} else if (phase === 'verify-updated') {
  const memories = await state.prisma.memory.findMany({ where: { orgId } });
  const relationships = await state.prisma.relationship.findMany({ where: { fromId: replacementId } });
  process.stdout.write(JSON.stringify({
    latestIds: memories.filter((memory) => memory.isLatest).map((memory) => memory.id).sort(),
    predecessorLatest: memories.find((memory) => memory.id === claimId)?.isLatest,
    replacementContent: memories.find((memory) => memory.id === replacementId)?.content,
    updateType: relationships[0]?.type,
  }));
} else if (phase === 'delete') {
  await state.adapter.relationship.deleteMany({ where: { fromId: replacementId } });
  await state.adapter.memory.delete({ where: { id: replacementId } });
  state.store.flush();
  process.stdout.write(JSON.stringify({ deleted: true }));
} else if (phase === 'verify-deleted') {
  const memories = await state.prisma.memory.findMany({ where: { orgId } });
  const relationships = await state.prisma.relationship.findMany({ where: { fromId: replacementId } });
  process.stdout.write(JSON.stringify({
    replacementPresent: memories.some((memory) => memory.id === replacementId),
    updateEdges: relationships.length,
  }));
} else {
  throw new Error(`unknown phase: ${phase}`);
}
