import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentParseProvenance } from '../../src/knowledge/document-parse-provenance.js';

test('a successful retry heals stale failed parser provenance', () => {
  const projection = buildDocumentParseProvenance({
    parseResult: {
      success: true,
      engine: 'pdf-parse',
      wordCount: 1234,
      metadata: { pages: 90 },
    },
    documentType: 'report',
    documentTypeConfidence: 0.98,
  });

  assert.deepEqual(projection, {
    wordCount: 1234,
    parseStatus: 'parsed',
    parseEngine: 'pdf-parse',
    parseMetadata: { pages: 90, document_type: 'report', document_type_confidence: 0.98 },
    structureExtracted: true,
  });
});

test('a failed parse remains explicit and never claims extracted structure', () => {
  const projection = buildDocumentParseProvenance({
    parseResult: { success: false, engine: 'unparsed', error: 'no parser' },
    documentType: 'document',
    documentTypeConfidence: 0.5,
  });
  assert.equal(projection.parseStatus, 'failed');
  assert.equal(projection.parseEngine, 'unparsed');
  assert.equal(projection.structureExtracted, false);
});
