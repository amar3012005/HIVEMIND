import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PredicateEngine,
  GenericStageExecutor,
  DirectorPlaybookSelector,
  RuntimeAdapterRegistry,
  RuntimeRoomDirector,
  roomPhaseEnvelope,
  serializeRoomEnvelope,
  RuntimePlaybookService,
  RuntimePlaybookRegistry,
  createJsonPlaybookSource,
  createPrismaPlaybookSource,
  defaultPredicateNames,
  runtimePlaybookContentHash,
} from '../../src/runtime-playbooks/index.js';

class TestRuntimeStore {
  constructor() {
    this.runs = new Map();
    this.checkpoints = [];
  }

  async createRun(input) {
    const existing = [...this.runs.values()].find((run) => run.orgId === input.orgId && run.idempotencyKey === input.idempotencyKey);
    if (existing) return structuredClone(existing);
    const run = {
      id: `run-${this.runs.size + 1}`,
      orgId: input.orgId,
      roomId: input.roomId || null,
      scopeKey: input.scopeKey || 'global',
      playbookId: input.playbookId,
      playbookVersion: input.playbookVersion,
      idempotencyKey: input.idempotencyKey,
      status: 'ACTIVE',
      currentStageId: input.currentStageId,
      completedStageIds: [],
      terminalState: null,
      trigger: input.trigger || {},
      context: input.context || {},
      stageAttempts: {},
      waitingFor: null,
      lastVerdict: {},
      artifacts: [],
      authorityGates: [],
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  async loadRun(runId, orgId) {
    const run = this.runs.get(runId);
    if (!run || run.orgId !== orgId) throw new Error('runtime_run_not_found');
    return structuredClone(run);
  }

  async claimRun(runId, orgId, owner) {
    const run = this.runs.get(runId);
    if (!run || run.orgId !== orgId || (run.leaseOwner && run.leaseOwner !== owner)) return false;
    run.leaseOwner = owner;
    return true;
  }

  async releaseRun(runId, orgId, owner) {
    const run = this.runs.get(runId);
    if (run?.orgId === orgId && run.leaseOwner === owner) run.leaseOwner = null;
  }

  async updateRun(runId, orgId, data) {
    const run = this.runs.get(runId);
    if (!run || run.orgId !== orgId) throw new Error('runtime_run_not_found');
    Object.assign(run, structuredClone(data));
    return this.loadRun(runId, orgId);
  }

  async appendCheckpoint(runId, orgId, checkpoint) {
    await this.loadRun(runId, orgId);
    const row = { runId, orgId, sequence: this.checkpoints.length + 1, ...structuredClone(checkpoint) };
    this.checkpoints.push(row);
    return row;
  }

  async persistArtifacts(runId, orgId, stageId, artifacts) {
    const run = this.runs.get(runId);
    if (!run || run.orgId !== orgId) throw new Error('runtime_run_not_found');
    for (const artifact of artifacts) {
      const previous = run.artifacts.find((candidate) => candidate.id === artifact.id);
      if (!previous) run.artifacts.push({ ...structuredClone(artifact), stage_id: stageId });
      else assert.deepEqual(previous, { ...structuredClone(artifact), stage_id: stageId });
    }
    return structuredClone(artifacts);
  }

  async grantAuthority(runId, orgId, gate) {
    const run = this.runs.get(runId);
    if (!run || run.orgId !== orgId) throw new Error('runtime_run_not_found');
    run.authorityGates = [...new Set([...run.authorityGates, gate])];
    return { gate, status: 'GRANTED' };
  }
}

const fixturePath = fileURLToPath(new URL('../../src/runtime-playbooks/fixtures/greenleaf-order-operations.v1.json', import.meta.url));
const outreachFixturePath = fileURLToPath(new URL('../../src/runtime-playbooks/fixtures/outreach-prospect-to-conversation.v1.json', import.meta.url));
const outreachV2FixturePath = fileURLToPath(new URL('../../src/runtime-playbooks/fixtures/outreach-prospect-to-conversation.v2.json', import.meta.url));

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

function stage(playbook, id) {
  return playbook.stages.find((candidate) => candidate.id === id);
}

test('GreenLeaf Bakery playbook is pure data and validates without engine changes', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([fixturePath])]);
  const playbook = registry.get('greenleaf.order-operations', 1);

  assert.equal(playbook.initial_stage_id, 'capture_request');
  assert.deepEqual(playbook.terminal_states, ['notified', 'cancelled']);
  assert.equal(stage(playbook, 'fulfill_request').waits_for_event.type, 'fulfillment.completed');
  assert.equal(stage(playbook, 'notify_customer').authority_gate, 'external_write');
  assert.equal(registry.descriptors()[0].content_hash, runtimePlaybookContentHash(playbook));

  const artifacts = {
    request_record: [{
      id: 'request-1',
      key: 'request_record',
      data: {
        request_id: 'GL-1001',
        customer_contact: 'customer@example.test',
        items: [{ sku: 'LOAF-1', quantity: 2 }],
        cancelled: false,
      },
    }],
    confirmation_record: [{
      id: 'confirmation-1',
      key: 'confirmation_record',
      data: { request_ref: 'request-1', confirmed_at: '2026-08-01T10:00:00.000Z' },
    }],
    fulfillment_record: [{
      id: 'fulfillment-1',
      key: 'fulfillment_record',
      data: { request_ref: 'request-1', state: 'fulfilled', completed_at: '2026-08-01T11:00:00.000Z' },
    }],
    notification_receipt: [{
      id: 'receipt-1',
      key: 'notification_receipt',
      data: { provider_receipt_id: 'provider-42', status: 'accepted' },
    }],
  };

  const predicates = new PredicateEngine();
  for (const current of playbook.stages) {
    const verdict = predicates.validateChecks(current.completion_checks, artifacts);
    assert.equal(verdict.passed, true, `${current.id}: ${JSON.stringify(verdict.unmet)}`);
  }
  assert.equal(predicates.evaluate(stage(playbook, 'capture_request').transitions[0].when, artifacts), false);
});

test('new planning catalogs expose only the latest active playbook version', async () => {
  const registry = new RuntimePlaybookRegistry();
  const first = await loadFixture();
  const second = structuredClone(first);
  second.version = 2;
  second.name = `${first.name} v2`;
  registry.register(first);
  registry.register(second);

  assert.deepEqual(registry.descriptors().map((entry) => entry.version), [2, 1]);
  assert.deepEqual(registry.descriptors({ latestOnly: true }).map((entry) => entry.version), [2]);
  assert.equal(registry.get(first.playbook_id, 1).version, 1);
});

