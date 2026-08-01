import test from 'node:test';
import assert from 'node:assert/strict';
import { roomVerdict, workEnvelope, workOrderPrompt, workOrderTaskTag } from '../../src/hq-runtime/work-dispatcher.js';
import { compileCompletionRequirements, fallbackRoomTag, specialistWorkObjective, verifySpecialistDelivery } from '../../src/hq-runtime/native-engine.js';

test('a Room turn without a typed result is blocked, not completed', () => {
  assert.equal(roomVerdict({ ok: false, status: 'disabled' }).status, 'blocked');
});

test('the Room grounding gate outranks a sealed turn', () => {
  const v = roomVerdict({ ok: true, status: 'complete', verification: { met: true, grounded_ok: false, gaps: ['invented two customer metrics'] } });
  assert.equal(v.status, 'blocked');
  assert.match(v.gaps[0], /work-order-result\.v2/);
});

test('a sealed, grounded turn that did not meet the request is blocked', () => {
  assert.equal(roomVerdict({ ok: true, status: 'complete', verification: { met: false, grounded_ok: true, gaps: ['no emails drafted'] } }).status, 'blocked');
});

test('prose alone can no longer read as completed', () => {
  const v = roomVerdict({ ok: true, status: 'complete', verification: { met: true, grounded_ok: true, gaps: [] }, artifacts: [{ url: 'https://docs/x', title: 'Draft' }] });
  assert.equal(v.status, 'blocked');
});

test('a Room with no verification block is not silently accepted as met', () => {
  assert.equal(roomVerdict({ ok: true, status: 'complete' }).status, 'blocked');
});

test('the envelope carries acceptance criteria and forbids plan-as-completion', () => {
  const env = JSON.parse(workEnvelope({
    id: 'wo-1', title: 'Build pipeline', objective: 'Find clients in Hannover', kind: 'outreach_growth',
    acceptance_criteria: ['Return verified prospect records'], selected_skills: ['primary-outreach'],
    input_snapshot: { todo_id: 'todo-9', location: 'Hannover, Germany' },
  }));
  assert.equal(env.contract, 'hq-work-order.v2');
  assert.equal(env.todo_id, 'todo-9');
  assert.equal(env.location, 'Hannover, Germany');
  assert.equal(env.kind, 'outreach_growth');
  assert.deepEqual(env.acceptance_criteria, ['Return verified prospect records']);
  assert.ok(env.governance.never.some((x) => /future plan/.test(x)));
});

test('envelope tolerates JSON-string columns from raw SQL', () => {
  const env = JSON.parse(workEnvelope({ id: 'wo-2', title: 't', objective: 'o', acceptance_criteria: '["a","b"]' }));
  assert.deepEqual(env.acceptance_criteria, ['a', 'b']);
});

test('typed work-order result requires deterministic checks', () => {
  const base = {
    contract_version: 'work-order-result.v2', status: 'completed', gaps: [],
    acceptance: [{ criterion: 'Return prospects', met: true }],
    subtasks: [{ status: 'completed', checks: [
      { criterion: 'Return prospects', type: 'records_created', passed: true },
    ] }],
  };
  assert.equal(roomVerdict({ result: base }).status, 'completed');
  assert.equal(roomVerdict({ result: { ...base, subtasks: [{ status: 'completed', checks: [
    { criterion: 'Return prospects', type: 'judgment', passed: true },
  ] }] } }).status, 'blocked');
});

test('partial typed result can never be coerced to completed by HTTP ok', () => {
  const result = {
    contract_version: 'work-order-result.v2', status: 'partial', gaps: [{ why: 'No records persisted' }],
    acceptance: [{ criterion: 'Return prospects', met: false }],
    subtasks: [{ status: 'partial', checks: [{ type: 'records_created', passed: false }] }],
  };
  const verdict = roomVerdict({ ok: true, status: 'complete', result });
  assert.equal(verdict.status, 'blocked');
  assert.deepEqual(verdict.gaps, ['No records persisted']);
});

