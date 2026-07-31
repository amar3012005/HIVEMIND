import { appendHqEvent, scheduleHqWake } from './repository.js';
import { validateWorkResultPacket } from './contracts.js';

function internalKey() {
  return process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
}

function sidecarUrl() {
  return process.env.EMPLOYEES_SIDECAR_URL || process.env.HIVEMIND_EMPLOYEES_URL || 'http://hm-employees:8060';
}

async function nextQueuedOrder(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT wo.id, wo.org_id, wo.hq_cycle_id, wo.growth_delegation_id,
           wo.title, wo.objective, wo.kind, wo.room_id,
           wo.selected_skills, wo.acceptance_criteria, wo.required_evidence,
           wo.input_snapshot, wo.evidence_refs,
           r.room_tag, r.goal AS room_goal, r.project_id, r.participant_ids,
           -- Work orders carry an owning EMPLOYEE, never a user. Tenant identity for
           -- the delegated Room turn comes from the runtime owner (server-side only),
           -- falling back to the room's creator. An LLM never supplies this.
           COALESCE(rt.owner_user_id, r.user_id) AS owner_user_id,
           rt.id AS runtime_id
      FROM hivemind.hyper_work_orders wo
      JOIN hivemind.hq_runtimes rt ON rt.org_id = wo.org_id
      LEFT JOIN hivemind.hyper_rooms r ON r.id = wo.room_id
     WHERE wo.hq_cycle_id IS NOT NULL
       AND wo.status = 'queued'
       AND rt.state <> 'PAUSED'
     ORDER BY wo.created_at ASC
     LIMIT 1
  `);
  return rows[0] || null;
}

function controlPlaneUrl() {
  return process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000';
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

/** Machine-readable envelope the Room Director reads instead of guessing from prose.
 *  It never renders as a user turn — `execution_context` is the private contract lane. */
export function workEnvelope(order) {
  return JSON.stringify({
    contract: 'hq-work-order.v1',
    work_order_id: order.id,
    todo_id: order.input_snapshot?.todo_id || null,
    objective: order.objective || order.title,
    location: order.input_snapshot?.location || null,
    selected_skills: asList(order.selected_skills),
    required_evidence: asList(order.required_evidence),
    acceptance_criteria: asList(order.acceptance_criteria),
    evidence_refs: asList(order.evidence_refs),
    governance: {
      note: 'HQ verifies this Room turn against acceptance_criteria before accepting it as done.',
      must_return: ['concrete result of work actually performed', 'evidence refs', 'blockers or needs_input'],
      never: ['a future plan presented as completed work', 'invented facts, metrics, or contacts'],
    },
  }).slice(0, 16000);
}

/** Create the durable turn row the Room pipeline streams its events into, so the
 *  HQ-delegated turn is visible in the Room exactly like a user-submitted one. */
async function createRoomTurn(prisma, order) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.hyper_turns (room_id, seq, user_message, status, idempotency_key)
     SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2, 'live', $3
       FROM hivemind.hyper_turns WHERE room_id = $1::uuid
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'live'
     RETURNING id`,
    order.room_id, String(order.objective || order.title).slice(0, 4000), `hq-wo:${order.id}`,
  );
  return rows?.[0]?.id || null;
}

/** Map the Room's own governance verdict onto the HQ result contract.
 *  A Room turn only counts as done when its grounding gate passed AND its
 *  verifier says the request was met — prose alone can no longer read as done. */
export function roomVerdict(body) {
  const verification = body?.verification || {};
  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  const gaps = Array.isArray(verification.gaps) ? verification.gaps.filter(Boolean) : [];
  const sealed = String(body?.status || '') === 'complete' || body?.ok === true;
  const grounded = verification.grounded_ok !== false;
  const met = verification.met !== false;
  if (!sealed) return { status: 'failed', gaps: gaps.length ? gaps : ['Room turn did not seal.'], artifacts };
  if (!grounded) return { status: 'blocked', gaps: gaps.length ? gaps : ['Room grounding gate rejected the output.'], artifacts };
  if (!met) return { status: 'blocked', gaps: gaps.length ? gaps : ['Room verifier did not meet the work order.'], artifacts };
  return { status: 'completed', gaps, artifacts };
}

function resultPacket(body, status) {
  const result = body?.result || {};
  return validateWorkResultPacket({
    result,
    actions: [],
    metrics: {},
    cost: result.usage || {},
    failures: status === 'failed' ? [body?.error || 'specialist execution failed'] : [],
    blockers: status === 'blocked' ? [body?.error || 'specialist execution blocked'] : [],
    recommendation: status === 'completed' ? 'continue' : 'escalate',
    source_refs: Array.isArray(result.evidence) ? result.evidence : [],
  });
}