test('Room Director sends a generic stage envelope and accepts only correlated expected artifacts', async () => {
  const calls = [];
  const director = new RuntimeRoomDirector({
    transport: async (payload) => {
      calls.push(payload);
      const context = JSON.parse(payload.execution_context);
      return { result: {
        contract: 'runtime-stage-result.v1',
        run_id: context.run_id,
        stage_id: context.stage_id,
        artifacts: [{
          id: 'artifact-1', key: 'request_record', status: 'READY',
          data: { request_id: 'GL-1003' }, source_refs: ['work:1'], external_ref: null,
        }],
        gaps: [],
      } };
    },
  });
  const result = await director.execute({
    run_id: 'run-1', org_id: 'org-1', room_id: 'room-1', owner_user_id: 'user-1',
    room_context: { user_id: 'user-1', participant_ids: ['employee-1'], room_tag: 'operations' },
    playbook_id: 'greenleaf.order-operations', playbook_version: 1,
    stage_id: 'capture_request', objective: 'Capture the supplied request.',
    expected_artifacts: ['request_record'], checks: [{ predicate: 'has_min_count', select: 'request_record', value: 1 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schema_version, 'runtime-stage.v1');
  assert.equal(calls[0].write_policy, 'deny');
  assert.equal(JSON.parse(calls[0].execution_context).contract, 'runtime-stage.v1');
  assert.deepEqual(result.artifacts.map((artifact) => artifact.key), ['request_record']);
});

test('Runtime Room context stays within the sidecar contract without losing phase evidence', () => {
  const transcript = `Administrator: current priority\nRuntime: noted\n${'detail '.repeat(2200)}`;
  const envelope = {
    contract: 'room-phase.v2', run_id: 'run-large', playbook_id: 'opaque.lifecycle', playbook_version: 1,
    phase_id: 'analyze', instruction: 'Analyze the retained conversation.',
    context: {
      company: { name: 'Example', profile: { facts: Array.from({ length: 80 }, (_, i) => `company fact ${i} ${'x'.repeat(160)}`) } },
      baseline: { observations: Array.from({ length: 80 }, (_, i) => ({ id: i, detail: 'y'.repeat(180) })) },
      request: { instruction: 'Analyze the retained conversation.' },
      prior_artifacts: { event: { transcript } },
    },
    lifecycle: {
      guidance: 'Produce evidence from the retained conversation.', expected_artifacts: ['status_record'],
      completion_checks: [{ predicate: 'has_min_count', select: 'status_record', value: 1 }],
      artifact_schemas: { status_record: { description: 'z'.repeat(9000) } },
      strict_response_schema: { type: 'object', properties: { summary: { type: 'string' } } },
    },
    capabilities: Array.from({ length: 30 }, (_, i) => ({ id: `provider-${i}`, operations: ['execute', 'verify'], description: 'q'.repeat(500) })),
  };
  const encoded = serializeRoomEnvelope(envelope);
  const decoded = JSON.parse(encoded);
  assert.ok(encoded.length <= 15_500);
  assert.equal(decoded.instruction, envelope.instruction);
  assert.match(decoded.context.prior_artifacts.event.transcript, /Administrator: current priority/);
  assert.deepEqual(decoded.lifecycle.strict_response_schema, envelope.lifecycle.strict_response_schema);
  assert.equal(decoded.lifecycle.artifact_schemas, undefined);
  assert.doesNotMatch(encoded, /nested context omitted/);
});

test('room phase context does not duplicate dedicated lifecycle inputs inside prior artifacts', () => {
  const catalog = Array.from({ length: 12 }, (_, index) => ({
    playbook_id: `lifecycle.${index}`, version: 1, supported_actions: [`action_${index}`],
  }));
  const envelope = roomPhaseEnvelope({
    run_id: 'run-dedup', playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 4,
    stage_id: 'design_first_life_portfolio', instruction: 'Design the portfolio.',
    expected_artifacts: ['first_life_motion_portfolio'], checks: [],
    execution_config: { contract: 'room-phase.v2', exclude_current_playbook_from_catalog: true },
    runtime_context: { company: { name: 'Example' }, request: { instruction: 'Design it' }, lifecycle_catalog: catalog },
    inputs: {
      'context.company': { name: 'Example' },
      'context.request': { instruction: 'Design it' },
      'context.lifecycle_catalog': catalog,
      'artifacts.marketing_strategy_decision': [{ id: 'decision-1' }],
    },
  });
  assert.equal(envelope.context.lifecycle_catalog.length, catalog.length);
  assert.equal(envelope.context.prior_artifacts['context.lifecycle_catalog'], undefined);
  assert.equal(envelope.context.prior_artifacts['context.company'], undefined);
  assert.deepEqual(envelope.context.prior_artifacts['artifacts.marketing_strategy_decision'], [{ id: 'decision-1' }]);
  assert.ok(serializeRoomEnvelope(envelope).length <= 15_500);
});

test('Room Director marks only an authority-granted stage as authorized', async () => {
  const policies = [];
  const director = new RuntimeRoomDirector({ transport: async (payload) => {
    policies.push(payload.write_policy);
    const context = JSON.parse(payload.execution_context);
    return { result: {
      contract: 'runtime-stage-result.v1', run_id: context.run_id, stage_id: context.stage_id,
      artifacts: [{ id: 'receipt-1', key: 'receipt', data: {}, source_refs: ['work:1'] }], gaps: [],
    } };
  } });
  await director.execute({
    run_id: 'run-authorized', org_id: 'org-1', room_id: 'room-1', owner_user_id: 'user-1',
    room_context: { user_id: 'user-1' }, playbook_id: 'opaque.lifecycle', playbook_version: 1,
    stage_id: 'execute', objective: 'Execute the approved action.', expected_artifacts: ['receipt'],
    checks: [], authority_granted: true,
  });
  assert.deepEqual(policies, ['authorized']);
});

test('Room Director fails closed on invented artifact keys and mismatched stages', async () => {
  const baseRequest = {
    run_id: 'run-2', org_id: 'org-1', room_id: 'room-1', owner_user_id: 'user-1',
    room_context: { user_id: 'user-1' }, playbook_id: 'greenleaf.order-operations',
    playbook_version: 1, stage_id: 'capture_request', objective: 'Capture it.',
    expected_artifacts: ['request_record'], checks: [],
  };
  const wrongKey = new RuntimeRoomDirector({ transport: async () => ({ result: {
    contract: 'runtime-stage-result.v1', run_id: 'run-2', stage_id: 'capture_request',
    artifacts: [{ id: 'bad-1', key: 'made_up_record', data: {} }], gaps: [],
  } }) });
  await assert.rejects(() => wrongKey.execute(baseRequest), /runtime_room_artifact_key_unexpected/);

  const wrongStage = new RuntimeRoomDirector({ transport: async () => ({ result: {
    contract: 'runtime-stage-result.v1', run_id: 'run-2', stage_id: 'another_stage', artifacts: [], gaps: [],
  } }) });
  await assert.rejects(() => wrongStage.execute(baseRequest), /runtime_room_result_correlation_mismatch/);
});

test('Room Director namespaces retry artifacts by stage attempt', async () => {
  const director = new RuntimeRoomDirector({ transport: async () => ({ result: {
    contract: 'runtime-stage-result.v1', run_id: 'run-repair', stage_id: 'repair',
    artifacts: [{ id: 'artifact-001', key: 'result', data: { revised: true } }], gaps: [],
  } }) });
  const result = await director.execute({
    run_id: 'run-repair', org_id: 'org-1', room_id: 'room-1', owner_user_id: 'user-1',
    room_context: { user_id: 'user-1' }, playbook_id: 'generic.repair', playbook_version: 1,
    stage_id: 'repair', objective: 'Repair the rejected artifact.', expected_artifacts: ['result'],
    checks: [], stage_attempts: { repair: 2 },
  });
  assert.equal(result.artifacts[0].id, 'artifact-001:attempt:2');
});

test('generic executor checkpoints and resumes the GreenLeaf lifecycle end to end', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([fixturePath])]);
  const store = new TestRuntimeStore();
  const director = {
    async execute({ stage_id: stageId }) {
      const outputs = {
        capture_request: [{ id: 'request-1', key: 'request_record', data: {
          request_id: 'GL-1001', customer_contact: 'customer@example.test',
          items: [{ sku: 'LOAF-1', quantity: 2 }], cancelled: false,
        } }],
        confirm_terms: [{ id: 'confirmation-1', key: 'confirmation_record', data: {
          request_ref: 'request-1', confirmed_at: '2026-08-01T10:00:00.000Z',
        } }],
        fulfill_request: [{ id: 'fulfillment-1', key: 'fulfillment_record', data: {
          request_ref: 'request-1', state: 'fulfilled', completed_at: '2026-08-01T11:00:00.000Z',
        } }],
        notify_customer: [{ id: 'receipt-1', key: 'notification_receipt', data: {
          provider_receipt_id: 'provider-42', status: 'accepted',
        } }],
      };
      return { artifacts: outputs[stageId] || [] };
    },
  };
  const stageEvents = [];
  const executor = new GenericStageExecutor({
    registry, predicates: new PredicateEngine(), store, director, workerId: 'test-worker',
    onStageState: async (entry) => stageEvents.push({ phase: entry.phase, stage: entry.stage.id, count: entry.artifacts.length }),
  });
  const created = await executor.createRun({
    orgId: 'organization-1',
    playbookId: 'greenleaf.order-operations',
    playbookVersion: 1,
    idempotencyKey: 'order-1001',
    trigger: { request: 'two loaves' },
  });

  let run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'WAITING_AUTHORITY');
  assert.equal(run.currentStageId, 'confirm_terms');

  await executor.grantAuthority(run.id, run.orgId, 'commit_terms');
  run = await executor.run(run.id, { orgId: run.orgId });
  assert.equal(run.status, 'WAITING_EVENT');
  assert.equal(run.currentStageId, 'notify_customer');
  assert.equal(run.waitingFor.type, 'fulfillment.completed');

  run = await executor.run(run.id, {
    orgId: run.orgId,
    event: { type: 'fulfillment.completed', data: { request_ref: 'request-1' } },
  });
  assert.equal(run.status, 'WAITING_AUTHORITY');
  assert.equal(run.currentStageId, 'notify_customer');

  await executor.grantAuthority(run.id, run.orgId, 'external_write');
  run = await executor.run(run.id, { orgId: run.orgId });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.terminalState, 'notified');
  assert.deepEqual(run.completedStageIds, ['capture_request', 'confirm_terms', 'fulfill_request', 'notify_customer']);
  assert.deepEqual(store.checkpoints.map((checkpoint) => checkpoint.phase), [
    'BEFORE_EXECUTION', 'AFTER_EXECUTION', 'STAGE_ADVANCED',
    'BEFORE_EXECUTION', 'AUTHORITY_REQUIRED',
    'BEFORE_EXECUTION', 'AFTER_EXECUTION', 'STAGE_ADVANCED',
    'BEFORE_EXECUTION', 'AFTER_EXECUTION', 'EVENT_REQUIRED',
    'EVENT_RECEIVED', 'BEFORE_EXECUTION', 'AUTHORITY_REQUIRED',
    'BEFORE_EXECUTION', 'AFTER_EXECUTION', 'TERMINAL',
  ]);
  assert.deepEqual(stageEvents.filter((entry) => entry.phase === 'ACCEPTED'), [
    { phase: 'ACCEPTED', stage: 'capture_request', count: 1 },
    { phase: 'ACCEPTED', stage: 'confirm_terms', count: 1 },
    { phase: 'ACCEPTED', stage: 'fulfill_request', count: 1 },
    { phase: 'ACCEPTED', stage: 'notify_customer', count: 1 },
  ]);
});

