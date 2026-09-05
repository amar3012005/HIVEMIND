import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativePlanTool } from '../../src/agent/v2/planner-schema.js';
import { compileNativePlan } from '../../src/agent/v2/plan-compiler.js';
import { validateNativePlan, validateNativePlanResult } from '../../src/agent/v2/plan-validator.js';
import { createNativeMetaPlannerGraph } from '../../src/agent/v2/orchestrator.js';
import { assertNativeMetaAuthority, bindNativeMetaArguments, buildNativeMetaReceipt, getNativeToolSchemas, renderCertifiedNativeResult } from '../../src/agent/v2/native-meta-registry.js';
import { intentDecisionToPlan } from '../../src/agent/chat-intent-decision.js';
import { nativeOrchestratorFor } from '../../src/agent/v2/cloudflare-chat-session-client.js';

function plan(overrides = {}) {
  return {
    schema_version: 'native-turn-plan.v2', capability: 'workspace_read', operation: 'recall',
    retrieval: { limit: 5, tags: [], memory_types: ['decision'], scope_filter: null, entity_filter_mode: 'should', relationship_types: [], relationship_direction: 'any' },
    response: { language: 'en', type: 'decision', scope: 'bounded', depth: 'standard', shape: 'inventory', objective: 'Return the five latest decisions.' },
    references: { resolved_pronouns: [], entities: ['governed agent'], source: null },
    time: { semantics: 'latest', axis: 'event_time', start: null, end: null, valid_at: null, known_at: null },
    steps: [{ id: 'decisions', capability: 'workspace_read', tool: 'hivemind_recall', query: 'governed agent decisions', entities: ['governed agent'], depends_on: [], result_binding: 'decisions' }],
    completion: { needs_user_input: false, approval_required: false }, relation_entities: [], aggregate: null,
    external_fallback: { allowed: false, query: null, reason: null }, uses_recent_public_sources: false,
    memory: null, direct_response: null, context_free_certificate: false,
    ...overrides,
  };
}

test('flag off preserves the existing Native V2 orchestrator and tools mode remains isolated', () => {
  assert.equal(nativeOrchestratorFor({ useTools: false, nativeMetaMode: 'off' }), 'v2');
  assert.equal(nativeOrchestratorFor({ useTools: true, nativeMetaMode: 'native-meta-v1' }), null);
});

test('meta planner schema progressively adds retrieval controls without changing legacy schema', () => {
  const legacy = createNativePlanTool().function.parameters;
  const meta = createNativePlanTool({ nativeMeta: true }).function.parameters;
  assert.equal(legacy.properties.retrieval, undefined);
  assert.equal(legacy.required.includes('retrieval'), false);
  assert.ok(meta.properties.retrieval);
  assert.ok(meta.required.includes('retrieval'));
});

test('native meta discovery loads only the selected canonical Core schema', () => {
  const checked = validateNativePlan(plan());
  const receipt = assertNativeMetaAuthority(buildNativeMetaReceipt({ plan: checked, validation: { status: 'valid', repairs: [] } }));
  assert.equal(receipt.capability.tool, 'hivemind_recall');
  assert.equal(receipt.capability.authority, 'tenant_scoped_read');
  assert.deepEqual(receipt.schemas.map((entry) => entry.function.name), ['hivemind_recall']);
  assert.throws(() => getNativeToolSchemas(['GMAIL_FETCH_EMAILS']), /schema_missing/);
});

test('requested count and complex native filters survive plan compilation', () => {
  const compiled = compileNativePlan(validateNativePlan(plan()), 'Show my last five decisions');
  const executable = intentDecisionToPlan(compiled, 'Show my last five decisions');
  assert.deepEqual(executable.retrieval, {
    limit: 5, tags: [], memory_types: ['decision'], scope_filter: null,
    entity_filter_mode: 'should', relationship_types: [], relationship_direction: 'any',
  });
  assert.equal(executable.time.kind, 'latest');
  assert.equal(executable.time.axis, 'event_time');
});

test('selected canonical schema binds only precise structured arguments', () => {
  const compiled = intentDecisionToPlan(
    compileNativePlan(validateNativePlan(plan({ operation: 'list_memories', steps: [{
      id: 'list', capability: 'workspace_read', tool: 'hivemind_list_memories', query: 'decisions', entities: [], depends_on: [], result_binding: 'rows',
    }] })), 'Show five decisions'),
    'Show five decisions',
  );
  const schema = getNativeToolSchemas(['hivemind_list_memories'])[0];
  assert.deepEqual(bindNativeMetaArguments(compiled, schema), {
    args: { memory_type: 'decision', limit: 5 }, unresolved: [],
  });
});

test('certified native scalar receipts bypass probabilistic synthesis', () => {
  const result = { count: 2, complete: true, filter: { memory_type: 'decision' } };
  assert.equal(renderCertifiedNativeResult({ tool: 'hivemind_count_where', result, language: 'en' })?.response, 'You have exactly 2 decision memories.');
  assert.equal(renderCertifiedNativeResult({ tool: 'hivemind_count_where', result: { ...result, complete: false }, language: 'en' }), null);
  assert.equal(renderCertifiedNativeResult({ tool: 'hivemind_recall', result, language: 'en' }), null);
});

