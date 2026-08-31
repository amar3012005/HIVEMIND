import { Agent, getAgentByName, routeAgentRequest, type Connection, type ConnectionContext, type WSMessage } from 'agents';
import { connectBrowserSession, createBrowserSession, type BrowserBinding } from 'agents/browser';
import { getSandbox, Sandbox } from '@cloudflare/sandbox';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { assignmentWorkflowId, modeRank, normalizeMode, type AssignmentParams, type RuntimeMode, type TurnParams, validAssignmentParams, validParams, workflowId } from './contract';

interface Env {
  ENVIRONMENT: string;
  HIVEMIND_CORE_URL: string;
  HYPER_GROK_FLAG?: string;
  HYPER_GROK_WORKFLOW_SECRET: string;
  FLAGS: {
    getStringDetails(key: string, fallback: string, context: Record<string, string>): Promise<{
      value: string; reason?: string; variant?: string;
    }>;
  };
  HIRED_HYPER_AGENT: DurableObjectNamespace<HiredHyperAgent>;
  HYPER_ROOM_GATEWAY: DurableObjectNamespace<HyperRoomGateway>;
  ROOM_RUN_WORKFLOW: Workflow<TurnParams>;
  AGENT_ASSIGNMENT_WORKFLOW: Workflow<AssignmentParams>;
  BROWSER: BrowserBinding;
  Sandbox: DurableObjectNamespace<Sandbox>;
}

export { Sandbox };

function safePublicUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null;
    return url;
  } catch { return null; }
}

function bounded(value: unknown, limit = 100_000): string {
  return String(value ?? '').slice(0, limit);
}

type AgentManifest = {
  employee_id: string; agent_instance_id: string; slug: string; name: string;
  lane: string; tools: string[]; connectors: string[]; processing_version: number;
};
type AgentState = {
  manifest: AgentManifest | null;
  status: 'idle' | 'active' | 'working' | 'waiting' | 'complete' | 'blocked';
  assignments: string[];
  routines: string[];
  preferences: Record<string, string | number | boolean>;
  task_history: Array<{ work_order_id: string; status: string; completed_at: number }>;
  updated_at: number;
};

type RoomGatewayState = {
  room_instance_id: string | null;
  revision: number;
  last_event_type: string | null;
  last_status: string | null;
  updated_at: number;
};

