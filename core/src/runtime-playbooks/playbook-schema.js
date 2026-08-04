import Ajv from 'ajv';

const transitionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    default: { type: 'boolean' },
    when: { type: 'object' },
    to_stage: { type: 'string', minLength: 1 },
    to_terminal: { type: 'string', minLength: 1 },
  },
  oneOf: [
    { required: ['to_stage'] },
    { required: ['to_terminal'] },
  ],
};

export const runtimePlaybookSchema = {
  $id: 'https://runtime.local/schemas/playbook-v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'playbook_id',
    'version',
    'status',
    'name',
    'initial_stage_id',
    'terminal_states',
    'stages',
  ],
  properties: {
    playbook_id: { type: 'string', minLength: 3, maxLength: 160, pattern: '^[a-z0-9][a-z0-9._-]+$' },
    version: { type: 'integer', minimum: 1 },
    status: { enum: ['DRAFT', 'ACTIVE', 'RETIRED'] },
    name: { type: 'string', minLength: 1, maxLength: 180 },
    description: { type: 'string', maxLength: 2000 },
    initial_stage_id: { type: 'string', minLength: 1, maxLength: 120 },
    terminal_states: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    metadata: { type: 'object' },
    input_contract: {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'type', 'description'],
            properties: {
              path: { type: 'string', minLength: 1, maxLength: 240 },
              type: { enum: ['string', 'integer', 'number', 'boolean', 'array', 'object'] },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
              required: { type: 'boolean' },
              default_value: true,
              enum: { type: 'array', minItems: 1, uniqueItems: true },
            },
          },
        },
      },
    },
    stages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'objective',
          'input_refs',
          'expected_artifacts',
          'completion_checks',
          'transitions',
          'on_failure',
        ],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          input_refs: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
          expected_artifacts: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
          completion_checks: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['predicate'],
              properties: { predicate: { type: 'string', minLength: 1 } },
              additionalProperties: true,
            },
          },
          execution: {
            type: 'object',
            additionalProperties: false,
            required: ['mode'],
            properties: {
              mode: { enum: ['room', 'adapter'] },
              adapter_id: { type: 'string', minLength: 2, maxLength: 120 },
              operation: { enum: ['execute', 'monitor'] },
              config: { type: 'object' },
            },
          },
          verifications: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['adapter_id', 'select'],
              properties: {
                adapter_id: { type: 'string', minLength: 2, maxLength: 120 },
                operation: { const: 'verify' },
                select: { type: 'string', minLength: 1, maxLength: 160 },
                config: { type: 'object' },
              },
            },
          },
          authority_gate: { type: 'string', minLength: 1, maxLength: 120 },
          authority_policy_key: { type: 'string', minLength: 1, maxLength: 120 },
          authority_policy_mode: { enum: ['organization_default', 'manual_only'] },
          authority_binding: { enum: ['stage_inputs'] },
          waits_for_event: {
            type: 'object',
            additionalProperties: false,
            anyOf: [{ required: ['type'] }, { required: ['types'] }],
            properties: {
              type: { type: 'string', minLength: 1, maxLength: 160 },
              types: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 160 } },
              correlation_path: { type: 'string', minLength: 1, maxLength: 240 },
              timeout_after_seconds: { type: 'integer', minimum: 60, maximum: 31536000 },
              releases_execution_slot: { type: 'boolean' },
            },
          },
          presentation: {
            type: 'object',
            additionalProperties: false,
            properties: {
              waiting: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: 240 },
                  summary: { type: 'string', minLength: 1, maxLength: 2000 },
                  next_action: { type: 'string', minLength: 1, maxLength: 160 },
                },
              },
            },
          },
          transitions: { type: 'array', minItems: 1, items: transitionSchema },
          on_failure: { enum: ['REPAIR', 'ESCALATE', 'TERMINATE'] },
          max_attempts: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(runtimePlaybookSchema);

function formatErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

export function validateRuntimePlaybookShape(playbook) {
  if (!validateSchema(playbook)) {
    throw new Error(`runtime_playbook_schema_invalid: ${formatErrors(validateSchema.errors)}`);
  }

  const stageIds = new Set();
  const inputPaths = new Set();
  for (const field of playbook.input_contract?.fields || []) {
    if (inputPaths.has(field.path)) throw new Error(`runtime_playbook_input_duplicate:${field.path}`);
    inputPaths.add(field.path);
  }
  for (const stage of playbook.stages) {
    if (stageIds.has(stage.id)) throw new Error(`runtime_playbook_stage_duplicate:${stage.id}`);
    stageIds.add(stage.id);
  }
  if (!stageIds.has(playbook.initial_stage_id)) {
    throw new Error(`runtime_playbook_initial_stage_missing:${playbook.initial_stage_id}`);
  }

  const terminals = new Set(playbook.terminal_states);
  const reachableStages = new Set([playbook.initial_stage_id]);
  const reachableTerminals = new Set();
  const pending = [playbook.initial_stage_id];
  for (const stage of playbook.stages) {
    for (const transition of stage.transitions) {
      if (transition.to_stage && !stageIds.has(transition.to_stage)) {
        throw new Error(`runtime_playbook_transition_stage_missing:${stage.id}:${transition.to_stage}`);
      }
      if (transition.to_terminal && !terminals.has(transition.to_terminal)) {
        throw new Error(`runtime_playbook_transition_terminal_missing:${stage.id}:${transition.to_terminal}`);
      }
    }
    const defaultCount = stage.transitions.filter((transition) => transition.default === true).length;
    if (defaultCount !== 1) throw new Error(`runtime_playbook_default_transition_required:${stage.id}`);
    if (stage.transitions.at(-1)?.default !== true) {
      throw new Error(`runtime_playbook_default_transition_must_be_last:${stage.id}`);
    }
    if (stage.on_failure === 'REPAIR' && !stage.max_attempts) {
      throw new Error(`runtime_playbook_repair_attempts_required:${stage.id}`);
    }
    if (Boolean(stage.authority_gate) !== Boolean(stage.authority_policy_key)) {
      throw new Error(`runtime_playbook_authority_policy_required:${stage.id}`);
    }
    const execution = stage.execution || { mode: 'room' };
    if (execution.mode === 'adapter' && (!execution.adapter_id || !execution.operation)) {
      throw new Error(`runtime_playbook_adapter_execution_required:${stage.id}`);
    }
    if (execution.mode === 'room' && (execution.adapter_id || execution.operation)) {
      throw new Error(`runtime_playbook_room_execution_invalid:${stage.id}`);
    }
    for (const expected of stage.expected_artifacts) {
      if (!stage.completion_checks.some((check) => (Array.isArray(check.select) ? check.select : [check.select]).includes(expected))) {
        throw new Error(`runtime_playbook_expected_artifact_unchecked:${stage.id}:${expected}`);
      }
    }
  }

  while (pending.length > 0) {
    const current = pending.shift();
    const currentStage = playbook.stages.find((stage) => stage.id === current);
    for (const transition of currentStage.transitions) {
      if (transition.to_terminal) reachableTerminals.add(transition.to_terminal);
      if (transition.to_stage && !reachableStages.has(transition.to_stage)) {
        reachableStages.add(transition.to_stage);
        pending.push(transition.to_stage);
      }
    }
  }
  for (const stageId of stageIds) {
    if (!reachableStages.has(stageId)) throw new Error(`runtime_playbook_stage_unreachable:${stageId}`);
  }
  if (reachableTerminals.size === 0) {
    throw new Error('runtime_playbook_terminal_unreachable');
  }
  return playbook;
}
