import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('native AMR lexical recall preserves non-Latin letters and numbers', async (t) => {
  let AmrMemoryStore;
  try { ({ AmrMemoryStore } = await import('../../src/vector/mneme/amr-store.mjs')); }
  catch (error) { t.skip(`native binding unavailable: ${error.message}`); return; }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-multilingual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new AmrMemoryStore({ dataRoot: root, org: 'multilingual-canary', dim: 8 });
  const rows = [
    {
      id: '00000000-0000-4000-8000-00000000d101',
      content: 'رمز العقد هو ٩٨٧٦ وتاريخ المراجعة في مارس.',
      query: 'ما هو رمز العقد ٩٨٧٦؟',
    },
    {
      id: '00000000-0000-4000-8000-00000000d102',
      content: 'La bomba de calor SolvisLea se lanzó en marzo de 2021.',
      query: '¿Cuándo se lanzó la bomba de calor SolvisLea?',
    },
  ];
  rows.forEach((row, index) => {
    const vector = new Float32Array(8);
    vector[index] = 1;
    store.write({ ...row, memoryType: 'fact', isLatest: true, layer: 'memory' }, vector);
  });

  for (const row of rows) {
    const hits = store.lexical(row.query, { layer: 'memory', is_latest: true }, 5);
    assert.equal(hits[0]?.id, row.id);
  }
});
