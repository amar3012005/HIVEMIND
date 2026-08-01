import {
  appendHqEvent,
  ensureHqRuntime,
  FIRST_LIFE_OBJECTIVE,
  getHqRuntime,
  resetHqForCompanyReplacement,
  scheduleHqWake,
  transitionHqRuntime,
} from './repository.js';
import { reconcileTodoCapabilities } from './instruction-loop.js';
import { loadRuntimePlaybookSnapshot, projectRuntimePlaybookSnapshot } from '../runtime-playbooks/snapshot.js';
import { stageAuthorityHash } from '../runtime-playbooks/stage-executor.js';

const ACTIVE_STATES = new Set(['OBSERVING', 'DIAGNOSING', 'DELEGATING', 'WAITING', 'REVIEWING', 'BLOCKED']);

function asJsonEvent(row) {
  return {
    ...row,
    sequence: String(row.sequence),
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
  };
}

function asJsonRuntime(row) {
  if (!row) return null;
  return { ...row, eventSequence: String(row.eventSequence ?? 0) };
}

function tokenPair(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
  return { input, output };
}

async function getHqUsage(prisma, orgId, since = null) {
  const createdAt = since ? { gte: since } : undefined;
  const [plans, workOrders] = await Promise.all([
    prisma.sourceArtifact.findMany({
      where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response', ...(createdAt ? { createdAt } : {}) },
      select: { payload: true }, take: 100,
    }),
    prisma.hyperWorkOrder.findMany({ where: { orgId, hqCycleId: { not: null }, ...(createdAt ? { createdAt } : {}) }, select: { id: true }, take: 500 }),
  ]);
  const results = workOrders.length ? await prisma.hyperWorkResult.findMany({
    where: { workOrderId: { in: workOrders.map((row) => row.id) } }, select: { usage: true }, take: 500,
  }) : [];
  return [...plans.map((row) => row.payload?.usage || {}), ...results.map((row) => row.usage || {})]
    .reduce((total, usage) => { const value = tokenPair(usage); return { input_tokens: total.input_tokens + value.input, output_tokens: total.output_tokens + value.output }; }, { input_tokens: 0, output_tokens: 0 });
}

async function requireHqAccess({ req, res, requireSession, requirePrivilegedAgentAccess }) {
  const current = await requireSession(req, res);
  if (!current) return null;
  if (!await requirePrivilegedAgentAccess(req, res, current)) return null;
  return current;
}

