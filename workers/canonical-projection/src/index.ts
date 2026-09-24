import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { evaluateEntityDiscoveryCanary, evaluateEntityProfileMode, evaluateGovernedRoomCanary, evaluateHyperPlannerMode, evaluateProjectionMode, evaluateRecallReliability, evaluateRecallQualityMode } from './flags';
import { signCoreRequest } from './security';
import {
  type ProjectionParams,
  type EntityProfileParams,
  type CoreStageName,
  coreStagePath,
  validParams,
  validEntityProfileParams,
  validUuid,
  workflowInstanceId,
  entityProfileWorkflowInstanceId,
} from './contract';
import { admitQueuedProjection } from './queue-admission';

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

async function loadLinkedEntityIds(env: RuntimeEnv, params: ProjectionParams): Promise<string[]> {
  const pathname = `/internal/entity-profile-projection/v1/memories/${params.memory_id}/entities`;
  const signed = await signCoreRequest(env.CANONICAL_PROJECTION_HMAC_SECRET, pathname, params);
  const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}${pathname}`, { method: 'POST', headers: signed.headers, body: signed.body });
  if (!response.ok) throw new Error(`linked_entities_http_${response.status}`);
  const body: any = await response.json().catch(() => ({}));
  return Array.isArray(body.entity_ids) ? body.entity_ids.filter((id: unknown) => typeof id === 'string' && validUuid(id)) : [];
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
      // Entity links are deliberately materialized outside the write lock. Give
      // the bounded linker a small window, then use Core's signed completion
      // receipt as the sole source for post-canonical dossier admission.
      await step.sleep('allow canonical entity links to settle', '5 seconds');
      const completed: CoreResult = await step.do('mark projection complete', STANDARD_RETRY, () => core(this.env, params, 'complete'));
      const projection = (persisted as any)?.receipt?.projection || (persisted as any)?.projection || {};
      const claims = Array.isArray(projection.claims) ? projection.claims : [];
      const linkedEntityIds = Array.isArray(projection.entity_ids) ? projection.entity_ids : [];
      const completedEntityIds = Array.isArray((completed as any)?.receipt?.entity_ids) ? (completed as any).receipt.entity_ids : [];
      let settledEntityIds = completedEntityIds;
      // The linker is intentionally detached from the memory write. Poll the
      // signed, tenant-checked Core view a bounded number of times rather than
      // turning an entity-free memory into a failed canonical workflow.
      for (let attempt = 1; attempt <= 3 && settledEntityIds.length === 0; attempt += 1) {
        settledEntityIds = await step.do(`read settled canonical entity links ${attempt}`, STANDARD_RETRY, () => loadLinkedEntityIds(this.env, params));
        if (settledEntityIds.length === 0 && attempt < 3) await step.sleep(`wait for canonical entity links ${attempt}`, '5 seconds');
      }
      const entityIds = [...new Set([
        ...linkedEntityIds,
        ...completedEntityIds,
        ...settledEntityIds,
        ...claims.flatMap((claim: any) => [claim?.subjectEntityId, claim?.objectEntityId]),
      ].filter((id: unknown) => typeof id === 'string' && validUuid(id)))];
      // New admissions preserve the actor identity. This makes the entity-profile
      // Flagship rule exact to the organization/user that admitted the memory.
      // Pre-release queued messages have no actor and remain safely off.
      const profileMode = await evaluateEntityProfileMode(this.env, params.org_id, params.user_id || '');
      if (profileMode !== 'off') {
        await step.do('queue entity profile projections', STANDARD_RETRY, async () => {
          for (const entityId of entityIds) {
            await this.env.ENTITY_PROFILE_QUEUE.send({ entity_id: entityId, org_id: params.org_id, source_watermark: `memory-${params.memory_id}-v${params.processing_version}`, required_projection: profileMode }, { contentType: 'json' });
          }
        });
      }
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

export class EntityProfileWorkflow extends WorkflowEntrypoint<RuntimeEnv, EntityProfileParams> {
  async run(event: WorkflowEvent<EntityProfileParams>, step: WorkflowStep) {
    if (!validEntityProfileParams(event.payload)) throw new NonRetryableError('invalid_entity_profile_payload');
    const params = event.payload;
    const pathname = `/internal/entity-profile-projection/v1/entities/${params.entity_id}/project`;
    const execute = async () => {
      const signed = await signCoreRequest(this.env.CANONICAL_PROJECTION_HMAC_SECRET, pathname, params);
      const response = await fetch(`${this.env.HIVEMIND_CORE_URL.replace(/\/$/, '')}${pathname}`, { method: 'POST', headers: signed.headers, body: signed.body });
      if (!response.ok) {
        const body: any = await response.json().catch(() => ({}));
        const message = String(body?.error || `core_http_${response.status}`);
        if ([400, 401, 403, 404, 409, 422].includes(response.status)) throw new NonRetryableError(message);
        throw new Error(message);
      }
      return response.json<any>();
    };
    return step.do('project evidence-backed entity dossier', STANDARD_RETRY, execute);
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
    if (url.pathname === '/entity-profile-enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      return Response.json({ mode: await evaluateEntityProfileMode(env, orgId, userId), org_id: orgId, user_id: userId });
    }
    if (url.pathname === '/entity-profile-start' && request.method === 'POST') {
      let input: unknown;
      try { input = await boundedJson(request); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      const admission = input as Record<string, unknown>;
      const orgId = String(admission?.org_id || '');
      const userId = request.headers.get('x-hivemind-user-id') || '';
      const mode = await evaluateEntityProfileMode(env, orgId, userId);
      const params = { entity_id: admission?.entity_id, org_id: orgId, source_watermark: admission?.source_watermark, required_projection: mode };
      if (mode === 'off') return Response.json({ error: 'feature_disabled' }, { status: 403 });
      if (!validEntityProfileParams(params)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      await env.ENTITY_PROFILE_QUEUE.send(params, { contentType: 'json' });
      return Response.json({ ok: true, queued: true, instance_id: entityProfileWorkflowInstanceId(params) }, { status: 202 });
    }
    if (url.pathname === '/recall-enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      return Response.json({ enabled: await evaluateRecallReliability(env, orgId, userId), org_id: orgId, user_id: userId });
    }
    if (url.pathname === '/recall-quality-mode' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      return Response.json({ mode: await evaluateRecallQualityMode(env, orgId, userId) });
    }
    if (url.pathname === '/hyper-planner-mode' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      return Response.json({ mode: await evaluateHyperPlannerMode(env, orgId, userId) });
    }
    if (url.pathname === '/governed-room-enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      const email = url.searchParams.get('email') || '';
      return Response.json({ enabled: await evaluateGovernedRoomCanary(env, orgId, userId, email) });
    }
    if (url.pathname === '/entity-discovery-enabled' && request.method === 'GET') {
      const orgId = url.searchParams.get('org_id') || '';
      const userId = url.searchParams.get('user_id') || '';
      const email = url.searchParams.get('email') || '';
      return Response.json({ enabled: await evaluateEntityDiscoveryCanary(env, orgId, userId, email) });
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
      const params = { memory_id: admission.memory_id, org_id: admission.org_id, user_id: userId, processing_version: admission.processing_version, required_projection: mode };
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

  async queue(batch: MessageBatch<ProjectionParams | EntityProfileParams>, env: RuntimeEnv): Promise<void> {
    for (const message of batch.messages) {
      if (validEntityProfileParams(message.body)) {
        try { await env.ENTITY_PROFILE_WORKFLOW.create({ id: entityProfileWorkflowInstanceId(message.body), params: message.body }); }
        catch { message.retry(); continue; }
        message.ack();
        continue;
      }
      if (!validParams(message.body)) { message.ack(); continue; }
      try {
        await admitQueuedProjection(env.PROJECTION_WORKFLOW, message.body);
      } catch {
        message.retry();
        continue;
      }
      message.ack();
    }
  },
} satisfies ExportedHandler<RuntimeEnv, ProjectionParams | EntityProfileParams>;
