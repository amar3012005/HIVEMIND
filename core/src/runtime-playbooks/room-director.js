import crypto, { randomUUID } from 'node:crypto';
import { employeesSidecarUrl, runtimeRequestJson } from '../runtime-transport/client.js';
import { recordRuntimeMetric } from '../hq-runtime/runtime-metrics.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
  return asObject(request.execution_config).contract === 'room-phase.v1';
}

function roomPhaseContext(request) {
  const runtime = asObject(request.runtime_context);
  return {
    company: runtime.company || null,
    baseline: runtime.baseline || null,
    request: runtime.request || null,
    target: runtime.target || null,
    policy: runtime.policy || null,
    supplied_inputs: asObject(runtime.supplied_inputs),
    prior_artifacts: asObject(request.inputs),
  };
}

function normalizeArtifact(artifact, expectedKeys) {
  const id = String(artifact?.id || '').trim();
  const key = String(artifact?.key || '').trim();
  if (!id) throw new Error('runtime_room_artifact_id_required');
  if (!expectedKeys.has(key)) throw new Error(`runtime_room_artifact_key_unexpected:${key || 'missing'}`);
  return {
    id,
    key,
    status: String(artifact?.status || 'READY').trim().toUpperCase(),
    data: asObject(artifact?.data),
    source_refs: asArray(artifact?.source_refs).map(String).map((value) => value.trim()).filter(Boolean),
    external_ref: artifact?.external_ref == null ? null : String(artifact.external_ref),
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
      unmet: asArray(request.unmet),
      checkpoint_sequence: request.checkpoint_sequence,
      attempt: asObject(request.stage_attempts)[request.stage_id] || 1,
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
      execution_context: JSON.stringify(envelope),
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
    const artifacts = asArray(result.artifacts).map((artifact) => normalizeArtifact(artifact, expectedKeys));
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
    return { artifacts, gaps, warnings: gaps, turn_id: turnId };
  }
}
