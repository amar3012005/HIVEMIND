import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  type IngestParams,
  validOrgId,
  validParams,
  workflowInstanceId,
} from './contract';

export { type IngestParams, validParams, workflowInstanceId } from './contract';
const OBJECT_KEY = /^org\/[0-9a-f-]{36}\/sha256\/[a-f0-9]{64}\//i;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
type StageResult = {
  ok: boolean;
  stage?: string;
  receipt_id?: string;
  reused?: boolean;
  terminal?: boolean;
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const actual = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return equalSecret(actual, env.KNOWLEDGE_INGEST_WORKFLOW_SECRET || '');
}

async function flagEnabled(env: Env, orgId: string): Promise<boolean> {
  const environment = env.ENVIRONMENT === 'production' ? 'production' : env.ENVIRONMENT === 'local' ? 'local' : null;
  if (!environment || !validOrgId(orgId) || !env.FLAGS) return false;
  const details = await env.FLAGS.getBooleanDetails(
    env.KNOWLEDGE_INGEST_FLAG || 'knowledge_ingest_workflow_v1',
    false,
    { targetingKey: orgId, org_id: orgId, environment },
  );
  console.log(JSON.stringify({
    event: 'knowledge_ingest_flag_evaluation',
    org_id: orgId,
    value: details.value,
    variant: details.variant,
    reason: details.reason,
    error_code: details.errorCode,
  }));
  return details.value === true;
}

async function core<T>(
  env: Env,
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
        org_id: params.org_id,
        processing_version: params.processing_version,
        ...extra,
      }),
    },
  );
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.message || body.error || `core_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) {
      throw new NonRetryableError(message);
    }
    throw new Error(message);
  }
  return body as T;
}

export class KnowledgeIngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    if (!validParams(event.payload)) throw new NonRetryableError('invalid_ingest_payload');
    const params = event.payload;
    if (!await flagEnabled(this.env, params.org_id)) throw new NonRetryableError('knowledge_ingest_feature_disabled');
    try {
      await step.do(
        'acquire authorized ingest job',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        () => core<StageResult>(this.env, params, 'stages/acquire'),
      );
      const materialized = await step.do(
        'materialize canonical evidence and memories',
        { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' }, timeout: '30 minutes' },
        () => core<StageResult>(this.env, params, 'stages/materialize'),
      );
      await step.do(
        'reconcile coverage and settle',
        { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        () => core<StageResult>(this.env, params, 'stages/reconcile'),
      );
      console.log(JSON.stringify({
        event: 'knowledge_ingest_workflow_completed',
        instance_id: event.instanceId,
        ...params,
      }));
      return { ok: true, instance_id: event.instanceId, materialized };
    } catch (error) {
      await core(this.env, params, 'fail', {
        error_code: error instanceof NonRetryableError ? 'WORKFLOW_NON_RETRYABLE' : 'WORKFLOW_RETRIES_EXHAUSTED',
        message: error instanceof Error ? error.message : 'Workflow failed',
        retryable: false,
      }).catch((failure) => {
        console.error(JSON.stringify({
          event: 'knowledge_ingest_failure_record_failed',
          instance_id: event.instanceId,
          message: failure instanceof Error ? failure.message : String(failure),
        }));
      });
      throw error;
    }
  }
}

async function objectResponse(request: Request, env: Env, objectKey: string): Promise<Response> {
  if (!OBJECT_KEY.test(objectKey)) return Response.json({ error: 'invalid_object_key' }, { status: 400 });
  if (request.method === 'PUT') {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_SOURCE_BYTES) return Response.json({ error: 'payload_too_large' }, { status: 413 });
    if (!request.body) return Response.json({ error: 'body_required' }, { status: 400 });
    const stored = await env.ARTIFACTS.put(objectKey, request.body, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        sha256: request.headers.get('x-hivemind-sha256') || '',
        filename: request.headers.get('x-hivemind-filename') || '',
      },
    });
    return Response.json({ ok: true, key: objectKey, etag: stored.etag });
  }
  if (request.method === 'GET') {
    const object = await env.ARTIFACTS.get(objectKey);
    if (!object) return Response.json({ error: 'not_found' }, { status: 404 });
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType || 'application/octet-stream',
        etag: object.httpEtag,
        'x-hivemind-sha256': object.customMetadata?.sha256 || '',
      },
    });
  }
  if (request.method === 'HEAD') {
    const object = await env.ARTIFACTS.head(objectKey);
    if (!object) return new Response(null, { status: 404 });
    return new Response(null, { headers: { etag: object.httpEtag } });
  }
  if (request.method === 'DELETE') {
    await env.ARTIFACTS.delete(objectKey);
    return Response.json({ ok: true });
  }
  return Response.json({ error: 'method_not_allowed' }, { status: 405 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!await authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      return Response.json({ enabled: await flagEnabled(env, orgId), org_id: orgId });
    }
    if (url.pathname.startsWith('/objects/')) {
      return objectResponse(request, env, decodeURIComponent(url.pathname.slice('/objects/'.length)));
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const params = await request.json<unknown>().catch(() => null);
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      if (!await flagEnabled(env, params.org_id)) return Response.json({ error: 'feature_disabled' }, { status: 403 });
      const instanceId = workflowInstanceId(params);
      await env.INGEST_QUEUE.send(params, { contentType: 'json' });
      return Response.json({ ok: true, queued: true, instance_id: instanceId }, { status: 202 });
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      const instanceId = url.searchParams.get('instance_id');
      if (!instanceId) return Response.json({ error: 'instance_id_required' }, { status: 400 });
      const instance = await env.INGEST_WORKFLOW.get(instanceId);
      return Response.json({ instance_id: instance.id, status: await instance.status() });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<IngestParams>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (!validParams(message.body) || !await flagEnabled(env, message.body.org_id)) {
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
        const existing = await env.INGEST_WORKFLOW.get(id);
        const status = await existing.status();
        if (status.status === 'errored' || status.status === 'terminated') await existing.restart();
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, IngestParams>;
