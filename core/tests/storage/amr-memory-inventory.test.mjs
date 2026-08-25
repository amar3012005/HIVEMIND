import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AmrMemoryStore } from '../../src/vector/mneme/amr-store.mjs';

test('AMR memory inventory filter excludes evidence from list and stats', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-memory-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const amr = new AmrMemoryStore({ dataRoot: root, org: 'inventory-org', dim: 2 });
  const write = (id, layer) => amr.write({
    id,
    content: `${layer} record`,
    layer,
    isLatest: true,
    createdAt: new Date().toISOString(),
  }, [1, 0]);

  write('memory-1', 'memory');
  write('cognitive-1', 'cognitive');
  write('evidence-1', 'evidence');

  const filter = { layers: ['memory', 'cognitive'] };
  assert.deepEqual(amr.list(filter, null, 10).memories.map((row) => row.id).sort(), ['cognitive-1', 'memory-1']);
  assert.equal(amr.stats(filter).memories, 2);
  assert.equal(amr.stats({}).memories, 3, 'the store remains able to report all live content when an internal caller explicitly asks');
});
