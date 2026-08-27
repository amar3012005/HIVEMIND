import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../../byod/agent/server.mjs', import.meta.url), 'utf8');

test('Memory Box advertises versioned storage and recovery capabilities', () => {
  for (const marker of [
    "PROTOCOL_VERSION = 'memory-box.v1'",
    "storage_mode: 'byod_postgres_qdrant'",
    "'memory.recall'",
    "'memory.inventory.total'",
    "'evidence.recall'",
    "'evidence.lexical'",
    "'graph.read'",
    "'vector.status'",
    "'vector.pending'",
    "'vector.repair'",
  ]) assert.ok(source.includes(marker), `missing capability marker: ${marker}`);
});

test('Memory Box health exposes protocol, release, and storage mode', () => {
  assert.match(source, /protocol_version:\s*PROTOCOL_VERSION/);
  assert.match(source, /agent_release:\s*AGENT_RELEASE/);
  assert.match(source, /storage_mode:\s*'byod_postgres_qdrant'/);
});