test('generic executor follows an alternate terminal transition from playbook data', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([fixturePath])]);
  const store = new TestRuntimeStore();
  const executor = new GenericStageExecutor({
    registry,
    predicates: new PredicateEngine(),
    store,
    workerId: 'test-worker',
    director: { async execute() { return { artifacts: [{
      id: 'request-cancelled', key: 'request_record', data: {
        request_id: 'GL-1002', customer_contact: 'customer@example.test',
        items: [{ sku: 'ROLL-1', quantity: 1 }], cancelled: true,
      },
    }] }; } },
  });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'greenleaf.order-operations', playbookVersion: 1,
    idempotencyKey: 'order-1002',
  });
  const run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.terminalState, 'cancelled');
  assert.deepEqual(run.completedStageIds, ['capture_request']);
});

test('adapter-declared capability wait resumes the same stage after connection', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register({
    playbook_id: 'generic.capability-wait', version: 1, status: 'ACTIVE',
    name: 'Generic capability wait', description: 'Wait and resume without replacing the run.',
    initial_stage_id: 'perform', terminal_states: ['done'],
    stages: [{
      id: 'perform', objective: 'Perform the configured adapter action.',
      input_refs: ['trigger.payload'], expected_artifacts: ['receipt'],
      execution: { mode: 'adapter', adapter_id: 'provider', operation: 'execute' },
      completion_checks: [{ predicate: 'has_exact_count', select: 'receipt', value: 1 }],
      transitions: [{ default: true, to_terminal: 'done' }], on_failure: 'ESCALATE',
    }],
  });
  const store = new TestRuntimeStore();
  let connected = false;
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({ id: 'provider', async execute() {
    if (!connected) return { artifacts: [], waiting_for: {
      types: ['capability.connected'], capability: 'provider',
      presentation: { status_label: 'Waiting for provider' },
    } };
    return { artifacts: [{ id: 'receipt-1', key: 'receipt', status: 'READY', data: {} }] };
  } });
  const executor = new GenericStageExecutor({
    registry, predicates: new PredicateEngine(), store, director: { async execute() { throw new Error('room_not_expected'); } },
    adapters, workerId: 'capability-worker',
  });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'generic.capability-wait', playbookVersion: 1,
    idempotencyKey: 'capability-1', trigger: { payload: {} },
  });
  let run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'WAITING_EVENT');
  assert.equal(run.currentStageId, 'perform');
  assert.deepEqual(run.completedStageIds, []);
  connected = true;
  run = await executor.run(run.id, { orgId: run.orgId, event: { type: 'capability.connected' } });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.terminalState, 'done');
});

