import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecallSpine } from '../../src/memory/persisted-retrieval.js';

// PHASE-B: buildRecallSpine is a pure partitioner — no DB, no Qdrant, no IO.
// It slots already-scored memories into l2_principles / l1_summaries /
// supporting_facts, flattens+dedupes synthesized[].evidence, and never throws.

test('(a) canonical-fact + synthesis-bridge → both l2_principles, bridge also in bridges', () => {
  const mems = [
    { id: 'c1', source_metadata: { source_type: 'canonical-fact' }, tags: ['synthesis:canonical'] },
    { id: 'b1', source_metadata: { source_type: 'synthesis-bridge' }, tags: ['synthesis:bridge'] },
  ];
  const spine = buildRecallSpine(mems, []);
  assert.equal(spine.l2_principles.length, 2);
  assert.deepEqual(spine.l2_principles.map(m => m.id).sort(), ['b1', 'c1']);
  assert.equal(spine.bridges.length, 1);
  assert.equal(spine.bridges[0].id, 'b1');
  assert.equal(spine.l1_summaries.length, 0);
  assert.equal(spine.supporting_facts.length, 0);
});

test('(b) compression-role → l1_summaries', () => {
  const mems = [{ id: 's1', cognitive_layer_role: 'compression' }];
  const spine = buildRecallSpine(mems, []);
  assert.equal(spine.l1_summaries.length, 1);
  assert.equal(spine.l1_summaries[0].id, 's1');
  assert.equal(spine.l2_principles.length, 0);
  assert.equal(spine.supporting_facts.length, 0);
});

test('(c) plain fact → supporting_facts', () => {
  const mems = [{ id: 'f1', tags: ['extracted-fact'] }];
  const spine = buildRecallSpine(mems, []);
  assert.equal(spine.supporting_facts.length, 1);
  assert.equal(spine.supporting_facts[0].id, 'f1');
  assert.equal(spine.l2_principles.length, 0);
  assert.equal(spine.l1_summaries.length, 0);
});

test('(d) synthesized[].evidence → evidence deduped by id', () => {
  const synthesized = [
    { id: 'c1', evidence: [{ id: 'e1', snippet: 'a' }, { id: 'e2', snippet: 'b' }] },
    { id: 'c2', evidence: [{ id: 'e2', snippet: 'b-dup' }, { id: 'e3', snippet: 'c' }] },
  ];
  const spine = buildRecallSpine([], synthesized);
  assert.equal(spine.evidence.length, 3);
  assert.deepEqual(spine.evidence.map(e => e.id), ['e1', 'e2', 'e3']);
  // First-wins dedupe — e2 keeps the snippet from the first occurrence.
  assert.equal(spine.evidence.find(e => e.id === 'e2').snippet, 'b');
});

test('(e) empty input → all-empty tiers, no throw', () => {
  const spine = buildRecallSpine([], []);
  assert.deepEqual(spine, {
    l2_principles: [], l1_summaries: [], supporting_facts: [], evidence: [], bridges: [],
  });
  // Non-array args must also be tolerated.
  const spine2 = buildRecallSpine(undefined, null);
  assert.deepEqual(spine2.l2_principles, []);
  assert.deepEqual(spine2.evidence, []);
});

test('(f) malformed item (no tags/role) → supporting_facts, no throw', () => {
  const mems = [{ id: 'x1' }, { id: 'x2', tags: null }];
  const spine = buildRecallSpine(mems, []);
  assert.equal(spine.supporting_facts.length, 2);
  assert.equal(spine.l2_principles.length, 0);
});

test('ordering invariant: l2 → l1 → supporting → evidence partitions are disjoint and complete', () => {
  const mems = [
    { id: 'L2', cognitive_layer_role: 'canonical' },
    { id: 'L1', cognitive_layer_role: 'reflection' },
    { id: 'SF', tags: ['extracted-fact'] },
  ];
  const synthesized = [{ id: 'L2', evidence: [{ id: 'ev1' }] }];
  const spine = buildRecallSpine(mems, synthesized);

  // Each input memory lands in exactly one of the three primary tiers.
  const primaryIds = [
    ...spine.l2_principles.map(m => m.id),
    ...spine.l1_summaries.map(m => m.id),
    ...spine.supporting_facts.map(m => m.id),
  ];
  assert.equal(primaryIds.length, 3);
  assert.deepEqual([...primaryIds].sort(), ['L1', 'L2', 'SF']);

  // Tier membership order: l2 before l1 before supporting (positional contract).
  assert.equal(spine.l2_principles[0].id, 'L2');
  assert.equal(spine.l1_summaries[0].id, 'L1');
  assert.equal(spine.supporting_facts[0].id, 'SF');
  // Evidence derives from synthesized, separate from the memory partitions.
  assert.equal(spine.evidence[0].id, 'ev1');
});