test('parentless exact memory count self-repairs to count_where without an invented substring', () => {
  const raw = plan({
    operation: 'aggregate', aggregate: null,
    retrieval: { limit: null, tags: [], memory_types: ['decision'], scope_filter: null, entity_filter_mode: 'off', relationship_types: [], relationship_direction: 'any' },
    references: { resolved_pronouns: [], entities: [], source: null },
    response: { language: 'en', type: 'decision', scope: 'exhaustive', depth: 'comprehensive', shape: 'inventory', objective: 'Return the exact complete count of decision memories.' },
    steps: [{ id: 'count', capability: 'workspace_read', tool: 'hivemind_aggregate_entities', query: 'decision memories', entities: [], depends_on: [], result_binding: 'count' }],
  });
  const validation = validateNativePlanResult(raw);
  assert.equal(validation.status, 'repairable');
  assert.equal(validation.plan.operation, 'count_where');
  assert.equal(validation.plan.steps[0].tool, 'hivemind_count_where');
  assert.ok(validation.repairs.includes('operation.filtered_memory_count'));
  const executable = intentDecisionToPlan(compileNativePlan(validation.plan, 'How many decision memories do I have?'), 'How many decision memories do I have?');
  const binding = bindNativeMetaArguments(executable, getNativeToolSchemas(['hivemind_count_where'])[0]);
  assert.deepEqual(binding, { args: { memory_type: 'decision' }, unresolved: [] });
});

test('partial aggregate reconciles from the selected canonical read tool', () => {
  const raw = plan({
    operation: 'aggregate', aggregate: { parent: null, kind: 'memory' },
    retrieval: { limit: null, tags: [], memory_types: [], scope_filter: null, entity_filter_mode: 'off', relationship_types: [], relationship_direction: 'any' },
    references: { resolved_pronouns: [], entities: [], source: null },
    response: { language: 'en', type: 'decision', scope: 'exhaustive', depth: 'comprehensive', shape: 'inventory', objective: 'Return the exact complete count of decision memories.' },
    steps: [{ id: 'count', capability: 'workspace_read', tool: 'count_where', query: "memory_type = 'decision' AND scope = 'personal'", entities: [], depends_on: [], result_binding: 'count' }],
  });
  const validation = validateNativePlanResult(raw);
  assert.equal(validation.status, 'repairable');
  assert.equal(validation.plan.operation, 'count_where');
  assert.equal(validation.plan.aggregate, null);
  assert.equal(validation.plan.steps[0].tool, 'hivemind_count_where');
  assert.ok(validation.repairs.includes('operation.selected_tool'));
});

test('parentless aggregate with typed memory predicates becomes a filtered count', () => {
  const raw = plan({
    operation: 'aggregate', aggregate: { parent: null, kind: 'memory' },
    retrieval: { limit: 1, tags: [], memory_types: ['decision'], scope_filter: 'personal', entity_filter_mode: 'off', relationship_types: [], relationship_direction: 'any' },
    references: { resolved_pronouns: [], entities: [], source: null },
    response: { language: 'en', type: 'fact', scope: 'exhaustive', depth: 'comprehensive', shape: 'inventory', objective: 'Return the complete filtered count.' },
    steps: [{ id: 'count', capability: 'workspace_read', tool: 'aggregate', query: 'filtered complete count', entities: [], depends_on: [], result_binding: 'count' }],
  });
  const validation = validateNativePlanResult(raw);
  assert.equal(validation.status, 'repairable');
  assert.equal(validation.plan.operation, 'count_where');
  assert.equal(validation.plan.aggregate, null);
  assert.equal(validation.plan.steps[0].tool, 'hivemind_count_where');
  assert.ok(validation.repairs.includes('operation.filtered_memory_count'));
});

test('selected-tool recovery cannot cross the read/write authority boundary', () => {
  const raw = plan({
    operation: 'aggregate', aggregate: { parent: null, kind: 'memory' },
    retrieval: { limit: null, tags: [], memory_types: [], scope_filter: null, entity_filter_mode: 'off', relationship_types: [], relationship_direction: 'any' },
    references: { resolved_pronouns: [], entities: [], source: null },
    steps: [{ id: 'unsafe', capability: 'workspace_read', tool: 'hivemind_save_memory', query: 'count records', entities: [], depends_on: [], result_binding: 'result' }],
  });
  const validation = validateNativePlanResult(raw);
  assert.equal(validation.status, 'invalid');
  assert.equal(validation.error, 'native_plan_missing_aggregate_parent');
});

test('LangGraph meta lane validates, discovers schema, and compiles one governed decision', async () => {
  const rawPlan = plan();
  const graph = createNativeMetaPlannerGraph({
    planner: async ({ nativeMeta }) => {
      assert.equal(nativeMeta, true);
      return { rawPlan, usage: { total_tokens: 1 } };
    },
    compactContextGraph: { invoke: async () => ({ history: [], sourceContext: { refs: [], answer: null } }) },
  });
  const result = await graph.invoke({ input: { message: 'Show my last five decisions' } });
  assert.equal(result.nativeMeta.capability.tool, 'hivemind_recall');
  assert.equal(result.nativeMeta.schemas.length, 1);
  assert.equal(result.decision._native_meta.schema_version, 'hivemind-native-meta.v1');
  assert.equal(result.decision.retrieval.limit, 5);
});
