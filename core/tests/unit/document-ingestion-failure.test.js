import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';

test('malformed document retains its raw artifact but creates no document, segments, or memories', async () => {
  const calls = [];
  const db = {
    sourceArtifact: {
      upsert: async () => {
        calls.push('sourceArtifact.upsert');
        return { id: 'artifact-1' };
      },
    },
    knowledgeDocument: {
      upsert: async () => calls.push('knowledgeDocument.upsert'),
      create: async () => calls.push('knowledgeDocument.create'),
    },
    knowledgeSegment: {
      create: async () => calls.push('knowledgeSegment.create'),
      createMany: async () => calls.push('knowledgeSegment.createMany'),
    },
  };
  const memoryGraphEngine = {
    ingestMemory: async () => calls.push('memoryGraphEngine.ingestMemory'),
  };
  const service = new DocumentFirstIngestionService({
    db,
    memoryGraphEngine,
    smartIngestRouter: null,
    embeddingService: null,
    logger: { info() {}, warn() {} },
  });
  service._parseDocument = async () => {
    throw new Error('malformed document payload');
  };

  await assert.rejects(
    service.ingestKnowledgeDocument({
      userId: '00000000-0000-4000-8000-00000000f101',
      orgId: '00000000-0000-4000-8000-00000000f102',
      filename: 'broken.pdf',
      fileBuffer: Buffer.from('%PDF-malformed'),
      contentType: 'application/pdf',
      metadata: { scope: 'organization' },
    }),
    /malformed document payload/,
  );

  assert.deepEqual(calls, ['sourceArtifact.upsert']);
});
