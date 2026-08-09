import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ARTIFACT_FIELD_SHAPES, deriveStageArtifactContract, deriveStrictResponseSchema } from '../../src/runtime-playbooks/artifact-schema.js';

// THE BUG CLASS THIS KILLS: the checker held a contract the producer was never handed.
// Core derived `artifact_schemas` from its own predicates and the phase spec dropped them,
// so a Room was told the shape in prose and judged on a predicate. form_strategy returned
// `channel_mix: null` five attempts running, and the synth prompt even licensed it.

const DIR = new URL('../../src/runtime-playbooks/fixtures/', import.meta.url);
const FIXTURES = readdirSync(DIR).filter((name) => name.endsWith('.json'))
  .map((name) => ({ name, doc: JSON.parse(readFileSync(new URL(name, DIR), 'utf8')) }));

const stages = () => FIXTURES.flatMap(({ name, doc }) =>
  (doc.stages || []).map((stage) => ({ fixture: name, stage })));

test('every shipped fixture stage yields a derivable contract', () => {
  assert.ok(FIXTURES.length >= 10, `expected the fixture set, saw ${FIXTURES.length}`);
  for (const { fixture, stage } of stages()) {
    assert.doesNotThrow(() => deriveStageArtifactContract(stage), `${fixture}:${stage.id}`);
  }
});

test('a strict schema, where one applies, obeys every strict-mode invariant', () => {
  let applied = 0;
  for (const { fixture, stage } of stages()) {
    const spec = deriveStrictResponseSchema(stage);
    if (!spec) continue;  // strict deliberately does not apply — the producer keeps json_object
    applied += 1;
    const where = `${fixture}:${stage.id}`;
    const violations = [];
    (function walk(node, path) {
      if (!node || typeof node !== 'object') return;
      const isObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
      if (isObject) {
        // Strict mode forbids free-form objects and demands every property be listed in
        // `required`; optionality is a nullable union instead.
        if (node.additionalProperties !== false) violations.push(`${path}: additionalProperties must be false`);
        const props = Object.keys(node.properties || {});
        const missing = props.filter((key) => !(node.required || []).includes(key));
        if (missing.length) violations.push(`${path}: not in required -> ${missing.join(',')}`);
      }
      for (const [key, child] of Object.entries(node.properties || {})) walk(child, `${path}.${key}`);
      if (node.items) walk(node.items, `${path}[]`);
    })(spec.schema, 'root');
    assert.deepEqual(violations, [], `${where} strict violations:\n  ${violations.join('\n  ')}`);
    assert.ok(spec.name, `${where} needs a schema name`);
  }
  assert.ok(applied >= 1, 'at least one stage must actually exercise strict output');
});

test('severity maps onto nullability: required cannot be null, preferred can', () => {
  for (const { fixture, stage } of stages()) {
    const spec = deriveStrictResponseSchema(stage);
    if (!spec) continue;
    const data = spec.schema.properties.artifacts.items.properties.data;
    for (const field of spec.fields.required) {
      const type = data.properties[field]?.type;
      const nullable = Array.isArray(type) ? type.includes('null') : type === 'null';
      assert.equal(nullable, false, `${fixture}:${stage.id} required field ${field} must NOT be nullable`);
      assert.ok((data.required || []).includes(field), `${fixture}:${stage.id} ${field} must be present`);
    }
    for (const field of spec.fields.preferred) {
      const type = data.properties[field]?.type;
      assert.ok(Array.isArray(type) && type.includes('null'),
        `${fixture}:${stage.id} preferred field ${field} must be nullable`);
      // Still listed — strict mode has no true optionality, and the producer should see it.
      assert.ok((data.required || []).includes(field), `${fixture}:${stage.id} ${field} must be present`);
    }
  }
});

