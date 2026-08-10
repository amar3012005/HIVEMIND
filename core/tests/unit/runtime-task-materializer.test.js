import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeTaskMaterializerAdapter } from '../../src/runtime-playbooks/adapters/runtime-task-materializer.js';

function fixture() {
  const todos = [];
  const tx = {
    async $queryRawUnsafe() { return [{ id: 'runtime-1', epoch: 'epoch-1' }]; },
    hyperRoom: { async findFirst() { return { userId: 'user-1' }; } },
    sourceArtifact: {
      async upsert({ create }) { return { id: 'strategy-source-1', ...create }; },
    },
    hqTodo: {
      async findFirst({ where }) {
        const key = where.context.equals;
        return todos.find((todo) => todo.context.strategy_motion_key === key) || null;
      },
      async create({ data }) { const todo = { id: `todo-${todos.length + 1}`, ...data }; todos.push(todo); return todo; },
    },
  };
  const prisma = {
    runtimePlaybookRun: { async findFirst() { return { id: 'run-1', roomId: 'room-1', playbookId: 'marketing.strategy-to-growth-brief', playbookVersion: 3, scopeKey: 'global', trigger: { runtime_id: 'runtime-1' }, context: { request: { instruction: 'Decide' }, policy: { first_life_policy_version: 7 } } }; } },
    async $transaction(fn) { return fn(tx); },
  };
  return { prisma, todos };
}

test('strategy portfolio materialization is per-motion, evidence-bound, provider-neutral and idempotent', async () => {
  const { prisma, todos } = fixture();
  const adapter = createRuntimeTaskMaterializerAdapter({ prisma });
  const portfolio = {
    id: 'portfolio-1', source_refs: ['evidence-1'], data: { motions: [
      { motion_id: 'valid', title: 'Validate category', objective: 'Make a decision', expected_outcome: 'decision_ready',
        reason: 'Evidence gap blocks a decision', effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Decision accepted', dependencies: [], priority: 1,
        playbook_id: 'research.evidence-to-decision', playbook_version: 1, supported_action: 'produce_source_backed_decision', owner_room_tag: 'research', provider: 'google' },
      { motion_id: 'invalid', title: 'Unknown work', objective: 'Unknown', expected_outcome: 'done',
        effect_class: 'external', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Done', dependencies: [], priority: 2 },
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
  assert.equal(todos[0].kind, 'runtime_task');
  assert.equal(todos[0].context.source_instruction, 'Make a decision');
  assert.equal(todos[0].context.strategy_source_instruction, 'Decide');
  assert.equal(Object.hasOwn(todos[0].context, 'planned_playbook_id'), false);
  assert.equal(Object.hasOwn(todos[0].context, 'room_tag'), false);
  assert.equal(Object.hasOwn(todos[0].context, 'requested_action'), false);
  assert.equal(Object.hasOwn(todos[0].context, 'provider'), false);
  assert.equal(todos[0].context.first_life_policy_version, 7);
  assert.equal(todos[0].context.strategy_source_artifact_id, 'strategy-source-1');
  assert.ok(todos[0].context.evidence_refs.includes('strategy-source-1'));
  assert.deepEqual(first.artifacts[0].data.accepted_todo_ids, ['todo-1']);
  assert.equal(first.artifacts[0].data.rejected_motions[0].reason, 'runtime_task_proposal_fields_missing');
  assert.deepEqual(second.artifacts[0].data.accepted_todo_ids, ['todo-1']);
});

test('strategy portfolio cannot turn its own lifecycle fields into Runtime assignment', async () => {
  const { prisma, todos } = fixture();
  const adapter = createRuntimeTaskMaterializerAdapter({ prisma });
  const portfolio = { id: 'portfolio-recursive', source_refs: ['evidence-1'], data: { motions: [
    { motion_id: 'again-1', title: 'Form strategy again', objective: 'Repeat strategy', expected_outcome: 'strategy_program_ready',
      reason: 'A room attempted to select itself', playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 3, supported_action: 'formulate_go_to_market_strategy', owner_room_tag: 'marketing',
      effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Repeated', dependencies: [], priority: 1 },
    { motion_id: 'again-2', title: 'Repeat once more', objective: 'Repeat strategy', expected_outcome: 'strategy_program_ready',
      reason: 'A room attempted to select itself', playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 3, supported_action: 'formulate_go_to_market_strategy', owner_room_tag: 'marketing',
      effect_class: 'internal', required_capabilities: [], evidence_refs: ['evidence-1'], success_measure: 'Repeated', dependencies: [], priority: 2 },
  ] } };
  const result = await adapter.execute({
    config: { input_key: 'first_life_motion_portfolio', strategy_key: 'marketing_strategy' },
    inputs: { 'artifacts.first_life_motion_portfolio': [portfolio], 'artifacts.marketing_strategy': [{ id: 'strategy-1', source_refs: ['evidence-1'] }] },
  }, { runId: 'run-1', stageId: 'materialize', orgId: 'org-1' });
  assert.equal(todos.length, 2);
  assert.equal(result.artifacts[0].data.rejected_motions.length, 0);
  assert.equal(todos.every((todo) => !Object.hasOwn(todo.context, 'planned_playbook_id')), true);
});
