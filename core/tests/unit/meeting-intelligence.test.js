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

import { continuity } from '../../src/knowledge/meeting-intelligence.js';

test('continuity: emits UPDATES/CONFLICTS above floor, drops NEW + low-confidence + ungrounded', async () => {
  const recall = async (q) => {
    if (q.includes('18%')) return { memories: [{ id: 'p1', content: '15% rev-share with B&B' }] };
    if (q.includes('Austria')) return { memories: [{ id: 'p2', content: 'Germany-first, Austria phase 2' }] };
    if (q.includes('Switzerland')) return { memories: [] };
    return { memories: [] };
  };
  const judge = async ({ pairs }) => ({
    results: pairs.map((p) => {
      if (p.decision.includes('18%')) return { relation: 'UPDATES', reason: '15→18', confidence: 0.82 };
      if (p.decision.includes('Austria')) return { relation: 'CONFLICTS', reason: 'order', confidence: 0.4 };
      return { relation: 'NEW', confidence: 0.9 };
    }),
  });
  const out = await continuity(
    ['Raise B&B commission to 18%', 'Launch in Austria first', 'Add Switzerland'],
    { recall, judge, maxDecisions: 8, minConfidence: 0.6 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].relation, 'UPDATES');
  assert.equal(out[0].prior_memory_id, 'p1');
  assert.equal(out[0].confidence, 0.82);
});

import { openLoops, generateIntelligence } from '../../src/knowledge/meeting-intelligence.js';

test('openLoops: surfaces unresolved risk/action memories, grounded', async () => {
  const recall = async () => ({ memories: [
    { id: 'r1', content: 'B&B contract not countersigned', tags: ['risk'], created_at: '2026-06-01T00:00:00Z', meeting_id: 'mtg-old' },
    { id: 'd1', content: 'random doc', tags: ['fact'] },
  ] });
  const out = await openLoops(['B&B'], { recall, maxTopics: 6 });
  assert.equal(out.length, 1);
  assert.equal(out[0].memory_id, 'r1');
  assert.equal(out[0].kind, 'risk');
});

test('generateIntelligence: all lanes empty → status empty', async () => {
  const recall = async () => ({ memories: [] });
  const judge = async () => ({ briefs: {}, results: [] });
  const meeting = { insights: { entities: { people: ['X'], organizations: [] }, decisions: ['Y'], topics: ['Z'] } };
  const out = await generateIntelligence(meeting, { recall, judge });
  assert.equal(out.status, 'empty');
  assert.equal(out.entities.length, 0);
  assert.equal(out.continuity.length, 0);
  assert.equal(out.open_loops.length, 0);
});

test('generateIntelligence: any populated lane → status ready + related_count', async () => {
  const recall = async (q) => q === 'X' ? { memories: [{ id: 'm1', content: 'about X' }] } : { memories: [] };
  const judge = async () => ({ briefs: { X: 'X is a person' }, results: [] });
  const meeting = { insights: { entities: { people: ['X'], organizations: [] }, decisions: [], topics: [] } };
  const out = await generateIntelligence(meeting, { recall, judge });
  assert.equal(out.status, 'ready');
  assert.equal(out.entities.length, 1);
  assert.ok(out.related_count >= 1);
  assert.ok(out.generated_at);
});

import { relatedMemories } from '../../src/knowledge/meeting-intelligence.js';

test('relatedMemories: surfaces real memories, drops synthesis/test artifacts', async () => {
  const recall = async () => ({ memories: [
    { id: 'r1', title: 'We raised €200K angel round', content: 'fundraising note' },
    { id: 's1', title: 'Bridge: entity-120b-test', content: 'junk', tags: ['synthesis:bridge'] },
    { id: 's2', title: 'Canonical fact: test-md-hivemind', content: 'junk' },
    { id: 's3', title: 'real', content: 'x', cognitive_layer_role: 'canonical' },
    { id: 'r2', title: 'Wie denkt ein Business Angel', content: 'event' },
  ] });
  const out = await relatedMemories(['angel investing'], { recall, max: 5 });
  assert.deepEqual(out.map((o) => o.memory_id), ['r1', 'r2']);
});
