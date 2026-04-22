import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnterpriseMemories } from '../../src/knowledge/enterprise/enterprise-chunker.js';

test('enterprise memories include knowledge-base tags on parent and child chunks', () => {
  const result = createEnterpriseMemories({
    documentType: 'general',
    extractedSchema: {
      summary: 'General document summary',
      fields: {},
      model_used: 'test-model',
    },
    rawText: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
    filename: 'example.pdf',
    uploadId: 'upload-123',
    userId: 'user-1',
    orgId: 'org-1',
    userTags: ['custom-tag'],
  });

  assert.ok(result.parent.tags.includes('knowledge-base'));
  assert.ok(result.parent.tags.includes('enterprise'));
  assert.ok(result.parent.tags.includes('schema-record'));
  assert.ok(result.chunks.length > 0);
  assert.ok(result.chunks[0].tags.includes('knowledge-base'));
  assert.ok(result.chunks[0].tags.includes('enterprise'));
  assert.ok(!result.chunks[0].tags.includes('schema-record'));
});
