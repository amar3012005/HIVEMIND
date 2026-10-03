import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceWindows, joinSourceSegments, windowSegments } from '../../src/knowledge/source-windows.js';

test('windows retain exact slices, repeated text, and every non-whitespace source character', () => {
  const source = ('Repeated title\n\nFirst fact has a condition.\nSecond fact has a number: 123.\n\n').repeat(30) + 'Final critical deadline: 31 December 2027.';
  const windows = sourceWindows(source, { targetSize: 180, maxSize: 250, minSize: 70, overlapSize: 35 });
  const covered = new Set();
  for (const w of windows) {
    assert.equal(w.text, source.slice(w.startOffset, w.endOffset));
    for (let i = w.startOffset; i < w.endOffset; i++) covered.add(i);
  }
  for (let i = 0; i < source.length; i++) if (!/\s/.test(source[i])) assert.ok(covered.has(i), `unread character ${i}`);
  assert.ok(windows.at(-1).text.includes('31 December 2027'));
  assert.ok(windows.at(-1).startOffset > windows[0].startOffset);
});
test('source map reads beyond twenty sections and returns the actual section', () => {
  const segments = Array.from({ length: 54 }, (_, i) => ({ id: `s${i}`, content: `Section ${i}: Exact evidence for topic ${i}.\n  Repeated words.` }));
  const map = joinSourceSegments(segments);
  const windows = sourceWindows(map.text, { targetSize: 120, maxSize: 150, minSize: 40, overlapSize: 15 });
  const read = new Set(windows.flatMap(w => windowSegments(w, map.ranges).map(s => s.id)));
  assert.equal(read.size, 54);
  assert.ok(read.has('s53'));
  const final = map.ranges.at(-1);
  assert.deepEqual(windowSegments({ startOffset: final.start, endOffset: final.end }, map.ranges).map(s => s.id), ['s53']);
});
test('tiny final sections and long unbroken tokens are retained', () => {
  for (const text of ['x', 'a'.repeat(600), 'Important fact.\n\nX']) {
    const result = sourceWindows(text, { targetSize: 40, maxSize: 60, minSize: 20, overlapSize: 0 });
    assert.equal(result.map(x => x.text).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  }
});
