import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getGrowthPlanToolCatalog } from '../../src/agent/connector-toolkits/growth-plan-tools.js';
import { buildGrowthPlanArtifactData, compilePrepareQueue, completeGrowthPlanAssessments, growthPlanArtifactMetadata, normalizeGrowthPlanEvidence, renderGrowthPlanReport, selectGrowthPlanAspects } from '../../src/growth/planner.js';
import { applyFirstLifePolicy, loadFirstLifePolicy } from '../../src/growth/first-life-policy.js';

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

test('prepare queue retains model suggestions as evidence but grants no execution capability', () => {
  const plan = compilePrepareQueue({ operating_queue: [
    { kind: 'seo', required_capabilities: ['google-search-console', 'content-management'] },
    { kind: 'outreach', required_capabilities: ['google-maps', 'email-automation'] },
    { kind: 'marketing', required_capabilities: ['zernio', 'instagram', 'linkedin', 'x_organic'] },
    { kind: 'legal_finance', required_capabilities: ['document_review'] },
  ] });
  assert.deepEqual(plan.operating_queue.map((item) => item.required_capabilities), [[], [], [], []]);
  assert.ok(plan.operating_queue.every((item) => item.authority_mode === 'PREPARE' && item.external_actions_required === false));
  assert.deepEqual(plan.operating_queue[2].ignored_capability_suggestions, ['zernio', 'instagram', 'linkedin', 'x_organic']);
});

test('historical first-life policy preserves varied company proposals without injecting a domain or language', async () => {
  const policy = await loadFirstLifePolicy(5);
  const cases = [
    ['English SaaS', ['Clarify retained demand', 'Measure activation evidence']],
    ['Deutsche Agentur', ['Angebotssignale pruefen', 'Bestandskunden lernen']],
    ['استشارات عربية', ['تحليل الطلب الحالي', 'توثيق إشارات الثقة']],
    ['GreenLeaf Bakery', ['Reduce unconfirmed orders', 'Measure fulfillment delays']],
  ];
  for (const [company, titles] of cases) {
    const baselineId = `baseline:${company}`;
    const plan = {
      mode: 'initial_full',
      constraints: titles.map((title, index) => ({ id: `c${index}`, evidence_refs: [baselineId] })),
      stage: { queue_item_id: 'q0' },
      operating_queue: titles.map((title, index) => ({
        id: `q${index}`, constraint_id: `c${index}`, title,
        objective: `${title}.`, room_tag: `room-${index}`,
        effect_class: index === 0 ? 'external' : 'internal',
        effect_basis: index === 0 ? 'The terminal outcome changes external state.' : 'Persisted internal evidence is terminal.',
        external_action_requested: index === 0,
      })),
    };
    const result = applyFirstLifePolicy(plan, { baseline: { resource_id: baselineId } }, policy);
    assert.deepEqual(result.operating_queue.map((item) => item.title), titles);
    assert.equal(result.first_life.recommended_todo_source_id, 'q0');
    assert.ok(result.operating_queue.every((item) => item.first_life_policy_id === 'runtime.first-life-policy'));
  }
});

test('historical first-life policy removes unsupported proposals and never pads the queue', async () => {
  const policy = await loadFirstLifePolicy(5);
  const plan = {
    mode: 'initial_full',
    constraints: [
      { id: 'c1', evidence_refs: ['baseline-1'] },
      { id: 'c2', evidence_refs: ['baseline-1'] },
      { id: 'c3', evidence_refs: [] },
    ],
    stage: { queue_item_id: 'q1' },
    operating_queue: [
      { id: 'q1', constraint_id: 'c1', title: 'First', effect_class: 'external', effect_basis: 'External state changes.', external_action_requested: true },
      { id: 'q2', constraint_id: 'c2', title: 'Second', effect_class: 'internal', effect_basis: 'Internal evidence is terminal.', external_action_requested: false },
      { id: 'q3', constraint_id: 'c3', title: 'Unsupported', effect_class: 'internal', effect_basis: 'Internal evidence is terminal.', external_action_requested: false },
    ],
  };
  const result = applyFirstLifePolicy(plan, { baseline: { resource_id: 'baseline-1' } }, policy);
  assert.deepEqual(result.operating_queue.map((item) => item.id), ['q1', 'q2']);
});

