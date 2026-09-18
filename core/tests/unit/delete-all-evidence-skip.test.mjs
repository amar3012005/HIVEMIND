import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const server = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.js'),
  'utf8',
);

test('delete-all skips the shared hivemind_evidence collection on per-tenant Qdrant', () => {
  assert.match(server, /perTenant \? \[\] : \[legacyEvidence\]/);
  assert.match(server, /collection === legacyEvidence \? 'false' : 'true'/);
  assert.match(server, /Qdrant \$\{collection\} delete failed/);
});