test('ASYMMETRY GUARD: a registered artifact key must type every field its predicates check', () => {
  // This is the assertion that makes the failure class impossible. If someone adds a
  // completion_check for a new field on a REGISTERED key without giving it a shape, the
  // deriver refuses to emit strict output — silently losing the guarantee. Fail here loudly.
  const unregistered = [];
  for (const { fixture, stage } of stages()) {
    const expected = (stage.expected_artifacts || []).map(String);
    if (expected.length !== 1) continue;
    const [key] = expected;
    const shapes = ARTIFACT_FIELD_SHAPES[key];
    if (!shapes) continue;  // unregistered key: json_object path, nothing to guarantee
    const { artifacts } = deriveStageArtifactContract(stage);
    const data = artifacts[key]?.schema?.properties?.data || {};
    for (const field of Object.keys(data.properties || {})) {
      if (!shapes[field]) unregistered.push(`${fixture}:${stage.id} -> ${key}.${field}`);
    }
    // …and therefore strict output must actually be produced for it.
    assert.ok(deriveStrictResponseSchema(stage),
      `${fixture}:${stage.id} has a registered key (${key}) but produced no strict schema`);
  }
  assert.deepEqual(unregistered, [],
    `predicates check fields with no registered shape:\n  ${unregistered.join('\n  ')}`);
});

test('every registered field declares whether it is authored or evidence_bound', () => {
  // The prompt used to forbid "fabricating" any field, which silently covered judgement
  // fields too. The distinction now lives in the schema registry, not in prose.
  for (const [key, shapes] of Object.entries(ARTIFACT_FIELD_SHAPES)) {
    for (const [field, entry] of Object.entries(shapes)) {
      assert.ok(['authored', 'evidence_bound'].includes(entry.kind),
        `${key}.${field} needs kind authored|evidence_bound, got ${entry.kind}`);
      assert.ok(entry.schema && typeof entry.schema === 'object', `${key}.${field} needs a schema`);
    }
  }
});

test('channel_mix is typed so the consumer gets organic AND paid, not a sentence', () => {
  // A predicate can only see "non-empty". With an untyped schema the model returned a STRING
  // for channel_mix — non-empty, predicate-passing, and useless to the campaign that reads it.
  const cm = ARTIFACT_FIELD_SHAPES.marketing_strategy.channel_mix.schema;
  assert.equal(cm.type, 'object');
  assert.deepEqual([...cm.required].sort(), ['organic', 'paid']);
  for (const lane of ['organic', 'paid']) {
    assert.equal(cm.properties[lane].type, 'array');
    assert.deepEqual([...cm.properties[lane].items.required].sort(), ['channel', 'rationale']);
  }
});

test('DELIVERY GUARD: the stage that needs the strict schema actually receives it', async () => {
  const { roomPhaseEnvelope, runtimeStageEnvelope } = await import('../../src/runtime-playbooks/room-director.js');
  // The trap: usesRoomPhase() tests the stage's configured contract against the literal
  // 'room-phase.v1', so a stage configured 'room-phase.v2' takes the runtimeStageEnvelope
  // path. Shipping the derived contract only inside roomPhaseEnvelope.lifecycle delivered it
  // to NOBODY — deriving it correctly is worthless if the producer never receives it.
  let checked = 0;
  for (const { fixture, stage } of stages()) {
    const derived = deriveStrictResponseSchema(stage);
    if (!derived) continue;
    const config = stage.execution?.config || {};
    const request = {
      run_id: 'r', playbook_id: 'p', playbook_version: 1, stage_id: stage.id, objective: stage.objective,
      expected_artifacts: stage.expected_artifacts, checks: stage.completion_checks,
      execution_config: config, inputs: {}, runtime_context: {},
      retry_policy: { owner: 'playbook', stage_attempt: 1, max_stage_attempts: stage.max_attempts || 1 },
    };
    const envelope = /^room-phase\.v\d+$/.test(String(config.contract || ''))
      ? roomPhaseEnvelope(request) : runtimeStageEnvelope(request);
    const delivered = envelope.strict_response_schema || envelope.lifecycle?.strict_response_schema;
    assert.ok(delivered, `${fixture}:${stage.id} derives a strict schema but the ${envelope.contract} envelope does not carry it`);
    assert.equal(delivered.name, derived.name, `${fixture}:${stage.id} delivered a different schema than was derived`);
    assert.equal((envelope.retry_policy || envelope.lifecycle?.retry_policy)?.owner, 'playbook',
      `${fixture}:${stage.id} must declare playbook retry ownership`);
    checked += 1;
  }
  assert.ok(checked >= 1, 'no stage exercised the delivery path');
});

