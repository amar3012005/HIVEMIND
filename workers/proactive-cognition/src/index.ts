import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Schedule = { schedule_id: string; user_id: string; org_id: string; trigger_key: 'decision_reflection.v1'; due_at: string };
type EvaluationResponse = { status: string; evaluation_id?: string; delivery_id?: string; decision?: string; mode?: string };
type Env = {
  PROACTIVE_WORKFLOW: Workflow<Schedule>;
  PROACTIVE_QUEUE: Queue<Schedule>;
  FLAGS: Flagship;
  HIVEMIND_CONTROL_URL: string;
  HIVEMIND_PROACTIVE_COGNITION_SECRET: string;
  ENVIRONMENT: string;
  PROACTIVE_COGNITION_ENABLED: string;
  PROACTIVE_COGNITION_FLAG?: string;
  PROACTIVE_RECONCILE_LIMIT?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validSchedule = (value: unknown): value is Schedule => Boolean(value && typeof value === 'object'
  && UUID.test(String((value as Schedule).schedule_id || ''))
  && UUID.test(String((value as Schedule).user_id || ''))
  && UUID.test(String((value as Schedule).org_id || ''))
  && (value as Schedule).trigger_key === 'decision_reflection.v1'
  && Number.isFinite(Date.parse(String((value as Schedule).due_at || ''))));

function globallyEnabled(env: Env) { return env.PROACTIVE_COGNITION_ENABLED === 'true'; }
function instanceId(schedule: Schedule) { return `proactive-${schedule.schedule_id}-${Date.parse(schedule.due_at).toString(36)}`; }

async function modeFor(env: Env, schedule: Schedule): Promise<'off' | 'shadow' | 'deliver'> {
  if (!globallyEnabled(env) || !validSchedule(schedule) || !env.FLAGS) return 'off';
  try {
    const details = await env.FLAGS.getStringDetails(env.PROACTIVE_COGNITION_FLAG || 'proactive_cognition_v1', 'off', {
      targetingKey: `${schedule.org_id}:${schedule.user_id}`,
      org_id: schedule.org_id, user_id: schedule.user_id, environment: env.ENVIRONMENT,
    });
    const mode = details.value === 'deliver' || details.value === 'shadow' ? details.value : 'off';
    console.log(JSON.stringify({ event: 'proactive_cognition_flag', schedule_id: schedule.schedule_id, mode, variant: details.variant, reason: details.reason }));
    return mode;
  } catch (error) {
    console.error(JSON.stringify({ event: 'proactive_cognition_flag_error', schedule_id: schedule.schedule_id, message: error instanceof Error ? error.message : String(error) }));
    return 'off';
  }
}

async function control<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${env.HIVEMIND_CONTROL_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.HIVEMIND_PROACTIVE_COGNITION_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = String(payload.error || `control_http_${response.status}`);
    if (payload.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(error);
    throw new Error(error);
  }
  return payload as T;
}

async function enqueue(env: Env, schedule: Schedule) {
  if (await modeFor(env, schedule) === 'off') return false;
  await env.PROACTIVE_QUEUE.send(schedule, { contentType: 'json' });
  return true;
}

export class ProactiveCognitionWorkflow extends WorkflowEntrypoint<Env, Schedule> {
  async run(event: WorkflowEvent<Schedule>, step: WorkflowStep) {
    if (!validSchedule(event.payload)) throw new NonRetryableError('invalid_proactive_schedule');
    const mode = await modeFor(this.env, event.payload);
    if (mode === 'off') throw new NonRetryableError('proactive_cognition_disabled');
    return step.do('evaluate one bounded proactive reflection', {
      retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' }, timeout: '45 seconds',
    }, () => control<EvaluationResponse>(this.env, '/internal/proactive-cognition/evaluate', { schedule_id: event.payload.schedule_id, mode, workflow_instance_id: event.instanceId }));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = request.headers.get('authorization') || '';
    if (!env.HIVEMIND_PROACTIVE_COGNITION_SECRET || auth !== `Bearer ${env.HIVEMIND_PROACTIVE_COGNITION_SECRET}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (request.method === 'GET' && new URL(request.url).pathname === '/mode') return Response.json({ enabled: globallyEnabled(env), environment: env.ENVIRONMENT });
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      if (!globallyEnabled(env)) return;
      const limit = Math.max(1, Math.min(500, Number(env.PROACTIVE_RECONCILE_LIMIT) || 100));
      const result = await control<{ schedules?: Schedule[] }>(env, '/internal/proactive-cognition/eligible', { limit });
      let admitted = 0;
      for (const schedule of result.schedules || []) if (validSchedule(schedule) && await enqueue(env, schedule)) admitted += 1;
      console.log(JSON.stringify({ event: 'proactive_cognition_reconciled', candidates: result.schedules?.length || 0, admitted }));
    })());
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (!validSchedule(message.body)) { message.ack(); continue; }
      try {
        if (await modeFor(env, message.body) === 'off') { message.ack(); continue; }
        try {
          await env.PROACTIVE_WORKFLOW.create({ id: instanceId(message.body), params: message.body, retention: { successRetention: '30 days', errorRetention: '30 days' } });
        } catch {
          // Deterministic workflow ids make duplicate cron/queue admissions safe.
          const existing = await env.PROACTIVE_WORKFLOW.get(instanceId(message.body));
          await existing.status();
        }
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: 'proactive_cognition_queue_retry', schedule_id: message.body.schedule_id, message: error instanceof Error ? error.message : String(error) }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
