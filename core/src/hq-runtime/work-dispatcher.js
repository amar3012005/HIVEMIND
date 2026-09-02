import { appendHqEvent, scheduleHqWake } from './repository.js';
import { validateWorkResultPacket } from './contracts.js';
import { employeesSidecarUrl, runtimeRequestJson } from '../runtime-transport/client.js';

export function specialistEventSummary({ status, packet = {}, orderTitle = '' }) {
  const artifacts = Array.isArray(packet.artifacts) ? packet.artifacts.length : 0;
  const evidence = Array.isArray(packet.source_refs) ? packet.source_refs.length : 0;
  const gaps = [...new Set([
    ...(Array.isArray(packet.blockers) ? packet.blockers : []),
    ...(Array.isArray(packet.failures) ? packet.failures : []),
  ].map((item) => String(item || '').trim()).filter(Boolean))];
  if (status === 'completed') {
    return `The specialist completed ${orderTitle || 'the assigned work'} and returned ${artifacts} artifact(s) with ${evidence} evidence reference(s). HQ is verifying the completion criteria now.`;
  }
  return `The specialist stopped without claiming completion for ${orderTitle || 'the assigned work'}.${gaps.length ? ` Unmet: ${gaps.slice(0, 3).join('; ')}.` : ''} The full report remains in the specialist Room and durable Work Result; HQ will preserve the gap and advance independent work.`;
}

function internalKey() {
  return process.env.HIVEMIND_MASTER_API_KEY || process.env.HIVEMIND_API_KEY || '';
}

function sidecarUrl() {
  return employeesSidecarUrl();
}

const WORK_LEASE_MS = Math.max(30000, Number(process.env.HQ_WORK_ORDER_LEASE_MS || 120000));
const WORK_HEARTBEAT_MS = Math.max(10000, Number(process.env.HQ_WORK_ORDER_HEARTBEAT_MS || 30000));
const WORK_MAX_ATTEMPTS = Math.max(1, Number(process.env.HQ_WORK_ORDER_MAX_ATTEMPTS || 3));

export async function reconcileExpiredWorkOrders({ prisma, logger = console } = {}) {
  const expired = await prisma.hyperWorkOrder.findMany({
    where: {
      hqCycleId: { not: null }, status: 'running',
      leaseExpiresAt: { lt: new Date() },
    },
    orderBy: { leaseExpiresAt: 'asc' }, take: 50,
  });
  const reconciled = [];
  for (const order of expired) {
    const result = await prisma.hyperWorkResult.findFirst({
      where: { workOrderId: order.id }, orderBy: { attempt: 'desc' },
    });
    if (result) {
      await prisma.hyperWorkOrder.updateMany({
        where: { id: order.id, status: 'running', leaseExpiresAt: { lt: new Date() } },
        data: {
          status: result.status,
          completedAt: ['completed', 'blocked', 'failed'].includes(result.status) ? result.createdAt : null,
          error: result.status === 'completed' ? null : String(result.summary || result.status).slice(0, 2000),
          leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null,
        },
      });
      reconciled.push({ id: order.id, outcome: 'result_reconciled' });
      continue;
    }
    const turn = order.turnId ? await prisma.hyperTurn.findUnique({
      where: { id: order.turnId }, select: { status: true },
    }) : null;
    if (turn?.status === 'complete') {
      await prisma.hyperWorkOrder.updateMany({
        where: { id: order.id, status: 'running', leaseExpiresAt: { lt: new Date() } },
        data: {
          status: 'blocked', completedAt: new Date(),
          error: 'room_turn_completed_without_typed_work_result',
          leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null,
        },
      });
      reconciled.push({ id: order.id, outcome: 'completed_turn_needs_intervention' });
      continue;
    }
    if (order.attempt >= WORK_MAX_ATTEMPTS) {
      await prisma.hyperWorkOrder.updateMany({
        where: { id: order.id, status: 'running', leaseExpiresAt: { lt: new Date() } },
        data: {
          status: 'blocked', completedAt: new Date(),
          error: 'room_work_infrastructure_attempts_exhausted',
          leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null,
        },
      });
      reconciled.push({ id: order.id, outcome: 'attempts_exhausted' });
      continue;
    }
    const reset = await prisma.hyperWorkOrder.updateMany({
      where: { id: order.id, status: 'running', leaseExpiresAt: { lt: new Date() } },
      data: {
        status: 'queued', error: 'reclaimed_after_expired_worker_lease',
        leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null,
      },
    });
    if (reset.count) reconciled.push({ id: order.id, outcome: 'requeued' });
  }
  if (reconciled.length) logger.warn('[hq-runtime] reconciled expired Room work:', reconciled);
  return reconciled;
}

