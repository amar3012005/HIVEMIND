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

const base = {
  userId: 'user-1', orgId: 'org-1', content: 'A durable source claim.',
  source: { type: 'api', source_id: 'source-1' },
};

test('canonical envelope rejects relationship memory rows', () => {
  const result = validateEnvelope({ ...base, metadata: { memory_type: 'relationship' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /memory_type/);
});

test('document ingestMode is independent from the legacy evidence record mode', () => {
  assert.deepEqual(validateEnvelope({ ...base, mode: 'document', ingestMode: 'evidence' }), { ok: true });
  const invalid = validateEnvelope({ ...base, ingestMode: 'semantic-only' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /ingestMode/);
});

test('legacy ingest_mode selects evidence policy without corrupting document versus atomic routing', () => {
  const both = legacyPayloadToEnvelope({ ...base, ingest_mode: 'both' });
  assert.equal(both.ingestMode, 'both');
  assert.equal(both.mode, undefined);
  assert.deepEqual(validateEnvelope(both), { ok: true });

  const evidence = legacyPayloadToEnvelope({ ...base, ingest_mode: 'evidence' });
  assert.equal(evidence.ingestMode, 'evidence');
  assert.equal(evidence.mode, undefined);
  assert.deepEqual(validateEnvelope(evidence), { ok: true });
});

test('canonical provenance accepts snake-case external source ids', () => {
  const provenance = normalizeProvenance(base);
  assert.equal(provenance.sourceMetadata.source_id, 'source-1');
  assert.equal(provenance.sourceMetadata.source_external_id, 'source-1');
  assert.equal(provenance.sourceMetadata.source_version, '1');
  assert.equal(provenance.sourceMetadata.uploader_user_id, 'user-1');
  assert.equal(provenance.sourceMetadata.organization_id, 'org-1');
  assert.match(provenance.sourceMetadata.content_checksum, /^[a-f0-9]{64}$/);
  assert.ok(provenance.provenanceTags.includes('source-id:source-1'));
});

test('canonical provenance captures immutable revision, scope, consent and extraction policy', () => {
  const provenance = normalizeProvenance({
    ...base,
    knownAt: '2026-09-13T10:00:00Z',
    occurredAt: '2026-09-12T09:00:00Z',
    scope: 'project', projectId: 'project-1',
    ingestMode: 'evidence',
    consent: { lawful_basis: 'contract', receipt_id: 'consent-1' },
    source: { type: 'connector', provider: 'gmail', sourceId: 'message-1', version: 'rev-4', checksum: 'abc123' },
  });
  assert.equal(provenance.sourceMetadata.source_version, 'rev-4');
  assert.equal(provenance.sourceMetadata.content_checksum, 'abc123');
  assert.equal(provenance.sourceMetadata.known_at, '2026-09-13T10:00:00.000Z');
  assert.equal(provenance.sourceMetadata.event_time, '2026-09-12T09:00:00.000Z');
  assert.equal(provenance.sourceMetadata.scope, 'project');
  assert.equal(provenance.sourceMetadata.project_id, 'project-1');
  assert.equal(provenance.sourceMetadata.consent.receipt_id, 'consent-1');
  assert.equal(provenance.sourceMetadata.extraction_policy.model_calls, 'forbidden');
});

test('explicit evidence routing records a zero-model extraction policy', () => {
  const provenance = normalizeProvenance({ ...base, mode: 'evidence' });
  assert.equal(provenance.sourceMetadata.extraction_policy.ingest_mode, 'evidence');
  assert.equal(provenance.sourceMetadata.extraction_policy.model_calls, 'forbidden');
});

test('missing upstream source identity is stable across retries', () => {
  const first = normalizeProvenance({ ...base, source: { type: 'api' } });
  const second = normalizeProvenance({ ...base, source: { type: 'api' } });
  assert.equal(first.sourceId, second.sourceId);
  assert.equal(first.sourceId, first.contentChecksum);
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
  assert.equal(canonicalSourceType({ source_metadata: { source_platform: 'talk-to-hive' } }), 'chat');
  assert.equal(canonicalSourceType({ source_metadata: { source_platform: 'google-drive' } }), 'connector');
});

test('legacy chat save preserves structured entities and explicit memory type', () => {
  const envelope = legacyPayloadToEnvelope({
    user_id: 'user-1', org_id: 'org-1',
    title: 'Product decision',
    content: 'We decided to consolidate HIVEMIND, BRAIN, OS, and VOICE.',
    memory_type: 'decision',
    entities: ['HIVEMIND', { name: 'BRAIN', kind: 'product' }],
    source_metadata: { source_platform: 'talk-to-hive', source_type: 'chat-turn' },
  }, { mode: 'atomic' });

  assert.equal(envelope.metadata.memory_type, 'decision');
  assert.deepEqual(envelope.metadata.extracted_entities, ['HIVEMIND', { name: 'BRAIN', kind: 'product' }]);
  assert.equal(detectMode(envelope), 'atomic');
});

test('every source type shares the same provenance and mode contract', () => {
  const cases = [
    ['kb', 'knowledge_base', 'document'],
    ['connector', 'connector:gmail', 'document'],
    ['mcp', 'mcp', 'atomic'],
    ['meeting', 'meeting', 'document'],
    ['chat', 'chat', 'atomic'],
    ['api', 'api', 'document'],
  ];

  for (const [type, expectedPlatform, expectedMode] of cases) {
    const envelope = {
      userId: 'user-1',
      orgId: 'org-1',
      content: 'A'.repeat(1300),
      occurredAt: '2026-07-16T10:00:00Z',
      source: {
        type,
        ...(type === 'connector' ? { provider: 'gmail' } : {}),
        sourceId: `${type}-source-1`,
        version: 'revision-1',
        title: `${type} source`,
      },
    };
    const provenance = normalizeProvenance(envelope);

    assert.deepEqual(validateEnvelope(envelope), { ok: true }, type);
    assert.equal(provenance.sourcePlatform, expectedPlatform, type);
    assert.equal(provenance.sourceMetadata.ingest_source, type, type);
    assert.equal(provenance.sourceMetadata.source_id, `${type}-source-1`, type);
    assert.equal(provenance.sourceMetadata.source_version, 'revision-1', type);
    assert.ok(provenance.provenanceTags.includes(`source:${type}`), type);
    assert.equal(detectMode(envelope), expectedMode, type);
  }
});
