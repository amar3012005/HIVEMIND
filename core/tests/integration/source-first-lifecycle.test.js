import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { buildRecallPacket, validateGroundedClaims } from '../../src/memory/recall-packet.js';
import { assertCanonicalBackendContract } from '../fixtures/canonical-backend-contract.mjs';

const prisma = getPrismaClient();
const id = () => crypto.randomUUID();

async function cleanup(userId, orgId) {
  await prisma.derivationJob.deleteMany({ where: { OR: [{ sourceMemory: { userId } }, { targetMemory: { userId } }] } });
  await prisma.relationship.deleteMany({ where: { OR: [{ fromMemory: { userId } }, { toMemory: { userId } }] } });
  await prisma.memoryEvidenceLink.deleteMany({ where: { memory: { userId } } });
  await prisma.memoryDerivation.deleteMany({ where: { memory: { userId } } });
  await prisma.sourceMetadata.deleteMany({ where: { memory: { userId } } });
  await prisma.memoryVersion.deleteMany({ where: { memory: { userId } } });
  await prisma.memoryProject.deleteMany({ where: { memory: { userId } } });
  await prisma.memory.deleteMany({ where: { userId } });
  await prisma.knowledgeSegment.deleteMany({ where: { userId, orgId } });
  await prisma.knowledgeDocument.deleteMany({ where: { userId, orgId } });
  await prisma.sourceArtifact.deleteMany({ where: { userId, orgId } });
  await prisma.userOrganization.deleteMany({ where: { userId, orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

test('source-first lifecycle persists evidence, promotes an exact claim, recalls it, validates citations, dedupes, isolates, and deletes', { skip: !prisma }, async () => {
  const userId = id();
  const orgId = id();
  const otherUserId = id();
  const otherOrgId = id();
  await ensureTenantContext(prisma, { user_id: userId, org_id: orgId });
  await ensureTenantContext(prisma, { user_id: otherUserId, org_id: otherOrgId });

  const previous = {
    unified: process.env.KB_UNIFIED_EXTRACT,
    linkMode: process.env.KB_ENTITY_LINK_MODE,
    entities: process.env.ENABLE_ENTITY_EXTRACTION,
    memoryEntityLinking: process.env.MEMORY_ENTITY_LINKING,
  };
  process.env.KB_UNIFIED_EXTRACT = 'true';
  process.env.KB_ENTITY_LINK_MODE = 'algo';
  process.env.ENABLE_ENTITY_EXTRACTION = 'false';
  process.env.MEMORY_ENTITY_LINKING = 'false';

  const store = new PrismaGraphStore(prisma);
  const vectorWrites = [];
  const engine = new MemoryGraphEngine({ store, predictCalibrate: false });
  engine.vectorStore = {
    generateEmbeddings: async (texts) => texts.map(() => [1, 0, 0, 0]),
    storeMemory: async (memory) => vectorWrites.push({ layer: 'memory', id: memory.id }),
  };
  const evidenceWrites = [];
  const service = new DocumentFirstIngestionService({
    db: prisma,
    memoryGraphEngine: engine,
    smartIngestRouter: null,
    embeddingService: {
      embed: async () => [1, 0, 0, 0],
      storeVector: async ({ id }) => evidenceWrites.push({ layer: 'evidence', id }),
    },
    logger: { info() {}, warn() {} },
  });
  service._extractUnifiedReliable = async (window) => {
    const claims = [
      ['Customer record retention', 'Customer records must be retained for seven years.', 'The retention policy requires customer records to be kept for seven years.', ['Customer Records']],
      ['Periodo de retención', 'El periodo de retención es de siete años.', 'El periodo de retención de los registros es de siete años.', ['Registros de clientes']],
      ['رمز العقد', 'رمز العقد هو ٩٨٧٦.', 'رمز العقد الخاص بالعميل هو ٩٨٧٦.', ['عقد العميل']],
    ];
    return claims.flatMap(([title, fact, quote, entities]) => {
      const start = window.content.indexOf(quote);
      if (start < 0) return [];
      return [{
        t: title, f: fact, memory_type: 'fact', source_quote: quote,
        source_start: start, source_end: start + quote.length,
        importance: 0.92, entities, rels: [],
      }];
    });
  };
  // Storage parity must not depend on a live curator deciding to merge/drop one
  // of the fixed multilingual fixtures. Preserve each already-grounded atomic
  // claim and exercise the persistence/retrieval contract deterministically.
  service._curateDocumentClaims = async (candidates) => candidates.map((candidate) => ({
    ...candidate,
    support_segment_ids: [candidate.segmentId],
    support_quotes: [candidate.source_quote],
    rels: [],
  }));

  const content = Buffer.from([
    '# Records Policy',
    'This policy governs the handling of customer records throughout the organization.',
    'The retention policy requires customer records to be kept for seven years.',
    'El periodo de retención de los registros es de siete años.',
    'رمز العقد الخاص بالعميل هو ٩٨٧٦.',
    'After that period, authorized staff must review the records before secure disposal.',
    'The requirement applies to every managed customer workspace and remains auditable.',
  ].join('\n\n'));

  try {
    const ingested = await service.ingestKnowledgeDocument({
      userId, orgId, filename: 'records-policy.md', fileBuffer: content,
      contentType: 'text/markdown', metadata: { scope: 'organization', document_type: 'policy', tags: ['policy'] },
    });
    assert.ok(ingested.segmentCount >= 1);
    assert.ok(ingested.promotedCount >= 3);
    assert.equal(evidenceWrites.length, ingested.segmentCount);
    assert.equal(vectorWrites.length, 3);

    const document = await prisma.knowledgeDocument.findUnique({ where: { id: ingested.documentId } });
    const segments = await prisma.knowledgeSegment.findMany({ where: { documentId: ingested.documentId }, orderBy: { segmentIndex: 'asc' } });
    const persistedClaims = await prisma.memory.findMany({ where: { userId, orgId, tags: { has: 'distilled-from-kb' } } });
    assert.ok(persistedClaims.some((memory) => /seven years/.test(memory.content)));
    assert.ok(persistedClaims.some((memory) => /siete años/.test(memory.content)));
    assert.ok(persistedClaims.some((memory) => /٩٨٧٦/.test(memory.content)));
    const promoted = await prisma.memory.findFirst({ where: { userId, orgId, title: 'Customer record retention', tags: { has: 'distilled-from-kb' } } });
    const links = await prisma.memoryEvidenceLink.findMany({ where: { memoryId: promoted.id } });
    assert.equal(document.parseStatus, 'parsed');
    assert.match(segments[0].content, /kept for seven years/);
    assert.equal(promoted.memoryType, 'fact');
    assert.equal(links.length, 1);
    assert.equal(links[0].segmentId, segments[0].id);
    assert.equal(links[0].excerpt, 'The retention policy requires customer records to be kept for seven years.');

    const recalled = await recallPersistedMemories(store, {
      query_context: 'How long must customer records be retained?', user_id: userId, org_id: orgId,
      max_memories: 5, access_context: { orgId, userId },
    });
    assert.ok(recalled.memories.some((memory) => memory.id === promoted.id));
    const spanish = await recallPersistedMemories(store, {
      query_context: '¿Cuál es el periodo de retención?', user_id: userId, org_id: orgId,
      max_memories: 5, access_context: { orgId, userId },
    });
    assert.ok(spanish.memories.some((memory) => /siete años/.test(memory.content)));
    const arabic = await recallPersistedMemories(store, {
      query_context: 'ما هو رمز العقد ٩٨٧٦؟', user_id: userId, org_id: orgId,
      max_memories: 5, access_context: { orgId, userId },
    });
    assert.ok(arabic.memories.some((memory) => /٩٨٧٦/.test(memory.content)));

    const packet = buildRecallPacket({
      facts: recalled.memories,
      sourceSections: [{
        segment_id: segments[0].id, document_id: document.id, document_title: document.title,
        source_platform: document.sourcePlatform, content: segments[0].content, segment_index: 0,
      }],
      plan: { mode: 'explain' },
    });
    const grounded = validateGroundedClaims({
      answer: 'Customer records must be retained for seven years.',
      claims: [{ text: 'Customer records must be retained for seven years.', grounded: true, citation_ids: ['C1', 'invented'] }],
    }, packet);
    assert.equal(grounded.grounded, true);
    assert.deepEqual(grounded.claims[0].citation_ids, ['C1']);

    const isolatedStore = new PrismaGraphStore(prisma);
    const isolated = await recallPersistedMemories(isolatedStore, {
      query_context: 'customer record retention', user_id: otherUserId, org_id: otherOrgId, max_memories: 5,
      access_context: { orgId: otherOrgId, userId: otherUserId },
    });
    assert.equal(isolated.memories.length, 0);
    assertCanonicalBackendContract({
      backend: 'managed',
      memories: ingested.promotedCount,
      evidence: segments.length,
      relationship: 'PartOf',
      recall_hit: recalled.memories.some((memory) => memory.id === promoted.id),
      source_hydrated: segments[0].content.includes('kept for seven years'),
      isolated: isolated.memories.length === 0,
    });

    const repeated = await service.ingestKnowledgeDocument({
      userId, orgId, filename: 'records-policy.md', fileBuffer: content,
      contentType: 'text/markdown', metadata: { scope: 'organization', document_type: 'policy', tags: ['policy'] },
    });
    assert.equal(repeated.skippedUnchanged, true);
    assert.equal(repeated.documentId, ingested.documentId);

    const concurrentContent = Buffer.concat([content, Buffer.from('\n\nConcurrent upload sentinel.')]);
    const concurrentBefore = await prisma.knowledgeDocument.count({ where: { userId, orgId } });
    const concurrentResults = await Promise.all([
      service.ingestKnowledgeDocument({
        userId, orgId, filename: 'records-policy-concurrent.md', fileBuffer: concurrentContent,
        contentType: 'text/markdown', metadata: { scope: 'organization', document_type: 'policy', tags: ['policy'] },
      }),
      service.ingestKnowledgeDocument({
        userId, orgId, filename: 'records-policy-concurrent.md', fileBuffer: concurrentContent,
        contentType: 'text/markdown', metadata: { scope: 'organization', document_type: 'policy', tags: ['policy'] },
      }),
    ]);
    assert.equal(new Set(concurrentResults.map((result) => result.documentId)).size, 1);
    assert.equal(concurrentResults.filter((result) => result.coalescedConcurrent === true).length, 1);
    assert.equal(await prisma.knowledgeDocument.count({ where: { userId, orgId } }), concurrentBefore + 1);
    const concurrentDocumentId = concurrentResults[0].documentId;
    assert.equal(await prisma.knowledgeSegment.count({ where: { documentId: concurrentDocumentId } }), 1);
    assert.equal(await prisma.memoryEvidenceLink.count({ where: { documentId: concurrentDocumentId } }), 3);

    await prisma.memoryEvidenceLink.deleteMany({ where: { documentId: document.id } });
    await prisma.memoryDerivation.deleteMany({ where: { memoryId: promoted.id } });
    await prisma.relationship.deleteMany({ where: { OR: [{ fromId: promoted.id }, { toId: promoted.id }] } });
    await prisma.sourceMetadata.deleteMany({ where: { memoryId: promoted.id } });
    await prisma.memoryVersion.deleteMany({ where: { memoryId: promoted.id } });
    await prisma.memory.delete({ where: { id: promoted.id } });
    await prisma.knowledgeSegment.deleteMany({ where: { documentId: document.id } });
    await prisma.knowledgeDocument.delete({ where: { id: document.id } });
    assert.equal(await prisma.memory.count({ where: { id: promoted.id } }), 0);
    assert.equal(await prisma.knowledgeSegment.count({ where: { documentId: document.id } }), 0);
  } finally {
    for (const [key, value] of Object.entries({
      KB_UNIFIED_EXTRACT: previous.unified,
      KB_ENTITY_LINK_MODE: previous.linkMode,
      ENABLE_ENTITY_EXTRACTION: previous.entities,
      MEMORY_ENTITY_LINKING: previous.memoryEntityLinking,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanup(userId, orgId).catch(() => {});
    await cleanup(otherUserId, otherOrgId).catch(() => {});
  }
});
