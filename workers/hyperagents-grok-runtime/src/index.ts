import { Agent, getAgentByName, routeAgentRequest } from 'agents';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { modeRank, normalizeMode, type RuntimeMode, type TurnParams, validParams, workflowId } from './contract';

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
  ROOM_RUN_WORKFLOW: Workflow<TurnParams>;
}

type AgentManifest = {
  employee_id: string; agent_instance_id: string; slug: string; name: string;
  lane: string; tools: string[]; connectors: string[]; processing_version: number;
};
type AgentState = {
  manifest: AgentManifest | null;
  status: 'idle' | 'active' | 'working' | 'waiting' | 'complete' | 'blocked';
  assignments: string[];
  updated_at: number;
};

export class HiredHyperAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { manifest: null, status: 'idle', assignments: [], updated_at: 0 };

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
      this.setState({ ...this.state, manifest, updated_at: Date.now() });
      return Response.json({ ok: true, agent_instance_id: manifest.agent_instance_id });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;
    if (!await authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/decision' && request.method === 'GET') {
      return Response.json(await decision(env, url.searchParams.get('org_id') || '', url.searchParams.get('user_id') || ''));
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
    if (url.pathname === '/provision' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const live = await decision(env, params.org_id, params.user_id);
      if (live.mode !== params.mode || modeRank(live.mode) < modeRank('persistent_agents')) {
        return Response.json({ error: 'feature_disabled_or_mismatch' }, { status: 403 });
      }
      return Response.json({ ok: true, ...(await provisionRoster(env, params)) });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
