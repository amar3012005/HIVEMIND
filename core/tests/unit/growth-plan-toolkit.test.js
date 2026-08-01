import test from 'node:test';
import assert from 'node:assert/strict';
import { getGrowthPlanToolCatalog } from '../../src/agent/connector-toolkits/growth-plan-tools.js';
import { buildGrowthPlanArtifactData, compilePrepareQueue, completeGrowthPlanAssessments, growthPlanArtifactMetadata, normalizeGrowthPlanEvidence, renderGrowthPlanReport, selectGrowthPlanAspects } from '../../src/growth/planner.js';

test('initial growth plan always assesses the complete operating system', () => {
  assert.deepEqual(selectGrowthPlanAspects('initial_full', ['pipeline']), [
    'positioning', 'audience', 'offer', 'product_readiness', 'channels',
    'content', 'pipeline', 'measurement', 'operations', 'risks',
  ]);
});

test('operating-loop runs retain only supported requested aspects', () => {
  assert.deepEqual(selectGrowthPlanAspects('operate', ['pipeline', 'channels', 'pipeline', 'unknown']), ['pipeline', 'channels']);
  assert.deepEqual(selectGrowthPlanAspects('operate', []), ['measurement', 'pipeline', 'channels']);
});

test('growth plan toolkit exposes run, latest, and history without Room orchestration', () => {
  const catalog = getGrowthPlanToolCatalog();
  assert.equal(catalog.name, 'growth_plan');
  assert.deepEqual(catalog.tools.map((tool) => tool.name), ['growth_plan_run', 'growth_plan_latest', 'growth_plan_history']);
  const run = catalog.tools[0];
  assert.deepEqual(run.parameters.properties.mode.enum, ['initial_full', 'operate']);
  assert.match(run.description, /without running the generic Room debate pipeline/);
});

test('growth report is rendered outside the model JSON contract', () => {
  const report = renderGrowthPlanReport({
    executive_thesis: 'Build evidence before scaling.', aspect_assessments: [],
    constraints: [{ type: 'measurement', statement: 'Outcomes are not connected.', known_facts: [], unknowns: [] }],
    hypotheses: [], stage: { name: 'Measurement foundation', objective: 'Connect outcomes.', duration_days: 7, checkpoint_day: 7, measurement: {} },
    operating_queue: [{ title: 'Define measurement', room_tag: 'marketing', objective: 'Define measurement.', deliverable: 'Measurement map', acceptance_criteria: [] }], roadmap: [],
  });
  assert.match(report, /# Growth Operating Plan/);
  assert.match(report, /Measurement foundation/);
});

test('artifact metadata consumes the compact committed result shape', () => {
  assert.deepEqual(growthPlanArtifactMetadata({
    mode: 'initial_full', aspects: ['pipeline'], plan: { baseline_ref: { resource_id: 'baseline-1' } },
    committed: { stage_id: 'stage-1' },
  }), { mode: 'initial_full', aspects: ['pipeline'], baseline_id: 'baseline-1', growth_stage_id: 'stage-1' });
});

test('growth plan artifacts use the canonical SourceArtifact Prisma fields', () => {
  const data = buildGrowthPlanArtifactData({
    orgId: 'org-1', userId: 'user-1', runId: 'run-1', mode: 'initial_full', aspects: ['pipeline'],
    plan: { baseline_ref: { resource_id: 'baseline-1' } }, committed: { stage_id: 'stage-1' }, usage: {},
  });
  assert.equal(data.contentType, 'application/json');
  assert.equal(typeof data.sizeBytes, 'number');
  assert.ok(data.sizeBytes > 0);
  assert.equal('mimeType' in data, false);
  assert.equal(data.metadata.growth_stage_id, 'stage-1');
});

test('deterministic compiler attaches the authoritative baseline reference', () => {
  const plan = normalizeGrowthPlanEvidence({
    baseline_ref: {}, constraints: [{ type: 'measurement', evidence_refs: [] }],
    aspect_assessments: [{ aspect: 'measurement', evidence_refs: [] }],
    hypotheses: [{ statement: 'Connected outcomes may change prioritization.' }],
  }, { baseline: { resource_id: 'baseline-1', captured_at: '2026-07-29T00:00:00Z' } });
  assert.equal(plan.baseline_ref.resource_id, 'baseline-1');
  assert.deepEqual(plan.constraints[0].evidence_refs, ['baseline-1']);
  assert.deepEqual(plan.aspect_assessments[0].evidence_refs, ['baseline-1']);
  assert.deepEqual(plan.hypotheses[0].evidence_refs, ['baseline-1']);
});

test('missing initial assessment rows become explicit unknowns instead of failing the cycle', () => {
  const plan = completeGrowthPlanAssessments({
    aspect_assessments: [{ aspect: 'Positioning', status: 'strength', evidence_refs: ['baseline-1'] }],
  }, { baseline: { resource_id: 'baseline-1' } }, ['positioning', 'audience']);
  assert.equal(plan.aspect_assessments[0].aspect, 'positioning');
  assert.equal(plan.aspect_assessments[1].aspect, 'audience');
  assert.equal(plan.aspect_assessments[1].status, 'unknown');
  assert.deepEqual(plan.aspect_assessments[1].evidence_refs, ['baseline-1']);
});

test('prepare queue ignores invented execution connectors while retaining Maps discovery', () => {
  const plan = compilePrepareQueue({ operating_queue: [
    { kind: 'seo', required_capabilities: ['google-search-console', 'content-management'] },
    { kind: 'outreach', required_capabilities: ['google-maps', 'email-automation'] },
    { kind: 'marketing', required_capabilities: ['zernio', 'instagram', 'linkedin', 'x_organic'] },
    { kind: 'legal_finance', required_capabilities: ['document_review'] },
  ] });
  assert.deepEqual(plan.operating_queue.map((item) => item.required_capabilities), [[], ['google-maps'], [], []]);
  assert.ok(plan.operating_queue.every((item) => item.authority_mode === 'PREPARE' && item.external_actions_required === false));
  assert.deepEqual(plan.operating_queue[2].ignored_capability_suggestions, ['zernio', 'instagram', 'linkedin', 'x_organic']);
});