test('dispatch fallback honors only an explicit owner or the general Room', () => {
  const tag = fallbackRoomTag({
    context: { room_tag: 'operations' },
  }, ['seo', 'marketing', 'research', 'general']);
  assert.equal(tag, 'general');
  assert.equal(fallbackRoomTag({ context: { room_tag: 'operations' } }, ['operations', 'general']), 'operations');
});

test('HQ accepts a completed Room result without adding domain-specific checks', () => {
  const delivery = verifySpecialistDelivery({
    order: { acceptanceCriteria: ['Return the requested durable result'] },
    result: { status: 'completed', summary: 'The bounded assignment completed.', evidence: [] },
    resultOutput: {},
  });
  assert.deepEqual(delivery, { accepted: true, failures: [] });
});

test('HQ rejects a completed Room result when its typed phase outcome is missing', () => {
  const delivery = verifySpecialistDelivery({
    order: { kind: 'email_drafting', acceptanceCriteria: ['Prepare five drafts'], inputSnapshot: {
      completion_requirements: [{ type: 'email_drafts', minimum: 5 }],
    } },
    result: { status: 'completed', summary: 'Drafting report returned', evidence: [] },
    resultOutput: { work_order_result: {
      status: 'completed', completion_requirements: [{ type: 'email_drafts', met: false }],
    } },
  });
  assert.equal(delivery.accepted, false);
  assert.ok(delivery.failures.includes('completion_requirement_unmet:email_drafts'));
});

test('typed outreach dispatch replaces a broad instruction with a bounded specialist objective', () => {
  const objective = specialistWorkObjective({
    title: 'Build qualified pipeline in Hannover, Germany',
    objective: 'Run SEO, social, marketing, outreach, legal, finance, and fundraising.',
    context: { location: 'Hannover, Germany' },
  }, 'primary-outreach');
  assert.equal(objective, 'Run SEO, social, marketing, outreach, legal, finance, and fundraising.');
});

test('typed outreach objective preserves the requested sector and quantity', () => {
  const objective = specialistWorkObjective({
    objective: 'Find and qualify three manufacturing prospects in Hannover.',
    context: { location: 'Hannover, Germany' },
  }, 'primary-outreach');
  assert.match(objective, /three manufacturing prospects/);
  assert.equal(objective, 'Find and qualify three manufacturing prospects in Hannover.');
});

test('typed outreach work uses the normal outreach Room methodology catalog', () => {
  assert.equal(workOrderTaskTag({ kind: 'outreach_growth', room_tag: 'outreach' }), 'outreach');
  assert.equal(workOrderTaskTag({ kind: 'seo', room_tag: 'seo' }), 'seo');
});

test('work order prompt is a bounded plain-text Room request', () => {
  const prompt = workOrderPrompt({
    title: 'Build pipeline',
    objective: 'Find qualified regulated-sector prospects in Hannover.',
    input_snapshot: { location: 'Hannover, Germany' },
    acceptance_criteria: ['Persist verified prospects.', 'Include a fit rationale.'],
  });
  assert.match(prompt, /^Find qualified regulated-sector prospects/);
  assert.match(prompt, /Company location for this assignment: Hannover, Germany/);
  assert.match(prompt, /Done when:\n- Persist verified prospects/);
  assert.doesNotMatch(prompt, /work_order_id|selected_skills|hq-work-order\.v2/);
});

test('HQ forwards only completion requirements authored in durable task data', () => {
  const requirements = compileCompletionRequirements({
    kind: 'arbitrary', context: { completion_requirements: [
      { type: 'has_min_count', minimum: 3, select: 'records' },
    ] },
  });
  assert.deepEqual(requirements, [{ type: 'has_min_count', minimum: 3, select: 'records' }]);
  assert.equal(requirements[0].minimum, 3);
});
