import {
  appendHqEvent,
  ensureHqRuntime,
  getHqRuntime,
  scheduleHqWake,
  transitionHqRuntime,
} from './repository.js';

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
    prisma, runtimeId: runtime.id, orgId: runtime.orgId,
    idempotencyKey, triggerType, dueAt, payload,
  });
}

export function createHqRuntimeRouteHandler({ prisma, requireSession, requirePrivilegedAgentAccess, parseBody, jsonResponse }) {
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
        const objective = String(body.objective || await findDefaultObjective(prisma, orgId)).trim().slice(0, 5000);
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
            },
          },
        });
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_first_activation',
          payload: { instruction_id: instruction.id, source: 'runtime_invitation' },
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
          where: { orgId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' },
        });
        if (activeCycle) return jsonResponse(res, { runtime: asJsonRuntime(runtime), cycle: activeCycle, already_running: true });
        const body = await parseBody(req).catch(() => ({}));
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_wake', payload: body.payload || {},
          key: String(body.idempotency_key || `user_wake:${Date.now()}`).slice(0, 160),
        });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule }, 202);
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
        const [workOrders, schedules, todos, capabilityRequests, instructions] = await Promise.all([
          prisma.hyperWorkOrder.findMany({ where: { orgId, hqCycleId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50 }),
          prisma.hqSchedule.findMany({ where: { orgId, status: { in: ['PENDING', 'LEASED'] } }, orderBy: { dueAt: 'asc' }, take: 50 }),
          prisma.hqTodo.findMany({ where: { orgId, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
          prisma.hqCapabilityRequest.findMany({ where: { orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
          prisma.hqInstruction.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
        ]);
        return jsonResponse(res, { work_orders: workOrders, schedules, todos, capability_requests: capabilityRequests, instructions });
      }

      if (pathname === '/v1/hq/instructions' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const body = await parseBody(req).catch(() => ({}));
        const instructionBody = String(body.instruction || '').trim().slice(0, 5000);
        if (!instructionBody) return jsonResponse(res, { error: 'hq_instruction_required' }, 400);
        const instruction = await prisma.hqInstruction.create({ data: { runtimeId: runtime.id, orgId, userId, body: instructionBody } });
        const schedule = await requestWake({ prisma, runtime, triggerType: 'instruction_updated', payload: { instruction_id: instruction.id }, key: `instruction:${instruction.id}` });
        return jsonResponse(res, { instruction, schedule }, 201);
      }

      if (pathname === '/v1/hq/capabilities/recheck' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const schedule = await requestWake({ prisma, runtime, triggerType: 'connector_changed', key: `connector_changed:${Date.now()}` });
        return jsonResponse(res, { schedule }, 202);
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