test('a reconciled terminal outcome supersedes append-only uncertain history', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register({
    playbook_id: 'generic.reconcile-outcome', version: 1, status: 'ACTIVE',
    name: 'Generic reconciliation', description: 'Resolve an uncertain item without deleting its audit history.',
    initial_stage_id: 'perform', terminal_states: ['done'],
    stages: [{
      id: 'perform', objective: 'Produce one terminal outcome.', input_refs: ['trigger.payload'],
      expected_artifacts: ['receipt', 'uncertain'],
      completion_checks: [
        { predicate: 'references_cover_all', select: ['receipt', 'uncertain'], path: 'data.input_ref', target_select: 'input', target_path: 'id' },
        { predicate: 'has_max_count', select: 'uncertain', value: 0 },
        { predicate: 'has_exact_count', select: 'receipt', value: 1 },
      ],
      transitions: [{ default: true, to_terminal: 'done' }], on_failure: 'REPAIR', max_attempts: 2,
    }],
  });
  const store = new TestRuntimeStore();
  let attempt = 0;
  const director = { async execute() {
    attempt += 1;
    return { artifacts: attempt === 1
      ? [{ id: 'uncertain-1', key: 'uncertain', status: 'UNCERTAIN', data: { input_ref: 'input-1' } }]
      : [{ id: 'receipt-1', key: 'receipt', status: 'READY', data: { input_ref: 'input-1' } }] };
  } };
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, workerId: 'reconcile-worker' });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'generic.reconcile-outcome', playbookVersion: 1,
    idempotencyKey: 'reconcile-1', trigger: { payload: {} },
  });
  store.runs.get(created.id).artifacts.push({ id: 'input-1', key: 'input', status: 'READY', data: {} });
  const run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.artifacts.some((artifact) => artifact.status === 'UNCERTAIN'), true);
  assert.equal(run.artifacts.some((artifact) => artifact.key === 'receipt'), true);
});

test('playbook executor exclusively owns semantic retry count and parks after the declared maximum', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register({
    playbook_id: 'generic.retry-owner', version: 1, status: 'ACTIVE',
    name: 'Retry owner', description: 'Proves bounded retry ownership.',
    initial_stage_id: 'perform', terminal_states: ['done'],
    stages: [{
      id: 'perform', objective: 'Produce accepted evidence.', expected_artifacts: ['result'], input_refs: [],
      completion_checks: [{ predicate: 'has_min_count', select: 'result', value: 1 }],
      transitions: [{ default: true, to_terminal: 'done' }], on_failure: 'REPAIR', max_attempts: 2,
    }],
  });
  const store = new TestRuntimeStore();
  const requests = [];
  const director = { async execute(request) { requests.push(request); return { artifacts: [] }; } };
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, workerId: 'retry-owner' });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'generic.retry-owner', playbookVersion: 1,
    idempotencyKey: 'retry-owner-1', trigger: { payload: {} },
  });

  let run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'NEEDS_INTERVENTION');
  assert.equal(run.stageAttempts.perform, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.retry_policy), [
    { owner: 'playbook', stage_attempt: 1, max_stage_attempts: 2, room_outer_replays: 0, local_artifact_repair: true },
    { owner: 'playbook', stage_attempt: 2, max_stage_attempts: 2, room_outer_replays: 0, local_artifact_repair: true },
  ]);

  run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'NEEDS_INTERVENTION');
  assert.equal(run.stageAttempts.perform, 2);
  assert.equal(requests.length, 2, 'automatic reentry must not create a third Room execution');
});

test('artifact persistence failures obey the bounded playbook retry policy', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register({
    playbook_id: 'generic.persistence-repair', version: 1, status: 'ACTIVE',
    name: 'Persistence repair', description: 'Bounds persistence failures.',
    initial_stage_id: 'persist', terminal_states: ['done'],
    stages: [{
      id: 'persist', objective: 'Persist one result.', expected_artifacts: ['result'], input_refs: [],
      completion_checks: [{ predicate: 'has_min_count', select: 'result', value: 1 }],
      transitions: [{ default: true, to_terminal: 'done' }], on_failure: 'REPAIR', max_attempts: 2,
    }],
  });
  const store = new TestRuntimeStore();
  let persistenceCalls = 0;
  store.persistArtifacts = async () => {
    persistenceCalls += 1;
    throw new Error('runtime_artifact_immutable:artifact-001');
  };
  const director = { async execute() {
    return { artifacts: [{ id: 'artifact-001', key: 'result', data: { ready: true } }] };
  } };
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, workerId: 'persistence-repair' });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'generic.persistence-repair', playbookVersion: 1,
    idempotencyKey: 'persistence-repair-1', trigger: { payload: {} },
  });
  const run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'NEEDS_INTERVENTION');
  assert.equal(run.stageAttempts.persist, 2);
  assert.equal(persistenceCalls, 2);
  assert.equal(store.checkpoints.filter((entry) => entry.phase === 'ARTIFACT_PERSISTENCE_ERROR').length, 2);
});

