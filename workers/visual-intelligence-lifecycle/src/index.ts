import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { STAGES, type Trigger, validBrandDna, validTrigger, instanceId } from './contract';

type Env = { VISUAL_WORKFLOW: Workflow<Trigger>; VISUAL_TRIGGER_QUEUE: Queue<Trigger>; VISUAL_ARTIFACTS: R2Bucket; FLAGS: Flagship; HIVEMIND_VISUAL_API_URL: string; HIVEMIND_VISUAL_WORKFLOW_SECRET: string; HIVEMIND_VISUAL_INSTANCE_PREFIX?: string };
type Receipt = { run_id: string; status?: string; artifact?: unknown; [key: string]: unknown };
const enabled = async (env: Env, trigger: Trigger) => {
  try { return (await env.FLAGS.getBooleanDetails('visual_intelligence_workflow_v1', false, { targetingKey: trigger.user_id, org_id: trigger.org_id })).value === true; }
  catch { return false; }
};
const auth = (request: Request, env: Env) => request.headers.get('authorization') === `Bearer ${env.HIVEMIND_VISUAL_WORKFLOW_SECRET}`;
async function api(env: Env, path: string, body: unknown): Promise<any> {
  const response = await fetch(`${env.HIVEMIND_VISUAL_API_URL.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${env.HIVEMIND_VISUAL_WORKFLOW_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Receipt & { error?: string; retryable?: boolean };
  if (!response.ok) { if ([400, 401, 403, 404, 409, 422].includes(response.status) || payload.retryable === false) throw new NonRetryableError(payload.error || `visual_api_${response.status}`); throw new Error(payload.error || `visual_api_${response.status}`); }
  return payload;
}
export class VisualIntelligenceWorkflow extends WorkflowEntrypoint<Env, Trigger> {
  async run(event: WorkflowEvent<Trigger>, step: WorkflowStep) {
    const trigger = event.payload;
    if (!validTrigger(trigger) || !await enabled(this.env, trigger)) throw new NonRetryableError('visual_feature_disabled_or_invalid_trigger');
    let receipt: Receipt | undefined;
    let stage = 'admit';
    try {
      for (stage of STAGES) {
        receipt = await step.do(stage, { retries: { limit: 6, delay: '15 seconds', backoff: 'exponential' }, timeout: '15 minutes' }, () => api(this.env, stage === 'admit' ? '/internal/visual-intelligence/admit' : '/internal/visual-intelligence/stage', stage === 'admit' ? { ...trigger, workflow_instance_id: event.instanceId } : { run_id: receipt?.run_id, stage, processing_version: trigger.processing_version })) as Receipt;
        if (stage === 'publish' && !validBrandDna(receipt.artifact)) throw new NonRetryableError('invalid_brand_dna_artifact');
        if (receipt.status === 'failed' || receipt.status === 'cancelled') throw new NonRetryableError(`visual_run_${receipt.status}`);
      }
      return receipt;
    } catch (error) {
      if (receipt?.run_id) await step.do('record-failure', { retries: { limit: 3, delay: '20 seconds' } }, () => api(this.env, '/internal/visual-intelligence/fail', { run_id: receipt!.run_id, failed_stage: stage, failure_code: error instanceof Error ? error.message : 'workflow_failure' }));
      throw error;
    }
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (!auth(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/start') { const trigger = await request.json().catch(() => null); if (!validTrigger(trigger)) return Response.json({ error: 'invalid_trigger' }, { status: 400 }); await env.VISUAL_TRIGGER_QUEUE.send(trigger); return Response.json({ ok: true, queued: true, job_id: trigger.job_id }, { status: 202 }); }
    if (request.method === 'GET' && url.pathname === '/status') { const id = url.searchParams.get('instance_id'); if (!id) return Response.json({ error: 'instance_id_required' }, { status: 400 }); const instance = await env.VISUAL_WORKFLOW.get(id); return Response.json({ instance_id: id, status: await instance.status() }); }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
  async queue(batch: MessageBatch<Trigger>, env: Env) { for (const message of batch.messages) { try { if (!validTrigger(message.body) || !await enabled(env, message.body)) throw new NonRetryableError('visual_feature_disabled_or_invalid_trigger'); const id = instanceId(message.body); try { await env.VISUAL_WORKFLOW.create({ id, params: message.body, retention: { successRetention: '30 days', errorRetention: '30 days' } }); } catch { const instance = await env.VISUAL_WORKFLOW.get(id); const state = await instance.status(); if (state.status === 'errored' || state.status === 'terminated') await instance.restart(); } message.ack(); } catch (error) { if (error instanceof NonRetryableError) message.ack(); else message.retry(); } } },
} satisfies ExportedHandler<Env, Trigger>;
