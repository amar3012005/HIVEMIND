import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMemoryType,
  canonicalSourceType,
  detectMode,
  legacyPayloadToEnvelope,
  normalizeProvenance,
  validateEnvelope,
} from '../../src/knowledge/canonical-ingest.js';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';

const base = {
  userId: 'user-1', orgId: 'org-1', content: 'A durable source claim.',
  source: { type: 'api', source_id: 'source-1' },
};

test('canonical envelope rejects relationship memory rows', () => {
  const result = validateEnvelope({ ...base, metadata: { memory_type: 'relationship' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /memory_type/);
});

test('canonical provenance accepts snake-case external source ids', () => {
  const provenance = normalizeProvenance(base);
  assert.equal(provenance.sourceMetadata.source_id, 'source-1');
  assert.ok(provenance.provenanceTags.includes('source-id:source-1'));
});

test('canonical mode keeps explicit mode authoritative', () => {
  assert.equal(detectMode({ ...base, mode: 'atomic', content: 'x'.repeat(5000) }), 'atomic');
  assert.equal(detectMode({ ...base, source: { type: 'connector' }, content: 'x'.repeat(1300) }), 'document');
});

test('legacy source payloads normalize into the canonical envelope', () => {
  const envelope = legacyPayloadToEnvelope({
    user_id: 'user-1', org_id: 'org-1', content: 'A durable Slack decision.',
    title: 'Decision', memory_type: 'note', scope: 'project', project_ids: ['project-1'],
    source_metadata: {
      source_platform: 'slack', source_id: 'thread-1', source_url: 'https://example.test/thread-1',
      channel_id: 'C123', thread_ts: '171234.0001',
    },
  });
  assert.equal(envelope.source.type, 'connector');
  assert.equal(envelope.source.platform, 'slack');
  assert.equal(envelope.source.sourceId, 'thread-1');
  assert.equal(normalizeProvenance(envelope).sourceMetadata.channel_id, 'C123');
  assert.equal(normalizeProvenance(envelope).sourceMetadata.thread_ts, '171234.0001');
  assert.equal(envelope.metadata.memory_type, 'fact');
  assert.equal(envelope.projectId, 'project-1');
  assert.deepEqual(validateEnvelope(envelope), { ok: true });
});

test('canonical compatibility mapping never creates relationship memories', () => {
  assert.equal(canonicalMemoryType('relationship'), 'fact');
  assert.equal(canonicalMemoryType('commitment'), 'goal');
  assert.equal(canonicalMemoryType('conversation'), 'summary');
  assert.equal(canonicalSourceType({ source_metadata: { source_platform: 'talk-to-hive' } }), 'chat');
  assert.equal(canonicalSourceType({ source_metadata: { source_platform: 'google-drive' } }), 'connector');
});

test('legacy conversation input validates only through summary normalization', () => {
  const envelope = legacyPayloadToEnvelope({
    user_id: 'user-1', org_id: 'org-1', content: 'A short conversation summary.',
    memory_type: 'conversation', source_metadata: { source_platform: 'slack' },
  });
  assert.equal(envelope.metadata.memory_type, 'summary');
  assert.deepEqual(validateEnvelope(envelope), { ok: true });
});

test('canonical dispatcher persists legacy conversation input as a summary', async () => {
  let persisted = null;
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      ingestMemory: async (payload) => {
        persisted = payload;
        return { memoryId: 'memory-1' };
      },
    },
    logger: { info() {}, warn() {} },
  });
  const result = await service.ingestSource({
    ...base,
    source: { type: 'chat', platform: 'talk-to-hive', sourceId: 'turn-1' },
    mode: 'atomic',
    metadata: { memory_type: 'conversation' },
  });
  assert.equal(result.ok, true);
  assert.equal(persisted.memory_type, 'summary');
});