async function nextQueuedOrder(prisma, leaseOwner) {
  // Claim Room-owned work atomically so multiple bounded workers can execute
  // independent Company Rooms concurrently without selecting the same order.
  // Non-Room legacy work remains on the sidecar's own claim path below.
  const roomRows = await prisma.$queryRawUnsafe(`
    WITH candidate AS (
      SELECT wo.id
        FROM hivemind.hyper_work_orders wo
        JOIN hivemind.hq_runtimes rt ON rt.org_id = wo.org_id
       WHERE wo.hq_cycle_id IS NOT NULL
         AND wo.room_id IS NOT NULL
         AND wo.status = 'queued'
         AND wo.runtime_epoch = rt.epoch
         AND rt.state <> 'PAUSED'
       ORDER BY wo.created_at ASC
       FOR UPDATE OF wo SKIP LOCKED
       LIMIT 1
    ), claimed AS (
      UPDATE hivemind.hyper_work_orders wo
         SET status = 'running',
             started_at = COALESCE(started_at, now()),
             attempt = attempt + 1,
             lease_owner = $1,
             lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
             last_heartbeat_at = now()
        FROM candidate
       WHERE wo.id = candidate.id
       RETURNING wo.*
    )
    SELECT wo.id, wo.org_id, wo.hq_cycle_id, wo.growth_delegation_id,
           wo.title, wo.objective, wo.kind, wo.room_id,
           wo.selected_skills, wo.acceptance_criteria, wo.required_evidence,
           wo.input_snapshot, wo.evidence_refs, wo.runtime_epoch, wo.attempt,
           r.room_tag, r.goal AS room_goal, r.project_id, r.participant_ids,
           -- Work orders carry an owning EMPLOYEE, never a user. Tenant identity for
           -- the delegated Room turn comes from the runtime owner (server-side only),
           -- falling back to the room's creator. An LLM never supplies this.
           COALESCE(rt.owner_user_id, r.user_id) AS owner_user_id,
           rt.id AS runtime_id, rt.epoch AS current_runtime_epoch
      FROM claimed wo
      JOIN hivemind.hq_runtimes rt ON rt.org_id = wo.org_id
      LEFT JOIN hivemind.hyper_rooms r ON r.id = wo.room_id
  `, leaseOwner, WORK_LEASE_MS);
  if (roomRows[0]) return roomRows[0];
  const legacyRows = await prisma.$queryRawUnsafe(`
    SELECT wo.id, wo.org_id, wo.hq_cycle_id, wo.growth_delegation_id,
           wo.title, wo.objective, wo.kind, wo.room_id,
           wo.selected_skills, wo.acceptance_criteria, wo.required_evidence,
           wo.input_snapshot, wo.evidence_refs, wo.runtime_epoch,
           r.room_tag, r.goal AS room_goal, r.project_id, r.participant_ids,
           COALESCE(rt.owner_user_id, r.user_id) AS owner_user_id,
           rt.id AS runtime_id, rt.epoch AS current_runtime_epoch
      FROM hivemind.hyper_work_orders wo
      JOIN hivemind.hq_runtimes rt ON rt.org_id = wo.org_id
      LEFT JOIN hivemind.hyper_rooms r ON r.id = wo.room_id
     WHERE wo.hq_cycle_id IS NOT NULL
       AND wo.room_id IS NULL
       AND wo.status = 'queued'
       AND wo.runtime_epoch = rt.epoch
       AND rt.state <> 'PAUSED'
     ORDER BY wo.created_at ASC
     LIMIT 1
  `);
  return legacyRows[0] || null;
}

export async function drainHqWorkOrders({ prisma, logger = console, concurrency = 2, leaseOwner = `hq-worker:${process.pid}`, transport = runtimeRequestJson } = {}) {
  await reconcileExpiredWorkOrders({ prisma, logger });
  const width = Math.max(1, Math.min(4, Number(concurrency) || 2));
  const completed = [];
  while (true) {
    const batch = await Promise.all(Array.from({ length: width }, (_, index) => dispatchNextHqWorkOrder({
      prisma, logger, leaseOwner: `${leaseOwner}:${index}`, transport,
    })));
    const active = batch.filter(Boolean);
    if (!active.length) return completed;
    completed.push(...active);
  }
}

