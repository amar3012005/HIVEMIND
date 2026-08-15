import test from 'node:test';
import assert from 'node:assert/strict';
import { projectScopedAnchorFilter } from '../src/knowledge/document-delete-scope.js';

test('document deletion requires the same project scope as the selected document', () => {
  const filter = projectScopedAnchorFilter({
    orgId: 'org-1',
    documentTags: ['filename:deck.pdf', 'scope-key:project:project-a'],
    anchorTags: ['filename:deck.pdf'],
  });
  assert.deepEqual(filter.AND, [
    { tags: { hasSome: ['filename:deck.pdf'] } },
    { tags: { has: 'scope-key:project:project-a' } },
  ]);
});

test('legacy unscoped documents retain tenant-scoped deletion behavior', () => {
  const filter = projectScopedAnchorFilter({
    orgId: 'org-1',
    documentTags: ['filename:deck.pdf'],
    anchorTags: ['filename:deck.pdf'],
  });
  assert.deepEqual(filter.AND, [{ tags: { hasSome: ['filename:deck.pdf'] } }]);
});