type RoomTicket = {
  room_instance_id: string;
  org_id: string;
  user_id: string;
  exp: number;
};

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function verifyRoomTicket(token: string, expectedInstance: string, secret: string): Promise<RoomTicket | null> {
  const [payloadPart, signaturePart, extra] = String(token || '').split('.');
  if (!payloadPart || !signaturePart || extra) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const verified = await crypto.subtle.verify(
      'HMAC', key, base64UrlBytes(signaturePart).buffer as ArrayBuffer, new TextEncoder().encode(payloadPart),
    );
    if (!verified) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(payloadPart))) as RoomTicket;
    if (payload.room_instance_id !== expectedInstance || !payload.org_id || !payload.user_id
        || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export class HyperRoomGateway extends Agent<Env, RoomGatewayState> {
  initialState: RoomGatewayState = {
    room_instance_id: null, revision: 0, last_event_type: null, last_status: null, updated_at: 0,
  };

  async onConnect(connection: Connection, context: ConnectionContext) {
    const token = new URL(context.request.url).searchParams.get('token') || '';
    const ticket = await verifyRoomTicket(token, this.name, this.env.HYPER_GROK_WORKFLOW_SECRET);
    if (!ticket) {
      connection.close(4001, 'Unauthorized');
      return;
    }
    connection.setState({ org_id: ticket.org_id, user_id: ticket.user_id });
    connection.send(JSON.stringify({ type: 'ready', room_instance_id: this.name, state: this.state }));
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== 'string') return;
    let parsed: { type?: string } = {};
    try { parsed = JSON.parse(message) as { type?: string }; } catch { return; }
    if (parsed.type === 'ping') connection.send(JSON.stringify({ type: 'pong', at: Date.now() }));
  }

  async onRequest(request: Request): Promise<Response> {
    if (!await authorized(request, this.env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/publish')) {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }
    const body = await request.json<{ room_instance_id?: string; event?: Record<string, unknown> }>()
      .catch(() => ({})) as { room_instance_id?: string; event?: Record<string, unknown> };
    if (body.room_instance_id !== this.name || !body.event || typeof body.event !== 'object') {
      return Response.json({ error: 'invalid_room_event' }, { status: 400 });
    }
    const eventType = String(body.event.t || body.event.type || 'event').slice(0, 80);
    const status = String(body.event.status || '').slice(0, 32) || null;
    this.setState({
      room_instance_id: this.name, revision: this.state.revision + 1,
      last_event_type: eventType, last_status: status, updated_at: Date.now(),
    });
    this.broadcast(JSON.stringify({ type: 'event', revision: this.state.revision, event: body.event }));
    return Response.json({ ok: true, revision: this.state.revision, connections: Array.from(this.getConnections()).length });
  }
}

export class HiredHyperAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    manifest: null, status: 'idle', assignments: [], routines: [], preferences: {}, task_history: [], updated_at: 0,
  };

  validateStateChange(next: AgentState) {
    if ((next.assignments || []).length > 100 || (next.routines || []).length > 100
        || (next.task_history || []).length > 100
        || Object.keys(next.preferences || {}).length > 50) throw new Error('agent_state_limit');
    if (next.manifest && this.state.manifest
        && next.manifest.employee_id !== this.state.manifest.employee_id) throw new Error('agent_identity_immutable');
  }

  async runRoutine(payload: { routine_id: string }) {
    const response = await fetch(
      `${this.env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/hyper-grok/v1/routines/${payload.routine_id}/trigger`,
      { method: 'POST', headers: { authorization: `Bearer ${this.env.HYPER_GROK_WORKFLOW_SECRET}` } },
    );
    if (!response.ok) throw new Error(`routine_trigger_${response.status}`);
  }

  async onRequest(request: Request): Promise<Response> {
    if (!await authorized(request, this.env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/provision')) {
      const manifest = await request.json<AgentManifest>().catch(() => null);
      if (!manifest || !manifest.employee_id || !manifest.agent_instance_id) {
        return Response.json({ error: 'invalid_manifest' }, { status: 400 });
      }
      if (this.state.manifest && this.state.manifest.employee_id !== manifest.employee_id) {
        return Response.json({ error: 'agent_identity_mismatch' }, { status: 409 });
      }
      this.setState({ ...this.initialState, ...this.state, manifest, updated_at: Date.now() });
      return Response.json({ ok: true, agent_instance_id: manifest.agent_instance_id });
    }
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/assignment')) {
      const body = await request.json<{ work_order_id?: string; status?: AgentState['status'] }>()
        .catch(() => ({})) as { work_order_id?: string; status?: AgentState['status'] };
      const workOrderId = String(body.work_order_id || '');
      if (!this.state.manifest || !/^[0-9a-f-]{36}$/i.test(workOrderId)) {
        return Response.json({ error: 'invalid_assignment' }, { status: 400 });
      }
      const assignments = body.status === 'complete'
        ? this.state.assignments.filter((id) => id !== workOrderId)
        : Array.from(new Set([...this.state.assignments, workOrderId])).slice(-100);
      const taskHistory = body.status === 'complete'
        ? [...(this.state.task_history || []).filter((row) => row.work_order_id !== workOrderId), {
            work_order_id: workOrderId, status: 'complete', completed_at: Date.now(),
          }].slice(-100)
        : (this.state.task_history || []);
      this.setState({ ...this.state, assignments, task_history: taskHistory,
        status: body.status === 'complete' ? 'idle' : 'working', updated_at: Date.now() });
      return Response.json({ ok: true, assignments, status: this.state.status });
    }
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/preferences')) {
      const body = await request.json<{ preferences?: Record<string, unknown> }>()
        .catch(() => ({} as { preferences?: Record<string, unknown> }));
      if (!this.state.manifest || !body.preferences || typeof body.preferences !== 'object') {
        return Response.json({ error: 'invalid_preferences' }, { status: 400 });
      }
      const preferences: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(body.preferences).slice(0, 50)) {
        if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(key)) continue;
        if (['string', 'number', 'boolean'].includes(typeof value)) {
          preferences[key] = typeof value === 'string' ? value.slice(0, 500) : value as number | boolean;
        }
      }
      this.setState({ ...this.state, preferences, updated_at: Date.now() });
      return Response.json({ ok: true, preferences: this.state.preferences });
    }
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/routine')) {
      const body = await request.json<{
        routine_id?: string; schedule_type?: string; schedule_expression?: string;
      }>().catch(() => ({})) as { routine_id?: string; schedule_type?: string; schedule_expression?: string };
      const routineId = String(body.routine_id || '');
      const expression = String(body.schedule_expression || '');
      if (!this.state.manifest || !/^[0-9a-f-]{36}$/i.test(routineId) || !expression) {
        return Response.json({ error: 'invalid_routine' }, { status: 400 });
      }
      let schedule;
      if (body.schedule_type === 'cron') schedule = await this.schedule(expression, 'runRoutine', { routine_id: routineId });
      else if (body.schedule_type === 'interval') schedule = await this.scheduleEvery(Number(expression), 'runRoutine', { routine_id: routineId });
      else schedule = await this.schedule(Number(expression), 'runRoutine', { routine_id: routineId });
      this.setState({ ...this.state, routines: Array.from(new Set([...this.state.routines, routineId])).slice(-100), updated_at: Date.now() });
      return Response.json({ ok: true, schedule_id: schedule.id });
    }
    if (request.method === 'GET') return Response.json(this.state);
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
}

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const bytes = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', bytes.encode(actual)),
    crypto.subtle.digest('SHA-256', bytes.encode(expected)),
  ]);
  const a = new Uint8Array(left); const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  return equalSecret(
    String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''),
    env.HYPER_GROK_WORKFLOW_SECRET || '',
  );
}

