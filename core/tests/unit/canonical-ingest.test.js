import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMode, normalizeProvenance, validateEnvelope } from '../../src/knowledge/canonical-ingest.js';

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
