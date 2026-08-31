import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { audioObjectKey, type AudioMessage, type EmailMessage, type MeetingParams, validAudioMessage, validEmailMessage, validMeetingParams, validUuid, workflowId } from './contract';

type RuntimeEnv = Env & {
  MEETING_LIFECYCLE_SECRET: string;
  AUDIO_QUEUE: Queue<AudioMessage>;
  EMAIL_QUEUE: Queue<EmailMessage>;
};
const MODES = new Set(['off', 'shadow', 'consent', 'workflow', 'full']);
const MAX_AUDIO = 24 * 1024 * 1024;

async function equalSecret(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const enc = new TextEncoder(); const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(actual)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function authorized(request: Request, env: RuntimeEnv) {
  return equalSecret((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), env.MEETING_LIFECYCLE_SECRET || '');
}
async function modeFor(env: RuntimeEnv, orgId: string, userId: string) {
  const environment = env.ENVIRONMENT === 'production' ? 'production' : env.ENVIRONMENT === 'local' ? 'local' : null;
  if (!environment || !validUuid(orgId) || !validUuid(userId) || !env.FLAGS) return 'off';
  try {
    const detail = await env.FLAGS.getStringDetails(env.MEETING_LIFECYCLE_FLAG || 'meeting_lifecycle_v2', 'off', {
      targetingKey: `${orgId}:${userId}`, org_id: orgId, user_id: userId, environment,
    });
    return MODES.has(String(detail.value)) ? String(detail.value) : 'off';
  } catch { return 'off'; }
}
async function core(env: RuntimeEnv, params: MeetingParams, stage: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/meeting-lifecycle/v2/stage`, {
    method: 'POST', headers: { authorization: `Bearer ${env.MEETING_LIFECYCLE_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...params, stage, ...extra }),
  });
  const body: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
  if (!response.ok) {
    const message = String(body.error || `core_http_${response.status}`);
    if (body.retryable === false || [400, 401, 403, 404, 422].includes(response.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }
  return body;
}

export class MeetingFinalizationWorkflow extends WorkflowEntrypoint<RuntimeEnv, MeetingParams> {
  async run(event: WorkflowEvent<MeetingParams>, step: WorkflowStep) {
    if (!validMeetingParams(event.payload)) throw new NonRetryableError('invalid_meeting_payload');
    // The admission-time flag decision is part of the immutable Workflow payload.
    // Re-evaluating Flagship here could switch an in-flight meeting between paths.
    const p = event.payload; const mode = p.mode;
    await step.do('verify authorization and segment receipts', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } }, () => core(this.env, p, 'verify'));
    await step.do('assemble and finalize meeting', { retries: { limit: 8, delay: '20 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, () => core(this.env, p, 'finalize'));
    if (mode === 'full') await step.do('publish authorized canonical knowledge', { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, () => core(this.env, p, 'publish'));
    const reconciled = await step.do('reconcile successful finalization', { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' } }, () => core(this.env, p, 'reconcile_delete')) as { delete_keys?: string[] };
    const deleted = await step.do('delete successful raw audio', { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' } }, async () => {
      const keys = Array.isArray(reconciled.delete_keys) ? reconciled.delete_keys.slice(0, 500) : [];
      for (const key of keys) await this.env.AUDIO.delete(key);
      return { deleted_keys: keys };
    });
    await step.do('persist audio deletion receipts', { retries: { limit: 8, delay: '30 seconds', backoff: 'exponential' } }, () => core(this.env, p, 'confirm_delete', deleted));
    return { ok: true, instance_id: event.instanceId, mode };
  }
}

async function sha256Hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (!await authorized(request, env)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === '/mode' && request.method === 'GET') {
      return Response.json({ mode: await modeFor(env, url.searchParams.get('org_id') || '', url.searchParams.get('user_id') || '') });
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const input = await request.json<MeetingParams>().catch(() => null);
      if (!validMeetingParams(input)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      const id = workflowId(input); await env.MEETING_WORKFLOW.create({ id, params: input });
      return Response.json({ ok: true, instance_id: id }, { status: 202 });
    }
    if (url.pathname === '/email' && request.method === 'POST') {
      const input = await request.json<EmailMessage>().catch(() => null);
      if (!validEmailMessage(input)) return Response.json({ error: 'invalid_payload' }, { status: 400 });
      await env.EMAIL_QUEUE.send(input);
      return Response.json({ ok: true, accepted: true }, { status: 202 });
    }
    const match = /^\/audio\/([0-9a-f-]{36})\/(\d+)$/.exec(url.pathname);
    if (match && request.method === 'PUT') {
      const orgId = request.headers.get('x-hivemind-org-id') || ''; const sessionId = match[1]; const index = Number(match[2]);
      if (!validUuid(orgId) || !request.body) return Response.json({ error: 'invalid_audio_request' }, { status: 400 });
      const bytes = await request.arrayBuffer(); if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO) return Response.json({ error: 'invalid_audio_size' }, { status: 413 });
      const actual = await sha256Hex(bytes); const declared = request.headers.get('x-hivemind-sha256') || '';
      if (actual !== declared) return Response.json({ error: 'checksum_mismatch' }, { status: 422 });
      const key = audioObjectKey(orgId, sessionId, index, actual);
      const existing = await env.AUDIO.head(key); if (!existing) await env.AUDIO.put(key, bytes, { httpMetadata: { contentType: request.headers.get('content-type') || 'audio/webm' } });
      await env.AUDIO_QUEUE.send({ kind: 'audio', session_id: sessionId, org_id: orgId, segment_index: index, pipeline_version: 2 });
      return Response.json({ ok: true, object_key: key, etag: existing?.etag || actual, receipt_id: `${sessionId}:${index}:${actual.slice(0, 12)}` }, { status: 202 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
  async queue(batch: MessageBatch<AudioMessage | EmailMessage>, env: RuntimeEnv) {
    for (const message of batch.messages) {
      if (validEmailMessage(message.body)) {
        try {
          const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/meeting-lifecycle/v2/email`, {
            method: 'POST', headers: { authorization: `Bearer ${env.MEETING_LIFECYCLE_SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(message.body),
          });
          if (!response.ok) throw new Error(`core_http_${response.status}`);
          message.ack();
        } catch { message.retry({ delaySeconds: 30 }); }
        continue;
      }
      if (!validAudioMessage(message.body)) { message.ack(); continue; }
      try {
        const prefix = `org/${message.body.org_id}/meeting/${message.body.session_id}/segment/${message.body.segment_index}/`;
        const listed = await env.AUDIO.list({ prefix, limit: 2 });
        if (listed.objects.length !== 1) throw new Error(listed.objects.length ? 'conflicting_audio_objects' : 'audio_object_not_visible');
        const object = await env.AUDIO.get(listed.objects[0].key); if (!object?.body) throw new Error('audio_object_missing');
        const response = await fetch(`${env.HIVEMIND_CORE_URL.replace(/\/$/, '')}/internal/meeting-lifecycle/v2/audio/${message.body.session_id}/${message.body.segment_index}`, {
          method: 'POST', headers: {
            authorization: `Bearer ${env.MEETING_LIFECYCLE_SECRET}`,
            'content-type': object.httpMetadata?.contentType || 'audio/webm',
            'x-hivemind-org-id': message.body.org_id,
            'x-hivemind-object-key': listed.objects[0].key,
          }, body: object.body,
        });
        const failure: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
        if (!response.ok) {
          if (failure.retryable === false || [400, 401, 403, 404, 413, 415, 422].includes(response.status)) {
            console.error(JSON.stringify({ event: 'meeting_audio_terminal_failure', session_id: message.body.session_id, segment_index: message.body.segment_index, error: String(failure.error || `core_http_${response.status}`) }));
            message.ack();
            continue;
          }
          throw new Error(String(failure.error || `core_http_${response.status}`));
        }
        message.ack();
      }
      catch { message.retry({ delaySeconds: 30 }); }
    }
  },
};
