import assert from 'node:assert/strict';

export function assertCanonicalBackendContract(result) {
  assert.ok(result?.backend, 'backend name is required');
  assert.ok(result.memories >= 1, `${result.backend}: memory missing`);
  assert.ok(result.evidence >= 1, `${result.backend}: evidence missing`);
  assert.equal(result.relationship, 'PartOf', `${result.backend}: structural edge missing`);
  assert.equal(result.recall_hit, true, `${result.backend}: recall miss`);
  assert.equal(result.source_hydrated, true, `${result.backend}: source hydration failed`);
  assert.equal(result.isolated, true, `${result.backend}: tenant isolation failed`);
}
