import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextualEmbedInput,
  contextualEmbedInputForSegment,
} from '../../src/knowledge/contextual-embed-input.js';

test('anchors a chunk to its document and heading path', () => {
  // The failure this prevents: a chunk reading "94 Prozent" embedded as a bare number, retrievable
  // only by a query that happens to say "94 Prozent".
  const out = contextualEmbedInput(
    { documentTitle: 'Q3 Pitch Deck', headingPath: 'Unit Economics › Pricing' },
    'Die Effizienz liegt bei 94 Prozent.',
  );
  assert.equal(out, '[Q3 Pitch Deck › Unit Economics › Pricing]\nDie Effizienz liegt bei 94 Prozent.');
});

test('falls back to the leaf heading when no path is known', () => {
  const out = contextualEmbedInput({ documentTitle: 'Deck', heading: 'Pricing' }, 'body');
  assert.equal(out, '[Deck › Pricing]\nbody');
});

test('embeds text unchanged when there is nothing to anchor to', () => {
  // Never fabricate an anchor: an empty bracket would be a token every chunk shares, which is
  // worse than no prefix at all.
  assert.equal(contextualEmbedInput({}, 'body'), 'body');
  assert.equal(contextualEmbedInput({ documentTitle: '   ' }, 'body'), 'body');
  assert.equal(contextualEmbedInput(undefined, 'body'), 'body');
});

test('a pathological heading path cannot eat the embedding window', () => {
  const out = contextualEmbedInput({ headingPath: 'x'.repeat(5000) }, 'body');
  const prefix = out.slice(0, out.indexOf('\n'));
  assert.ok(prefix.length <= 202, `prefix was ${prefix.length} chars`);
  assert.ok(out.endsWith('\nbody'), 'the chunk text must survive intact');
});

test('reads context straight off a segment record', () => {
  const segment = {
    content: 'Der Rahmenvertrag läuft bis 2027.',
    metadata: { document_title: 'Nordwind', heading_path: 'Verträge › Laufzeit' },
  };
  assert.equal(
    contextualEmbedInputForSegment(segment),
    '[Nordwind › Verträge › Laufzeit]\nDer Rahmenvertrag läuft bis 2027.',
  );
});

test('stored content is never mutated — the prefix exists only in the embed input', () => {
  // Prefixing stored content would put a synthetic header inside every quoted citation AND inside
  // every lexical match. The helper must be pure with respect to the record.
  const segment = { content: 'raw text', metadata: { document_title: 'D', heading_path: 'H' } };
  const before = JSON.parse(JSON.stringify(segment));
  const out = contextualEmbedInputForSegment(segment);
  assert.deepEqual(segment, before, 'segment must be untouched');
  assert.notEqual(out, segment.content);
  assert.ok(out.endsWith('raw text'));
});

test('malformed segments degrade to their text rather than throwing', () => {
  assert.equal(contextualEmbedInputForSegment({}), '');
  assert.equal(contextualEmbedInputForSegment({ content: 't' }), 't');
  assert.equal(contextualEmbedInputForSegment({ content: 't', metadata: null }), 't');
});
