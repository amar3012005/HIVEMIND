import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonRecallable, isMetadataLayer, DOCUMENT_LAYER } from '../../src/vector/mneme/layers.mjs';

// The `document` layer holds a document's owner, scope-key grants and title so the slot can
// answer "who may see this" without Postgres. Those records are gating METADATA, not content.
// If one ever reached a recall pipeline it would be rendered to a user as though it were a
// memory. The exclusion is therefore an invariant, not a nicety.

test('document-layer records are withheld from content recall', () => {
  assert.equal(isNonRecallable({ layer: DOCUMENT_LAYER }, {}), true);
  assert.equal(isNonRecallable({ layer: DOCUMENT_LAYER }, { layer: 'memory' }), true);
  assert.equal(isNonRecallable({ layer: DOCUMENT_LAYER }, { layer: 'evidence' }), true);
});

test('the real content layers are never withheld', () => {
  // memory + evidence are recalled together on purpose (cross-layer recall is a feature);
  // withholding either would silently cut recall in half.
  for (const layer of ['memory', 'evidence', 'cognitive']) {
    assert.equal(isNonRecallable({ layer }, {}), false, `${layer} must stay recallable`);
    assert.equal(isNonRecallable({ layer }, { layer }), false);
  }
  assert.equal(isNonRecallable({}, {}), false, 'a record with no layer is a memory, not metadata');
});

test('document records are readable only by asking for them explicitly', () => {
  // Opt-IN, so a caller that forgets gets nothing rather than gating metadata dressed as content.
  assert.equal(isNonRecallable({ layer: DOCUMENT_LAYER }, { layer: DOCUMENT_LAYER }), false);
});

test('malformed records do not throw and do not become recallable metadata', () => {
  assert.equal(isNonRecallable(null, {}), false);
  assert.equal(isNonRecallable(undefined, undefined), false);
  assert.equal(isNonRecallable({ layer: DOCUMENT_LAYER }, undefined), true, 'no filter still excludes');
});

test('the entity layer is metadata too — same exclusion, no second rule', () => {
  // Entities moved into the slot as layer-4 records. They are graph structure, not content: an
  // entity surfacing in recall would render to the user as a memory whose text is a bare name.
  assert.equal(isNonRecallable({ layer: 'entity' }, {}), true);
  assert.equal(isNonRecallable({ layer: 'entity' }, { layer: 'memory' }), true);
  assert.equal(isNonRecallable({ layer: 'entity' }, { layer: 'entity' }), false, 'opt-in still reads them');
  // And adding it must not have widened the rule onto content layers.
  assert.equal(isNonRecallable({ layer: 'memory' }, {}), false);
  assert.equal(isNonRecallable({ layer: 'evidence' }, {}), false);
});

test('isMetadataLayer gates the SQL mirror — the write-path guard, untested until it leaked', () => {
  // This is the predicate /v1/write uses to decide whether a record may be mirrored into
  // hm.memories. It matters more than the recall-side exclusions: /v1/lexical runs Postgres FTS
  // over that table and does NOT go through them, which is how entity records reached a user's
  // recall as memories. A row that is never mirrored cannot leak through any future SQL reader.
  assert.equal(isMetadataLayer('document'), true);
  assert.equal(isMetadataLayer('entity'), true);

  // Content layers MUST still mirror — over-matching here silently empties the lexical lane,
  // which fails in the opposite direction and just as quietly.
  assert.equal(isMetadataLayer('memory'), false);
  assert.equal(isMetadataLayer('evidence'), false);
  assert.equal(isMetadataLayer('cognitive'), false);

  // An absent layer defaults to memory (see layerIdOf) and must therefore mirror.
  assert.equal(isMetadataLayer(undefined), false);
  assert.equal(isMetadataLayer(null), false);
  assert.equal(isMetadataLayer(''), false);
});

test('every metadata layer is BOTH non-recallable and non-mirrored', () => {
  // The two guards must not drift apart: a layer excluded from recall but still mirrored is
  // exactly the leak that shipped, and the reverse would hide content from the lexical lane.
  for (const layer of ['document', 'entity']) {
    assert.equal(isMetadataLayer(layer), true, `${layer} must not be mirrored`);
    assert.equal(isNonRecallable({ layer }, {}), true, `${layer} must not be recalled`);
  }
});
