import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params = {
  org_id: string;
  hq_room_id: string;
  target_at: string;
};

type RoomCompleted = { turn_id: string; status: string };
type PrepareResult = { status: string; turn_id?: string; room_id?: string; task_id?: string; task_title?: string };
type DeliverResult = { ok: boolean; status: string; provider?: string; message_id?: string; room_id?: string; turn_id?: string };
type EligibleResult = { companies: Params[] };

type Env = {
  DAY1_WORKFLOW: Workflow<Params>;
  FLAGS: Flagship;
  HIVEMIND_CONTROL_URL: string;
  HIVEMIND_D1_WORKFLOW_SECRET: string;
  HIVEMIND_D1_INSTANCE_PREFIX?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY1_FLAG = 'day1_first_move_v1';

function instanceId(env: Env, hqRoomId: string): string {
  const prefix = String(env.HIVEMIND_D1_INSTANCE_PREFIX || 'd1').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'd1';
  return `${prefix}-${hqRoomId}`;
}

async function dayOneEnabled(env: Env, orgId: string): Promise<boolean> {
  if (!UUID.test(orgId) || !env.FLAGS) return false;
  const details = await env.FLAGS.getBooleanDetails(DAY1_FLAG, false, {
    targetingKey: orgId,
    org_id: orgId,
  });
  console.log(JSON.stringify({ event: 'day1_flag_evaluation', org_id: orgId, value: details.value, variant: details.variant, reason: details.reason, error_code: details.errorCode }));
  return details.value === true;
}

function authorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') || '';
  return Boolean(env.HIVEMIND_D1_WORKFLOW_SECRET) && auth === `Bearer ${env.HIVEMIND_D1_WORKFLOW_SECRET}`;
}

function validParams(value: unknown): value is Params {
  if (!value || typeof value !== 'object') return false;
  const params = value as Record<string, unknown>;
  return UUID.test(String(params.org_id || ''))
    && UUID.test(String(params.hq_room_id || ''))
    && Number.isFinite(Date.parse(String(params.target_at || '')));
}

async function control<T>(env: Env, pathname: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${env.HIVEMIND_CONTROL_URL.replace(/\/$/, '')}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.HIVEMIND_D1_WORKFLOW_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    const message = String(payload.error || `control_http_${response.status}`);
    if (payload.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }
  return payload as T;
}

export class DayOneWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    if (!validParams(event.payload)) throw new NonRetryableError('invalid_day1_payload');
    const params = event.payload;
    if (!await dayOneEnabled(this.env, params.org_id)) throw new NonRetryableError('day1_feature_disabled');
    const target = Date.parse(params.target_at);
    if (target > Date.now()) await step.sleepUntil('wait until Day 1', target);
    // A rollout can be paused while an instance is sleeping. Re-evaluate at
    // the irreversible execution boundary instead of trusting the value from
    // instance creation time.
    if (!await dayOneEnabled(this.env, params.org_id)) throw new NonRetryableError('day1_feature_disabled');

    const prepared = await step.do(
      'claim and start the research room',
      { retries: { limit: 8, delay: '15 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      () => control<PrepareResult>(this.env, '/internal/lifecycle/day1/prepare', {
        org_id: params.org_id,
        hq_room_id: params.hq_room_id,
        workflow_instance_id: event.instanceId,
      }),
    );
    if (prepared.status === 'sent') return prepared;

    // The room's canonical seal event wakes this instance. Events sent before
    // this line are buffered by Workflows. The timeout is also a recovery net:
    // delivery below re-reads the persisted turn and refuses unsealed output.
    if (prepared.status !== 'completed') {
      try {
        const completed = await step.waitForEvent<RoomCompleted>('wait for the sealed room output', {
          type: 'room-completed',
          timeout: '7 days',
        });
        if (completed.payload.status !== 'complete') throw new NonRetryableError('day1_room_failed');
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        console.warn('Day-1 room event timed out; reconciling from persisted turn state');
      }
    }

    if (!await dayOneEnabled(this.env, params.org_id)) throw new NonRetryableError('day1_feature_disabled');
    return step.do(
      'render and send the Day 1 report',
      { retries: { limit: 24, delay: '2 minutes', backoff: 'constant' }, timeout: '2 minutes' },
      () => control<DeliverResult>(this.env, '/internal/lifecycle/day1/deliver', {
        org_id: params.org_id,
        hq_room_id: params.hq_room_id,
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start') {
      const params = await request.json<Params>().catch(() => null);
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      if (!await dayOneEnabled(env, params.org_id)) return Response.json({ error: 'feature_disabled' }, { status: 403 });
      const id = instanceId(env, params.hq_room_id);
      try {
        const instance = await env.DAY1_WORKFLOW.create({
          id,
          params,
          retention: { successRetention: '30 days', errorRetention: '30 days' },
        });
        return Response.json({ ok: true, created: true, instance_id: instance.id, status: await instance.status() }, { status: 202 });
      } catch {
        const instance = await env.DAY1_WORKFLOW.get(id);
        const status = await instance.status();
        if (status.status === 'errored' || status.status === 'terminated') {
          await instance.restart();
          return Response.json({ ok: true, created: false, restarted: true, instance_id: instance.id, status: await instance.status() }, { status: 202 });
        }
        return Response.json({ ok: true, created: false, restarted: false, instance_id: instance.id, status });
      }
    }
    if (request.method === 'POST' && url.pathname === '/event') {
      const body = await request.json<{ instance_id?: string; org_id?: string; turn_id?: string; status?: string }>().catch(() => ({} as { instance_id?: string; org_id?: string; turn_id?: string; status?: string }));
      if (!body.instance_id || !UUID.test(String(body.org_id || '')) || !UUID.test(String(body.turn_id || ''))) return Response.json({ error: 'invalid_event' }, { status: 400 });
      if (!await dayOneEnabled(env, body.org_id!)) return Response.json({ error: 'feature_disabled' }, { status: 403 });
      const instance = await env.DAY1_WORKFLOW.get(body.instance_id);
      await instance.sendEvent({ type: 'room-completed', payload: { turn_id: body.turn_id, status: body.status || 'complete' } });
      return Response.json({ ok: true, instance_id: instance.id, status: await instance.status() });
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      const id = url.searchParams.get('instance_id');
      if (!id) return Response.json({ error: 'instance_id_required' }, { status: 400 });
      const instance = await env.DAY1_WORKFLOW.get(id);
      return Response.json({ instance_id: instance.id, status: await instance.status() });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const eligible = await control<EligibleResult>(env, '/internal/lifecycle/day1/eligible', { limit: 100 });
      for (const params of eligible.companies || []) {
        if (!validParams(params)) continue;
        if (!await dayOneEnabled(env, params.org_id)) continue;
        const id = instanceId(env, params.hq_room_id);
        try {
          await env.DAY1_WORKFLOW.create({ id, params, retention: { successRetention: '30 days', errorRetention: '30 days' } });
        } catch {
          // Deterministic instance IDs make the 15-minute reconciliation safe:
          // an existing scheduled/running instance is the desired outcome.
          await env.DAY1_WORKFLOW.get(id);
        }
      }
    })());
  },
} satisfies ExportedHandler<Env>;