async function decision(env: Env, orgId: string, userId: string): Promise<{ mode: RuntimeMode; processing_version: number; reason: string; variant?: string }> {
  if (!env.FLAGS || !orgId || !userId) return { mode: 'off', processing_version: 1, reason: 'invalid_context' };
  const details = await env.FLAGS.getStringDetails(
    env.HYPER_GROK_FLAG || 'hyperagents_grok_agents_v1', 'off',
    { targetingKey: userId, org_id: orgId, user_id: userId, environment: env.ENVIRONMENT },
  );
  return {
    mode: normalizeMode(details.value), processing_version: 1,
    reason: String(details.reason || 'flagship'), variant: details.variant,
  };
}

async function core(env: Env, params: TurnParams, action: 'prepare' | 'execute' | 'reconcile'): Promise<string> {
  const response = await fetch(
    `${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/hyper-grok/v1/turns/${params.turn_id}/${action}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        org_id: params.org_id, user_id: params.user_id, mode: params.mode,
        processing_version: params.processing_version,
      }),
    },
  );
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.error || `core_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }
  // Workflow step results must remain plainly serializable. Keeping the Core
  // receipt as JSON also prevents Cloudflare's RPC types from recursively
  // instantiating an unbounded Record<string, unknown>.
  return JSON.stringify(body);
}

async function coreAssignment(env: Env, params: AssignmentParams, action: 'prepare' | 'reconcile'): Promise<string> {
  const response = await fetch(
    `${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/hyper-grok/v1/work-orders/${params.work_order_id}/${action}`,
    { method: 'POST', headers: {
      authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json',
    }, body: JSON.stringify(params) },
  );
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.error || `core_assignment_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }
  return JSON.stringify(body);
}

async function provisionRoster(env: Env, params: TurnParams): Promise<{ count: number }> {
  const prepared = JSON.parse(await core(env, params, 'prepare')) as { agents?: AgentManifest[] };
  for (const manifest of prepared.agents || []) {
    const agent = await getAgentByName(env.HIRED_HYPER_AGENT, manifest.agent_instance_id);
    const response = await agent.fetch(new Request('https://agent.internal/provision', {
      method: 'POST', headers: {
        authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`,
        'content-type': 'application/json',
      }, body: JSON.stringify(manifest),
    }));
    if (!response.ok) throw new Error(`agent_provision_${response.status}`);
  }
  return { count: prepared.agents?.length || 0 };
}

