import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params = {
  org_id: string;
  hq_room_id: string;
  target_at: string;
};

/** Identifier-only contract shared by future lifecycle adapters. */
type LifecycleAdmission = Params & {
  lifecycle: 'day1_first_move';
  admitted_at: string;
  schema_version: 1;
};

type RoomCompleted = { turn_id: string; status: string };
type PrepareResult = { status: string; turn_id?: string; room_id?: string; task_id?: string; task_title?: string };
type DeliverResult = { ok: boolean; status: string; provider?: string; message_id?: string; room_id?: string; turn_id?: string };
type EligibleResult = { companies: Params[] };

type Env = {
  DAY1_WORKFLOW: Workflow<Params>;
  LIFECYCLE_ADMISSION: Queue<LifecycleAdmission>;
  FLAGS: Flagship;
  HIVEMIND_CONTROL_URL: string;
  HIVEMIND_D1_WORKFLOW_SECRET: string;
  HIVEMIND_D1_INSTANCE_PREFIX?: string;
  HIVEMIND_D1_RECONCILE_LIMIT?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY1_FLAG = 'day1_first_move_v1';
const DELIVERABLE_ROOM_STATUSES = new Set(['complete', 'blocked']);

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

function validAdmission(value: unknown): value is LifecycleAdmission {
  return Boolean(value && typeof value === 'object'
    && (value as Record<string, unknown>).lifecycle === 'day1_first_move'
    && (value as Record<string, unknown>).schema_version === 1
    && validParams(value));
}

function admissionDelaySeconds(targetAt: string): number {
  // Queues supports a maximum 24-hour delay. Longer future lifecycles simply
  // re-admit themselves at the next bounded horizon; no customer payload is
  // ever held in queue messages.
  return Math.max(0, Math.min(86_400, Math.floor((Date.parse(targetAt) - Date.now()) / 1000)));
}

function admissionFor(params: Params): LifecycleAdmission {
  return {
    lifecycle: 'day1_first_move',
    schema_version: 1,
    org_id: params.org_id,
    hq_room_id: params.hq_room_id,
    target_at: params.target_at,
    admitted_at: new Date().toISOString(),
  };
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

async function enqueueAdmission(env: Env, params: Params): Promise<LifecycleAdmission> {
  const admission = admissionFor(params);
  await env.LIFECYCLE_ADMISSION.send(admission, { delaySeconds: admissionDelaySeconds(params.target_at) });
  return admission;
}

async function ensureDayOneWorkflow(env: Env, params: Params): Promise<{ instance_id: string; created: boolean; restarted: boolean; status: unknown }> {
  const id = instanceId(env, params.hq_room_id);
  try {
    const instance = await env.DAY1_WORKFLOW.create({
      id,
      params,
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    });
    return { instance_id: instance.id, created: true, restarted: false, status: await instance.status() };
  } catch {
    const instance = await env.DAY1_WORKFLOW.get(id);
    const status = await instance.status();
    if (status.status === 'errored' || status.status === 'terminated') {
      await instance.restart();
      return { instance_id: instance.id, created: false, restarted: true, status: await instance.status() };
    }
    return { instance_id: instance.id, created: false, restarted: false, status };
  }
}

async function admitDayOne(env: Env, params: Params): Promise<{ action: 'deferred' | 'sent' | 'workflow'; instance_id?: string }> {
  if (!await dayOneEnabled(env, params.org_id)) throw new NonRetryableError('day1_feature_disabled');
  if (Date.parse(params.target_at) > Date.now()) {
    await enqueueAdmission(env, params);
    return { action: 'deferred' };
  }

  // The Queue is the global launch bulkhead. It claims/starts at bounded
  // consumer concurrency, while the Workflow owns long waits and delivery.
  // A previously errored Workflow therefore cannot strand a sealed report:
  // the control-plane receipt remains the source of truth and this call can
  // deliver it before attempting another Workflow restart.
  const id = instanceId(env, params.hq_room_id);
  const prepared = await control<PrepareResult>(env, '/internal/lifecycle/day1/prepare', {
    org_id: params.org_id,
    hq_room_id: params.hq_room_id,
    workflow_instance_id: id,
  });
  if (prepared.status === 'sent') return { action: 'sent', instance_id: id };
  if (prepared.status === 'completed') {
    await control<DeliverResult>(env, '/internal/lifecycle/day1/deliver', {
      org_id: params.org_id,
      hq_room_id: params.hq_room_id,
    });
    return { action: 'sent', instance_id: id };
  }
  const workflow = await ensureDayOneWorkflow(env, { ...params, target_at: new Date().toISOString() });
  return { action: 'workflow', instance_id: workflow.instance_id };
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
        if (!DELIVERABLE_ROOM_STATUSES.has(completed.payload.status)) throw new NonRetryableError('day1_room_failed');
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
      const admission = await enqueueAdmission(env, params);
      return Response.json({ ok: true, admitted: true, lifecycle: admission.lifecycle, instance_id: instanceId(env, params.hq_room_id), target_at: params.target_at }, { status: 202 });
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
      const startLimit = Math.max(1, Math.min(500, Number(env.HIVEMIND_D1_RECONCILE_LIMIT) || 100));
      let admitted = 0;
      const eligible = await control<EligibleResult>(env, '/internal/lifecycle/day1/eligible', { limit: startLimit });
      for (const params of eligible.companies || []) {
        if (admitted >= startLimit) break;
        if (!validParams(params)) continue;
        if (!await dayOneEnabled(env, params.org_id)) continue;
        await enqueueAdmission(env, params);
        admitted += 1;
      }
      console.log(JSON.stringify({ event: 'lifecycle_reconciliation_complete', lifecycle: 'day1_first_move', scanned: eligible.companies?.length || 0, admitted, start_limit: startLimit }));
    })());
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      if (!validAdmission(message.body)) {
        console.error(JSON.stringify({ event: 'lifecycle_admission_invalid' }));
        message.ack();
        continue;
      }
      try {
        const result = await admitDayOne(env, message.body);
        console.log(JSON.stringify({ event: 'lifecycle_admission_processed', lifecycle: message.body.lifecycle, action: result.action, instance_id: result.instance_id || null }));
        message.ack();
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'lifecycle_admission_failed';
        // Flag-off is intentional pause, not a poison message. Persisted state
        // and the next reconciliation remain the recovery authority.
        if (error instanceof NonRetryableError && messageText === 'day1_feature_disabled') {
          console.warn(JSON.stringify({ event: 'lifecycle_admission_paused', lifecycle: message.body.lifecycle }));
          message.ack();
          continue;
        }
        console.error(JSON.stringify({ event: 'lifecycle_admission_retry', lifecycle: message.body.lifecycle, error: messageText.slice(0, 160) }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
