import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  type IngestParams,
  materializationPollDecision,
  validAdmittedParams,
  validParams,
  workflowFailureDisposition,
  workflowInstanceId,
} from './contract';

export { type IngestParams, validParams, workflowInstanceId } from './contract';
type StageResult = {
  ok: boolean;
  stage?: string;
  receipt_id?: string;
  reused?: boolean;
  terminal?: boolean;
  status?: string;
  acquired?: boolean;
};
type MaterializationStatus = StageResult & {
  result?: { documentId?: string; segmentCount?: number; promotedCount?: number };
  retryable?: boolean;
  error_code?: string;
  message?: string;
};
type RuntimeEnv = Env & {
  KNOWLEDGE_INGEST_WORKFLOW_SECRET: string;
};

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authorized(request: Request, env: RuntimeEnv): Promise<boolean> {
  const actual = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return equalSecret(actual, env.KNOWLEDGE_INGEST_WORKFLOW_SECRET || '');
}

async function flagEnabled(env: RuntimeEnv, targetingKey: string): Promise<boolean> {
  const environment = ['production', 'local', 'enigma'].includes(env.ENVIRONMENT)
    ? env.ENVIRONMENT
    : null;
  if (!environment || !/^[a-f0-9]{64}$/i.test(targetingKey) || !env.FLAGS) return false;
  const details = await env.FLAGS.getBooleanDetails(
    env.KNOWLEDGE_INGEST_FLAG || 'knowledge_ingest_workflow_v1',
    false,
    { targetingKey, environment },
  );
  console.log(JSON.stringify({
    event: 'knowledge_ingest_flag_evaluation',
    value: details.value,
    variant: details.variant,
    reason: details.reason,
    error_code: details.errorCode,
  }));
  return details.value === true;
}

async function core<T>(
  env: RuntimeEnv,
  params: IngestParams,
  suffix: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(
    `${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/knowledge-ingest/v1/jobs/${params.job_id}/${suffix}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.KNOWLEDGE_INGEST_WORKFLOW_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        processing_version: params.processing_version,
        ...extra,
      }),
    },
  );
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.error || `core_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) {
      throw new NonRetryableError(message);
    }
    throw new Error(message);
  }
  return body as T;
}

export class KnowledgeIngestWorkflow extends WorkflowEntrypoint<RuntimeEnv, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    if (!validAdmittedParams(event.payload)) throw new NonRetryableError('invalid_or_unadmitted_ingest_payload');
    const params = event.payload;
    try {
      await step.do(
        'validate and acquire admission',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        async () => { await core<StageResult>(this.env, params, 'stages/acquire'); return { ok: true, status: 'acquired' }; },
      );
      await step.do(
        'dispatch canonical materialization',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        async () => { await core<StageResult>(this.env, params, 'stages/materialize/start'); return { ok: true, status: 'accepted' }; },
      );
      let materialized: MaterializationStatus['result'] | StageResult | null = null;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        await step.sleep(`wait for canonical materialization ${attempt + 1}`, '2 seconds');
        const status = await step.do(
          `verify canonical materialization ${attempt + 1}`,
          { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' },
          () => core<MaterializationStatus>(this.env, params, 'stages/materialize/status'),
        );
        const decision = materializationPollDecision(status);
        if (decision === 'complete') {
          materialized = { ok: true, status: 'succeeded' };
          break;
        }
        if (decision === 'fail') {
          throw new NonRetryableError(status.message || status.error_code || 'materialization_failed');
        }
        if (decision === 'redispatch') {
          await step.do(
            `redispatch failed canonical materialization ${attempt + 1}`,
            { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
            async () => { await core<StageResult>(this.env, params, 'stages/materialize/start'); return { ok: true, status: 'accepted' }; },
          );
        }
      }
      if (!materialized) throw new Error('canonical materialization did not reach a verified checkpoint before timeout');
      await step.do(
        'reconcile coverage and settle',
        { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        async () => { await core<StageResult>(this.env, params, 'stages/reconcile'); return { ok: true, status: 'complete' }; },
      );
      console.log(JSON.stringify({
        event: 'knowledge_ingest_workflow_completed',
        instance_id: event.instanceId,
        job_id: params.job_id,
        processing_version: params.processing_version,
      }));
      return { ok: true, instance_id: event.instanceId, status: 'complete' };
    } catch (error) {
      const failurePlan = workflowFailureDisposition(error instanceof NonRetryableError);
      await core(this.env, params, 'fail', {
        error_code: failurePlan.errorCode,
        retryable: failurePlan.retryable,
      }).catch((failure) => {
        console.error(JSON.stringify({
          event: 'knowledge_ingest_failure_record_failed',
          instance_id: event.instanceId,
          error_code: 'FAILURE_RECORD_UNAVAILABLE',
        }));
      });
      if (failurePlan.enqueueRecovery) {
        // A Workflow/DO lifecycle interruption must not release the job's credit
        // reservation or processing lease. Redelivery restarts the deterministic
        // instance and all completed Core receipts are reused.
        await this.env.INGEST_QUEUE.send(params, { contentType: 'json', delaySeconds: 30 }).catch((failure) => {
          console.error(JSON.stringify({
            event: 'knowledge_ingest_recovery_enqueue_failed',
            instance_id: event.instanceId,
            error_code: 'RECOVERY_ENQUEUE_UNAVAILABLE',
          }));
        });
      }
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (!await authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/enabled' && request.method === 'GET') {
      const targetingKey = url.searchParams.get('targeting_key') || '';
      return Response.json({ enabled: await flagEnabled(env, targetingKey) });
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validAdmittedParams(params)) return Response.json({ error: 'invalid_or_unadmitted_payload' }, { status: 400 });
      const instanceId = workflowInstanceId(params);
      await env.INGEST_QUEUE.send(params, { contentType: 'json' });
      return Response.json({ ok: true, queued: true, instance_id: instanceId }, { status: 202 });
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      const instanceId = url.searchParams.get('instance_id');
      if (!instanceId) return Response.json({ error: 'instance_id_required' }, { status: 400 });
      try {
        const instance = await env.INGEST_WORKFLOW.get(instanceId);
        const current = await instance.status();
        return Response.json({ instance_id: instance.id, status: current.status });
      } catch {
        return Response.json({ error: 'workflow_status_unavailable' }, { status: 503 });
      }
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<IngestParams>, env: RuntimeEnv): Promise<void> {
    for (const message of batch.messages) {
      if (!validAdmittedParams(message.body)) {
        message.ack();
        continue;
      }
      const id = workflowInstanceId(message.body);
      try {
        await env.INGEST_WORKFLOW.create({
          id,
          params: message.body,
          retention: { successRetention: '30 days', errorRetention: '30 days' },
        });
      } catch {
        try {
          const existing = await env.INGEST_WORKFLOW.get(id);
          const status = await existing.status();
          if (status.status === 'errored' || status.status === 'terminated') await existing.restart();
        } catch {
          message.retry({ delaySeconds: 30 });
          continue;
        }
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<RuntimeEnv, IngestParams>;