test('non-retryable Room contract failures stop after one attempt', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register({
    playbook_id: 'generic.non-retryable-room-error', version: 1, status: 'ACTIVE',
    name: 'Non-retryable Room error', description: 'Stops deterministic contract failures immediately.',
    initial_stage_id: 'perform', terminal_states: ['done'],
    stages: [{
      id: 'perform', objective: 'Produce accepted evidence.', expected_artifacts: ['result'], input_refs: [],
      completion_checks: [{ predicate: 'has_min_count', select: 'result', value: 1 }],
      transitions: [{ default: true, to_terminal: 'done' }], on_failure: 'REPAIR', max_attempts: 3,
    }],
  });
  const store = new TestRuntimeStore();
  let calls = 0;
  const director = { async execute() {
    calls += 1;
    const error = new Error('runtime_room_execution_context_too_large:16933');
    error.retryable = false;
    throw error;
  } };
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, workerId: 'non-retryable-room-error' });
  const created = await executor.createRun({
    orgId: 'organization-1', playbookId: 'generic.non-retryable-room-error', playbookVersion: 1,
    idempotencyKey: 'non-retryable-room-error-1', trigger: { payload: {} },
  });

  const run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'NEEDS_INTERVENTION');
  assert.equal(run.stageAttempts.perform, 1);
  assert.equal(calls, 1);
  assert.equal(store.checkpoints.filter((entry) => entry.phase === 'EXECUTION_ERROR').length, 1);
});

test('Director selects an exact registered playbook without local content routing', async () => {
  const fixture = await loadFixture();
  const alternate = structuredClone(fixture);
  alternate.playbook_id = 'alternate.service-cycle';
  alternate.name = 'Alternate service cycle';
  alternate.description = 'A second lifecycle with an independently selected purpose.';
  const registry = new RuntimePlaybookRegistry();
  registry.register(fixture);
  registry.register(alternate);
  const calls = [];
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async (model, request) => {
      calls.push({ model, body: JSON.parse(request.body) });
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({
            playbook_id: alternate.playbook_id, version: 1, reason: 'semantic fit',
          }) } }] };
        },
      };
    },
  });
  const selected = await selector.select({ objective: '任意の業務を処理してください', context: { signal: 7 } });
  assert.deepEqual(selected, { playbook_id: alternate.playbook_id, version: 1, reason: 'semantic fit' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages[1].content.includes(alternate.playbook_id), true);
});

test('Director selection rejects invented identifiers rather than guessing a fallback', async () => {
  const fixture = await loadFixture();
  const alternate = structuredClone(fixture);
  alternate.playbook_id = 'alternate.service-cycle';
  const registry = new RuntimePlaybookRegistry();
  registry.register(fixture);
  registry.register(alternate);
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '{"playbook_id":"invented.route","version":1}' } }] }; },
    }),
  });
  await assert.rejects(() => selector.select({ objective: 'ambiguous request' }), /runtime_playbook_selection_not_in_registry/);
});

test('Director retries one malformed selection response without local routing', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  let calls = 0;
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() {
        calls += 1;
        return { choices: [{ message: { content: calls === 1
          ? '{"playbook_id":"outreach.prospect-to-conversation"'
          : '{"playbook_id":"outreach.prospect-to-conversation","version":2,"reason":"complete fit","bindings":{"target.quantity":10,"constraints.delivery_requested":true}}' } }] };
      },
    }),
  });
  const selected = await selector.select({ objective: 'Acquire customers from a sourced local prospect list.' });
  assert.equal(calls, 2);
  assert.equal(selected.version, 2);
  assert.deepEqual(selected.context_patch, { target: { quantity: 10 }, constraints: { delivery_requested: true } });
});

test('Director may decline every registered playbook instead of forcing a bad fit', async () => {
  const registry = new RuntimePlaybookRegistry();
  registry.register(await loadFixture());
  const calls = [];
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async (_model, request) => {
      calls.push(JSON.parse(request.body));
      return {
        ok: true,
        async json() { return { choices: [{ message: { content: '{"playbook_id":null,"version":null,"reason":"no lifecycle fit"}' } }] }; },
      };
    },
  });
  const selected = await selector.select({ objective: 'A task unrelated to the available lifecycle.' });
  assert.deepEqual(selected, { playbook_id: null, version: null, reason: 'no lifecycle fit' });
  assert.equal(calls.length, 1, 'selection must still use the Director when one playbook is registered');
});

test('Director does not substitute another Room when the selected owner has no lifecycle', async () => {
  const fixture = await loadFixture();
  fixture.metadata = { ...(fixture.metadata || {}), owner_room_tag: 'operator-room' };
  const registry = new RuntimePlaybookRegistry();
  registry.register(fixture);
  let calls = 0;
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async (_model, request) => {
      calls += 1;
      return {
        ok: true,
        async json() { return { choices: [{ message: { content: '{"playbook_id":null,"version":null,"reason":"no lifecycle fit"}' } }] }; },
      };
    },
  });
  const selected = await selector.select({
    objective: 'Evaluate the requested outcome.',
    context: { request: { owner_room_tag: 'advisory-room' } },
  });
  assert.deepEqual(selected, {
    playbook_id: null,
    version: null,
    reason: 'no_active_playbook_for_selected_room:advisory-room',
  });
  assert.equal(calls, 0);
});

test('Director validates only the lifecycle durably selected by the planner', async () => {
  const selectedFixture = await loadFixture();
  const unrelatedFixture = structuredClone(selectedFixture);
  unrelatedFixture.playbook_id = 'sample.unrelated-lifecycle';
  unrelatedFixture.name = 'Unrelated lifecycle';
  const registry = new RuntimePlaybookRegistry();
  registry.register(selectedFixture);
  registry.register(unrelatedFixture);
  let suppliedCatalog = '';
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async (_model, request) => {
      suppliedCatalog = JSON.parse(request.body).messages[1].content;
      return {
        ok: true,
        async json() { return { choices: [{ message: { content: '{"playbook_id":null,"version":null,"reason":"no lifecycle fit"}' } }] }; },
      };
    },
  });
  await selector.select({
    objective: 'Validate the planned lifecycle.',
    context: { request: { playbook_id: selectedFixture.playbook_id, playbook_version: selectedFixture.version } },
  });
  assert.equal(suppliedCatalog.includes(selectedFixture.playbook_id), true);
  assert.equal(suppliedCatalog.includes(unrelatedFixture.playbook_id), false);
});