export async function dispatchNextHqWorkOrder({ prisma, logger = console } = {}) {
  const order = await nextQueuedOrder(prisma);
  if (!order) return null;
  const key = internalKey();
  if (!key) throw new Error('hq_dispatch_internal_key_missing');

  // ROOM DELEGATION (canonical): HQ governs the company, Rooms execute specialist
  // work. A work order with a Room runs that Room's OWN pipeline — director, domain
  // skills, toolkit, visible debate, grounding gate, governed report — and HQ judges
  // the Room's verdict. The single-agent sidecar path below is only the fallback for
  // an order with no Room, so there is never a second imitation Room system.
  const useRoom = Boolean(order.room_id) && String(process.env.HQ_ROOM_DELEGATION || 'on').toLowerCase() !== 'off';
  let response;
  let body;
  let roomTurnId = null;
  try {
    if (useRoom) {
      roomTurnId = await createRoomTurn(prisma, order);
      response = await fetch(`${sidecarUrl()}/internal/hyper/room-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({
          schema_version: 'hq-work-order.v1',
          room_id: order.room_id,
          turn_id: roomTurnId,
          user_id: order.owner_user_id,
          org_id: order.org_id,
          // The Room sees the objective as its request; the contract rides the
          // private execution_context lane so it is never rendered as a user turn.
          user_message: String(order.objective || order.title).slice(0, 8000),
          display_message: `HQ Runtime work order — ${order.title}`.slice(0, 8000),
          execution_context: workEnvelope(order),
          // The Room's PERSISTED tag is authoritative for room-kind resolution, so
          // routing never falls through to keyword matching on the message text.
          task_tag: order.room_tag || null,
          room_goal: order.room_goal || null,
          project_id: order.project_id || null,
          participant_ids: asList(order.participant_ids).map(String).slice(0, 8),
          callback_url: `${controlPlaneUrl()}/internal/hyper/turn-event`,
          write_policy: 'ask',
        }),
        signal: AbortSignal.timeout(600000),
      });
    } else {
      response = await fetch(`${sidecarUrl()}/internal/hq/work-order/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ work_order_id: order.id, org_id: order.org_id }),
        signal: AbortSignal.timeout(180000),
      });
    }
    body = await response.json().catch(() => ({}));
  } catch (error) {
    // The executor claims before model execution, so a transport timeout is
    // ambiguous and must be reconciled from the durable Work Order, not replayed.
    // Return NULL, not a truthy row: the caller drains with `while (await ...)`,
    // and a truthy ambiguous result spins that loop forever whenever the sidecar
    // is unreachable — which also starves the schedule drain in the same tick.
    logger.warn('[hq-runtime] specialist dispatch transport outcome is ambiguous:', error.message);
    return null;
  }

  if (!response.ok && !body.status) {
    throw new Error(`hq_dispatch_sidecar_http_${response.status}`);
  }

  if (response.status === 409 || body.status === 'already_claimed') {
    return { workOrderId: order.id, status: 'ALREADY_CLAIMED' };
  }

  let status;
  let packet;
  if (useRoom) {
    // The Room already ran its own governance. HQ does not re-judge prose — it
    // reads the Room's verdict and records the artifacts the Room actually produced.
    const verdict = roomVerdict(body);
    status = verdict.status;
    packet = validateWorkResultPacket({
      result: { text: String(body?.summary || body?.result?.text || '').slice(0, 4000), room_turn_id: roomTurnId },
      actions: [], metrics: { cost_tokens: Number(body?.cost_tokens || 0) },
      cost: { total_tokens: Number(body?.cost_tokens || 0) },
      failures: status === 'failed' ? verdict.gaps : [],
      blockers: status === 'blocked' ? verdict.gaps : [],
      recommendation: status === 'completed' ? 'continue' : 'escalate',
      source_refs: verdict.artifacts.map((a) => a?.url || a?.title).filter(Boolean),
    });
    packet.artifacts = verdict.artifacts;
    packet.verification = body?.verification || {};
    await prisma.hyperWorkOrder.updateMany({
      where: { id: order.id, orgId: order.org_id },
      data: { status, completedAt: new Date(), ...(status === 'completed' ? {} : { error: verdict.gaps.join('; ').slice(0, 2000) }) },
    });
    // HQ's REVIEWING path reads the DURABLE result row, not this response. The
    // sidecar writes one on its own path; the Room path must write its own or the
    // next work_result wake finds nothing and escalates "could not be reconciled".
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.hyper_work_results
         (work_order_id, attempt, status, summary, output, evidence, artifacts, usage)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
      order.id, 1, status,
      String(body?.summary || body?.result?.text || verdict.gaps.join('; ') || status).slice(0, 4000),
      JSON.stringify({
        todo_id: order.input_snapshot?.todo_id || null,
        room_turn_id: roomTurnId, room_id: order.room_id,
        verification: body?.verification || {},
        // Room governance already ran; surface the machine-checkable facts the HQ
        // acceptance gate looks for so a governed Room turn is not re-litigated.
        discovery_complete: status === 'completed',
        completed_requirements: status === 'completed' ? asList(order.acceptance_criteria) : [],
        code: status === 'completed' ? null : 'room_verification_failed',
      }),
      JSON.stringify(verdict.artifacts.map((a) => a?.url || a?.title).filter(Boolean)),
      JSON.stringify(verdict.artifacts),
      JSON.stringify({ total_tokens: Number(body?.cost_tokens || 0) }),
    );
  } else {
    status = String(body.status || (response.ok ? 'completed' : 'failed')).toLowerCase();
    if (!['completed', 'blocked', 'failed'].includes(status)) {
      logger.warn('[hq-runtime] specialist returned non-terminal status:', status);
      return { workOrderId: order.id, status: status.toUpperCase() };
    }
    packet = resultPacket(body, status);
  }
  if (order.growth_delegation_id) {
    await prisma.growthDelegation.updateMany({
      where: { id: order.growth_delegation_id, orgId: order.org_id },
      data: {
        status: status === 'completed' ? 'COMPLETED' : status.toUpperCase(),
        result: packet,
        completedAt: new Date(),
      },
    });
  }
  await appendHqEvent({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id,
    eventType: status === 'completed' ? 'work_order_completed' : 'blocked',
    title: status === 'completed' ? `Specialist result returned: ${order.title}` : `Specialist work ${status}: ${order.title}`,
    summary: String(body?.result?.text || body?.error || status).slice(0, 1200),
    details: { status, packet }, workOrderId: order.id,
  });
  await scheduleHqWake({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id,
    idempotencyKey: `work-result:${order.id}`,
    triggerType: 'work_result', dueAt: new Date(),
    payload: { work_order_id: order.id, status },
  });
  return { workOrderId: order.id, status: status.toUpperCase() };
}
