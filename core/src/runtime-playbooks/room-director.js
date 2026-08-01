import crypto, { randomUUID } from 'node:crypto';

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
  return process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
}

function defaultCallbackUrl() {
  return `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`;
}

function turnIdempotencyKey(request) {
  const identity = [request.run_id, request.stage_id, asObject(request.stage_attempts)[request.stage_id] || 1]
    .map(String).join('\u0000');
  return `runtime-stage:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 48)}`;
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

  async #createTurn(roomId, message, idempotencyKey) {
    const rows = await this.prisma.$queryRawUnsafe(
      `INSERT INTO hivemind.hyper_turns (room_id, seq, user_message, status, idempotency_key)
       SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2, 'live', $3
         FROM hivemind.hyper_turns WHERE room_id = $1::uuid
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'live'
       RETURNING id`,
      roomId, message, idempotencyKey,
    );
    return rows?.[0]?.id;
  }

  async #post(payload) {
    const response = await fetch(`${this.sidecarUrl}/internal/hyper/room-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = JSON.stringify(body?.detail || body || {}).slice(0, 1000);
      throw new Error(`runtime_room_director_http_${response.status}:${detail}`);
    }
    return body;
  }

  async execute(request) {
    if (!request.room_id) throw new Error('runtime_room_id_required');
    const envelope = runtimeStageEnvelope(request);
    let room = asObject(request.room_context);
    let turnId = String(request.turn_id || '').trim();
    if (this.prisma) {
      room = await this.#roomContext(request.room_id, request.org_id);
      turnId = turnId || await this.#createTurn(
        request.room_id,
        `Runtime stage | ${String(request.objective || '').trim()}`.slice(0, 8000),
        turnIdempotencyKey(request),
      );
    }
    turnId = turnId || `runtime-turn-${randomUUID()}`;
    const body = await this.transport({
      schema_version: 'runtime-stage.v1',
      room_id: request.room_id,
      turn_id: turnId,
      user_id: String(room.user_id || request.owner_user_id || ''),
      org_id: request.org_id,
      user_message: String(request.objective || '').slice(0, 8000),
      display_message: `Runtime stage - ${String(request.objective || '').trim()}`.slice(0, 8000),
      execution_context: JSON.stringify(envelope),
      participant_ids: asArray(room.participant_ids).map(String).slice(0, 8),
      callback_url: this.callbackUrl,
      project_id: room.project_id || null,
      room_goal: room.goal || null,
      task_tag: room.room_tag || null,
      write_policy: request.authority_granted === true ? 'authorized' : 'deny',
    });
    const result = body?.result;
    if (result?.contract !== 'runtime-stage-result.v1') {
      throw new Error('runtime_room_result_contract_required');
    }
    if (String(result.run_id) !== String(request.run_id) || String(result.stage_id) !== String(request.stage_id)) {
      throw new Error('runtime_room_result_correlation_mismatch');
    }
    const expectedKeys = new Set(asArray(request.expected_artifacts).map(String));
    const artifacts = asArray(result.artifacts).map((artifact) => normalizeArtifact(artifact, expectedKeys));
    const duplicateIds = artifacts.map((artifact) => artifact.id)
      .filter((id, index, values) => values.indexOf(id) !== index);
    if (duplicateIds.length) throw new Error(`runtime_room_artifact_duplicate:${duplicateIds[0]}`);
    return { artifacts, gaps: asArray(result.gaps).map(String).filter(Boolean), turn_id: turnId };
  }
}
