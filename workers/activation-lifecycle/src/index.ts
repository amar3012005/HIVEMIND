import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type Params = { activation_id: string; generation: number; sequence: number; target_at: string };
type Env = { ACTIVATION_WORKFLOW: Workflow<Params>; ACTIVATION_ADMISSION: Queue<Params>; FLAGS: Flagship; HIVEMIND_CONTROL_URL: string; HIVEMIND_ACTIVATION_WORKFLOW_SECRET: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enabled(env: Env, activationId: string) {
  return env.FLAGS.getBooleanDetails('activation_lifecycle_v1', false, { targetingKey: activationId, activation_id: activationId }).then((result) => result.value === true);
}
function valid(value: unknown): value is Params {
  const input = value as Partial<Params> | null;
  return Boolean(input && UUID.test(String(input.activation_id || '')) && Number.isInteger(input.generation) && Number.isInteger(input.sequence) && Number(input.sequence) >= 0 && Number.isFinite(Date.parse(String(input.target_at || ''))));
}
function authorized(request: Request, env: Env) { return request.headers.get('authorization') === `Bearer ${env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET}`; }
function id(params: Params) { return `activation-${params.activation_id}-${params.generation}-${params.sequence}`; }
async function control<T>(env: Env, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${env.HIVEMIND_CONTROL_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.HIVEMIND_ACTIVATION_WORKFLOW_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    const message = String(payload.error || `control_http_${response.status}`);
    if (payload.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }
  return payload as T;
}
async function start(env: Env, params: Params) {
  if (!await enabled(env, params.activation_id)) throw new NonRetryableError('activation_feature_disabled');
  if (Date.parse(params.target_at) > Date.now()) { await env.ACTIVATION_ADMISSION.send(params, { delaySeconds: Math.min(86_400, Math.max(0, Math.floor((Date.parse(params.target_at) - Date.now()) / 1000))) }); return; }
  try { await env.ACTIVATION_WORKFLOW.create({ id: id(params), params, retention: { successRetention: '30 days', errorRetention: '30 days' } }); }
  catch { const instance = await env.ACTIVATION_WORKFLOW.get(id(params)); const state = await instance.status(); if (state.status === 'errored' || state.status === 'terminated') await instance.restart(); }
}

export class ActivationLifecycleWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    if (!valid(event.payload)) throw new NonRetryableError('invalid_activation_payload');
    if (!await enabled(this.env, event.payload.activation_id)) throw new NonRetryableError('activation_feature_disabled');
    if (Date.parse(event.payload.target_at) > Date.now()) await step.sleepUntil('wait until activation reminder', Date.parse(event.payload.target_at));
    const evaluation = await step.do('revalidate canonical activation state', { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' } }, () => control<{ status: string }>(this.env, '/internal/lifecycle/activation/evaluate', event.payload));
    if (evaluation.status !== 'due') return evaluation;
    return step.do('deliver typed activation reminder', { retries: { limit: 8, delay: '2 minutes', backoff: 'exponential' } }, () => control<{ status: string }>(this.env, '/internal/lifecycle/activation/deliver', event.payload));
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (!authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/start') return Response.json({ error: 'Not found' }, { status: 404 });
    const params = await request.json<Params>().catch(() => null);
    if (!valid(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
    await start(env, params);
    return Response.json({ ok: true, instance_id: id(params) }, { status: 202 });
  },
  async queue(batch: MessageBatch<Params>, env: Env) {
    for (const message of batch.messages) {
      if (!valid(message.body)) { message.ack(); continue; }
      try { await start(env, message.body); message.ack(); }
      catch (error) { if (error instanceof NonRetryableError) message.ack(); else message.retry({ delaySeconds: 60 }); }
    }
  },
};