function controlPlaneUrl() {
  return process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000';
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  return {};
}

/** Machine-readable envelope the Room Director reads instead of guessing from prose.
 *  It never renders as a user turn — `execution_context` is the private contract lane. */
export function workEnvelope(order) {
  const snapshot = asObject(order.input_snapshot);
  return JSON.stringify({
    contract: 'hq-work-order.v2',
    work_order_id: order.id,
    runtime_epoch: order.runtime_epoch || snapshot.runtime_epoch || null,
    todo_id: snapshot.todo_id || null,
    kind: order.kind || null,
    objective: order.objective || order.title,
    location: snapshot.location || snapshot.target?.location || null,
    target: snapshot.target || {},
    completion_requirements: asList(snapshot.completion_requirements),
    upstream_result: snapshot.upstream_result || null,
    room_checkpoint: snapshot.room_checkpoint || null,
    authority: snapshot.authority || { mode: 'PREPARE', external_writes: false },
    selected_skills: asList(order.selected_skills),
    required_evidence: asList(order.required_evidence),
    acceptance_criteria: asList(order.acceptance_criteria),
    evidence_refs: asList(order.evidence_refs),
    governance: {
      note: 'HQ verifies this Room turn against acceptance_criteria before accepting it as done.',
      must_return: ['concrete result of work actually performed', 'evidence refs', 'blockers or needs_input'],
      never: ['a future plan presented as completed work', 'invented facts, metrics, or contacts'],
    },
  });
}

export function workOrderTaskTag(order) {
  return order?.room_tag || null;
}

/** Plain assignment presented to the Room Director. Security and lifecycle fields
 * stay in execution_context; the Director receives the same kind of request it
 * would receive from a person, plus only the context needed to know when it is done. */
export function workOrderPrompt(order) {
  const objective = String(order?.objective || order?.title || 'Complete the assigned work.').trim();
  const snapshot = asObject(order?.input_snapshot);
  const location = String(snapshot.location || snapshot.target?.location || '').trim();
  const criteria = asList(order?.acceptance_criteria).map((item) => String(item).trim()).filter(Boolean);
  return [
    objective,
    location ? `Company location for this assignment: ${location}.` : '',
    criteria.length ? `Done when:\n${criteria.map((item) => `- ${item}`).join('\n')}` : '',
    'Perform the work now with the Room\'s normal Director, methods, skills, and tools. Return evidence and explicit gaps; do not merely recommend future work.',
  ].filter(Boolean).join('\n\n').slice(0, 8000);
}

function requirementLabel(requirement) {
  const type = String(requirement?.type || '').trim().replaceAll('_', ' ');
  if (!type) return '';
  const bounds = [];
  if (Number.isFinite(Number(requirement.minimum))) bounds.push(`at least ${Number(requirement.minimum)}`);
  if (Number.isFinite(Number(requirement.maximum))) bounds.push(`at most ${Number(requirement.maximum)}`);
  const entity = requirement.entity ? ` ${String(requirement.entity).trim()}` : '';
  const fields = Array.isArray(requirement.fields) && requirement.fields.length
    ? ` with ${requirement.fields.map((field) => String(field).replaceAll('_', ' ')).join(', ')}` : '';
  return `${type}: ${bounds.join(' and ') || 'required'}${entity}${fields}`;
}

/** Human-readable assignment persisted as the Room turn. This is intentionally
 * compact and operational: the private execution envelope remains the source of
 * truth, while people can see exactly what HQ asked the Room to complete. */
