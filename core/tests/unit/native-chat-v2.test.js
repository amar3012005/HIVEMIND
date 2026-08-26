import test from 'node:test';
import assert from 'node:assert/strict';
import { compileNativePlan } from '../../src/agent/v2/plan-compiler.js';
import { validateNativePlan, validateNativePlanResult } from '../../src/agent/v2/plan-validator.js';
import { createNativePlannerGraph, nativeV2RoutingMode } from '../../src/agent/v2/orchestrator.js';
import { buildTurnContext } from '../../src/agent/v2/turn-context-builder.js';
import { intentDecisionToPlan } from '../../src/agent/chat-intent-decision.js';
import { buildNativePlannerPrompt, NATIVE_PLANNER_PROMPT_VERSION } from '../../src/agent/v2/planner-prompt.js';

function makePlan({ operation = 'recall', query = 'Kruti', entities = ['Kruti'], response = {}, source = null, time = {}, relation = [], aggregate = null, memory = null, direct = null, certified = false, capability } = {}) {
  const family = capability || (['save'].includes(operation) ? 'memory_write' : ['profile', 'update_profile'].includes(operation) ? 'profile' : operation === 'direct' ? 'direct' : 'workspace_read');
  const tool = ({ recall: 'hivemind_recall', source_read: 'hivemind_recall', event_range: 'hivemind_recall', snapshot: 'hivemind_at', diff: 'hivemind_diff', timeline: 'hivemind_timeline', relation_between: 'hivemind_relation_between', aggregate: 'hivemind_aggregate_entities', projects: 'hivemind_list_projects', profile: 'get_user_profile', update_profile: 'update_user_profile', save: 'hivemind_save_memory', direct: null })[operation];
  return {
    schema_version: 'native-turn-plan.v2', capability: family, operation,
    response: { language: 'en', type: 'fact', scope: 'broad', depth: 'detailed', shape: 'overview', objective: 'Answer exactly from authorized context.', ...response },
    references: { resolved_pronouns: [], entities, source },
    time: { semantics: 'none', axis: null, start: null, end: null, valid_at: null, known_at: null, ...time },
    steps: [{ id: 'step_1', capability: family, tool, query, entities, depends_on: [], result_binding: 'result' }],
    completion: { needs_user_input: false, approval_required: ['save', 'update_profile'].includes(operation) },
    relation_entities: relation, aggregate, memory, direct_response: direct, context_free_certificate: certified,
    external_fallback: { allowed: false, query: null, reason: null },
    uses_recent_public_sources: false,
  };
}

test('public web fallback compiles as a recall-first policy and unsafe source fallback is disabled', () => {
  const publicPlan = makePlan({ query: 'current public Acme pricing' });
  publicPlan.external_fallback = { allowed: true, query: 'Acme public pricing 2026', reason: 'current_public' };
  const compiled = compileNativePlan(validateNativePlan(publicPlan), 'Compare current pricing');
  assert.equal(compiled.operation, 'recall');
  assert.equal(compiled.web_fallback.allowed, true);

  const sourcePlan = makePlan({ operation: 'source_read', query: 'Plan.pdf', source: { title: 'Plan.pdf', document_id: null, kind: 'pdf', selection: null } });
  sourcePlan.external_fallback = { allowed: true, query: 'Plan.pdf', reason: 'explicit_web' };
  const checked = validateNativePlanResult(sourcePlan);
  assert.equal(checked.plan.external_fallback.allowed, false);
  assert.ok(checked.repairs.includes('external_fallback.unsafe'));
});

