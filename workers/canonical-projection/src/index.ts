import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { evaluateProjectionMode } from './flags';
import { signCoreRequest } from './security';
import {
  type ProjectionParams,
  type CoreStageName,
  coreStagePath,
  validParams,
  validUuid,
  workflowInstanceId,
} from './contract';

export { evaluateProjectionMode } from './flags';
export { signCoreRequest } from './security';
export { type ProjectionParams, coreStagePath, validParams, workflowInstanceId } from './contract';

type RuntimeEnv = Env & {
  CANONICAL_PROJECTION_ADMISSION_SECRET: string;
  CANONICAL_PROJECTION_HMAC_SECRET: string;
};

type CoreResult = {
  ok: boolean;
  receipt_id?: string;
  reused?: boolean;
  terminal?: boolean;
};

const MAX_ADMISSION_BYTES = 4096;

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
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return equalSecret(token, env.CANONICAL_PROJECTION_ADMISSION_SECRET || '');
}

async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > MAX_ADMISSION_BYTES) throw new Error('payload_too_large');
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ADMISSION_BYTES) throw new Error('payload_too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function core(env: RuntimeEnv, params: ProjectionParams, stage: CoreStageName): Promise<CoreResult> {
  const pathname = coreStagePath(params.memory_id, stage);
  const signed = await signCoreRequest(env.CANONICAL_PROJECTION_HMAC_SECRET, pathname, params);
  const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}${pathname}`, {
    method: 'POST', headers: signed.headers, body: signed.body,
  });
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.message || body.error || `core_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 409, 422].includes(response.status)) {
      throw new NonRetryableError(message);
    }
    throw new Error(message);
  }
  return body as CoreResult;
}

const STANDARD_RETRY = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class CanonicalProjectionWorkflow extends WorkflowEntrypoint<RuntimeEnv, ProjectionParams> {
  async run(event: WorkflowEvent<ProjectionParams>, step: WorkflowStep) {
    if (!validParams(event.payload)) throw new NonRetryableError('invalid_projection_payload');
    const params = event.payload;
    try {
      await step.do('load authorized memory', STANDARD_RETRY, () => core(this.env, params, 'load'));
      await step.do('reconstruct canonical extraction', STANDARD_RETRY, () => core(this.env, params, 'reconstruct'));
      await step.do('resolve canonical entities and roles', STANDARD_RETRY, () => core(this.env, params, 'resolve'));
      await step.do('normalize and verify claims', STANDARD_RETRY, () => core(this.env, params, 'normalize'));
      const persisted: CoreResult = await step.do('persist canonical projection', STANDARD_RETRY, () => core(this.env, params, 'persist'));
      await step.do('reconcile projection receipts', { ...STANDARD_RETRY, retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' } }, () => core(this.env, params, 'reconcile'));
      const completed: CoreResult = await step.do('mark projection complete', STANDARD_RETRY, () => core(this.env, params, 'complete'));
      console.log(JSON.stringify({ event: 'canonical_projection_completed', instance_id: event.instanceId, ...params, receipt_id: completed.receipt_id || persisted.receipt_id }));
      return { ok: true, instance_id: event.instanceId, receipt_id: completed.receipt_id || persisted.receipt_id, reused: completed.reused || persisted.reused };
    } catch (error) {
      await core(this.env, params, 'failed').catch((recordError) => {
        console.error(JSON.stringify({ event: 'canonical_projection_failure_record_failed', instance_id: event.instanceId, message: recordError instanceof Error ? recordError.message : String(recordError) }));
      });
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (!await authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      return Response.json({ mode: await evaluateProjectionMode(env, orgId, userId), org_id: orgId, user_id: userId });
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      let input: unknown;
      try { input = await boundedJson(request); } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'invalid_json' }, { status: error instanceof Error && error.message === 'payload_too_large' ? 413 : 400 });
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const admission = input as Record<string, unknown>;
      const orgId = String(admission.org_id || '');
      const userId = request.headers.get('x-hivemind-user-id') || '';
      if (!validUuid(orgId) || !validUuid(userId)) return Response.json({ error: 'invalid_identity' }, { status: 400 });
      const mode = await evaluateProjectionMode(env, orgId, userId);
      if (mode === 'off') return Response.json({ error: 'feature_disabled' }, { status: 403 });
      const params = { memory_id: admission.memory_id, org_id: admission.org_id, processing_version: admission.processing_version, required_projection: mode };
      if (!validParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      await env.PROJECTION_QUEUE.send(params, { contentType: 'json' });
      return Response.json({ ok: true, queued: true, instance_id: workflowInstanceId(params), required_projection: mode }, { status: 202 });
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      const memoryId = url.searchParams.get('memory_id') || '';
      const version = Number(url.searchParams.get('processing_version'));
      if (!validUuid(memoryId) || !Number.isInteger(version) || version < 1) return Response.json({ error: 'invalid_identity' }, { status: 400 });
      const id = `claim-${memoryId}-v${version}`;
      const instance = await env.PROJECTION_WORKFLOW.get(id);
      return Response.json({ instance_id: id, status: await instance.status() });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  async queue(batch: MessageBatch<ProjectionParams>, env: RuntimeEnv): Promise<void> {
    for (const message of batch.messages) {
      if (!validParams(message.body)) { message.ack(); continue; }
      const id = workflowInstanceId(message.body);
      try {
        await env.PROJECTION_WORKFLOW.create({
          id, params: message.body,
          retention: { successRetention: '30 days', errorRetention: '30 days' },
        });
      } catch {
        const existing = await env.PROJECTION_WORKFLOW.get(id);
        const status = await existing.status();
        if (status.status === 'errored' || status.status === 'terminated') await existing.restart();
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<RuntimeEnv, ProjectionParams>;
