import crypto, { randomUUID } from 'node:crypto';
import { employeesSidecarUrl, runtimeRequestJson } from '../runtime-transport/client.js';
import { recordRuntimeMetric } from '../hq-runtime/runtime-metrics.js';
import { deriveStageArtifactContract, deriveStrictResponseSchema, renderArtifactRequirements } from './artifact-schema.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactJsonValue(value, { stringLimit = 2000, arrayLimit = 16, depth = 0 } = {}) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= stringLimit ? value : `${value.slice(0, stringLimit)}\n[truncated]`;
  if (depth >= 6) return '[nested context omitted]';
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) => compactJsonValue(item, {
      stringLimit, arrayLimit, depth: depth + 1,
    }));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, compactJsonValue(item, { stringLimit, arrayLimit, depth: depth + 1 }),
    ]));
  }
  return String(value).slice(0, stringLimit);
}

export function serializeRoomEnvelope(envelope, maxChars = 15_500) {
  const full = JSON.stringify(envelope);
  if (full.length <= maxChars) return full;

  // The strict schema is the executable response contract. artifact_schemas is
  // its verbose explanatory mirror, so it can be omitted when both are present.
  const compact = structuredClone(envelope);
  const contract = asObject(compact.lifecycle || compact);
  if (contract.strict_response_schema) {
    delete contract.artifact_schemas;
    delete contract.artifact_requirements;
  }
  compact.capabilities = asArray(compact.capabilities).map((item) => ({
    id: item?.id || null,
    operations: asArray(item?.operations).map(String).slice(0, 16),
  }));
  let encoded = JSON.stringify(compact);
  if (encoded.length <= maxChars) return encoded;

  const context = asObject(compact.context);
  for (const budget of [
    { general: 1200, request: 1600, supplied: 4000, prior: 8000, array: 16 },
    { general: 800, request: 1200, supplied: 3000, prior: 6000, array: 12 },
    { general: 500, request: 800, supplied: 1800, prior: 4000, array: 8 },
    { general: 300, request: 500, supplied: 1000, prior: 2500, array: 6 },
  ]) {
    compact.context = {
      company: compactJsonValue(context.company, { stringLimit: budget.general, arrayLimit: budget.array }),
      baseline: compactJsonValue(context.baseline, { stringLimit: budget.general, arrayLimit: budget.array }),
      request: compactJsonValue(context.request, { stringLimit: budget.request, arrayLimit: budget.array }),
      target: compactJsonValue(context.target, { stringLimit: budget.general, arrayLimit: budget.array }),
      policy: compactJsonValue(context.policy, { stringLimit: budget.general, arrayLimit: budget.array }),
      supplied_inputs: compactJsonValue(context.supplied_inputs, { stringLimit: budget.supplied, arrayLimit: budget.array }),
      admin_current_status: compactJsonValue(context.admin_current_status, { stringLimit: budget.supplied, arrayLimit: budget.array }),
      lifecycle_catalog: compactJsonValue(context.lifecycle_catalog, { stringLimit: budget.general, arrayLimit: 24 }),
      // Event transcripts and prior Room artifacts are the evidence most likely
      // to be unique to this phase, so they receive the largest remaining budget.
      prior_artifacts: compactJsonValue(context.prior_artifacts, { stringLimit: budget.prior, arrayLimit: budget.array }),
    };
    encoded = JSON.stringify(compact);
    if (encoded.length <= maxChars) return encoded;
  }
  // Never mutate lifecycle schemas to satisfy a transport budget. A deterministic
  // intervention is safer than sending the Room a corrupted executable contract.
  const error = new Error(`runtime_room_execution_context_too_large:${encoded.length}`);
  error.retryable = false;
  throw error;
}

function internalKey() {
  return process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
}

function defaultSidecarUrl() {
  return employeesSidecarUrl();
}

function defaultCallbackUrl() {
  return `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`;
}