test('TurnContextBuilder bounds history, profile and authorized projects', () => {
  const context = buildTurnContext({ message: ' hello ', history: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` })), profileContext: 'x'.repeat(3000), projectCatalog: Array.from({ length: 30 }, (_, i) => ({ id: `${i}`, name: `P${i}` })) });
  assert.equal(context.message, 'hello'); assert.equal(context.history.length, 4);
  assert.equal(context.compact_profile.length, 1800); assert.equal(context.authorized_projects.length, 24);
});

test('planner classifies additional source follow-ups as multi-point detailed coverage', () => {
  const prompt = buildNativePlannerPrompt();
  assert.equal(NATIVE_PLANNER_PROMPT_VERSION, 'native-chat-planner.v2.2');
  assert.match(prompt, /source follow-up asking what else/i);
  assert.match(prompt, /response\.shape=overview/);
  assert.match(prompt, /multiple distinct additional points/i);
});

test('compiler carries the replaceable recent public checkpoint independently of planner phrasing', () => {
  const plan = validateNativePlan(makePlan({ query: 'which source did you use?' }));
  plan.uses_recent_public_sources = false;
  const decision = compileNativePlan(plan, 'which source did you use?', {
    recent_source_refs: [{ title: 'Pricing', url: 'https://example.com/pricing' }],
    recent_context_answer: 'The public price is EUR 10.',
  });
  assert.equal(decision.recent_public_sources[0].url, 'https://example.com/pricing');
  assert.equal(decision.recent_context_answer, 'The public price is EUR 10.');
  assert.equal(decision.uses_recent_public_sources, false);
  decision.uses_recent_public_sources = true;
  assert.equal(intentDecisionToPlan(decision, 'which source?').uses_recent_public_sources, true);
});

test('person overview preserves entity and compiles one canonical recall', () => {
  const decision = compileNativePlan(validateNativePlan(makePlan()), 'What do you know about Kruti?');
  assert.equal(decision.operation, 'recall'); assert.deepEqual(decision.queries, ['Kruti']);
  assert.deepEqual(decision.named_entities, ['Kruti']); assert.equal(decision.planned_steps.length, 1);
});

test('named source and latest upload preserve source/time semantics', () => {
  const named = compileNativePlan(validateNativePlan(makePlan({ operation: 'source_read', query: 'Solvis products', source: { title: 'Whitepaper_Transformation.pdf', document_id: null, kind: 'pdf', selection: null } })), 'file');
  assert.equal(named.source.title, 'Whitepaper_Transformation.pdf');
  const latest = compileNativePlan(validateNativePlan(makePlan({ query: 'latest uploaded image visual contents', source: { title: null, document_id: null, kind: 'image', selection: 'latest' }, time: { semantics: 'latest', axis: 'known_time' } })), 'recent image');
  assert.equal(latest.time.kind, 'latest'); assert.equal(latest.source.kind, 'image');
});

test('event range is bounded recall while snapshot/diff/timeline select temporal tools', () => {
  const range = compileNativePlan(validateNativePlan(makePlan({ operation: 'event_range', query: 'pricing decisions', response: { type: 'decision', scope: 'exhaustive', shape: 'inventory' }, time: { semantics: 'event_range', axis: 'event_time', start: '2026-08-17T00:00:00+02:00', end: '2026-08-23T23:59:59+02:00' } })), 'last week');
  const executable = intentDecisionToPlan(range, 'last week');
  assert.equal(executable.needs_time_travel, false); assert.equal(executable.time.kind, 'event_range'); assert.equal(range.response_depth, 'comprehensive');
  const snapshot = compileNativePlan(validateNativePlan(makePlan({ operation: 'snapshot', time: { semantics: 'snapshot', axis: 'valid_time', valid_at: '2026-08-01T00:00:00Z' } })), 'snapshot');
  assert.equal(snapshot.native_tool, 'hivemind_at'); assert.equal(intentDecisionToPlan(snapshot, 'snapshot').needs_time_travel, true);
  const diff = compileNativePlan(validateNativePlan(makePlan({ operation: 'diff', time: { semantics: 'diff', axis: 'valid_time', start: '2026-07-01T00:00:00Z', end: '2026-08-01T00:00:00Z' } })), 'diff');
  assert.equal(diff.native_tool, 'hivemind_diff');
  assert.equal(compileNativePlan(validateNativePlan(makePlan({ operation: 'timeline', time: { semantics: 'timeline', axis: 'valid_time' } })), 'history').native_tool, 'hivemind_timeline');
});

test('relation, aggregate and projects have dedicated exact operations', () => {
  assert.equal(compileNativePlan(validateNativePlan(makePlan({ operation: 'relation_between', query: 'Kruti marketing relationship', relation: ['Kruti', 'marketing team'], response: { type: 'relationship' } })), 'relation').native_tool, 'hivemind_relation_between');
  assert.equal(compileNativePlan(validateNativePlan(makePlan({ operation: 'aggregate', query: 'all Solvis products', aggregate: { parent: 'Solvis', kind: 'product' }, response: { scope: 'exhaustive', shape: 'inventory' } })), 'aggregate').native_tool, 'hivemind_aggregate_entities');
  const projects = compileNativePlan(validateNativePlan(makePlan({ operation: 'projects', query: 'authorized projects', entities: [] })), 'projects');
  assert.equal(projects.native_tool, 'hivemind_list_projects'); assert.deepEqual(projects.tool_groups, ['hivemind-projects']);
});

test('validator repairs legacy and reference-only relation entity shapes', () => {
  const referenceOnly = makePlan({ operation: 'relation_between', query: 'Amar and Kruti relationship', entities: ['Amar', 'Kruti'], relation: [] });
  delete referenceOnly.relation_entities;
  const repaired = validateNativePlanResult(referenceOnly);
  assert.deepEqual(repaired.plan.relation_entities, ['Amar', 'Kruti']);
  assert.ok(repaired.repairs.includes('relation_entities.references'));

  const legacy = makePlan({ operation: 'relation_between', query: 'Amar and Kruti relationship', entities: [], relation: [] });
  delete legacy.relation_entities;
  legacy.relation = { entities: ['Amar', 'Kruti'] };
  const legacyRepaired = validateNativePlanResult(legacy);
  assert.deepEqual(legacyRepaired.plan.relation_entities, ['Amar', 'Kruti']);
  assert.ok(legacyRepaired.repairs.includes('relation_entities.legacy'));
});

test('validator promotes a generic recall with relationship semantics to the relation lane', () => {
  const generic = makePlan({ operation: 'recall', query: 'How is Kruti related to Amar?', entities: ['Kruti', 'Amar'], response: { type: 'relationship' } });
  const repaired = validateNativePlanResult(generic);
  assert.equal(repaired.plan.operation, 'relation_between');
  assert.deepEqual(repaired.plan.relation_entities, ['Kruti', 'Amar']);
  assert.ok(repaired.repairs.includes('operation.relationship_semantics'));
});

test('validator repairs a relationship objective even when response type was mislabeled fact', () => {
  const generic = makePlan({ operation: 'recall', query: 'What is the relationship between Kruti and Amar?', entities: ['Kruti', 'Amar'], response: { type: 'fact' } });
  const repaired = validateNativePlanResult(generic);
  assert.equal(repaired.plan.operation, 'relation_between');
  assert.deepEqual(repaired.plan.relation_entities, ['Kruti', 'Amar']);
});

test('validator downgrades overview and source-shaped aggregate mistakes to unified recall', () => {
  const overview = validateNativePlanResult(makePlan({
    operation: 'aggregate', query: 'everything about Kruti',
    aggregate: { parent: 'Kruti', kind: 'fact' },
    response: { scope: 'exhaustive', depth: 'comprehensive', shape: 'overview' },
  }));
  assert.equal(overview.plan.operation, 'recall');
  assert.equal(overview.plan.aggregate, null);
  assert.ok(overview.repairs.includes('operation.uncertified_aggregate'));

  const source = validateNativePlanResult(makePlan({
    operation: 'aggregate', query: 'all details in Plan.pdf',
    aggregate: { parent: 'Plan.pdf', kind: 'fact' },
    source: { title: 'Plan.pdf', document_id: null, kind: 'pdf', selection: null },
    response: { scope: 'exhaustive', depth: 'comprehensive', shape: 'inventory' },
  }));
  assert.equal(source.plan.operation, 'source_read');
  assert.equal(source.plan.aggregate, null);
});

test('unscoped save stays null and profile update stays caller scoped', () => {
  const memory = { title: 'Kruti location', content: 'Kruti was born in India.', memory_type: 'fact', scope: null, project_id: null, tags: [], entities: ['Kruti'], event_time: null, profile_fields: {}, preferences: [] };
  const saved = compileNativePlan(validateNativePlan(makePlan({ operation: 'save', query: null, memory, response: { type: 'acknowledgement', scope: 'bounded', depth: 'standard', shape: 'fact' } })), 'save');
  assert.equal(saved.save.scope, undefined);
  const profileMemory = { ...memory, title: null, content: null, entities: [], profile_fields: { location: 'India' } };
  const profile = compileNativePlan(validateNativePlan(makePlan({ operation: 'update_profile', query: null, entities: [], memory: profileMemory, response: { type: 'acknowledgement', scope: 'bounded', depth: 'standard', shape: 'fact' } })), 'profile');
  assert.deepEqual(profile.profile_update.fields, { location: 'India' });
});

test('validator canonicalizes provider-safe profile field entries', () => {
  const plan = makePlan({ operation: 'update_profile', query: null, entities: [], memory: {
    title: null, content: null, memory_type: null, scope: null, project_id: null, tags: [], entities: [], event_time: null,
    profile_fields: [{ field: 'location', value: 'India' }], preferences: [],
  } });
  const result = validateNativePlanResult(plan);
  assert.equal(result.status, 'repairable');
  assert.deepEqual(result.plan.memory.profile_fields, { location: 'India' });
  assert.ok(result.repairs.includes('memory.profile_fields.entries'));
});

test('validator repairs model-owned tool mapping but rejects semantic invalidity', () => {
  const mismatched = makePlan(); mismatched.capability = 'direct'; mismatched.steps[0].capability = 'direct'; mismatched.steps[0].tool = 'hivemind_diff';
  const repaired = validateNativePlanResult(mismatched);
  assert.equal(repaired.status, 'repairable'); assert.equal(repaired.plan.steps[0].tool, 'hivemind_recall');
  const greeting = makePlan({ operation: 'direct', query: null, entities: [], direct: 'Hello', certified: false, response: { type: 'acknowledgement', scope: 'bounded', depth: 'standard', shape: 'fact' } });
  const certifiedGreeting = validateNativePlanResult(greeting);
  assert.equal(certifiedGreeting.status, 'repairable');
  assert.equal(certifiedGreeting.plan.context_free_certificate, true);
  assert.ok(certifiedGreeting.repairs.includes('context_free_certificate.structural'));
  const factualDirect = makePlan({ operation: 'direct', query: 'Respond directly.', entities: [], direct: 'Kruti works in marketing.', certified: false, response: { type: 'fact', scope: 'bounded', depth: 'standard', shape: 'fact' } });
  assert.equal(validateNativePlanResult(factualDirect).status, 'repairable');
  assert.equal(validateNativePlanResult(factualDirect).plan.steps[0].query, null);
  factualDirect.references.entities = ['Kruti'];
  assert.equal(validateNativePlanResult(factualDirect).status, 'invalid');
});

test('validator canonicalizes provider-omitted nullable source members', () => {
  const providerPlan = makePlan();
  providerPlan.references.source = {};
  const result = validateNativePlanResult(providerPlan);
  assert.equal(result.status, 'repairable');
  assert.equal(result.plan.references.source, null);
  assert.ok(result.repairs.includes('references.source.nullables'));
});

test('validator canonicalizes an empty provider result binding', () => {
  const plan = makePlan();
  plan.steps[0].result_binding = '';
  const result = validateNativePlanResult(plan);
  assert.equal(result.plan.steps[0].result_binding, 'result_1');
  assert.ok(result.repairs.includes('steps.0.result_binding'));
});

test('validator safely derives structural save, aggregate and snapshot fields', () => {
  const savePlan = makePlan({ operation: 'save', query: null, entities: ['Kruti'], memory: { title: null, content: 'Kruti joined marketing.', memory_type: 'fact', scope: null, project_id: null, tags: [], entities: ['Kruti'], event_time: null, profile_fields: {}, preferences: [] } });
  assert.equal(validateNativePlanResult(savePlan).plan.memory.title, 'Kruti fact');
  const aggregatePlan = makePlan({ operation: 'aggregate', query: 'documents mentioning SolvisPia', entities: ['SolvisPia'], response: { shape: 'inventory' }, aggregate: { parent: null, kind: 'source' } });
  assert.equal(validateNativePlanResult(aggregatePlan).plan.aggregate.parent, 'SolvisPia');
  const snapshotPlan = makePlan({ operation: 'snapshot', time: { semantics: 'snapshot', axis: 'valid_time', start: '2026-08-01T00:00:00Z' } });
  assert.equal(validateNativePlanResult(snapshotPlan).plan.time.valid_at, '2026-08-01T00:00:00Z');
});

test('validator reconciles exact-source and temporal semantics before tool compilation', () => {
  const sourcePlan = makePlan({
    operation: 'recall',
    query: 'products',
    source: { title: 'Whitepaper_Transformation.pdf', document_id: null, kind: 'pdf', selection: null },
  });
  const source = validateNativePlanResult(sourcePlan);
  assert.equal(source.plan.operation, 'source_read');
  assert.ok(source.repairs.includes('operation.exact_source'));
  assert.equal(source.plan.steps[0].tool, 'hivemind_recall');

  const historyPlan = makePlan({
    operation: 'recall',
    query: 'Orion launch date history',
    time: { semantics: 'timeline', axis: 'valid_time' },
  });
  const history = validateNativePlanResult(historyPlan);
  assert.equal(history.plan.operation, 'timeline');
  assert.ok(history.repairs.includes('operation.time_semantics'));
  assert.equal(history.plan.steps[0].tool, 'hivemind_timeline');
});

test('validator derives a missing read query from the required answer objective', () => {
  const plan = makePlan({
    operation: 'recall',
    query: null,
    source: { title: null, document_id: null, kind: 'image', selection: 'latest' },
    time: { semantics: 'latest', axis: 'known_time' },
  });
  const result = validateNativePlanResult(plan);
  assert.equal(result.plan.steps[0].query, 'Answer exactly from authorized context.');
  assert.ok(result.repairs.includes('steps.0.query'));
});

test('validator does not turn unbounded meeting reads or incomplete write-shaped reads into legacy fallbacks', () => {
  const unboundedMeeting = makePlan({
    operation: 'event_range',
    query: 'pricing meeting decisions',
    time: { semantics: 'event_range', axis: 'event_time' },
  });
  const meeting = validateNativePlanResult(unboundedMeeting);
  assert.equal(meeting.plan.operation, 'recall');
  assert.equal(meeting.plan.time.semantics, 'none');
  assert.ok(meeting.repairs.includes('time.incomplete_range'));

  const searchMiscastAsSave = makePlan({
    operation: 'save',
    query: 'personal travel preferences',
    response: { type: 'fact' },
    memory: { title: null, content: null, memory_type: null, scope: 'personal', project_id: null, tags: [], entities: [], event_time: null, profile_fields: {}, preferences: [] },
  });
  const search = validateNativePlanResult(searchMiscastAsSave);
  assert.equal(search.plan.operation, 'recall');
  assert.equal(search.plan.memory, null);
  assert.equal(search.plan.completion.approval_required, false);
  assert.ok(search.repairs.includes('operation.incomplete_write'));
});

test('validator keeps latest unnamed sources on recall instead of requiring an exact document id', () => {
  const plan = makePlan({
    operation: 'source_read',
    query: 'latest uploaded image',
    source: { title: null, document_id: null, kind: 'image', selection: 'latest' },
    time: { semantics: 'latest', axis: 'known_time' },
  });
  const result = validateNativePlanResult(plan);
  assert.equal(result.plan.operation, 'recall');
  assert.equal(result.plan.references.source.selection, 'latest');
  assert.equal(result.plan.references.source.kind, 'image');
  assert.ok(result.repairs.includes('operation.selected_source'));
});

test('validator degrades incomplete temporal misroutes to recall instead of failing the turn', () => {
  const snapshot = validateNativePlanResult(makePlan({
    operation: 'snapshot', query: 'business model from pitch deck',
    time: { semantics: 'snapshot', axis: 'known_time' },
  }));
  assert.equal(snapshot.plan.operation, 'recall');
  assert.ok(snapshot.repairs.includes('operation.incomplete_snapshot'));

  const range = validateNativePlanResult(makePlan({
    operation: 'event_range', query: 'recent decisions',
    time: { semantics: 'event_range', axis: 'event_time', start: null, end: null },
  }));
  assert.equal(range.plan.operation, 'recall');
  assert.ok(range.repairs.some((repair) => ['time.incomplete_range', 'operation.incomplete_event_range'].includes(repair)));
});

test('LangGraph trajectory performs one planner call after deterministic context/catalog nodes', async () => {
  let calls = 0;
  const graph = createNativePlannerGraph({ planner: async ({ context, capabilityCatalog }) => { calls += 1; assert.equal(context.message, 'Who is Kruti?'); assert.match(capabilityCatalog, /workspace_read/); return { rawPlan: makePlan(), usage: { total_tokens: 42 } }; } });
  const result = await graph.invoke({ input: { message: 'Who is Kruti?' } });
  assert.equal(calls, 1); assert.equal(result.decision.operation, 'recall'); assert.equal(result.validation.status, 'valid');
});

test('routing flags never capture use_tools:true and canary is stable', () => {
  const prior = { e: process.env.CHAT_ORCHESTRATOR_V2_ENABLED, s: process.env.CHAT_ORCHESTRATOR_V2_SHADOW, c: process.env.CHAT_ORCHESTRATOR_V2_CANARY_PERCENT };
  process.env.CHAT_ORCHESTRATOR_V2_ENABLED = 'true';
  try { assert.equal(nativeV2RoutingMode({ useTools: false, seed: 'u' }), 'serve'); assert.equal(nativeV2RoutingMode({ useTools: true, seed: 'u' }), 'off'); }
  finally { for (const [key, value] of [['CHAT_ORCHESTRATOR_V2_ENABLED', prior.e], ['CHAT_ORCHESTRATOR_V2_SHADOW', prior.s], ['CHAT_ORCHESTRATOR_V2_CANARY_PERCENT', prior.c]]) value === undefined ? delete process.env[key] : process.env[key] = value; }
});
