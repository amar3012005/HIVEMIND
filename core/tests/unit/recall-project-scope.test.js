import test from 'node:test';
import assert from 'node:assert/strict';

import { applyProjectScopeFilter } from '../../src/routes/recall.js';

const memories = () => [
  { id: 'personal', scope: 'personal' },
  { id: 'organization', scope: 'organization' },
  { id: 'team', scope: 'team' },
  { id: 'project-a', scope: 'project', project_id: 'project-a' },
  { id: 'project-b', scope: 'project', project_ids: ['project-b'] },
];

test('omitted project keeps every memory already authorized by recall access_context', async () => {
  const result = { memories: memories() };
  await applyProjectScopeFilter(null, 'org', result, null);

  assert.deepEqual(result.memories.map((memory) => memory.id), [
    'personal', 'organization', 'team', 'project-a', 'project-b',
  ]);
  assert.deepEqual(result.project_scope_applied, {
    project_id: null,
    mode: 'all_authorized',
    kept: 5,
    dropped: 0,
  });
});

test('explicit project keeps shared tiers and only the selected project', async () => {
  const result = { memories: memories() };
  await applyProjectScopeFilter(null, 'org', result, 'project-a');

  assert.deepEqual(result.memories.map((memory) => memory.id), [
    'personal', 'organization', 'team', 'project-a',
  ]);
  assert.deepEqual(result.project_scope_applied, {
    project_id: 'project-a',
    mode: 'selected_project',
    kept: 4,
    dropped: 1,
  });
});