test('Runtime selection binds one exact supported action from playbook data', async () => {
  const fixture = await loadFixture();
  fixture.metadata = { ...(fixture.metadata || {}), supported_actions: ['perform_declared_effect'] };
  const registry = new RuntimePlaybookRegistry();
  registry.register(fixture);
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        playbook_id: fixture.playbook_id,
        version: fixture.version,
        matched_supported_action: 'invented_effect',
        acceptable_terminal_states: [fixture.terminal_states[0]],
      }) } }] }; },
    }),
  });
  await assert.rejects(() => selector.select({
    objective: 'Perform the requested effect.',
    context: { request: { requested_action: 'Perform the requested effect.' } },
  }), /runtime_playbook_supported_action_required/);
});

test('Director binds only playbook-declared inputs without keyword parsing in the engine', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        playbook_id: 'outreach.prospect-to-conversation', version: 2, reason: 'complete lifecycle fit',
        bindings: {
          'target.quantity': 10,
          'target.location': 'Hannover, Germany',
          'target.segment': 'industrial automation manufacturers',
          'constraints.delivery_requested': true,
          'undeclared.value': 'ignored',
        },
      }) } }] }; },
    }),
  });
  const selected = await selector.select({ objective: '任意の言語で十社へ連絡してください' });
  assert.deepEqual(selected.context_patch, {
    target: { quantity: 10, location: 'Hannover, Germany', segment: 'industrial automation manufacturers' },
    constraints: { delivery_requested: true },
  });
  assert.equal(JSON.stringify(selected).includes('undeclared'), false);
});

test('Director applies a declared default when an open-ended binding is null', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        playbook_id: 'outreach.prospect-to-conversation', version: 2, reason: 'complete lifecycle fit',
        bindings: {
          'target.quantity': null,
          'target.location': 'Hannover, Germany',
          'constraints.delivery_requested': true,
        },
      }) } }] }; },
    }),
  });
  const selected = await selector.select({ objective: 'Pursue as many suitable organizations as possible.' });
  assert.equal(selected.context_patch.target.quantity, 10);
  assert.equal(selected.context_patch.target.location, 'Hannover, Germany');
});

test('durable runtime context wins over an inferred Director binding', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const selector = new DirectorPlaybookSelector({
    registry,
    completionFetch: async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        playbook_id: 'outreach.prospect-to-conversation', version: 2, reason: 'complete lifecycle fit',
        bindings: {
          'target.quantity': 50,
          'target.location': 'Europe',
          'constraints.delivery_requested': true,
        },
      }) } }] }; },
    }),
  });
  const selected = await selector.select({
    objective: 'Pursue suitable organizations.',
    context: { target: { location: 'Hannover, Germany' } },
  });
  assert.equal(selected.context_patch.target.location, 'Hannover, Germany');
  assert.equal(selected.context_patch.target.quantity, 50);
});

test('adapter registry exposes generic operations and injects immutable tenant execution context', async () => {
  const calls = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    id: 'sample.transport',
    name: 'Sample transport',
    description: 'A test implementation of the generic boundary.',
    inputSchema: { type: 'object' },
    async execute(input, context) {
      calls.push({ operation: 'execute', input, context });
      return { accepted: true, receipt: 'receipt-1' };
    },
    async verify(input, context) {
      calls.push({ operation: 'verify', input, context });
      return { verified: true };
    },
    async monitor(input, context) {
      calls.push({ operation: 'monitor', input, context });
      return { changed: false };
    },
  });
  assert.deepEqual(adapters.descriptors()[0].operations, ['execute', 'verify', 'monitor']);
  const result = await adapters.invoke('sample.transport', 'execute', { value: 3 }, {
    orgId: 'organization-1', runId: 'run-1', stageId: 'stage-1', roomId: 'room-1',
  });
  assert.deepEqual(result, { accepted: true, receipt: 'receipt-1' });
  assert.equal(calls[0].context.orgId, 'organization-1');
  await assert.rejects(
    () => adapters.invoke('sample.transport', 'execute', {}, { runId: 'run-1', stageId: 'stage-1' }),
    /runtime_adapter_execution_context_required/,
  );
  await assert.rejects(
    () => adapters.invoke('sample.transport', 'unknown', {}, { orgId: 'organization-1', runId: 'run-1', stageId: 'stage-1' }),
    /runtime_adapter_operation_invalid/,
  );
});

test('service-level authority grant resumes the exact waiting run immediately', async () => {
  const calls = [];
  const service = new RuntimePlaybookService({
    prisma: { runtimePlaybookRun: { async findFirst() { return { status: 'WAITING_AUTHORITY' }; } } },
    registry: {}, selector: {},
    executor: {
      async grantAuthority(...args) { calls.push(['grant', ...args]); return { status: 'GRANTED' }; },
      async run(...args) { calls.push(['run', ...args]); return { id: args[0], status: 'WAITING_EVENT' }; },
    },
  });
  const result = await service.grantAuthority('run-1', 'org-1', 'external_write', { grantedBy: 'user-1' });
  assert.equal(result.authority.status, 'GRANTED');
  assert.equal(result.run.status, 'WAITING_EVENT');
  assert.deepEqual(calls.map((call) => call[0]), ['grant', 'run']);
});

test('predicate engine exposes a bounded generic vocabulary and exact unmet checks', () => {
  assert.equal(defaultPredicateNames.length, 25);
  const engine = new PredicateEngine();
  const verdict = engine.validateChecks([
    { id: 'minimum', predicate: 'has_min_count', select: 'records', value: 2 },
    { id: 'grounding', predicate: 'is_source_backed', select: 'records', source_path: 'source_refs', value: 1 },
    { id: 'distinct', predicate: 'unique_by', select: 'records', path: 'data.external_id' },
  ], {
    records: [{ id: 'one', key: 'records', data: { external_id: 'A' }, source_refs: ['source-1'] }],
  });

  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.unmet.map((item) => item.id), ['minimum']);
  assert.throws(
    () => engine.validateChecks([{ predicate: 'unknown_check' }], {}),
    /runtime_predicate_unknown/,
  );
  assert.throws(
    () => engine.validateChecks([{ predicate: 'has_min_count', select: 'records' }], {}),
    /runtime_predicate_argument_missing:has_min_count:value/,
  );
});