async function findDefaultObjective(prisma, orgId) {
  const goal = await prisma.growthGoal.findFirst({
    where: { orgId, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' }, select: { objective: true },
  }).catch(() => null);
  if (goal?.objective) return goal.objective;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT agent_connectors->'_company' AS company FROM hivemind.hyper_rooms
      WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors ? '_company'
      ORDER BY updated_at DESC LIMIT 1`, orgId,
  ).catch(() => []);
  const company = rows[0]?.company || {};
  return company.goal || company.mission || '';
}

async function requestWake({ prisma, runtime, triggerType, payload = {}, key }) {
  const dueAt = new Date();
  const idempotencyKey = key || `${triggerType}:${dueAt.toISOString().slice(0, 16)}`;
  return scheduleHqWake({
    prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
    idempotencyKey, triggerType, dueAt, payload,
  });
}

async function reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler }) {
  const result = await reconcileTodoCapabilities({ prisma, runtime });
  if (!result.resolved.length) return result;
  for (const resolved of result.resolved) {
    await appendHqEvent({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId,
      eventType: 'capability_resolved', title: 'A required capability is available',
      summary: `${resolved.platform_managed?.length ? `${resolved.platform_managed.join(', ')} is provided by Singulance.` : `I verified ${resolved.capabilities.join(', ')} against this organization.`} The blocked todo is ready again and has returned to the operating queue.`,
      details: resolved,
    });
  }
  await requestWake({
    prisma, runtime, triggerType: 'connector_changed', payload: { resolved: result.resolved },
    key: `capability-reconciled:${runtime.id}:${result.resolved.map((item) => item.todo_id).join(':')}`,
  });
  Promise.resolve(wakeScheduler?.()).catch(() => {});
  return result;
}

function queueStatus(value) {
  const status = String(value || '').toUpperCase();
  if (['COMPLETED', 'COMPLETE'].includes(status)) return 'COMPLETED';
  if (status === 'WAITING_FOR_CONNECTOR') return 'WAITING_FOR_CONNECTOR';
  if (status === 'WAITING_FOR_AUTHORITY') return 'WAITING_FOR_AUTHORITY';
  if (status === 'BLOCKED') return 'BLOCKED';
  if (['RUNNING', 'ACTIVE', 'QUEUED'].includes(status)) return 'RUNNING';
  return 'READY';
}

function runtimeQueue({ todos, stages, delegations }) {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const todoRows = todos.map((todo) => ({
    id: `todo:${todo.id}`, source: 'todo', source_id: todo.id, title: todo.title,
    objective: todo.objective, status: queueStatus(todo.status), priority: todo.priority,
    position: todo.position, blocked_reason: todo.blockedReason || null, updated_at: todo.updatedAt,
  }));
  const stageRows = stages.map((stage) => {
    const stageDelegations = delegations.filter((delegation) => delegation.growthStageId === stage.id);
    const waitingForEvidence = String(stage.status).toUpperCase() === 'ACTIVE'
      && stage.checkpointAt && new Date(stage.checkpointAt).getTime() > Date.now()
      && stageDelegations.every((delegation) => ['COMPLETED', 'CANCELLED'].includes(String(delegation.status).toUpperCase()));
    return {
      id: `stage:${stage.id}`, source: 'growth_stage', source_id: stage.id, title: stage.name,
      objective: stage.objective, status: waitingForEvidence ? 'WAITING_FOR_EVIDENCE' : queueStatus(stage.status),
      priority: String(stage.status).toUpperCase() === 'ACTIVE' ? 10 : 80, position: 0,
      blocked_reason: waitingForEvidence ? `Review at ${new Date(stage.checkpointAt).toISOString()}` : null, updated_at: stage.updatedAt,
    };
  });
  const delegationRows = delegations.map((delegation) => ({
    id: `delegation:${delegation.id}`, source: 'growth_delegation', source_id: delegation.id,
    title: delegation.objective, objective: delegation.deliverable || delegation.objective,
    status: queueStatus(delegation.status), priority: stageById.get(delegation.growthStageId)?.status === 'ACTIVE' ? 15 : 90,
    position: 0, blocked_reason: null, updated_at: delegation.updatedAt,
  }));
  return [...todoRows, ...stageRows, ...delegationRows]
    .sort((left, right) => left.priority - right.priority || left.position - right.position || new Date(left.updated_at) - new Date(right.updated_at));
}

export function createHqRuntimeRouteHandler({ prisma, requireSession, requirePrivilegedAgentAccess, parseBody, jsonResponse, wakeScheduler = null, emailLifecycle = null, runtimePlaybooks = null }) {
  return async function handleHqRuntimeRoute(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/v1/hq/')) return false;
    const current = await requireHqAccess({ req, res, requireSession, requirePrivilegedAgentAccess });
    if (!current) return true;
    const orgId = current.session.orgId;
    const userId = current.session.userId;

    try {
      if (pathname === '/v1/hq/runtime' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        const usage = await getHqUsage(prisma, orgId, runtime?.activatedAt || runtime?.createdAt || null);
        return jsonResponse(res, { runtime: asJsonRuntime(runtime), usage });
      }

      if (pathname === '/v1/hq/authority-policy' && req.method === 'PATCH') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const body = await parseBody(req).catch(() => ({}));
        const outboundMessages = String(body.outbound_messages || '').trim().toLowerCase();
        if (!['manual', 'auto'].includes(outboundMessages)) {
          return jsonResponse(res, { error: 'hq_runtime_outbound_authority_invalid' }, 400);
        }
        if (runtime.authorityPolicy?.outbound_messages !== outboundMessages) {
          await prisma.hqRuntime.update({
            where: { id: runtime.id },
            data: {
              authorityPolicy: { ...(runtime.authorityPolicy || {}), outbound_messages: outboundMessages },
              version: { increment: 1 },
            },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'verification',
            title: outboundMessages === 'auto' ? 'Automatic message delivery enabled' : 'Manual message review enabled',
            summary: outboundMessages === 'auto'
              ? 'Future verified outbound-message checkpoints may proceed automatically. Existing pending batches still require their exact approval action.'
              : 'Future outbound-message checkpoints will wait for explicit approval before delivery.',
            details: { actor: userId, policy_key: 'outbound_messages', preference: outboundMessages },
          });
        }
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/activate' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || await findDefaultObjective(prisma, orgId)).trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);
        let runtime = await ensureHqRuntime({ prisma, orgId, userId, objective, authorityPolicy: body.authority_policy || {} });
        if (runtime.state === 'INACTIVE') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'INACTIVE', to: 'OBSERVING',
            data: { activatedAt: new Date() },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, eventType: 'wake',
            title: 'Company operation activated',
            summary: 'HQ is establishing current company state before choosing its first bounded action.',
          });
        }
        const schedule = runtime.state === 'PAUSED' ? null : await requestWake({
          prisma, runtime, triggerType: 'activation', key: `activation:${runtime.id}`,
        });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule }, 201);
      }

      if (pathname === '/v1/hq/launch' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const instructionBody = String(body.instruction || '').trim().slice(0, 5000);
        if (!instructionBody) return jsonResponse(res, { error: 'hq_instruction_required' }, 400);
        const existingRuntime = await getHqRuntime({ prisma, orgId });
        const freshStart = !existingRuntime || existingRuntime.state === 'INACTIVE';
        const objective = String(freshStart
          ? FIRST_LIFE_OBJECTIVE
          : body.objective || await findDefaultObjective(prisma, orgId)).trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);

        let runtime = await ensureHqRuntime({
          prisma, orgId, userId, objective,
          authorityPolicy: body.authority_policy || { internal_autonomy: true },
        });
        if (runtime.state === 'INACTIVE') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'INACTIVE', to: 'OBSERVING',
            data: { activatedAt: new Date() },
          });
        } else if (runtime.state === 'PAUSED') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'PAUSED', to: 'OBSERVING',
            data: { pauseReason: null },
          });
        }

        const instruction = await prisma.hqInstruction.create({
          data: {
            runtimeId: runtime.id, orgId, userId, body: instructionBody,
            interpreted: {
              source: 'runtime_invitation',
              focuses: Array.isArray(body.focuses) ? body.focuses.map(String).slice(0, 12) : [],
              execution_mode: body.execution_mode === 'single_outcome' ? 'single_outcome' : 'operating_plan',
            },
          },
        });
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_first_activation',
          payload: { instruction_id: instruction.id, source: 'runtime_invitation', fresh_start: freshStart },
          key: `runtime_launch:${instruction.id}`,
        });
        return jsonResponse(res, {
          runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), instruction, schedule,
        }, 201);
      }

      if (pathname === '/v1/hq/pause' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state !== 'PAUSED') {
          if (!ACTIVE_STATES.has(runtime.state)) return jsonResponse(res, { error: 'hq_runtime_not_active' }, 409);
          const body = await parseBody(req).catch(() => ({}));
          await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId, from: runtime.state, to: 'PAUSED', data: { pauseReason: String(body.reason || 'Paused by user').slice(0, 1000) } });
          await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'sleep', title: 'HQ paused', summary: 'No new HQ cycles or external operations will begin until the runtime is resumed.' });
        }
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/resume' && req.method === 'POST') {
        let runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state === 'PAUSED') {
          runtime = await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId, from: 'PAUSED', to: 'OBSERVING', data: { pauseReason: null } });
          await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'wake', title: 'HQ resumed', summary: 'HQ will refresh material state and continue from its last durable checkpoint.' });
        }
        const schedule = await requestWake({ prisma, runtime, triggerType: 'user_resume', key: `resume:${runtime.version}` });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule });
      }

      if (pathname === '/v1/hq/wake' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state === 'PAUSED') return jsonResponse(res, { error: 'hq_runtime_paused' }, 409);
        const activeCycle = await prisma.hqCycle.findFirst({
          where: { orgId, runtimeEpoch: runtime.epoch, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' },
        });
        if (activeCycle) return jsonResponse(res, { runtime: asJsonRuntime(runtime), cycle: activeCycle, already_running: true });
        const activeWorkOrder = await prisma.hyperWorkOrder.findFirst({
          where: { orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
          select: { id: true, title: true, status: true },
        });
        if (activeWorkOrder) {
          return jsonResponse(res, { runtime: asJsonRuntime(runtime), work_order: activeWorkOrder, already_operating: true });
        }
        const body = await parseBody(req).catch(() => ({}));
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_wake', payload: body.payload || {},
          key: String(body.idempotency_key || `user_wake:${Date.now()}`).slice(0, 160),
        });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule }, 202);
      }

      if (pathname === '/v1/hq/restart' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const lifecycle = typeof emailLifecycle === 'function' ? emailLifecycle() : emailLifecycle;
        if (lifecycle?.deleteCheckpoints) {
          const workflows = await prisma.hqWorkflow.findMany({
            where: { runtimeId: runtime.id, orgId },
            select: { id: true, context: true },
          });
          for (const workflow of workflows) {
            if (workflow.context?.email_lifecycle?.execution_id) {
              await lifecycle.deleteCheckpoints({ organizationId: orgId, executionId: workflow.id });
            }
          }
        }
        await prisma.runtimePlaybookRun?.deleteMany?.({ where: { orgId } }).catch?.(() => {});
        const reset = await resetHqForCompanyReplacement({ prisma, orgId });
        return jsonResponse(res, {
          runtime: asJsonRuntime(reset),
          reset: true,
          next: 'runtime_invitation',
        });
      }

      if (pathname === '/v1/hq/objective' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || '').trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const updated = await prisma.hqRuntime.updateMany({ where: { id: runtime.id, orgId }, data: { objective, version: { increment: 1 } } });
        if (updated.count !== 1) return jsonResponse(res, { error: 'hq_runtime_update_conflict' }, 409);
        await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'decision', title: 'Company objective updated', summary: objective, details: { actor: 'user' } });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/events' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { events: [], next: null });
        const after = BigInt(url.searchParams.get('after') || '0');
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const events = await prisma.hqRuntimeEvent.findMany({
          where: { runtimeId: runtime.id, orgId, sequence: { gt: after }, visibility: 'USER' },
          orderBy: { sequence: 'asc' }, take: limit,
        });
        return jsonResponse(res, { events: events.map(asJsonEvent), next: events.length ? String(events.at(-1).sequence) : String(after) });
      }

      if (pathname === '/v1/hq/events/stream' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        let cursor = BigInt(url.searchParams.get('after') || '0');
        let closed = false;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const writeAvailable = async () => {
          if (closed) return;
          const rows = await prisma.hqRuntimeEvent.findMany({
            where: { runtimeId: runtime.id, orgId, sequence: { gt: cursor }, visibility: 'USER' },
            orderBy: { sequence: 'asc' }, take: 100,
          });
          for (const row of rows) {
            cursor = row.sequence;
            res.write(`id: ${row.sequence}\nevent: hq_event\ndata: ${JSON.stringify(asJsonEvent(row))}\n\n`);
          }
        };
        await writeAvailable();
        const poll = setInterval(() => writeAvailable().catch(() => {}), 1000);
        const heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 15000);
        req.on('close', () => { closed = true; clearInterval(poll); clearInterval(heartbeat); });
        return true;
      }

      if (pathname === '/v1/hq/work' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { work_orders: [], schedules: [] });
        await reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler });
        const playbookService = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        const [workOrders, schedules, todos, capabilityRequests, instructions, stages, delegations, playbookRuns] = await Promise.all([
          prisma.hyperWorkOrder.findMany({ where: { orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50 }),
          prisma.hqSchedule.findMany({ where: { orgId, runtimeEpoch: runtime.epoch, status: { in: ['PENDING', 'LEASED'] } }, orderBy: { dueAt: 'asc' }, take: 50 }),
          prisma.hqTodo.findMany({ where: { orgId, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
          prisma.hqCapabilityRequest.findMany({ where: { orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
          prisma.hqInstruction.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.growthStage.findMany({ where: { orgId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, orderBy: { updatedAt: 'desc' }, take: 20 }),
          prisma.growthDelegation.findMany({ where: { orgId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, orderBy: { updatedAt: 'desc' }, take: 30 }),
          prisma.runtimePlaybookRun?.findMany ? prisma.runtimePlaybookRun.findMany({
            where: { orgId }, orderBy: { updatedAt: 'desc' }, take: 50,
            include: {
              artifacts: { orderBy: { createdAt: 'asc' } },
              checkpoints: { orderBy: { sequence: 'desc' }, take: 1 },
              authorities: { orderBy: { grantedAt: 'asc' } },
            },
          }).catch(() => []) : Promise.resolve([]),
        ]);
        const todoById = new Map(todos.map((todo) => [todo.id, todo]));
        const playbookApprovals = playbookRuns.filter((run) => run.status === 'WAITING_AUTHORITY').map((run) => {
          const playbook = playbookService?.registry?.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
          const stage = playbook?.stages?.find((candidate) => candidate.id === run.currentStageId);
          if (!stage?.authority_gate || !stage?.authority_policy_key) return null;
          const messages = run.artifacts.filter((artifact) => artifact.artifactKey === 'message_record').map((artifact) => ({
            id: artifact.artifactId,
            lead_ref: artifact.data?.lead_ref || null,
            to: artifact.data?.recipient || null,
            subject: artifact.data?.subject || null,
            body: artifact.data?.body || null,
          }));
          const todo = todoById.get(String(run.trigger?.todo_id || ''));
          return {
            run_id: run.id,
            todo_id: todo?.id || null,
            title: todo?.title || playbook?.name || 'External messages are ready',
            gate: stage.authority_gate,
            policy_key: stage.authority_policy_key,
            preference: runtime.authorityPolicy?.[stage.authority_policy_key] || 'unconfigured',
            messages,
          };
        }).filter(Boolean);
        return jsonResponse(res, { work_orders: workOrders, schedules, todos, capability_requests: capabilityRequests, instructions, runtime_queue: runtimeQueue({ todos, stages, delegations }), playbook_approvals: playbookApprovals, playbook_runs: playbookRuns, playbook_snapshots: playbookRuns.map((run) => projectRuntimePlaybookSnapshot(run)) });
      }

      const playbookSnapshotMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/snapshot$/i);
      if (playbookSnapshotMatch && req.method === 'GET') {
        const snapshot = await loadRuntimePlaybookSnapshot(prisma, playbookSnapshotMatch[1], orgId);
        return snapshot ? jsonResponse(res, { snapshot }) : jsonResponse(res, { error: 'runtime_playbook_run_not_found' }, 404);
      }

      if (pathname === '/v1/hq/playbooks/runs' && req.method === 'GET') {
        const runs = await prisma.runtimePlaybookRun.findMany({
          where: { orgId }, orderBy: { updatedAt: 'desc' }, take: 100,
          include: {
            artifacts: { orderBy: { createdAt: 'asc' } },
            checkpoints: { orderBy: { sequence: 'asc' } },
            authorities: { orderBy: { grantedAt: 'asc' } },
          },
        });
        return jsonResponse(res, { runs });
      }

      if (pathname === '/v1/hq/playbooks/runs' && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || '').trim().slice(0, 8000);
        const roomId = String(body.room_id || '').trim();
        if (!objective || !roomId) return jsonResponse(res, { error: 'runtime_playbook_objective_and_room_required' }, 400);
        const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, orgId, archivedAt: null }, select: { id: true } });
        if (!room) return jsonResponse(res, { error: 'runtime_playbook_room_not_found' }, 404);
        const created = await service.tryCreateAssignment({
          orgId, roomId, objective,
          idempotencyKey: String(body.idempotency_key || `user:${userId}:${Date.now()}`).slice(0, 180),
          trigger: body.trigger || { type: 'user_request', payload: body.payload || {} },
          context: body.context || {},
          scopeKey: String(body.scope_key || 'global').slice(0, 80),
        });
        if (!created.matched) return jsonResponse(res, { error: 'runtime_playbook_no_compatible_lifecycle', selection: created.selection }, 422);
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, created, 201);
      }

      const playbookAuthorityMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/authority$/i);
      if (playbookAuthorityMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const gate = String(body.gate || '').trim().slice(0, 120);
        if (!gate) return jsonResponse(res, { error: 'runtime_playbook_authority_gate_required' }, 400);
        const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: playbookAuthorityMatch[1], orgId } });
        if (!run || run.status !== 'WAITING_AUTHORITY') return jsonResponse(res, { error: 'runtime_playbook_authority_not_waiting' }, 409);
        const playbook = service.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
        const stage = playbook.stages.find((candidate) => candidate.id === run.currentStageId);
        if (!stage || stage.authority_gate !== gate || !stage.authority_policy_key) {
          return jsonResponse(res, { error: 'runtime_playbook_authority_stage_mismatch' }, 409);
        }
        if (typeof body.approve !== 'boolean') return jsonResponse(res, { error: 'runtime_playbook_authority_approve_required' }, 400);
        const preference = body.preference == null ? null : String(body.preference).toLowerCase();
        if (preference && !['auto', 'manual'].includes(preference)) {
          return jsonResponse(res, { error: 'runtime_playbook_authority_preference_invalid' }, 400);
        }
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (preference) {
          const policyValue = preference;
          await prisma.hqRuntime.updateMany({
            where: { id: runtime.id, orgId, epoch: runtime.epoch },
            data: { authorityPolicy: { ...(runtime.authorityPolicy || {}), [stage.authority_policy_key]: policyValue }, version: { increment: 1 } },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'verification',
            title: preference === 'auto' ? 'Automatic message delivery enabled' : 'Manual message review retained',
            summary: preference === 'auto'
              ? 'This organization authorized future checkpoints governed by this exact outbound-message policy. Other external writes, spending, deletion, and policy changes remain separately governed.'
              : 'Every future outbound-message checkpoint will wait for an explicit Approve and send decision.',
            details: { policy_key: stage.authority_policy_key, preference: policyValue, run_id: run.id },
          });
        }
        const approve = body.approve;
        if (approve) {
          const loadedRun = await service.executor.store.loadRun(run.id, orgId);
          await service.grantAuthority(run.id, orgId, gate, { grantedBy: userId, payload: { ...(body.payload || {}), preference: preference || null, input_hash: stageAuthorityHash(loadedRun, stage) } });
        }
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { ok: true, approved: approve, preference: preference || null }, approve ? 202 : 200);
      }

      const playbookEventMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/events$/i);
      if (playbookEventMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const event = body.event && typeof body.event === 'object' ? body.event : {};
        if (!event.type) return jsonResponse(res, { error: 'runtime_playbook_event_type_required' }, 400);
        const run = await service.resumeEvent(playbookEventMatch[1], orgId, event);
        return jsonResponse(res, { run }, 202);
      }

      if (pathname === '/v1/hq/instructions' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const body = await parseBody(req).catch(() => ({}));
        const instructionBody = String(body.instruction || '').trim().slice(0, 5000);
        if (!instructionBody) return jsonResponse(res, { error: 'hq_instruction_required' }, 400);
        const instruction = await prisma.hqInstruction.create({ data: { runtimeId: runtime.id, orgId, userId, body: instructionBody } });
        const schedule = await requestWake({ prisma, runtime, triggerType: 'instruction_updated', payload: { instruction_id: instruction.id }, key: `instruction:${instruction.id}` });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { instruction, schedule }, 201);
      }

      if (pathname === '/v1/hq/capabilities/recheck' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const result = await reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler });
        const schedule = result.resolved.length ? null : await requestWake({ prisma, runtime, triggerType: 'connector_changed', key: `connector_changed:${Date.now()}` });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { schedule, resolved: result.resolved, platform_managed: result.platform_managed }, 202);
      }

      if (pathname === '/v1/hq/resources' && req.method === 'GET') {
        const [baselines, plans, journal] = await Promise.all([
          prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' }, select: { id: true, sourceId: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response' }, select: { id: true, sourceId: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.growthJournal.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        ]);
        return jsonResponse(res, { baselines, growth_plans: plans, journal });
      }

      return false;
    } catch (error) {
      console.warn('[hq-runtime] route failed:', error.message);
      return jsonResponse(res, { error: 'hq_runtime_request_failed', message: error.message }, 503);
    }
  };
}
