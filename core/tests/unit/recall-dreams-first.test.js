import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceDreamQuota } from '../../src/memory/recall-router.js';

// Helpers
const dream = (id, extra = {}) => ({ id, cognitiveLayerRole: 'canonical', ...extra });
const raw = (id, extra = {}) => ({ id, memoryType: 'fact', ...extra });

test('enforceDreamQuota caps dreams in the delivered top-N so raw evidence survives', () => {
  // Worst case: 8 dreams ranked above 4 raw memories (the old flat-boost regression).
  const ranked = [
    dream('d1'), dream('d2'), dream('d3'), dream('d4'),
    dream('d5'), dream('d6'), dream('d7'), dream('d8'),
    raw('r1'), raw('r2'), raw('r3'), raw('r4'),
  ];
  const topN = 5;
  const out = enforceDreamQuota(ranked, topN, 2);
  const delivered = out.slice(0, topN);
  const dreamsInTop = delivered.filter((m) => m.cognitiveLayerRole).length;
  const rawInTop = delivered.filter((m) => m.memoryType === 'fact').length;

  assert.ok(dreamsInTop <= 2, `expected ≤2 dreams in top-${topN}, got ${dreamsInTop}`);
  assert.ok(rawInTop >= 3, `expected raw evidence to survive in top-${topN}, got ${rawInTop} raw`);
  // The two highest-ranked dreams are kept (relative order preserved).
  assert.deepEqual(delivered.filter((m) => m.cognitiveLayerRole).map((m) => m.id), ['d1', 'd2']);
});

test('enforceDreamQuota backfills with dreams when there is not enough raw', () => {
  // Only 1 raw available; topN=5 must still be filled (dreams backfill).
  const ranked = [dream('d1'), dream('d2'), dream('d3'), dream('d4'), raw('r1'), dream('d5')];
  const out = enforceDreamQuota(ranked, 5, 2);
  assert.equal(out.slice(0, 5).length, 5, 'top-N must still be filled');
  assert.ok(out.slice(0, 5).some((m) => m.id === 'r1'), 'the single raw must be delivered');
});

test('enforceDreamQuota is a no-op when results already fit topN', () => {
  const ranked = [dream('d1'), raw('r1'), raw('r2')];
  const out = enforceDreamQuota(ranked, 5, 2);
  assert.deepEqual(out.map((m) => m.id), ['d1', 'r1', 'r2']);
});

test('enforceDreamQuota preserves all items (none dropped, only reordered)', () => {
  const ranked = [dream('d1'), dream('d2'), dream('d3'), raw('r1'), raw('r2')];
  const out = enforceDreamQuota(ranked, 3, 1);
  assert.equal(out.length, ranked.length);
  assert.deepEqual(new Set(out.map((m) => m.id)), new Set(ranked.map((m) => m.id)));
});