test('dynamic predicate thresholds resolve from run context without engine domain logic', () => {
  const engine = new PredicateEngine();
  const check = {
    predicate: 'has_min_count', select: 'records',
    value_from: 'run.context.target.quantity', default_value: 1,
  };
  const artifacts = { records: [{ id: '1' }, { id: '2' }] };
  assert.equal(engine.validateChecks([check], artifacts, { run: { context: { target: { quantity: 2 } } } }).passed, true);
  assert.equal(engine.validateChecks([check], artifacts, { run: { context: { target: { quantity: 3 } } } }).passed, false);
});

test('Outreach lifecycle loads as versioned data with no engine modification', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const playbook = registry.get('outreach.prospect-to-conversation', 2);
  assert.equal(playbook.stages.length, 8);
  assert.deepEqual(playbook.terminal_states, ['prepared', 'conversation_started']);
  assert.equal(stage(playbook, 'prepare_drafts').execution.config.action, 'prepare_drafts');
  assert.equal(stage(playbook, 'deliver_outreach').authority_gate, 'external_write');
  assert.equal(stage(playbook, 'observe_responses').waits_for_event.type, 'response.received');
});

test('Outreach lifecycle advances through the Room contract and stops prepared without delivery', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const store = new TestRuntimeStore();
  const outputs = {
    discover_candidates: [
      { id: 'candidate-1', key: 'candidate_record', data: { organization_key: 'one', viable: true }, source_refs: ['source:1'] },
      { id: 'candidate-2', key: 'candidate_record', data: { organization_key: 'two', viable: true }, source_refs: ['source:2'] },
    ],
    qualify_candidates: [
      { id: 'qualified-1', key: 'qualified_record', data: { organization_key: 'one', fit_rationale: 'Fit one', outreach_angle: 'Angle one' }, source_refs: ['source:1'] },
      { id: 'qualified-2', key: 'qualified_record', data: { organization_key: 'two', fit_rationale: 'Fit two', outreach_angle: 'Angle two' }, source_refs: ['source:2'] },
    ],
    retain_records: [
      { id: 'lead-1', key: 'lead_record', data: { persistence_ref: 'leadbook:1', qualified_ref: 'qualified-1' }, source_refs: ['source:1'] },
      { id: 'lead-2', key: 'lead_record', data: { persistence_ref: 'leadbook:2', qualified_ref: 'qualified-2' }, source_refs: ['source:2'] },
    ],
    compose_messages: [
      { id: 'message-1', key: 'message_record', data: { recipient: 'one@example.test', subject: 'One', body: 'Body one', lead_ref: 'lead-1', delivery_requested: false }, source_refs: ['source:1'] },
      { id: 'message-2', key: 'message_record', data: { recipient: 'two@example.test', subject: 'Two', body: 'Body two', lead_ref: 'lead-2', delivery_requested: false }, source_refs: ['source:2'] },
    ],
  };
  const calls = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({
    id: 'tenant-records',
    async verify() { return { passed: true, evidence: [{ id: 'tenant-record-verified' }], unmet: [] }; },
  });
  adapters.register({
    id: 'gmail',
    async execute(input) {
      return { artifacts: input.inputs['artifacts.message_record'].map((message, index) => ({
        id: `draft-${index + 1}`, key: 'draft_record',
        data: { draft_ref: `drafts:${index + 1}`, recipient_ref: message.data.recipient,
          message_ref: message.id, lead_ref: message.data.lead_ref, delivery_requested: false },
        source_refs: message.source_refs,
      })) };
    },
  });
  const director = new RuntimeRoomDirector({ transport: async (payload) => {
    const envelope = JSON.parse(payload.execution_context);
    calls.push(envelope);
    return { result: {
      contract: 'runtime-stage-result.v1', run_id: envelope.run_id, stage_id: envelope.stage_id,
      artifacts: outputs[envelope.stage_id] || [], gaps: [],
    } };
  } });
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, adapters, workerId: 'outreach-worker' });
  const created = await executor.createRun({
    orgId: 'organization-1', roomId: 'room-1', playbookId: 'outreach.prospect-to-conversation',
    playbookVersion: 2, idempotencyKey: 'outreach-1',
    context: { target: { quantity: 2 }, company: { name: 'Any Company' }, constraints: { delivery_requested: false } },
  });
  const run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.terminalState, 'prepared');
  assert.deepEqual(run.completedStageIds, ['discover_candidates', 'qualify_candidates', 'retain_records', 'compose_messages', 'prepare_drafts']);
  assert.deepEqual(calls.map((call) => call.stage_id), ['discover_candidates', 'qualify_candidates', 'retain_records', 'compose_messages']);
  assert.equal(calls.every((call) => call.contract === 'runtime-stage.v1'), true);
  assert.equal(run.artifacts.length, 10);
});

