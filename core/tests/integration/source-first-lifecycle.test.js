import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { getPrismaClient, ensureTenantContext } from '../../src/db/prisma.js';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';
import { PrismaGraphStore } from '../../src/memory/prisma-graph-store.js';
import { MemoryGraphEngine } from '../../src/memory/graph-engine.js';
import { recallPersistedMemories } from '../../src/memory/persisted-retrieval.js';
import { buildRecallPacket, validateGroundedClaims } from '../../src/memory/recall-packet.js';

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
  };
  process.env.KB_UNIFIED_EXTRACT = 'true';
  process.env.KB_ENTITY_LINK_MODE = 'algo';
  process.env.ENABLE_ENTITY_EXTRACTION = 'false';

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
    const quote = 'The retention policy requires customer records to be kept for seven years.';
    if (!window.content.includes(quote)) return [];
    return [{
      t: 'Customer record retention',
      f: 'Customer records must be retained for seven years.',
      memory_type: 'fact',
      source_quote: quote,
      source_start: window.content.indexOf(quote),
      source_end: window.content.indexOf(quote) + quote.length,
      importance: 0.92,
      entities: ['Customer Records'],
      rels: [],
    }];
  };

  const content = Buffer.from([
    '# Records Policy',
    'This policy governs the handling of customer records throughout the organization.',
    'The retention policy requires customer records to be kept for seven years.',
    'After that period, authorized staff must review the records before secure disposal.',
    'The requirement applies to every managed customer workspace and remains auditable.',
  ].join('\n\n'));

  try {
    const ingested = await service.ingestKnowledgeDocument({
      userId, orgId, filename: 'records-policy.md', fileBuffer: content,
      contentType: 'text/markdown', metadata: { scope: 'organization', document_type: 'policy', tags: ['policy'] },
    });
    assert.ok(ingested.segmentCount >= 1);
    assert.equal(ingested.promotedCount, 2); // one curated claim plus its document-summary parent
    assert.equal(evidenceWrites.length, ingested.segmentCount);
    assert.equal(vectorWrites.length, 1);

    const document = await prisma.knowledgeDocument.findUnique({ where: { id: ingested.documentId } });
    const segments = await prisma.knowledgeSegment.findMany({ where: { documentId: ingested.documentId }, orderBy: { segmentIndex: 'asc' } });
    const promoted = await prisma.memory.findFirst({ where: { userId, orgId, tags: { has: 'distilled-from-kb' } } });
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
    assert.equal(await prisma.memoryEvidenceLink.count({ where: { documentId: concurrentDocumentId } }), 1);

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
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanup(userId, orgId).catch(() => {});
    await cleanup(otherUserId, otherOrgId).catch(() => {});
  }
});
