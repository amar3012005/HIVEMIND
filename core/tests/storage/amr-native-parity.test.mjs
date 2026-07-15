import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../fixtures/amr-native-phase.mjs', import.meta.url));

function runPhase(phase, root) {
  const result = spawnSync(process.execPath, [helper, phase, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('native AMR preserves canonical memory, evidence, graph, durability, and tenant routing', () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-amr-parity-'));
  try {
    const written = runPhase('write', root);
    assert.deepEqual(written, { memories: 2, relationships: 1, segments: 1, evidenceLinks: 1 });

    const reloaded = runPhase('read', root);
    assert.equal(reloaded.memories, 2);
    assert.equal(reloaded.relationshipType, 'PartOf');
    assert.equal(reloaded.segmentContent, 'Records are retained for seven years.');
    assert.equal(reloaded.evidenceSegmentId, '00000000-0000-4000-8000-00000000a202');
    assert.equal(reloaded.recalledId, '00000000-0000-4000-8000-00000000a102');
    assert.equal(reloaded.otherTenantId, 'pg-memory');
    assert.equal(reloaded.postgresCalls, 1);

    assert.deepEqual(runPhase('delete', root), { deleted: true });
    assert.deepEqual(runPhase('read-deleted', root), {
      memories: 0,
      relationships: 0,
      segments: 0,
      evidenceLinks: 0,
      documents: 0,
      deletedClaimRecalled: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