test('Outreach lifecycle delegates provider execution and event monitoring to adapters', async () => {
  const registry = new RuntimePlaybookRegistry();
  await registry.load([createJsonPlaybookSource([outreachV2FixturePath])]);
  const store = new TestRuntimeStore();
  const roomOutputs = {
    discover_candidates: [{ id: 'candidate-1', key: 'candidate_record', data: { organization_key: 'one', viable: true }, source_refs: ['source:1'] }],
    qualify_candidates: [{ id: 'qualified-1', key: 'qualified_record', data: { organization_key: 'one', fit_rationale: 'Fit', outreach_angle: 'Angle' }, source_refs: ['source:1'] }],
    retain_records: [{ id: 'lead-1', key: 'lead_record', data: { persistence_ref: 'record-1', qualified_ref: 'qualified-1' }, source_refs: ['source:1'] }],
    compose_messages: [{ id: 'message-1', key: 'message_record', data: { recipient: 'lead@example.test', subject: 'Hello', body: 'A grounded message.', lead_ref: 'lead-1', delivery_requested: true }, source_refs: ['source:1'] }],
    handle_response: [{ id: 'response-1', key: 'response_record', data: { classification: 'interested', timeline_ref: 'record-1', provider_event_ref: 'event-artifact-1' }, source_refs: ['provider:reply-1'] }],
  };
  const roomCalls = [];
  const seenEvents = [];
  const director = { async execute({ stage_id: stageId, inputs }) {
    roomCalls.push(stageId);
    if (stageId === 'handle_response') seenEvents.push(inputs.event);
    return { artifacts: roomOutputs[stageId] || [] };
  } };
  const adapterCalls = [];
  const adapters = new RuntimeAdapterRegistry();
  adapters.register({ id: 'tenant-records', async verify() { return { passed: true, evidence: [], unmet: [] }; } });
  adapters.register({
    id: 'gmail',
    async verify() { adapterCalls.push('verify'); return { passed: true, evidence: [], unmet: [] }; },
    async execute(input) {
      if (input.config?.action === 'prepare_drafts') {
        adapterCalls.push('prepare');
        return { artifacts: [{
          id: 'draft-1', key: 'draft_record', source_refs: ['source:1'],
          data: { draft_ref: 'provider-draft-1', recipient_ref: 'lead@example.test', message_ref: 'message-1', lead_ref: 'lead-1', delivery_requested: true },
        }] };
      }
      adapterCalls.push('execute');
      return { artifacts: [{
        id: 'receipt-1', key: 'delivery_receipt', source_refs: ['provider:sent-1'],
        data: { provider_receipt_id: 'sent-1', thread_id: 'thread-1', correlation_ref: 'thread-1', status: 'accepted' },
      }] };
    },
    async monitor() {
      adapterCalls.push('monitor');
      return { artifacts: [{
        id: 'subscription-1', key: 'observation_subscription', source_refs: ['provider:sent-1'],
        data: { subscription_ref: 'gmail-thread:thread-1', correlation_ref: 'thread-1' },
      }] };
    },
  });
  const executor = new GenericStageExecutor({ registry, predicates: new PredicateEngine(), store, director, adapters, workerId: 'outreach-adapter-worker' });
  const created = await executor.createRun({
    orgId: 'organization-1', roomId: 'room-1', playbookId: 'outreach.prospect-to-conversation',
    playbookVersion: 2, idempotencyKey: 'outreach-adapter-1', context: { target: { quantity: 1 } },
  });
  let run = await executor.run(created.id, { orgId: created.orgId });
  assert.equal(run.status, 'WAITING_AUTHORITY');
  assert.equal(run.currentStageId, 'deliver_outreach');
  await executor.grantAuthority(run.id, run.orgId, 'external_write');
  run = await executor.run(run.id, { orgId: run.orgId });
  assert.equal(run.status, 'WAITING_EVENT');
  assert.equal(run.currentStageId, 'handle_response');
  assert.equal(run.waitingFor.correlation_value, 'thread-1');
  assert.deepEqual(adapterCalls, ['prepare', 'execute', 'monitor']);
  assert.equal(roomCalls.includes('deliver_outreach'), false);
  assert.equal(roomCalls.includes('observe_responses'), false);
  run = await executor.run(run.id, {
    orgId: run.orgId,
    event: { type: 'response.received', data: { correlation_ref: 'thread-1' } },
  });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.terminalState, 'conversation_started');
  assert.equal(seenEvents[0].data.correlation_ref, 'thread-1');
});

test('registry enforces immutable versions, scope precedence, and schema integrity', async () => {
  const fixture = await loadFixture();
  const registry = new RuntimePlaybookRegistry();
  registry.register(fixture);
  registry.register(fixture);

  assert.throws(
    () => registry.register({ ...fixture, description: 'Mutated after publication.' }),
    /runtime_playbook_version_immutable/,
  );
  assert.throws(
    () => registry.register({ definition: fixture, content_hash: '0'.repeat(64) }),
    /runtime_playbook_content_hash_mismatch/,
  );

  const scoped = structuredClone(fixture);
  scoped.name = 'Organization-specific order operations';
  registry.register({ scope_key: 'organization-1', definition: scoped });
  assert.equal(registry.get(fixture.playbook_id, 1, { scopeKey: 'organization-1' }).name, scoped.name);
  assert.equal(registry.get(fixture.playbook_id, 1, { scopeKey: 'organization-2' }).name, fixture.name);

  const broken = structuredClone(fixture);
  broken.version = 2;
  broken.stages[0].transitions = [{ default: true, to_stage: 'missing_stage' }];
  assert.throws(() => registry.register(broken), /runtime_playbook_transition_stage_missing/);
});

test('Prisma source maps persisted playbook records without coupling registry to storage', async () => {
  const fixture = await loadFixture();
  const calls = [];
  const source = createPrismaPlaybookSource({
    scopeKey: 'organization-1',
    prisma: {
      runtimePlaybookDefinition: {
        async findMany(query) {
          calls.push(query);
          return [{
            scopeKey: 'global',
            playbookId: fixture.playbook_id,
            version: fixture.version,
            definition: fixture,
            contentHash: runtimePlaybookContentHash(fixture),
          }];
        },
      },
    },
  });
  const registry = new RuntimePlaybookRegistry();
  await registry.load([source]);
  assert.equal(registry.get(fixture.playbook_id, 1).name, fixture.name);
  assert.deepEqual(calls[0].where.scopeKey.in, ['global', 'organization-1']);
});

test('generic modules contain no forbidden company, task, or channel routing terms', async () => {
  const modulePaths = [
    new URL('../../src/runtime-playbooks/registry.js', import.meta.url),
    new URL('../../src/runtime-playbooks/predicate-engine.js', import.meta.url),
    new URL('../../src/runtime-playbooks/playbook-schema.js', import.meta.url),
    new URL('../../src/runtime-playbooks/postgres-store.js', import.meta.url),
    new URL('../../src/runtime-playbooks/stage-executor.js', import.meta.url),
    new URL('../../src/runtime-playbooks/director-selector.js', import.meta.url),
    new URL('../../src/runtime-playbooks/adapter-registry.js', import.meta.url),
    new URL('../../src/runtime-playbooks/room-director.js', import.meta.url),
    new URL('../../src/runtime-playbooks/service.js', import.meta.url),
  ];
  const source = (await Promise.all(modulePaths.map((path) => readFile(path, 'utf8')))).join('\n').toLowerCase();
  for (const forbidden of ['singulance', 'greenleaf', 'bakery', 'email', 'instagram', 'prospect', 'berlin', 'gmail', 'linkedin']) {
    assert.equal(source.includes(forbidden), false, `generic module leaked domain term: ${forbidden}`);
  }
});