test('both envelopes carry the derived contract, so neither path can drift', async () => {
  const { roomPhaseEnvelope, runtimeStageEnvelope } = await import('../../src/runtime-playbooks/room-director.js');
  const request = {
    run_id: 'r', playbook_id: 'p', playbook_version: 1, stage_id: 's',
    expected_artifacts: ['marketing_strategy'],
    checks: [{ predicate: 'all_have_nonempty_field', select: 'marketing_strategy', path: 'data.channel_mix' }],
    execution_config: {}, inputs: {}, runtime_context: {},
    retry_policy: { owner: 'playbook', stage_attempt: 1, max_stage_attempts: 3, room_outer_replays: 0 },
  };
  const direct = runtimeStageEnvelope(request);
  assert.ok(direct.artifact_schemas, 'runtime-stage.v1 must carry artifact_schemas');
  assert.ok('strict_response_schema' in direct, 'runtime-stage.v1 must carry strict_response_schema');
  const phase = roomPhaseEnvelope({ ...request, execution_config: { contract: 'room-phase.v1' } });
  assert.ok(phase.lifecycle.artifact_schemas, 'room-phase.v2 must carry artifact_schemas');
  assert.ok('strict_response_schema' in phase.lifecycle, 'room-phase.v2 must carry strict_response_schema');
  assert.equal(direct.retry_policy.owner, 'playbook');
  assert.equal(phase.lifecycle.retry_policy.owner, 'playbook');
});

test('room-phase.v2 is negotiated as a machine phase instead of a human runtime-stage turn', async () => {
  const { RuntimeRoomDirector } = await import('../../src/runtime-playbooks/room-director.js');
  let sent;
  const director = new RuntimeRoomDirector({ transport: async (payload) => {
    sent = payload;
    return { result: { contract: 'room-phase-result.v1', run_id: 'run-1', phase_id: 'choose_strategy', artifacts: [], gaps: ['fixture'] } };
  } });
  await director.execute({
    room_id: 'room-1', room_context: { user_id: 'user-1', room_tag: 'marketing' }, owner_user_id: 'user-1', org_id: 'org-1',
    run_id: 'run-1', playbook_id: 'marketing.strategy-to-growth-brief', playbook_version: 4,
    stage_id: 'choose_strategy', instruction: 'Produce the complete strategy.', objective: 'Choose one strategy.',
    expected_artifacts: [], checks: [], execution_config: { contract: 'room-phase.v2', phase_kind: 'strategy_decision' },
    inputs: {}, runtime_context: {}, stage_attempts: { choose_strategy: 1 }, retry_policy: { owner: 'playbook' },
  });
  assert.equal(sent.schema_version, 'room-phase.v2');
  assert.equal(JSON.parse(sent.execution_context).contract, 'room-phase.v2');
});

test('MULTI-ARTIFACT DELIVERY GUARD: every producer sees every expected key and predicate selector', async () => {
  const { roomPhaseEnvelope, runtimeStageEnvelope } = await import('../../src/runtime-playbooks/room-director.js');
  let multiKeyStages = 0;
  for (const { fixture, stage } of stages()) {
    const expected = (stage.expected_artifacts || []).map(String);
    if (expected.length > 1) multiKeyStages += 1;
    const request = {
      run_id: 'r', playbook_id: 'p', playbook_version: 1, stage_id: stage.id,
      objective: stage.objective, expected_artifacts: expected, checks: stage.completion_checks,
      execution_config: {}, inputs: {}, runtime_context: {}, retry_policy: { owner: 'playbook' },
    };
    for (const envelope of [runtimeStageEnvelope(request), roomPhaseEnvelope(request)]) {
      const schemas = envelope.artifact_schemas || envelope.lifecycle?.artifact_schemas;
      const selectors = (stage.completion_checks || []).flatMap((check) =>
        (Array.isArray(check.select) ? check.select : [check.select]).filter(Boolean).map(String));
      for (const key of new Set([...expected, ...selectors])) {
        assert.ok(schemas?.[key], `${fixture}:${stage.id} ${envelope.contract} omitted contract for ${key}`);
      }
    }
  }
  assert.ok(multiKeyStages >= 5, `expected meaningful multi-artifact coverage, saw ${multiKeyStages}`);
});
