import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeTaskMaterializerAdapter } from '../../src/runtime-playbooks/adapters/runtime-task-materializer.js';

function fixture() {
  const todos = [];
  const tx = {
    async $queryRawUnsafe() { return [{ id: 'runtime-1', epoch: 'epoch-1' }]; },
    hyperRoom: { async findFirst({ where }) { return where.roomTag === 'research' ? { id: 'room-1' } : null; } },
    hqTodo: {
      async findFirst({ where }) {
        const key = where.context.equals;
        return todos.find((todo) => todo.context.strategy_motion_key === key) || null;
      },
      async create({ data }) { const todo = { id: `todo-${todos.length + 1}`, ...data }; todos.push(todo); return todo; },
    },
  };
  const prisma = {
    runtimePlaybookRun: { async findFirst() { return { id: 'run-1', playbookId: 'marketing.strategy-to-growth-brief', playbookVersion: 3, scopeKey: 'global', trigger: { runtime_id: 'runtime-1' }, context: { request: { instruction: 'Decide' } } }; } },
    async $transaction(fn) { return fn(tx); },
  };
  const registry = { get(id, version) {
    if (id !== 'research.evidence-to-decision' || version !== 1) throw new Error('missing');
    return { metadata: { owner_room_tag: 'research', supported_actions: ['produce_source_backed_decision'] } };
  } };
  return { prisma, todos, registry };
}

test('strategy portfolio materialization is per-motion, evidence-bound and idempotent', async () => {
  const { prisma, todos, registry } = fixture();
  const adapter = createRuntimeTaskMaterializerAdapter({ prisma, getService: () => ({ registry }) });
  const portfolio = {
    id: 'portfolio-1', source_refs: ['evidence-1'], data: { motions: [
      { motion_id: 'valid', title: 'Validate category', objective: 'Make a decision', expected_outcome: 'decision_ready',
        playbook_id: 'research.evidence-to-decision', playbook_version: 1, supported_action: 'produce_source_backed_decision',
        effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Decision accepted', dependencies: [], priority: 1 },
      { motion_id: 'invalid', title: 'Unknown work', objective: 'Unknown', expected_outcome: 'done',
        playbook_id: 'missing.playbook', playbook_version: 1, supported_action: 'unknown', effect_class: 'external',
        required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Done', dependencies: [], priority: 2 },
    ] },
  };
  const input = { config: { input_key: 'first_life_motion_portfolio', strategy_key: 'marketing_strategy' }, inputs: {
    'artifacts.first_life_motion_portfolio': [portfolio],
    'artifacts.marketing_strategy': [{ id: 'strategy-1', source_refs: ['evidence-1'] }],
  } };
  const context = { runId: 'run-1', stageId: 'materialize', orgId: 'org-1' };
  const first = await adapter.execute(input, context);
  const second = await adapter.execute(input, context);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].status, 'PROPOSED');
  assert.equal(todos[0].context.planned_playbook_id, 'research.evidence-to-decision');
  assert.deepEqual(first.artifacts[0].data.accepted_todo_ids, ['todo-1']);
  assert.equal(first.artifacts[0].data.rejected_motions[0].reason, 'playbook_version_unavailable');
  assert.deepEqual(second.artifacts[0].data.accepted_todo_ids, ['todo-1']);
});

test('strategy portfolio cannot recursively materialize its own lifecycle', async () => {
  const { prisma, todos } = fixture();
  const registry = { get(id, version) {
    if (id !== 'marketing.strategy-to-growth-brief' || version !== 3) throw new Error('missing');
    return { playbook_id: id, version, metadata: { owner_room_tag: 'research', supported_actions: ['formulate_go_to_market_strategy'] } };
  } };
  const adapter = createRuntimeTaskMaterializerAdapter({ prisma, getService: () => ({ registry }) });
  const portfolio = { id: 'portfolio-recursive', source_refs: ['evidence-1'], data: { motions: [
    { motion_id: 'again-1', title: 'Form strategy again', objective: 'Repeat strategy', expected_outcome: 'strategy_program_ready',
      playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 3, supported_action: 'formulate_go_to_market_strategy',
      effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Repeated', dependencies: [], priority: 1 },
    { motion_id: 'again-2', title: 'Repeat once more', objective: 'Repeat strategy', expected_outcome: 'strategy_program_ready',
      playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 3, supported_action: 'formulate_go_to_market_strategy',
      effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Repeated', dependencies: [], priority: 2 },
  ] } };
  await assert.rejects(() => adapter.execute({
    config: { input_key: 'first_life_motion_portfolio', strategy_key: 'marketing_strategy' },
    inputs: { 'artifacts.first_life_motion_portfolio': [portfolio], 'artifacts.marketing_strategy': [{ id: 'strategy-1', source_refs: ['evidence-1'] }] },
  }, { runId: 'run-1', stageId: 'materialize', orgId: 'org-1' }), /recursive_playbook_not_allowed/);
  assert.equal(todos.length, 0);
});