test('v6 retains one policy-selected program builder and leaves portfolio design to it', async () => {
  const policy = await loadFirstLifePolicy(6);
  const plan = {
    mode: 'initial_full',
    constraints: [
      { id: 'strategy-gap', evidence_refs: ['baseline-1'] },
      { id: 'downstream-gap', evidence_refs: ['baseline-1'] },
    ],
    stage: { queue_item_id: 'builder' },
    operating_queue: [
      { id: 'builder', constraint_id: 'strategy-gap', title: 'Form program', playbook_id: 'program.builder', playbook_version: 7 },
      { id: 'downstream', constraint_id: 'downstream-gap', title: 'Act later', playbook_id: 'external.motion', playbook_version: 2 },
    ],
  };
  const catalog = [
    { playbook_id: 'program.builder', version: 7, effect_class: 'internal', first_life_program_builder: true },
    { playbook_id: 'external.motion', version: 2, effect_class: 'external', first_life_program_builder: false },
  ];
  const result = applyFirstLifePolicy(plan, { baseline: { resource_id: 'baseline-1' } }, policy, catalog);
  assert.deepEqual(result.operating_queue.map((item) => item.id), ['builder']);
  assert.equal(result.first_life.proposal_count, 1);
});

test('current first-life policy orders one campaign, outreach, and research task before deferred work', async () => {
  const policy = await loadFirstLifePolicy();
  assert.equal(policy.version, 15);
  assert.equal(policy.initial_lifecycle, undefined);
  assert.equal(policy.runtime_selects_lifecycle, true);
  assert.equal(policy.auto_start_initial_plan, true);
  assert.equal(policy.initial_execution_limit, 1);
  assert.equal(policy.first_life_outcome_preferences.length, 4);
  assert.deepEqual(policy.execution_defaults.campaign.channels, ['x_organic']);
  assert.equal(policy.execution_defaults.campaign.creative_format, 'single_image_post');
  assert.equal(policy.execution_defaults.campaign.duration_days, 7);
  assert.equal(policy.execution_defaults.campaign.maximum_posts, 7);

  const baselineId = 'baseline-current';
  const plan = applyFirstLifePolicy({
    mode: 'initial_full',
    constraints: [
      { id: 'c1', evidence_refs: [baselineId] },
      { id: 'c2', evidence_refs: [baselineId] },
      { id: 'c3', evidence_refs: [baselineId] },
      { id: 'c4', evidence_refs: [baselineId] },
    ],
    primary_constraint_id: 'c1',
    stage: { name: 'Initial', objective: 'Initial.', queue_item_id: 'q1' },
    operating_queue: [
      { id: 'q1', constraint_id: 'c1', kind: 'outreach', title: 'Find nearby prospects', objective: 'Prepare verified prospects.', room_tag: 'outreach', playbook_id: 'wrong.playbook', playbook_version: 9, requested_action: 'wrong', effect_class: 'internal' },
      { id: 'q2', constraint_id: 'c2', kind: 'campaign', title: 'Prepare awareness campaign', objective: 'Prepare campaign assets.', room_tag: 'campaign', playbook_id: 'wrong.playbook', playbook_version: 9, requested_action: 'wrong', effect_class: 'internal' },
      { id: 'q2-duplicate', constraint_id: 'c2', kind: 'campaign', title: 'Schedule campaign', objective: 'Schedule campaign assets.', effect_class: 'external' },
      { id: 'q3', constraint_id: 'c3', kind: 'research', title: 'Research competitors', objective: 'Resolve one market question.', effect_class: 'internal' },
      { id: 'q4', constraint_id: 'c4', kind: 'fundraising', title: 'Prepare fundraising later', objective: 'Prepare a future brief.', effect_class: 'internal' },
    ],
  }, { baseline: { resource_id: baselineId } }, policy);
  assert.equal(plan.first_life.runtime_selects_lifecycle, true);
  assert.deepEqual(plan.operating_queue.map((item) => item.proposal_kind), ['campaign', 'outreach', 'research', 'fundraising']);
  assert.equal(plan.first_life.recommended_todo_source_id, 'q2');
  assert.equal(plan.operating_queue[0].effect_class, 'external');
  assert.equal(plan.operating_queue[0].requested_terminal_outcome, 'launched');
  assert.match(plan.operating_queue[0].objective, /seven-day X organic awareness campaign/);
  assert.ok(plan.operating_queue.every((item) => item.room_tag === null
    && item.playbook_id === null && item.playbook_version === null && item.requested_action === null));
  assert.ok(plan.operating_queue.every((item) => item.execution_defaults === policy.execution_defaults));
});

test('current first-life policy rejects a missing mandatory sequence kind for bounded planner repair', async () => {
  const policy = await loadFirstLifePolicy();
  assert.throws(() => applyFirstLifePolicy({
    mode: 'initial_full',
    constraints: [{ id: 'c1', evidence_refs: ['baseline-1'] }, { id: 'c2', evidence_refs: ['baseline-1'] }],
    stage: { queue_item_id: 'q1' },
    operating_queue: [
      { id: 'q1', constraint_id: 'c1', kind: 'campaign', effect_class: 'external' },
      { id: 'q2', constraint_id: 'c2', kind: 'research', effect_class: 'internal' },
    ],
  }, { baseline: { resource_id: 'baseline-1' } }, policy), /growth_plan_first_life_required_task_kind_missing:outreach/);
});
