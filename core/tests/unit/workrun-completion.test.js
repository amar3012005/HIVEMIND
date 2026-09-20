import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkRunCompletion } from '../../src/employees/workrun-completion.js';

const contract = {
  tasks: { min_completed: 2, require_all_completed: true },
  artifacts: { min_count: 1 },
};

test('completion contracts require selected-playbook tasks and artifact pointers', () => {
  const blocked = validateWorkRunCompletion({
    scope: { completion_contract: contract },
    events: [{ t: 'plan.updated', tasks: [
      { id: 'one', state: 'completed' },
      { id: 'two', state: 'in_progress' },
    ] }],
    resultArtifactIds: [],
  });
  assert.equal(blocked.passed, false);
  assert.deepEqual(blocked.unmet.map((item) => item.predicate), [
    'tasks.min_completed', 'tasks.require_all_completed', 'artifacts.min_count',
  ]);

  const passed = validateWorkRunCompletion({
    scope: { completion_contract: contract },
    events: [{ t: 'plan.updated', tasks: [
      { id: 'one', state: 'completed' },
      { id: 'two', state: 'done' },
    ] }],
    resultArtifactIds: ['artifact-1'],
  });
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.unmet, []);
});

test('a WorkRun without a selected completion contract remains completable', () => {
  assert.deepEqual(validateWorkRunCompletion({ scope: {}, events: [], resultArtifactIds: [] }), {
    passed: true,
    unmet: [],
    contract: null,
  });
});
