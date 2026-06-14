import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyGrounded } from '../../src/knowledge/meeting-intelligence.js';

test('onlyGrounded keeps lines with a memory id, drops the rest', () => {
  const items = [
    { brief: 'has id', memory_ids: ['abc'] },
    { brief: 'empty ids', memory_ids: [] },
    { brief: 'no ids field' },
    { brief: 'single id', memory_id: 'xyz' },
  ];
  const kept = onlyGrounded(items);
  assert.deepEqual(kept.map((i) => i.brief), ['has id', 'single id']);
});

import { entityBriefs } from '../../src/knowledge/meeting-intelligence.js';

test('entityBriefs: recalls per entity, drops zero-hit, compresses with judge', async () => {
  const recall = async (q) => q === 'Uwe Berger'
    ? { memories: [{ id: 'm1', title: 'Uwe', content: 'MD of B&B' }, { id: 'm2', content: 'partner' }] }
    : { memories: [] };
  const judge = async () => ({ briefs: { 'Uwe Berger': 'MD of B&B, DACH partner' } });
  const out = await entityBriefs(
    [{ name: 'Uwe Berger', kind: 'person' }, { name: 'Nobody', kind: 'person' }],
    { recall, judge, maxEntities: 6 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Uwe Berger');
  assert.equal(out[0].memory_count, 2);
  assert.deepEqual(out[0].memory_ids, ['m1', 'm2']);
  assert.equal(out[0].brief, 'MD of B&B, DACH partner');
});

test('entityBriefs caps the number of entities queried', async () => {
  let calls = 0;
  const recall = async () => { calls += 1; return { memories: [{ id: 'x' }] }; };
  const judge = async () => ({ briefs: {} });
  const ents = Array.from({ length: 20 }, (_, i) => ({ name: `E${i}`, kind: 'org' }));
  await entityBriefs(ents, { recall, judge, maxEntities: 6 });
  assert.equal(calls, 6);
});