export function workOrderDisplayMessage(order) {
  const snapshot = asObject(order?.input_snapshot);
  const target = asObject(snapshot.target);
  const scope = [
    target.quantity ? `Quantity: ${target.quantity}` : '',
    target.location || snapshot.location ? `Location: ${target.location || snapshot.location}` : '',
    target.sector ? `Sector: ${target.sector}` : '',
    target.audience ? `Audience: ${target.audience}` : '',
  ].filter(Boolean);
  const requirements = asList(snapshot.completion_requirements)
    .map(requirementLabel).filter(Boolean);
  const criteria = asList(order?.acceptance_criteria)
    .map((item) => String(item || '').trim()).filter(Boolean);
  const dependency = snapshot.upstream_result
    ? 'Use the accepted upstream result supplied by HQ; do not rediscover it.' : '';
  const checkpoint = snapshot.room_checkpoint && typeof snapshot.room_checkpoint === 'object'
    ? `Resume checkpoint: ${String(snapshot.room_checkpoint.stage || 'retained work')}.${snapshot.room_checkpoint.next ? ` Continue with ${String(snapshot.room_checkpoint.next)}.` : ''}` : '';
  const authority = String(snapshot.authority?.mode || 'PREPARE').toUpperCase();
  return [
    `HQ WORK ORDER | ${String(order?.title || 'Specialist assignment').trim()}`,
    String(order?.objective || order?.title || '').trim(),
    scope.length ? `SCOPE\n${scope.map((item) => `- ${item}`).join('\n')}` : '',
    dependency,
    checkpoint,
    `AUTHORITY\n- ${authority === 'EXECUTE'
      ? 'Execute only through governed connected tools and return durable provider receipts.'
      : 'Prepare and persist internal deliverables only. Do not send, publish, spend, or change policy.'}`,
    criteria.length ? `ACCEPTANCE\n${criteria.map((item) => `- ${item}`).join('\n')}` : '',
    requirements.length ? `MACHINE CHECKS\n${requirements.map((item) => `- ${item}`).join('\n')}` : '',
    'The Room Director owns method, skills, tools, and internal sequencing. Return completed artifacts and evidence, or explicit unmet gaps.',
  ].filter(Boolean).join('\n\n').slice(0, 8000);
}

/** Create the durable turn row the Room pipeline streams its events into, so the
 *  HQ-delegated turn is visible in the Room exactly like a user-submitted one. */