export class HyperRoomRunWorkflow extends WorkflowEntrypoint<Env, TurnParams> {
  async run(event: WorkflowEvent<TurnParams>, step: WorkflowStep) {
    const params = event.payload;
    if (!validParams(params) || modeRank(params.mode) < modeRank('durable_assignments')) {
      throw new NonRetryableError('invalid_runtime_payload');
    }
    await step.do(
      'provision authorized room roster',
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      () => provisionRoster(this.env, params),
    );
    const executed = await step.do(
      'execute durable room turn',
      { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' }, timeout: '30 minutes' },
      () => core(this.env, params, 'execute'),
    );
    const reconciled = await step.do(
      'verify persisted terminal state',
      { retries: { limit: 10, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
      () => core(this.env, params, 'reconcile'),
    );
    return { ok: true, instance_id: event.instanceId, executed, reconciled };
  }
}

export class HyperAgentAssignmentWorkflow extends WorkflowEntrypoint<Env, AssignmentParams> {
  async run(event: WorkflowEvent<AssignmentParams>, step: WorkflowStep) {
    const params = event.payload;
    if (!validAssignmentParams(params) || modeRank(params.mode) < modeRank('durable_assignments')) {
      throw new NonRetryableError('invalid_assignment_payload');
    }
    await step.do('verify assignment authority', { retries: { limit: 5, delay: '10 seconds' } },
      () => coreAssignment(this.env, params, 'prepare'));
    const result = await step.do('reconcile persisted work result', {
      retries: { limit: 60, delay: '30 seconds', backoff: 'constant' }, timeout: '35 minutes',
    }, () => coreAssignment(this.env, params, 'reconcile'));
    const agent = await getAgentByName(this.env.HIRED_HYPER_AGENT, params.agent_instance_id);
    await agent.fetch(new Request('https://agent.internal/assignment', {
      method: 'POST', headers: {
        authorization: `Bearer ${this.env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ work_order_id: params.work_order_id, status: 'complete' }),
    }));
    return { ok: true, result };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    if (!await authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/decision' && request.method === 'GET') {
      return Response.json(await decision(env, url.searchParams.get('org_id') || '', url.searchParams.get('user_id') || ''));
    }
    if (url.pathname === '/rooms/publish' && request.method === 'POST') {
      const body = await request.json<{ room_instance_id?: string; event?: Record<string, unknown> }>()
        .catch(() => ({})) as { room_instance_id?: string; event?: Record<string, unknown> };
      const instanceId = String(body.room_instance_id || '');
      if (!/^hr-[a-f0-9]{32}$/i.test(instanceId)) {
        return Response.json({ error: 'invalid_room_instance' }, { status: 400 });
      }
      const room = await getAgentByName(env.HYPER_ROOM_GATEWAY, instanceId);
      return room.fetch(new Request('https://room.internal/publish', {
        method: 'POST', headers: {
          authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json',
        }, body: JSON.stringify(body),
      }));
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const live = await decision(env, params.org_id, params.user_id);
      if (live.mode !== params.mode || modeRank(live.mode) < modeRank('durable_assignments')) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      const id = workflowId(params.turn_id, params.processing_version);
      try {
        await env.ROOM_RUN_WORKFLOW.create({ id, params, retention: { successRetention: '30 days', errorRetention: '30 days' } });
      } catch {
        const existing = await env.ROOM_RUN_WORKFLOW.get(id);
        const status = await existing.status();
        if (status.status === 'errored' || status.status === 'terminated') await existing.restart();
      }
      return Response.json({ ok: true, instance_id: id }, { status: 202 });
    }
    if (url.pathname === '/assignments/start' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validAssignmentParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const live = await decision(env, params.org_id, params.user_id);
      if (live.mode !== params.mode || modeRank(live.mode) < modeRank('durable_assignments')) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      const id = assignmentWorkflowId(params.work_order_id, params.processing_version);
      const agent = await getAgentByName(env.HIRED_HYPER_AGENT, params.agent_instance_id);
      const state = await agent.fetch(new Request('https://agent.internal/assignment', {
        method: 'POST', headers: {
          authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json',
        }, body: JSON.stringify({ work_order_id: params.work_order_id, status: 'working' }),
      }));
      if (!state.ok) return Response.json({ error: 'agent_assignment_state_failed' }, { status: 409 });
      try { await env.AGENT_ASSIGNMENT_WORKFLOW.create({ id, params }); }
      catch { /* deterministic duplicate: the existing Workflow remains authoritative */ }
      return Response.json({ ok: true, instance_id: id }, { status: 202 });
    }
    if (url.pathname === '/routines/schedule' && request.method === 'POST') {
      const params = await request.json<{
        org_id?: string; user_id?: string; agent_instance_id?: string; mode?: RuntimeMode;
        routine_id?: string; schedule_type?: string; schedule_expression?: string;
      }>().catch(() => ({})) as Record<string, string>;
      const live = await decision(env, params.org_id || '', params.user_id || '');
      if (live.mode !== params.mode || modeRank(live.mode) < modeRank('routines')) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      if (!/^ha-[a-f0-9]{32}-v[1-9][0-9]*$/i.test(params.agent_instance_id || '')) {
        return Response.json({ error: 'invalid_agent_instance' }, { status: 400 });
      }
      const agent = await getAgentByName(env.HIRED_HYPER_AGENT, params.agent_instance_id);
      return agent.fetch(new Request('https://agent.internal/routine', {
        method: 'POST', headers: {
          authorization: `Bearer ${env.HYPER_GROK_WORKFLOW_SECRET}`, 'content-type': 'application/json',
        }, body: JSON.stringify(params),
      }));
    }
    if (url.pathname === '/provision' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const live = await decision(env, params.org_id, params.user_id);
      if (live.mode !== params.mode || modeRank(live.mode) < modeRank('persistent_agents')) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      return Response.json({ ok: true, ...(await provisionRoster(env, params)) });
    }
    if (url.pathname === '/browser/execute' && request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      const orgId = String(body.org_id || ''); const userId = String(body.user_id || '');
      const live = await decision(env, orgId, userId);
      if (modeRank(live.mode) < modeRank('browser') || live.mode !== body.mode) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      const destination = safePublicUrl(body.url);
      if (!destination) return Response.json({ error: 'invalid_public_https_url' }, { status: 400 });
      const browser = await createBrowserSession(env.BROWSER, { keepAliveMs: 300_000, includeTargets: true, recording: true });
      const cdp = await connectBrowserSession(env.BROWSER, browser.sessionId, 20_000);
      try {
        const target = browser.targets?.find((candidate) => candidate.type === 'page') || browser.targets?.[0];
        if (!target?.id) throw new Error('browser_target_unavailable');
        const sessionId = await cdp.attachToTarget(target.id, { timeoutMs: 20_000 });
        await cdp.send('Page.enable', {}, { sessionId, timeoutMs: 10_000 });
        await cdp.send('Page.navigate', { url: destination.toString() }, { sessionId, timeoutMs: 20_000 });
        // Commerce pages commonly hydrate prices after the load event and
        // lazy-render product cards only after a scroll. A one-second snapshot
        // captured navigation/footer text while omitting the requested prices.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await cdp.send('Runtime.evaluate', {
          expression: 'window.scrollTo(0, Math.max(document.body?.scrollHeight||0, document.documentElement?.scrollHeight||0)); true',
          returnByValue: true,
        }, { sessionId, timeoutMs: 10_000 });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: String.raw`JSON.stringify((()=>{const text=(document.body?.innerText||"");const html=document.documentElement?.innerHTML||"";const pricePattern=/(?:[$€£]\s?\d[\d,.]*(?:\.\d{2})?|\d[\d,.]*(?:\.\d{2})?\s?(?:USD|EUR|GBP))/gi;const priceEvidence=[];for(const source of [text,html]){for(const match of source.matchAll(pricePattern)){const i=match.index||0;const excerpt=source.slice(Math.max(0,i-100),Math.min(source.length,i+match[0].length+160)).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();if(excerpt&&!priceEvidence.includes(excerpt))priceEvidence.push(excerpt);if(priceEvidence.length>=80)break;}if(priceEvidence.length>=80)break;}const structured=Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s=>(s.textContent||"").trim().slice(0,20000)).filter(Boolean).slice(0,10);const priceMeta=Array.from(document.querySelectorAll('meta[property*="price" i],meta[name*="price" i],meta[itemprop*="price" i]')).map(m=>({key:m.getAttribute("property")||m.getAttribute("name")||m.getAttribute("itemprop")||"price",content:m.getAttribute("content")||""})).filter(x=>x.content).slice(0,50);return{title:document.title,url:location.href,text:text.slice(0,100000),priceEvidence,structured,priceMeta,links:Array.from(document.querySelectorAll("a[href]")).slice(0,500).map(a=>({text:(a.innerText||a.getAttribute("aria-label")||"").trim().slice(0,240),url:a.href})).filter(x=>x.text&&x.url)}})())`,
          returnByValue: true,
        }, { sessionId, timeoutMs: 20_000 }) as { result?: { value?: string } };
        const page = JSON.parse(evaluated.result?.value || '{}') as Record<string, unknown>;
        return Response.json({ ok: true, session_id: browser.sessionId, target_id: target.id,
          live_view_url: target.devtoolsFrontendUrl || null, page: {
            title: bounded(page.title, 500), url: bounded(page.url, 4_000), text: bounded(page.text),
            price_evidence: Array.isArray(page.priceEvidence) ? page.priceEvidence.slice(0, 80) : [],
            structured: Array.isArray(page.structured) ? page.structured.slice(0, 20) : [],
            price_meta: Array.isArray(page.priceMeta) ? page.priceMeta.slice(0, 50) : [],
            links: Array.isArray(page.links) ? page.links.slice(0, 250) : [],
          } });
      } finally { cdp.disconnect(); }
    }
    if (url.pathname === '/sandbox/execute' && request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      const orgId = String(body.org_id || ''); const userId = String(body.user_id || '');
      const live = await decision(env, orgId, userId);
      if (modeRank(live.mode) < modeRank('browser') || live.mode !== body.mode || body.authority_granted !== true) {
        return Response.json({ error: 'feature_disabled_or_authority_required' }, { status: 403 });
      }
      const argv = Array.isArray(body.argv) ? body.argv.map(String) : [];
      const allowed = new Set(['python3', 'node', 'git', 'npm', 'npx', 'bash']);
      if (!argv.length || !allowed.has(argv[0]) || argv.length > 64 || argv.some((arg) => arg.length > 8_000)) {
        return Response.json({ error: 'invalid_sandbox_command' }, { status: 400 });
      }
      const opaqueId = `ha-${await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${orgId}:${body.work_order_id || ''}`))
        .then((digest) => Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join(''))}`;
      const sandbox = getSandbox(env.Sandbox, opaqueId);
      const process = await sandbox.exec(argv as [string, ...string[]], { timeout: 120_000 });
      const output = await process.output({ encoding: 'utf8' });
      return Response.json({ ok: output.exitCode === 0, process_id: process.id, exit_code: output.exitCode,
        timed_out: output.timedOut, truncated: output.truncated, stdout: bounded(output.stdout), stderr: bounded(output.stderr) });
    }
    const workflowControl = url.pathname.match(/^\/workflows\/([^/]+)\/control$/);
    if (workflowControl && request.method === 'POST') {
      const body = await request.json<{ action?: string }>().catch(() => ({})) as { action?: string };
      const action = String(body.action || '');
      if (!['pause', 'resume', 'terminate'].includes(action)) {
        return Response.json({ error: 'invalid_control_action' }, { status: 400 });
      }
      const instance = await env.ROOM_RUN_WORKFLOW.get(decodeURIComponent(workflowControl[1]));
      if (action === 'pause') await instance.pause();
      else if (action === 'resume') await instance.resume();
      else await instance.terminate();
      return Response.json({ ok: true, action });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
