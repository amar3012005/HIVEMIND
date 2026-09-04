import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_OPERATION_TO_TOOL } from '../../src/agent/v2/capability-registry.js';
import { compileNativePlan } from '../../src/agent/v2/plan-compiler.js';
import { HIVEMIND_TOOL_GROUPS } from '../../src/agent/connector-toolkits/hivemind-tool-groups.js';

test('native planner can map every remaining HIVEMIND group tool family', () => {
  assert.equal(NATIVE_OPERATION_TO_TOOL.list_memories, 'hivemind_list_memories');
  assert.equal(NATIVE_OPERATION_TO_TOOL.get_memory, 'hivemind_get_memory');
  assert.equal(NATIVE_OPERATION_TO_TOOL.traverse, 'hivemind_traverse_graph');
  assert.equal(NATIVE_OPERATION_TO_TOOL.web_search, 'hivemind_web_search');
  assert.equal(NATIVE_OPERATION_TO_TOOL.recall_bugs, 'hivemind_recall_bugs');
  assert.equal(NATIVE_OPERATION_TO_TOOL.log_decision, 'hivemind_log_decision');
});

test('compiled native plans expose every HIVEMIND tool group', () => {
  const compiled = compileNativePlan({
    schema_version: 'native-turn-plan.v2',
    operation: 'list_memories',
    response: { language: 'en', type: 'fact', scope: 'bounded', depth: 'standard', shape: 'inventory', objective: 'List memories' },
    references: { entities: [] },
    time: { semantics: 'none' },
    steps: [{ query: 'company', entities: [] }],
    completion: { needs_user_input: false, approval_required: false },
    relation_entities: [],
    aggregate: null,
    external_fallback: { allowed: false, query: null, reason: null },
    uses_recent_public_sources: false,
    memory: null,
    direct_response: null,
  }, 'list my memories');
  assert.equal(compiled.native_tool, 'hivemind_list_memories');
  assert.deepEqual([...compiled.tool_groups].sort(), Object.keys(HIVEMIND_TOOL_GROUPS).sort());
});