export async function createRoomTurn(prisma, order) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.hyper_turns (room_id, seq, user_message, status, idempotency_key)
     SELECT $1::uuid, COALESCE(MAX(seq), 0) + 1, $2, 'live', $3
       FROM hivemind.hyper_turns WHERE room_id = $1::uuid
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = CASE WHEN hivemind.hyper_turns.status = 'complete' THEN hivemind.hyper_turns.status ELSE 'live' END
     RETURNING id`,
    order.room_id, workOrderDisplayMessage(order).slice(0, 8000), `hq-wo:${order.id}`,
  );
  return rows?.[0]?.id || null;
}

/** Map the Room's own governance verdict onto the HQ result contract.
 *  A Room turn only counts as done when its grounding gate passed AND its
 *  verifier says the request was met — prose alone can no longer read as done. */
export function roomVerdict(body) {
  const verification = body?.verification || {};
  const contract = body?.result?.contract_version === 'work-order-result.v2'
    ? body.result
    : verification?.work_order_result?.contract_version === 'work-order-result.v2'
      ? verification.work_order_result
      : null;
  const responseArtifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  if (contract) {
    const artifacts = Array.isArray(contract.deliverables) && contract.deliverables.length
      ? contract.deliverables : responseArtifacts;
    const gaps = Array.isArray(contract.gaps) ? contract.gaps.map((gap) =>
      String(gap?.why || gap?.criterion || gap)).filter(Boolean) : [];
    const acceptanceMet = Array.isArray(contract.acceptance)
      && contract.acceptance.every((item) => item?.met === true);
    const checksMet = Array.isArray(contract.subtasks) && contract.subtasks.length > 0
      && contract.subtasks.every((task) => task?.status === 'completed'
        && Array.isArray(task.checks) && task.checks.length > 0
        && task.checks.some((check) => check?.type !== 'judgment')
        && task.checks.every((check) => check?.passed === true));
    if (contract.status === 'completed' && acceptanceMet && checksMet && gaps.length === 0) {
      return { status: 'completed', gaps: [], artifacts, contract };
    }
    const contractStatus = String(contract.status || '').toLowerCase();
    const checkpointDisposition = String(contract?.checkpoint?.disposition || '').toLowerCase();
    const checkpointedPartial = contractStatus === 'partial'
      && ['continue_room', 'wait_event', 'wait_capability', 'request_hq'].includes(checkpointDisposition);
    return { status: checkpointedPartial ? 'partial' : 'blocked',
      gaps: gaps.length ? gaps : ['Room work-order contract did not pass deterministic acceptance.'], artifacts, contract };
  }
  return { status: 'blocked', gaps: ['Room did not return the required work-order-result.v2 governance contract.'], artifacts: responseArtifacts };
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

export async function dispatchNextHqWorkOrder({ prisma, logger = console, leaseOwner = `hq-worker:${process.pid}`, transport = runtimeRequestJson } = {}) {
  const order = await nextQueuedOrder(prisma, leaseOwner);
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
  let heartbeat = null;
  try {
    heartbeat = setInterval(() => prisma.hyperWorkOrder.updateMany({
      where: { id: order.id, status: 'running', leaseOwner },
      data: { leaseExpiresAt: new Date(Date.now() + WORK_LEASE_MS), lastHeartbeatAt: new Date() },
    }).catch(() => {}), WORK_HEARTBEAT_MS);
    if (useRoom) {
      roomTurnId = await createRoomTurn(prisma, order);
      await prisma.hyperWorkOrder.updateMany({
        where: { id: order.id, status: 'running', leaseOwner }, data: { turnId: roomTurnId },
      });
      response = await transport(`${sidecarUrl()}/internal/hyper/room-turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({
          schema_version: 'hq-work-order.v2',
          room_id: order.room_id,
          turn_id: roomTurnId,
          user_id: order.owner_user_id,
          org_id: order.org_id,
          // The Room sees the objective as its request; the contract rides the
          // private execution_context lane so it is never rendered as a user turn.
          user_message: workOrderPrompt(order),
          display_message: `HQ Runtime work order — ${order.title}`.slice(0, 8000),
          execution_context: workEnvelope(order),
          // Keep physical Room ownership, but let the typed workload select the
          // normal domain methodology catalog without keyword routing.
          task_tag: workOrderTaskTag(order),
          room_goal: order.room_goal || null,
          project_id: order.project_id || null,
          participant_ids: asList(order.participant_ids).map(String).slice(0, 8),
          callback_url: `${controlPlaneUrl()}/internal/hyper/turn-event`,
          write_policy: asObject(order.input_snapshot).authority?.mode === 'EXECUTE' ? 'ask' : 'deny',
        }),
        timeoutMs: 600000,
      });
    } else {
      response = await transport(`${sidecarUrl()}/internal/hq/work-order/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ work_order_id: order.id, org_id: order.org_id }),
        timeoutMs: 180000,
      });
    }
    body = response.body || {};
  } catch (error) {
    // The executor claims before model execution, so a transport timeout is
    // ambiguous and must be reconciled from the durable Work Order, not replayed.
    // Return NULL, not a truthy row: the caller drains with `while (await ...)`,
    // and a truthy ambiguous result spins that loop forever whenever the sidecar
    // is unreachable — which also starves the schedule drain in the same tick.
    logger.warn('[hq-runtime] specialist dispatch transport outcome is ambiguous:', {
      work_order_id: order.id,
      classification: error.classification || 'uncertain_transport',
      code: error.code || error.cause?.code || error.name,
      reconciliation_required: error.reconciliation_required !== false,
      message: error.message,
    });
    return null;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const currentRuntime = await prisma.hqRuntime.findFirst({
    where: { id: order.runtime_id, orgId: order.org_id }, select: { epoch: true },
  });
  const orderEpoch = String(order.runtime_epoch || '');
  if (!currentRuntime || !orderEpoch || String(currentRuntime.epoch) !== orderEpoch) {
    logger.warn('[hq-runtime] discarded specialist result from an obsolete Runtime epoch:', order.id);
    await prisma.hyperWorkOrder.updateMany({
      where: { id: order.id, orgId: order.org_id, runtimeEpoch: orderEpoch },
      data: { status: 'cancelled', error: 'Runtime epoch changed before the result returned.', completedAt: new Date() },
    }).catch(() => {});
    return { workOrderId: order.id, status: 'OBSOLETE_EPOCH' };
  }

  if (!response.ok && response.classification === 'transient_response') {
    logger.warn('[hq-runtime] specialist dispatch returned a transient response; retaining the lease for reconciliation:', {
      work_order_id: order.id,
      status: response.status,
      classification: response.classification,
      reconciliation_required: true,
    });
    return null;
  }

  if (!response.ok && !body.status) {
    body = {
      ...body,
      status: 'blocked',
      error: `hq_dispatch_sidecar_http_${response.status}`,
      transport: {
        classification: response.classification,
        status: response.status,
        retryable: response.retryable,
        reconciliation_required: response.reconciliation_required,
      },
    };
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
      result: { text: String(body?.summary || body?.result?.report_markdown || body?.result?.text || '').slice(0, 4000), room_turn_id: roomTurnId,
        work_order_result: verdict.contract || null },
      actions: [], metrics: { cost_tokens: Number(body?.cost_tokens || 0) },
      cost: { total_tokens: Number(body?.cost_tokens || 0) },
      failures: status === 'failed' ? verdict.gaps : [],
      blockers: ['blocked', 'partial'].includes(status) ? verdict.gaps : [],
      recommendation: status === 'completed' ? 'continue' : 'escalate',
      source_refs: [...new Set([...(verdict.contract?.evidence_refs || []), ...verdict.artifacts.map((a) => a?.url || a?.title).filter(Boolean)])],
    });
    packet.artifacts = verdict.artifacts;
    packet.verification = body?.verification || {};
    await prisma.hyperWorkOrder.updateMany({
      where: { id: order.id, orgId: order.org_id, runtimeEpoch: orderEpoch },
      data: { status, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastHeartbeatAt: null, ...(status === 'completed' ? { error: null } : { error: verdict.gaps.join('; ').slice(0, 2000) }) },
    });
    // HQ's REVIEWING path reads the DURABLE result row, not this response. The
    // sidecar writes one on its own path; the Room path must write its own or the
    // next work_result wake finds nothing and escalates "could not be reconciled".
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.hyper_work_results
         (work_order_id, runtime_epoch, attempt, status, summary, output, evidence, artifacts, usage)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
      order.id, orderEpoch, Number(order.attempt || 1), status,
      String(body?.summary || body?.result?.text || verdict.gaps.join('; ') || status).slice(0, 4000),
      JSON.stringify({
        todo_id: asObject(order.input_snapshot).todo_id || null,
        room_turn_id: roomTurnId, room_id: order.room_id,
        verification: body?.verification || {},
        work_order_result: verdict.contract || null,
        // Room governance already ran. Keep its typed contract intact so HQ can
        // verify each requested outcome rather than treating every completed Room
        // turn as prospect discovery.
        discovery_complete: status === 'completed' && (verdict.contract?.completion_requirements || [])
          .some((row) => row?.type === 'records_persisted' && row?.met === true),
        completed_requirements: status === 'completed' ? asList(order.acceptance_criteria) : [],
        code: status === 'completed' ? null : status === 'partial' ? 'room_checkpoint_returned' : 'room_verification_failed',
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
  // Titles/urls the Room or specialist actually produced (verdict.artifacts,
  // see roomVerdict() above) — previously only the COUNT reached the FE
  // event, so the Runtime terminal had no way to link/preview/download a
  // finished research doc or report even though the data existed all along.
  // `type: 'work.artifact_ready'` mirrors the campaign convention
  // (`campaign_artifact_progress` / `campaign.asset_ready`) so the FE can
  // special-case this the same way, without a brand new event taxonomy.
  const readyArtifacts = Array.isArray(packet.artifacts)
    ? packet.artifacts.map((a) => ({ title: a?.title || null, url: a?.url || null })).filter((a) => a.title || a.url).slice(0, 12)
    : [];
  await appendHqEvent({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id, runtimeEpoch: currentRuntime.epoch,
    eventType: status === 'completed' ? 'work_order_completed' : status === 'partial' ? 'observation' : 'blocked',
    title: status === 'completed' ? `Specialist result returned: ${order.title}`
      : status === 'partial' ? `Specialist checkpoint returned: ${order.title}` : `Specialist work ${status}: ${order.title}`,
    summary: specialistEventSummary({ status, packet, orderTitle: order.title }),
    details: {
      status, result_ref: order.id,
      artifact_count: Array.isArray(packet.artifacts) ? packet.artifacts.length : 0,
      artifacts: readyArtifacts,
      ...(status === 'completed' && readyArtifacts.length ? { type: 'work.artifact_ready' } : {}),
      evidence_count: Array.isArray(packet.source_refs) ? packet.source_refs.length : 0,
      blockers: Array.isArray(packet.blockers) ? packet.blockers.slice(0, 10) : [],
      failures: Array.isArray(packet.failures) ? packet.failures.slice(0, 10) : [],
    }, workOrderId: order.id,
    idempotencyKey: `room-result:${order.id}:${status}`,
  });
  await scheduleHqWake({
    prisma, runtimeId: order.runtime_id, orgId: order.org_id, runtimeEpoch: currentRuntime.epoch,
    materialCauseId: `work-order:${order.id}:result:${status}`,
    triggerType: 'work_result', dueAt: new Date(),
    payload: { work_order_id: order.id, status },
  });
  return { workOrderId: order.id, status: status.toUpperCase() };
}