function turnIdempotencyKey(request) {
  const identity = [request.run_id, request.stage_id, asObject(request.stage_attempts)[request.stage_id] || 1]
    .map(String).join('\u0000');
  return `runtime-stage:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
}

function usesRoomPhase(request) {
  return /^room-phase\.v\d+$/.test(String(asObject(request.execution_config).contract || ''));
}

function roomPhaseContext(request) {
  const runtime = asObject(request.runtime_context);
  const config = asObject(request.execution_config);
  const dedicatedContextRefs = new Set([
    'context.company', 'context.baseline', 'context.request', 'context.target',
    'context.policy', 'context.admin_current_status', 'context.lifecycle_catalog',
  ]);
  const priorArtifacts = Object.fromEntries(
    Object.entries(asObject(request.inputs))
      .filter(([key]) => !dedicatedContextRefs.has(key))
      .map(([key, value]) => [key, Array.isArray(value)
        ? value.filter((artifact) => String(artifact?.status || '').toUpperCase() !== 'SUPERSEDED')
        : value]),
  );
  const lifecycleCatalog = asArray(runtime.lifecycle_catalog)
    .filter((entry) => (
      config.exclude_current_playbook_from_catalog !== true
        || String(entry?.playbook_id || '') !== String(request.playbook_id || '')
        || Number(entry?.version) !== Number(request.playbook_version)
    ))
    .map((entry) => ({
      playbook_id: entry?.playbook_id || null,
      version: entry?.version || null,
      owner_room_tag: entry?.owner_room_tag || null,
      supported_actions: asArray(entry?.supported_actions),
      effect_class: entry?.effect_class || null,
      terminal_states: asArray(entry?.terminal_states),
    }));
  return {
    company: runtime.company || null,
    baseline: runtime.baseline || null,
    request: runtime.request || null,
    target: runtime.target || null,
    policy: runtime.policy || null,
    admin_current_status: runtime.admin_current_status || null,
    lifecycle_catalog: lifecycleCatalog,
    supplied_inputs: asObject(runtime.supplied_inputs),
    prior_artifacts: priorArtifacts,
  };
}

function normalizeArtifact(artifact, expectedKeys, attempt = 1) {
  const localId = String(artifact?.id || '').trim();
  const key = String(artifact?.key || '').trim();
  if (!localId) throw new Error('runtime_room_artifact_id_required');
  if (!expectedKeys.has(key)) throw new Error(`runtime_room_artifact_key_unexpected:${key || 'missing'}`);
  const id = attempt > 1 ? `${localId.slice(0, 140)}:attempt:${attempt}` : localId;
  return {
    id,
    key,
    status: String(artifact?.status || 'READY').trim().toUpperCase(),
    data: asObject(artifact?.data),
    source_refs: asArray(artifact?.source_refs).map(String).map((value) => value.trim()).filter(Boolean),
    external_ref: artifact?.external_ref == null ? null : String(artifact.external_ref),
  };
}

function artifactContractFields(request) {
  const stage = {
    expected_artifacts: asArray(request.expected_artifacts),
    completion_checks: asArray(request.checks),
  };
  return {
    artifact_requirements: renderArtifactRequirements(stage) || null,
    artifact_schemas: deriveStageArtifactContract(stage).artifacts,
    strict_response_schema: deriveStrictResponseSchema(stage),
  };
}

export function runtimeStageEnvelope(request) {
  return {
    contract: 'runtime-stage.v1',
    run_id: request.run_id,
    playbook_id: request.playbook_id,
    playbook_version: request.playbook_version,
    stage_id: request.stage_id,
    objective: request.objective,
    inputs: asObject(request.inputs),
    expected_artifacts: asArray(request.expected_artifacts),
    completion_checks: asArray(request.checks),
    unmet: asArray(request.unmet),
    adapter_descriptors: asArray(request.adapter_descriptors),
    authority_granted: request.authority_granted === true,
    retry_policy: asObject(request.retry_policy),
    // Legacy runtime-stage producers still need the same derived contract as
    // room-phase producers. Keeping both envelopes symmetric prevents version
    // negotiation from weakening the artifact boundary.
    ...artifactContractFields(request),
    result_contract: {
      contract: 'runtime-stage-result.v1',
      artifacts: ['id', 'key', 'status', 'data', 'source_refs', 'external_ref'],
      rule: 'Return only artifacts actually produced during this Room turn. State exact gaps when evidence is insufficient.',
    },
  };
}

export function roomPhaseEnvelope(request) {
  return {
    contract: 'room-phase.v2',
    run_id: request.run_id,
    playbook_id: request.playbook_id,
    playbook_version: request.playbook_version,
    phase_id: request.stage_id,
    phase_kind: String(asObject(request.execution_config).phase_kind || 'execute'),
    instruction: String(request.instruction || request.objective || '').trim(),
    context: roomPhaseContext(request),
    lifecycle: {
      guidance: String(request.stage_guidance || '').trim(),
      expected_artifacts: asArray(request.expected_artifacts),
      completion_checks: asArray(request.checks),
      // GENERATED contract, derived from the very predicates the engine will run, so the
      // Room is never told one shape in prose while a check demands another. That drift
      // is the failure class behind form_strategy / prepare_provider_drafts /
      // prepare_campaign_contract. `artifact_requirements` is plain language for the
      // prompt; `artifact_schemas` is the machine shape for schema-constrained output.
      // Strict output is the one-attempt mechanism when a typed schema exists. The
      // predicate-derived artifact contract is mandatory for every stage, including
      // multi-artifact stages; derivation failures stop dispatch instead of silently
      // sending a producer a weaker contract than the validator will enforce.
      ...artifactContractFields(request),
      unmet: asArray(request.unmet),
      checkpoint_sequence: request.checkpoint_sequence,
      attempt: asObject(request.stage_attempts)[request.stage_id] || 1,
      retry_policy: asObject(request.retry_policy),
      authority: { external_writes: request.authority_granted === true },
      execution_config: asObject(request.execution_config),
    },
    capabilities: asArray(request.adapter_descriptors),
    output_contract: {
      contract: 'room-phase-result.v1',
      artifacts: ['id', 'key', 'status', 'data', 'source_refs', 'external_ref'],
      rule: 'Return append-only artifacts actually produced by this Room phase and exact unresolved gaps.',
    },
  };
}

export class RuntimeRoomDirector {
  constructor({ prisma = null, transport = null, sidecarUrl = defaultSidecarUrl(), callbackUrl = defaultCallbackUrl(), apiKey = internalKey() } = {}) {
    if (!transport && (!prisma || !apiKey)) throw new Error('runtime_room_director_transport_required');
    this.prisma = prisma;
    this.sidecarUrl = sidecarUrl;
    this.callbackUrl = callbackUrl;
    this.apiKey = apiKey;
    this.transport = transport || ((payload) => this.#post(payload));
  }

  async #roomContext(roomId, orgId) {
    const rows = await this.prisma.$queryRawUnsafe(
      `SELECT r.id, r.user_id, r.goal, r.project_id, r.participant_ids, r.room_tag
         FROM hivemind.hyper_rooms r
        WHERE r.id = $1::uuid AND r.org_id = $2::uuid
        LIMIT 1`,
      roomId, orgId,
    );
    if (!rows[0]) throw new Error('runtime_room_not_found');
    return rows[0];
  }

  async #createTurn(roomId, message, idempotencyKey, runtime) {
    const rows = await this.prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.hyper_turns (room_id, seq, user_message, status, idempotency_key, runtime_playbook_run_id, runtime_stage_id, runtime_checkpoint_sequence, runtime_attempt)
       SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2, 'live', $3, $4::uuid, $5, $6::integer, $7::integer
         FROM hivemind.hyper_turns WHERE room_id = $1::uuid
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'live', runtime_playbook_run_id=EXCLUDED.runtime_playbook_run_id, runtime_stage_id=EXCLUDED.runtime_stage_id, runtime_checkpoint_sequence=EXCLUDED.runtime_checkpoint_sequence, runtime_attempt=EXCLUDED.runtime_attempt
       RETURNING id`,
      roomId, message, idempotencyKey, runtime.runId, runtime.stageId, runtime.checkpointSequence, runtime.attempt,
    );
    return rows?.[0]?.id;
  }

  async #post(payload) {
    const response = await runtimeRequestJson(`${this.sidecarUrl}/internal/hyper/room-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: JSON.stringify(payload),
      timeoutMs: 600_000,
    });
    const body = response.body;
    if (!response.ok) {
      const detail = JSON.stringify(body?.detail || body || {}).slice(0, 1000);
      const error = new Error(`runtime_room_director_http_${response.status}:${detail}`);
      Object.assign(error, {
        classification: response.classification,
        status: response.status,
        retryable: response.retryable,
        reconciliation_required: response.reconciliation_required,
        ambiguous: response.reconciliation_required === true,
      });
      throw error;
    }
    return { ...body, __runtime_transport: response.transport_metrics || null };
  }

  async execute(request) {
    const startedAt = Date.now();
    if (!request.room_id) throw new Error('runtime_room_id_required');
    const roomPhase = usesRoomPhase(request);
    const envelope = roomPhase ? roomPhaseEnvelope(request) : runtimeStageEnvelope(request);
    const requestContract = roomPhase ? 'room-phase.v2' : 'runtime-stage.v1';
    const resultContract = roomPhase ? 'room-phase-result.v1' : 'runtime-stage-result.v1';
    let room = asObject(request.room_context);
    let turnId = String(request.turn_id || '').trim();
    if (this.prisma) {
      room = await this.#roomContext(request.room_id, request.org_id);
      turnId = turnId || await this.#createTurn(
        request.room_id,
        String(request.instruction || request.objective || '').trim().slice(0, 8000),
        turnIdempotencyKey(request),
        { runId: request.run_id, stageId: request.stage_id, checkpointSequence: request.checkpoint_sequence, attempt: asObject(request.stage_attempts)[request.stage_id] || 1 },
      );
    }
    turnId = turnId || `runtime-turn-${randomUUID()}`;
    let body;
    try {
      body = await this.transport({
      schema_version: requestContract,
      room_id: request.room_id,
      turn_id: turnId,
      user_id: String(room.user_id || request.owner_user_id || ''),
      org_id: request.org_id,
      user_message: String(request.instruction || request.objective || '').slice(0, 8000),
      display_message: String(request.instruction || request.objective || '').trim().slice(0, 8000),
      execution_context: serializeRoomEnvelope(envelope),
      participant_ids: asArray(room.participant_ids).map(String).slice(0, 8),
      callback_url: this.callbackUrl,
      project_id: room.project_id || null,
      room_goal: room.goal || null,
      task_tag: room.room_tag || null,
      write_policy: request.authority_granted === true ? 'authorized' : 'deny',
      });
    } catch (error) {
      await recordRuntimeMetric(this.prisma, {
        orgId: request.org_id, runId: request.run_id, stageId: request.stage_id,
        metric: 'room_completion_latency', value: Date.now() - startedAt, unit: 'ms',
        source: 'runtime-room-director',
        metadata: { status: 'FAILED', classification: error?.classification || null, code: error?.code || null },
      });
      throw error;
    }
    await recordRuntimeMetric(this.prisma, {
      orgId: request.org_id, runId: request.run_id, stageId: request.stage_id,
      metric: 'room_transport_latency',
      value: Number(body?.__runtime_transport?.latency_ms || Date.now() - startedAt),
      unit: 'ms', source: 'runtime-room-director',
      metadata: {
        status: 'RESPONSE',
        connection_reused: body?.__runtime_transport?.connection_reused === true,
        origin: body?.__runtime_transport?.origin || null,
      },
    });
    const result = body?.result;
    if (result?.contract !== resultContract) {
      throw new Error('runtime_room_result_contract_required');
    }
    const resultStageId = roomPhase ? result.phase_id : result.stage_id;
    if (String(result.run_id) !== String(request.run_id) || String(resultStageId) !== String(request.stage_id)) {
      throw new Error('runtime_room_result_correlation_mismatch');
    }
    const expectedKeys = new Set(asArray(request.expected_artifacts).map(String));
    const attempt = Number(asObject(request.stage_attempts)[request.stage_id] || 1);
    const artifacts = asArray(result.artifacts).map((artifact) => normalizeArtifact(artifact, expectedKeys, attempt));
    const duplicateIds = artifacts.map((artifact) => artifact.id)
      .filter((id, index, values) => values.indexOf(id) !== index);
    if (duplicateIds.length) throw new Error(`runtime_room_artifact_duplicate:${duplicateIds[0]}`);
    const gaps = asArray(result.gaps).map(String).filter(Boolean);
    await recordRuntimeMetric(this.prisma, {
      orgId: request.org_id, runId: request.run_id, stageId: request.stage_id,
      metric: 'room_completion_latency', value: Date.now() - startedAt, unit: 'ms',
      source: 'runtime-room-director',
      metadata: { status: gaps.length ? 'COMPLETED_WITH_GAPS' : 'COMPLETED', artifact_count: artifacts.length },
    });
    return { artifacts, gaps, warnings: gaps, turn_id: turnId, usage: asObject(body?.usage) };
  }
}
