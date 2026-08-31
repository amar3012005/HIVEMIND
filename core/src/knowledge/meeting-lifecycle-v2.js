import crypto from 'node:crypto';
import { cloudflareGatewayConfig } from '../llm/cloudflare-gateway.js';
import { sendSystemEmail } from '../email/email-service.js';

export const MEETING_LIFECYCLE_MODES = new Set(['off', 'shadow', 'consent', 'workflow', 'full']);
export const MEETING_PURPOSES = new Set(['record_audio', 'transcribe_and_summarize', 'share_with_selected_scope', 'promote_to_hivemind_memory']);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const safeJson = (value, fallback) => value && typeof value === 'object' ? value : fallback;
const validUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const constantEqual = (left, right) => {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const invitationCipherKey = () => {
  const secret = String(process.env.MEETING_INVITATION_ENCRYPTION_KEY || '');
  if (secret.length < 32) throw Object.assign(new Error('meeting invitation encryption key unavailable'), { code: 'MEETING_INVITATION_KEY_REQUIRED' });
  return crypto.createHash('sha256').update(secret).digest();
};
const encryptDeliverySecret = (value) => {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', invitationCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
};
const decryptDeliverySecret = (value) => {
  const [iv, tag, encrypted] = String(value || '').split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', invitationCipherKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
};

export function meetingV2MasterEnabled() {
  return process.env.MEETING_LIFECYCLE_V2_ENABLED === 'true'
    && process.env.MEETING_AI_GATEWAY_REQUIRED === 'true'
    && cloudflareGatewayConfig().enabled;
}

function workerConfig() {
  const baseUrl = String(process.env.CLOUDFLARE_MEETING_LIFECYCLE_URL || '').replace(/\/$/, '');
  const secret = String(process.env.CLOUDFLARE_MEETING_LIFECYCLE_SECRET || '');
  return meetingV2MasterEnabled() && baseUrl && secret ? { baseUrl, secret } : null;
}

export class CloudflareMeetingLifecycleClient {
  constructor({ fetchImpl = fetch, logger = console } = {}) { this.fetchImpl = fetchImpl; this.logger = logger; }

  async modeFor({ orgId, userId }) {
    const config = workerConfig();
    if (!config || !orgId || !userId) return 'off';
    try {
      const response = await this.fetchImpl(`${config.baseUrl}/mode?org_id=${encodeURIComponent(orgId)}&user_id=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${config.secret}` }, signal: AbortSignal.timeout(3000),
      });
      const value = response.ok ? (await response.json())?.mode : 'off';
      return MEETING_LIFECYCLE_MODES.has(value) ? value : 'off';
    } catch (error) {
      this.logger.warn?.(`[meeting-v2] Flagship evaluation failed closed: ${error.message}`);
      return 'off';
    }
  }

  async request(path, init = {}, timeoutMs = 30_000) {
    const config = workerConfig();
    if (!config) throw Object.assign(new Error('meeting lifecycle worker unavailable'), { code: 'MEETING_V2_DISABLED' });
    return this.fetchImpl(`${config.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.secret}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async startWorkflow(payload) {
    const response = await this.request('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'meeting workflow start failed'), { code: 'MEETING_WORKFLOW_START_FAILED' });
    return body;
  }

  async putAudio({ sessionId, orgId, index, checksum, contentType, bytes }) {
    const response = await this.request(`/audio/${encodeURIComponent(sessionId)}/${index}`, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'x-hivemind-org-id': orgId, 'x-hivemind-sha256': checksum },
      body: bytes,
    }, 180_000);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'meeting audio persistence failed'), { code: 'MEETING_AUDIO_STORE_FAILED' });
    return body;
  }

  async enqueueEmail({ outboxId, sessionId, orgId }) {
    const response = await this.request('/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'email', outbox_id: outboxId, session_id: sessionId, org_id: orgId, pipeline_version: 2 }) });
    if (!response.ok) throw new Error('meeting email queue unavailable');
    return response.json().catch(() => ({ ok: true }));
  }
}

export function assertMeetingGatewayReady() {
  if (!meetingV2MasterEnabled()) throw Object.assign(new Error('Meeting v2 requires the private AI Gateway.'), { code: 'MEETING_GATEWAY_REQUIRED' });
  return cloudflareGatewayConfig();
}

function requiredPolicyFields(body) {
  const missing = [];
  for (const field of ['controller_name', 'privacy_contact', 'country_code', 'recording_jurisdiction', 'national_recording_rule']) {
    if (!String(body?.[field] || '').trim()) missing.push(field);
  }
  const basis = safeJson(body?.lawful_basis, {});
  const purposes = Array.isArray(body?.purposes) ? body.purposes.filter((p) => MEETING_PURPOSES.has(p)) : [];
  if (!Object.keys(basis).length) missing.push('lawful_basis');
  if (!purposes.includes('record_audio') || !purposes.includes('transcribe_and_summarize')) missing.push('purposes');
  if (purposes.some((purpose) => !String(basis[purpose] || '').trim())) missing.push('lawful_basis_per_purpose');
  if (body?.special_category_processing === true && !String(body?.special_category_condition || '').trim()) missing.push('special_category_condition');
  if (body?.status === 'active' && body?.dpia_status !== 'approved') missing.push('dpia_status');
  if (body?.status === 'active' && !String(body?.notice_body || '').trim()) missing.push('notice_body');
  return { missing, basis, purposes };
}

async function activePolicy(prisma, orgId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.*, n.id AS notice_version_id, n.version AS notice_version, n.title AS notice_title, n.body AS notice_body
       FROM hivemind.meeting_recording_policies p
       JOIN LATERAL (SELECT * FROM hivemind.meeting_notice_versions n WHERE n.policy_id=p.id AND n.approved_at IS NOT NULL ORDER BY n.version DESC LIMIT 1) n ON true
      WHERE p.org_id=$1::uuid AND p.status='active' AND p.effective_at<=now() AND p.superseded_at IS NULL LIMIT 1`, orgId,
  ).catch(() => []);
  return rows?.[0] || null;
}

export async function getMeetingPolicy(prisma, orgId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.*, n.id AS notice_version_id, n.version AS notice_version, n.title AS notice_title, n.body AS notice_body
       FROM hivemind.meeting_recording_policies p
       LEFT JOIN LATERAL (SELECT * FROM hivemind.meeting_notice_versions n WHERE n.policy_id=p.id ORDER BY n.version DESC LIMIT 1) n ON true
      WHERE p.org_id=$1::uuid ORDER BY p.version DESC LIMIT 1`, orgId,
  ).catch(() => []);
  return rows?.[0] || null;
}

export async function putMeetingPolicy(prisma, { orgId, userId, body }) {
  const { missing, basis, purposes } = requiredPolicyFields(body);
  if (missing.length) return { status: 422, body: { error: 'policy_incomplete', missing } };
  const requestedStatus = body.status === 'active' ? 'active' : 'draft';
  const digest = sha256(`${body.notice_title || ''}\n${body.notice_body || ''}`);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, `meeting-policy:${orgId}`);
    const versions = await tx.$queryRawUnsafe(`SELECT COALESCE(MAX(version),0)::int AS version FROM hivemind.meeting_recording_policies WHERE org_id=$1::uuid`, orgId);
    const version = Number(versions?.[0]?.version || 0) + 1;
    if (requestedStatus === 'active') await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_recording_policies SET status='superseded',superseded_at=now(),updated_at=now() WHERE org_id=$1::uuid AND status='active'`, orgId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hivemind.meeting_recording_policies
       (org_id,version,status,controller_name,privacy_contact,country_code,recording_jurisdiction,lawful_basis,purposes,
        special_category_condition,national_recording_rule,internal_consent_mode,external_consent_mode,processors,retention,
        dpia_status,dpia_reference,dpia_approved_by,dpia_approved_at,approved_by,approved_at,effective_at,created_by)
       VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,
              CASE WHEN $16='approved' THEN $18::uuid END,CASE WHEN $16='approved' THEN now() END,
              CASE WHEN $3='active' THEN $18::uuid END,CASE WHEN $3='active' THEN now() END,
              CASE WHEN $3='active' THEN now() END,$18::uuid)
       RETURNING *`, orgId, version, requestedStatus, String(body.controller_name).trim(), String(body.privacy_contact).trim(),
      String(body.country_code).trim().toUpperCase(), String(body.recording_jurisdiction).trim(), JSON.stringify(basis), JSON.stringify(purposes),
      body.special_category_condition || null, String(body.national_recording_rule).trim(), body.internal_consent_mode || 'participant_authorization',
      body.external_consent_mode || 'strict_participant_authorization', JSON.stringify(Array.isArray(body.processors) ? body.processors : []),
      JSON.stringify(safeJson(body.retention, { audio_failure_days: 7 })), body.dpia_status || 'required', body.dpia_reference || null, userId,
    );
    const policy = rows[0];
    const notices = await tx.$queryRawUnsafe(
      `INSERT INTO hivemind.meeting_notice_versions(policy_id,version,locale,title,body,content_digest,approved_by,approved_at)
       VALUES($1::uuid,1,$2,$3,$4,$5,CASE WHEN $6='active' THEN $7::uuid END,CASE WHEN $6='active' THEN now() END) RETURNING *`,
      policy.id, body.notice_locale || 'en', String(body.notice_title || 'Meeting recording and AI processing notice'), String(body.notice_body || ''), digest, requestedStatus, userId,
    );
    return { ...policy, notice: notices[0] };
  });
  return { status: requestedStatus === 'active' ? 201 : 200, body: { policy: result } };
}

function normalizedParticipants(body) {
  const source = Array.isArray(body?.participants) ? body.participants : [];
  const seen = new Set();
  return source.map((item) => typeof item === 'string' ? { email: item } : item).map((item) => ({
    user_id: validUuid(item?.user_id) ? item.user_id : null,
    email: normalizeEmail(item?.email), display_name: String(item?.display_name || item?.name || '').trim().slice(0, 160),
    kind: item?.user_id ? 'member' : 'external', required: item?.required !== false,
  })).filter((item) => {
    const key = item.user_id || item.email;
    if (!key || seen.has(key) || (!item.user_id && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email))) return false;
    seen.add(key); return true;
  }).slice(0, 100);
}

export async function createV2MeetingSession(prisma, client, { orgId, userId, body }) {
  const mode = await client.modeFor({ orgId, userId });
  if (mode === 'off') return { handled: false, mode };
  if (mode === 'shadow') {
    console.info('[meeting-v2-shadow]', JSON.stringify({ org_id_hash: sha256(orgId).slice(0, 16), user_id_hash: sha256(userId).slice(0, 16), policy_evaluated: true }));
    return { handled: false, mode };
  }
  assertMeetingGatewayReady();
  const policy = await activePolicy(prisma, orgId);
  if (!policy) return { handled: true, status: 409, body: { error: 'active_meeting_policy_required', mode } };
  const participants = normalizedParticipants(body);
  if (!participants.length) return { handled: true, status: 422, body: { error: 'participants_required' } };
  const sessionId = validUuid(body?.session_id) ? body.session_id : crypto.randomUUID();
  const requestedPurposes = (Array.isArray(body?.purposes) ? body.purposes : policy.purposes).filter((p) => MEETING_PURPOSES.has(p));
  if (!requestedPurposes.includes('record_audio') || !requestedPurposes.includes('transcribe_and_summarize')) {
    return { handled: true, status: 422, body: { error: 'required_purposes_missing' } };
  }
  const retentionDays = Math.min(7, Math.max(0, Number(policy.retention?.audio_failure_days ?? 7)));
  const gateway = assertMeetingGatewayReady();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO hivemind.meeting_sessions
       (id,org_id,user_id,status,consent_recorded,expected_segment_ms,orchestration_mode,pipeline_version,latched_flags,
        recording_policy_id,recording_policy_version,authorization_status,purposes,storage_placement,gateway_route,stt_model,
        insights_model,embedding_model,current_stage,progress,recovery_status,publication_allowed,audio_retention_deadline)
       VALUES($1::uuid,$2::uuid,$3::uuid,'awaiting_authorization',false,$4,$5,2,$6::jsonb,$7::uuid,$8,'pending',$9::jsonb,$10,$11,$12,$13,$14,
              'authorization',0,'ready',false,now()+($15::int*interval '1 day'))`, sessionId, orgId, userId,
      Math.min(1_800_000, Math.max(60_000, Number(body?.expected_segment_ms) || 600_000)), `workflow_v2:${mode}`,
      JSON.stringify({ meeting_lifecycle_v2: mode, evaluated_at: new Date().toISOString() }), policy.id, policy.version,
      JSON.stringify(requestedPurposes), body?.storage_placement || 'managed_eu_r2', gateway.gatewayId,
      process.env.MEETING_STT_MODEL || process.env.STT_MODEL || null, process.env.MEETING_INSIGHTS_MODEL || null,
      process.env.CLOUDFLARE_BGE_M3_MODEL || '@cf/baai/bge-m3', retentionDays,
    );
    for (const participant of participants) {
      const pRows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.meeting_participants(session_id,org_id,user_id,normalized_email,display_name,participant_kind,required)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) RETURNING *`, sessionId, orgId, participant.user_id, participant.email || null,
        participant.display_name || null, participant.kind, participant.required,
      );
      const p = pRows[0];
      if (p.normalized_email) {
        const secret = randomSecret(); const salt = randomSecret(16); const tokenHash = sha256(`${salt}:${secret}`);
        const reqRows = await tx.$queryRawUnsafe(
          `INSERT INTO hivemind.meeting_consent_requests(session_id,participant_id,org_id,token_hash,token_salt,delivery_secret_ciphertext,notice_version_id,requested_purposes,expires_at)
           VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::jsonb,now()+interval '72 hours') RETURNING id`,
          sessionId, p.id, orgId, tokenHash, salt, encryptDeliverySecret(secret), policy.notice_version_id, JSON.stringify(requestedPurposes),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload)
           VALUES($1::uuid,$2::uuid,'meeting.authorization.invitation',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
          sessionId, orgId, `meeting:${sessionId}:participant:${p.id}:invitation:v1`, JSON.stringify({ request_id: reqRows[0].id, participant_id: p.id }),
        );
      }
    }
  });
  void enqueueMeetingOutbox(prisma, client, { sessionId, orgId }).catch((error) => console.warn('[meeting-v2] invitation Queue handoff failed:', error.message));
  return { handled: true, status: 201, body: {
    session_id: sessionId, status: 'awaiting_authorization', orchestration_mode: `workflow_v2:${mode}`, pipeline_version: 2,
    policy_version: policy.version, authorization_status: 'pending', required_authorizations: participants.filter((p) => p.required).length,
    accepted_authorizations: 0, declined_authorizations: 0, stage: 'authorization', progress: 0,
    audio_retention_deadline: new Date(Date.now() + retentionDays * 86400000).toISOString(),
  } };
}

export async function enqueueMeetingOutbox(prisma, client, { sessionId, orgId }) {
  const rows = await prisma.$queryRawUnsafe(`SELECT id FROM hivemind.meeting_outbox WHERE session_id=$1::uuid AND org_id=$2::uuid AND status IN ('pending','error') ORDER BY created_at LIMIT 100`, sessionId, orgId);
  for (const row of rows || []) await client.enqueueEmail({ outboxId: row.id, sessionId, orgId });
  return { queued: rows?.length || 0 };
}

export async function enqueuePendingMeetingOutbox(prisma, client, { limit = 25 } = {}) {
  const rows = await prisma.$queryRawUnsafe(`SELECT id,session_id,org_id FROM hivemind.meeting_outbox WHERE status IN ('pending','error') AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_expires_at IS NULL OR lease_expires_at<now()) ORDER BY created_at LIMIT $1`, Math.min(100, Math.max(1, Number(limit) || 25)));
  let queued = 0;
  for (const row of rows || []) {
    try { await client.enqueueEmail({ outboxId: row.id, sessionId: row.session_id, orgId: row.org_id }); queued += 1; }
    catch { /* persistent row remains eligible for the next repair tick */ }
  }
  return { queued };
}

export async function dispatchMeetingOutbox(prisma, { sessionId = null, outboxId = null, orgId = null, limit = 25 } = {}) {
  const leaseId = crypto.randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `WITH candidates AS (
       SELECT id FROM hivemind.meeting_outbox
        WHERE status IN ('pending','error') AND (next_attempt_at IS NULL OR next_attempt_at<=now())
          AND (lease_expires_at IS NULL OR lease_expires_at<now()) AND ($1::uuid IS NULL OR session_id=$1::uuid)
          AND ($2::uuid IS NULL OR id=$2::uuid) AND ($3::uuid IS NULL OR org_id=$3::uuid)
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $4
     ) UPDATE hivemind.meeting_outbox o SET status='processing',attempts=attempts+1,lease_expires_at=now()+interval '2 minutes',updated_at=now()
       FROM candidates c WHERE o.id=c.id RETURNING o.*`, sessionId, outboxId, orgId, Math.min(100, Math.max(1, Number(limit) || 25)),
  );
  if (outboxId && !(rows || []).length) {
    const existing = await prisma.$queryRawUnsafe(`SELECT status FROM hivemind.meeting_outbox WHERE id=$1::uuid AND ($2::uuid IS NULL OR org_id=$2::uuid)`, outboxId, orgId);
    if (existing?.[0]?.status === 'completed') return { lease_id: leaseId, results: [{ id: outboxId, ok: true, reused: true }] };
  }
  const results = [];
  for (const item of rows || []) {
    try {
      let templateId; let to; let vars;
      if (item.event_type === 'meeting.authorization.invitation') {
        const details = await prisma.$queryRawUnsafe(
          `SELECT r.id,r.delivery_secret_ciphertext,p.normalized_email,pol.controller_name,pol.privacy_contact
             FROM hivemind.meeting_consent_requests r JOIN hivemind.meeting_participants p ON p.id=r.participant_id
             JOIN hivemind.meeting_notice_versions n ON n.id=r.notice_version_id JOIN hivemind.meeting_recording_policies pol ON pol.id=n.policy_id
            WHERE r.id=$1::uuid AND r.state='pending' AND r.expires_at>now()`, item.payload?.request_id,
        );
        const detail = details?.[0]; if (!detail) throw new Error('invitation_request_unavailable');
        const secret = decryptDeliverySecret(detail.delivery_secret_ciphertext);
        const link = `${String(process.env.HIVEMIND_PUBLIC_URL || 'https://next.singulancelabs.com').replace(/\/$/, '')}/hivemind/meeting-consent#token=${encodeURIComponent(`${detail.id}.${secret}`)}`;
        templateId = 'meeting_authorization_invitation'; to = detail.normalized_email;
        vars = { link, controllerName: detail.controller_name, privacyContact: detail.privacy_contact, expires: '72 hours' };
      } else if (item.event_type === 'meeting.authorization.otp') {
        const details = await prisma.$queryRawUnsafe(
          `SELECT p.normalized_email,pol.controller_name
             FROM hivemind.meeting_consent_requests r JOIN hivemind.meeting_participants p ON p.id=r.participant_id
             JOIN hivemind.meeting_notice_versions n ON n.id=r.notice_version_id JOIN hivemind.meeting_recording_policies pol ON pol.id=n.policy_id
            WHERE r.id=$1::uuid AND r.state='pending' AND r.otp_expires_at>now()`, item.payload?.request_id,
        );
        if (!details?.[0]?.normalized_email || !item.payload?.otp_ciphertext) throw new Error('otp_request_unavailable');
        templateId = 'meeting_authorization_otp'; to = details[0].normalized_email;
        vars = { code: decryptDeliverySecret(item.payload.otp_ciphertext), controllerName: details[0].controller_name, expires: '10 minutes' };
      } else if (item.event_type === 'meeting.authorization.confirmation') {
        const details = await prisma.$queryRawUnsafe(`SELECT normalized_email FROM hivemind.meeting_participants WHERE id=$1::uuid AND org_id=$2::uuid`, item.payload?.participant_id, item.org_id);
        if (!details?.[0]?.normalized_email) throw new Error('participant_email_unavailable');
        templateId = 'meeting_authorization_confirmation'; to = details[0].normalized_email; vars = { decision: item.payload?.decision || 'recorded' };
      } else if (['meeting.authorization.declined', 'meeting.authorization.withdrawn', 'meeting.ready_to_record'].includes(item.event_type)) {
        const session = await prisma.$queryRawUnsafe(`SELECT user_id FROM hivemind.meeting_sessions WHERE id=$1::uuid AND org_id=$2::uuid`, item.session_id, item.org_id);
        const owner = session?.[0]?.user_id ? await prisma.user.findUnique({ where: { id: session[0].user_id }, select: { email: true } }).catch(() => null) : null;
        if (!owner?.email) throw new Error('organizer_email_unavailable');
        templateId = item.event_type === 'meeting.ready_to_record' ? 'meeting_ready_to_record'
          : item.event_type === 'meeting.authorization.withdrawn' ? 'meeting_authorization_withdrawn' : 'meeting_declined_organizer';
        to = owner.email; vars = { sessionId: item.session_id };
      } else throw new Error('unsupported_meeting_outbox_event');
      const receipt = await sendSystemEmail({ templateId, to, vars,
        notification: { orgId: item.org_id, type: item.event_type, dedupeKey: item.dedupe_key } });
      if (!receipt?.ok) throw new Error(receipt?.error || 'email_provider_rejected');
      await prisma.$executeRawUnsafe(`UPDATE hivemind.meeting_outbox SET status='completed',provider_receipt=$1::jsonb,payload=payload-'otp_ciphertext',completed_at=now(),lease_expires_at=NULL,last_error=NULL,updated_at=now() WHERE id=$2::uuid`, JSON.stringify({ ok: receipt?.ok !== false, provider: receipt?.provider || null, message_id: receipt?.messageId || receipt?.message_id || null }), item.id);
      results.push({ id: item.id, ok: true });
    } catch (error) {
      await prisma.$executeRawUnsafe(`UPDATE hivemind.meeting_outbox SET status='error',next_attempt_at=now()+(LEAST(3600,POWER(2,LEAST(attempts,10)))::int*interval '1 second'),lease_expires_at=NULL,last_error=$1,updated_at=now() WHERE id=$2::uuid`, String(error.message || error).slice(0, 500), item.id);
      results.push({ id: item.id, ok: false });
    }
  }
  return { lease_id: leaseId, results };
}

export async function claimMeetingPipelineStep(prisma, { sessionId, orgId, pipelineVersion, stageKey, shardKey = '0' }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.meeting_pipeline_steps(session_id,org_id,pipeline_version,stage_key,shard_key)
     VALUES($1::uuid,$2::uuid,$3,$4,$5) ON CONFLICT(session_id,pipeline_version,stage_key,shard_key) DO NOTHING`,
    sessionId, orgId, pipelineVersion, stageKey, shardKey,
  );
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.meeting_pipeline_steps SET status='processing',attempt=attempt+1,lease_expires_at=now()+interval '10 minutes',structured_error=NULL,updated_at=now()
      WHERE session_id=$1::uuid AND org_id=$2::uuid AND pipeline_version=$3 AND stage_key=$4 AND shard_key=$5
        AND (status IN ('pending','error') OR (status='processing' AND lease_expires_at<now()))
      RETURNING id,attempt`, sessionId, orgId, pipelineVersion, stageKey, shardKey,
  );
  if (rows?.[0]) return { claimed: true, id: rows[0].id, attempt: rows[0].attempt };
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id,status,output_receipt,lease_expires_at FROM hivemind.meeting_pipeline_steps
      WHERE session_id=$1::uuid AND org_id=$2::uuid AND pipeline_version=$3 AND stage_key=$4 AND shard_key=$5`,
    sessionId, orgId, pipelineVersion, stageKey, shardKey,
  );
  return { claimed: false, ...(existing?.[0] || {}) };
}

export async function settleMeetingPipelineStep(prisma, { id, status, receipt = null, error = null }) {
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.meeting_pipeline_steps SET status=$1,output_receipt=$2::jsonb,structured_error=$3::jsonb,lease_expires_at=NULL,
       completed_at=CASE WHEN $1='completed' THEN now() ELSE completed_at END,updated_at=now() WHERE id=$4::uuid`,
    status, receipt == null ? null : JSON.stringify(receipt), error == null ? null : JSON.stringify(error), id,
  );
}

async function authorizationState(prisma, orgId, sessionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id,s.user_id,s.status,s.orchestration_mode,s.recording_policy_id,s.recording_policy_version,s.purposes,s.processing_restricted,s.authorization_status,
            COUNT(*) FILTER(WHERE p.required)::int required_count,
            COUNT(*) FILTER(WHERE p.required AND p.status='accepted')::int accepted_count,
            COUNT(*) FILTER(WHERE p.required AND p.status='declined')::int declined_count,
            COUNT(*) FILTER(WHERE p.required AND p.status='withdrawn')::int withdrawn_count,
            COUNT(*) FILTER(WHERE p.required AND p.status='accepted' AND EXISTS(
              SELECT 1 FROM hivemind.meeting_consent_receipts cr WHERE cr.session_id=s.id AND cr.participant_id=p.id
                AND cr.decision='accepted' AND cr.withdrawn_at IS NULL AND cr.purposes ? 'promote_to_hivemind_memory'
            ))::int memory_authorized_count
       FROM hivemind.meeting_sessions s JOIN hivemind.meeting_participants p ON p.session_id=s.id AND p.org_id=s.org_id
      WHERE s.id=$1::uuid AND s.org_id=$2::uuid GROUP BY s.id`, sessionId, orgId,
  ).catch(() => []);
  return rows?.[0] || null;
}

export async function refreshAuthorizationSnapshot(prisma, orgId, sessionId) {
  const state = await authorizationState(prisma, orgId, sessionId);
  if (!state) return null;
  const participants = await prisma.$queryRawUnsafe(
    `SELECT id,status,required FROM hivemind.meeting_participants WHERE session_id=$1::uuid AND org_id=$2::uuid ORDER BY id`, sessionId, orgId,
  );
  const digest = sha256(JSON.stringify(participants));
  const ready = !state.processing_restricted && state.required_count > 0 && state.accepted_count === state.required_count && state.declined_count === 0 && state.withdrawn_count === 0;
  const status = ready ? 'ready_to_record' : (state.declined_count || state.withdrawn_count ? 'blocked' : 'pending');
  const publicationAllowed = String(state.orchestration_mode || '').endsWith(':full')
    && state.required_count > 0 && state.memory_authorized_count === state.required_count;
  const snapshots = await prisma.$queryRawUnsafe(
    `INSERT INTO hivemind.meeting_authorization_snapshots(session_id,org_id,policy_id,policy_version,purposes,required_count,accepted_count,declined_count,participant_digest,status)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8,$9,$10)
     ON CONFLICT(session_id,participant_digest) DO UPDATE SET status=EXCLUDED.status RETURNING id`, sessionId, orgId, state.recording_policy_id,
    state.recording_policy_version, JSON.stringify(state.purposes), state.required_count, state.accepted_count, state.declined_count, digest, status,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.meeting_sessions SET authorization_status=$1,authorization_snapshot_id=$2::uuid,
      status=CASE WHEN $1='ready_to_record' AND status='awaiting_authorization' THEN 'ready_to_record' WHEN $1='blocked' AND status='recording' THEN 'paused' ELSE status END,
      consent_recorded=($1='ready_to_record'),publication_allowed=$5,updated_at=now() WHERE id=$3::uuid AND org_id=$4::uuid`, status, snapshots[0].id, sessionId, orgId, publicationAllowed,
  );
  return { ...state, authorization_status: status, authorization_snapshot_id: snapshots[0].id };
}

async function appendConsentEvent(prisma, { sessionId, participantId, orgId, eventType, eventData = {} }) {
  const prior = await prisma.$queryRawUnsafe(`SELECT event_digest FROM hivemind.meeting_consent_events WHERE session_id=$1::uuid AND participant_id=$2::uuid ORDER BY occurred_at DESC,id DESC LIMIT 1`, sessionId, participantId);
  const previous = prior?.[0]?.event_digest || null;
  const occurredAt = new Date().toISOString();
  const digest = sha256(JSON.stringify({ sessionId, participantId, orgId, eventType, eventData, previous, occurredAt }));
  await prisma.$executeRawUnsafe(
    `INSERT INTO hivemind.meeting_consent_events(session_id,participant_id,org_id,event_type,event_data,previous_digest,event_digest,occurred_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7,$8::timestamptz)`, sessionId, participantId, orgId, eventType, JSON.stringify(eventData), previous, digest, occurredAt,
  );
  return digest;
}

export async function exchangeMeetingInvitation(prisma, token) {
  const [requestId, secret] = String(token || '').split('.', 2);
  if (!validUuid(requestId) || !secret) return { status: 404, body: { error: 'invitation_not_found' } };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT r.*,p.normalized_email,p.display_name,n.title AS notice_title,n.body AS notice_body,
            pol.controller_name,pol.privacy_contact,pol.recording_jurisdiction,pol.lawful_basis,pol.processors,pol.retention
       FROM hivemind.meeting_consent_requests r JOIN hivemind.meeting_participants p ON p.id=r.participant_id
       JOIN hivemind.meeting_notice_versions n ON n.id=r.notice_version_id
       JOIN hivemind.meeting_recording_policies pol ON pol.id=n.policy_id
      WHERE r.id=$1::uuid AND r.expires_at>now() AND r.state='pending'`, requestId,
  ).catch(() => []);
  const row = rows?.[0];
  if (!row || !constantEqual(row.token_hash, sha256(`${row.token_salt}:${secret}`))) return { status: 404, body: { error: 'invitation_not_found' } };
  const otp = String(crypto.randomInt(100000, 1000000)); const otpSalt = randomSecret(16);
  const otpDigest = sha256(`${otpSalt}:${otp}`);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE hivemind.meeting_consent_requests SET otp_hash=$1,otp_salt=$2,otp_attempts=0,otp_expires_at=now()+interval '10 minutes',exchanged_at=now(),updated_at=now() WHERE id=$3::uuid`, otpDigest, otpSalt, requestId,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload)
       VALUES($1::uuid,$2::uuid,'meeting.authorization.otp',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
      row.session_id, row.org_id, `meeting:${row.session_id}:request:${requestId}:otp:${otpDigest.slice(0, 12)}`,
      JSON.stringify({ request_id: requestId, otp_ciphertext: encryptDeliverySecret(otp) }),
    );
  });
  void enqueueMeetingOutbox(prisma, new CloudflareMeetingLifecycleClient(), { sessionId: row.session_id, orgId: row.org_id }).catch(() => {});
  return { status: 200, body: { exchange_id: requestId, email_hint: row.normalized_email.replace(/^(.).+(@.*)$/, '$1***$2'),
    notice: { title: row.notice_title, body: row.notice_body, controller: row.controller_name, privacy_contact: row.privacy_contact,
      jurisdiction: row.recording_jurisdiction, lawful_basis: row.lawful_basis, purposes: row.requested_purposes, processors: row.processors, retention: row.retention } } };
}

export async function verifyMeetingInvitation(prisma, exchangeId, otp) {
  if (!validUuid(exchangeId) || !/^\d{6}$/.test(String(otp || ''))) return { status: 400, body: { error: 'invalid_verification' } };
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(`SELECT * FROM hivemind.meeting_consent_requests WHERE id=$1::uuid AND expires_at>now() AND otp_expires_at>now() AND state='pending' FOR UPDATE`, exchangeId).catch(() => []);
    const row = rows?.[0];
    if (!row || row.otp_attempts >= 5 || !constantEqual(row.otp_hash, sha256(`${row.otp_salt}:${otp}`))) {
      await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_consent_requests SET otp_attempts=otp_attempts+1,updated_at=now() WHERE id=$1::uuid`, exchangeId).catch(() => {});
      return { status: 401, body: { error: 'invalid_verification' } };
    }
    const decisionToken = randomSecret();
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_consent_requests SET token_hash=$1,token_salt='decision',verified_at=now(),otp_hash=NULL,otp_salt=NULL,updated_at=now() WHERE id=$2::uuid`, sha256(`decision:${decisionToken}`), exchangeId);
    return { status: 200, body: { verified: true, decision_token: decisionToken } };
  });
}

export async function decideMeetingInvitation(prisma, { exchangeId, decisionToken, decision, purposes, subjectAttestation = true }) {
  if (!validUuid(exchangeId) || !['accepted', 'declined'].includes(decision)) return { status: 400, body: { error: 'invalid_decision' } };
  const outcome = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT r.*,p.org_id,p.session_id,n.policy_id,pol.version AS policy_version,pol.lawful_basis
         FROM hivemind.meeting_consent_requests r JOIN hivemind.meeting_participants p ON p.id=r.participant_id
         JOIN hivemind.meeting_notice_versions n ON n.id=r.notice_version_id JOIN hivemind.meeting_recording_policies pol ON pol.id=n.policy_id
        WHERE r.id=$1::uuid AND r.verified_at IS NOT NULL AND r.consumed_at IS NULL AND r.expires_at>now() FOR UPDATE`, exchangeId,
    ).catch(() => []);
    const row = rows?.[0];
    if (!row || !constantEqual(row.token_hash, sha256(`decision:${decisionToken}`))) return { error: { status: 401, body: { error: 'invalid_decision_token' } } };
    const acceptedPurposes = (Array.isArray(purposes) ? purposes : row.requested_purposes).filter((p) => MEETING_PURPOSES.has(p));
    if (decision === 'accepted' && (!acceptedPurposes.includes('record_audio') || !acceptedPurposes.includes('transcribe_and_summarize'))) return { error: { status: 422, body: { error: 'required_purposes_missing' } } };
    const digest = await appendConsentEvent(tx, { sessionId: row.session_id, participantId: row.participant_id, orgId: row.org_id, eventType: decision, eventData: { purposes: acceptedPurposes } });
    await tx.$executeRawUnsafe(
      `INSERT INTO hivemind.meeting_consent_receipts(session_id,participant_id,request_id,org_id,policy_id,policy_version,notice_version_id,lawful_basis,purposes,decision,verification_method,subject_attestation,event_digest)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8::jsonb,$9::jsonb,$10,'email_otp',$11,$12)`, row.session_id, row.participant_id,
      row.id, row.org_id, row.policy_id, row.policy_version, row.notice_version_id, JSON.stringify(row.lawful_basis), JSON.stringify(acceptedPurposes), decision, subjectAttestation === true, digest,
    );
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_participants SET status=$1,updated_at=now() WHERE id=$2::uuid`, decision, row.participant_id);
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_consent_requests SET state=$1,consumed_at=now(),delivery_secret_ciphertext=NULL,otp_hash=NULL,otp_salt=NULL,updated_at=now() WHERE id=$2::uuid`, decision, row.id);
    await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload) VALUES($1::uuid,$2::uuid,'meeting.authorization.confirmation',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, row.session_id, row.org_id, `meeting:${row.session_id}:participant:${row.participant_id}:confirmation`, JSON.stringify({ participant_id: row.participant_id, decision }));
    if (decision === 'declined') await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload) VALUES($1::uuid,$2::uuid,'meeting.authorization.declined',$3,'{}'::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, row.session_id, row.org_id, `meeting:${row.session_id}:declined`);
    return { row };
  });
  if (outcome.error) return outcome.error;
  const state = await refreshAuthorizationSnapshot(prisma, outcome.row.org_id, outcome.row.session_id);
  if (state.authorization_status === 'ready_to_record') await prisma.$executeRawUnsafe(`INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload) VALUES($1::uuid,$2::uuid,'meeting.ready_to_record',$3,'{}'::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, outcome.row.session_id, outcome.row.org_id, `meeting:${outcome.row.session_id}:ready`);
  void enqueueMeetingOutbox(prisma, new CloudflareMeetingLifecycleClient(), { sessionId: outcome.row.session_id, orgId: outcome.row.org_id }).catch(() => {});
  return { status: 200, body: { decision, authorization_status: state.authorization_status } };
}

export async function withdrawMeetingAuthorization(prisma, { exchangeId, decisionToken }) {
  if (!validUuid(exchangeId)) return { status: 400, body: { error: 'invalid_request' } };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT r.*,p.org_id,p.session_id FROM hivemind.meeting_consent_requests r JOIN hivemind.meeting_participants p ON p.id=r.participant_id WHERE r.id=$1::uuid`, exchangeId,
  ).catch(() => []);
  const row = rows?.[0];
  if (!row || !constantEqual(row.token_hash, sha256(`decision:${decisionToken}`))) return { status: 401, body: { error: 'invalid_decision_token' } };
  const digest = await appendConsentEvent(prisma, { sessionId: row.session_id, participantId: row.participant_id, orgId: row.org_id, eventType: 'withdrawn' });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_participants SET status='withdrawn',updated_at=now() WHERE id=$1::uuid`, row.participant_id);
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_consent_receipts SET withdrawn_at=now() WHERE request_id=$1::uuid`, row.id);
    await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_processing_restrictions(session_id,org_id,participant_id,restriction_type,reason) VALUES($1::uuid,$2::uuid,$3::uuid,'withdrawal','participant withdrew authorization')`, row.session_id, row.org_id, row.participant_id);
    await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET processing_restricted=true,publication_allowed=false,status=CASE WHEN status='recording' THEN 'paused' ELSE status END,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid`, row.session_id, row.org_id);
    await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload) VALUES($1::uuid,$2::uuid,'meeting.authorization.withdrawn',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, row.session_id, row.org_id, `meeting:${row.session_id}:participant:${row.participant_id}:withdrawn`, JSON.stringify({ participant_id: row.participant_id }));
  });
  await refreshAuthorizationSnapshot(prisma, row.org_id, row.session_id);
  void enqueueMeetingOutbox(prisma, new CloudflareMeetingLifecycleClient(), { sessionId: row.session_id, orgId: row.org_id }).catch(() => {});
  return { status: 200, body: { withdrawn: true, event_digest: digest } };
}

export async function startV2MeetingSession(prisma, client, { orgId, userId, sessionId }) {
  const state = await refreshAuthorizationSnapshot(prisma, orgId, sessionId);
  if (!state || state.user_id !== userId) return { status: 404, body: { error: 'not_found' } };
  if (state.authorization_status !== 'ready_to_record') return { status: 409, body: { error: 'authorization_incomplete', authorization_status: state.authorization_status } };
  await prisma.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET status='recording',current_stage='recording',progress=5,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid`, sessionId, orgId, userId);
  return { status: 200, body: { session_id: sessionId, status: 'recording', authorization_status: 'ready_to_record', stage: 'recording', progress: 5 } };
}

export async function listV2Authorizations(prisma, { orgId, userId, sessionId }) {
  const state = await authorizationState(prisma, orgId, sessionId);
  if (!state || state.user_id !== userId) return { status: 404, body: { error: 'not_found' } };
  const participants = await prisma.$queryRawUnsafe(`SELECT id,user_id,display_name,participant_kind,required,status,created_at,updated_at FROM hivemind.meeting_participants WHERE session_id=$1::uuid AND org_id=$2::uuid ORDER BY created_at`, sessionId, orgId);
  return { status: 200, body: { authorization_status: state.authorization_status, required_authorizations: state.required_count, accepted_authorizations: state.accepted_count, declined_authorizations: state.declined_count,
    memory_promotion_authorized: state.required_count > 0 && state.memory_authorized_count === state.required_count, participants } };
}

export async function addV2MeetingParticipants(prisma, client, { orgId, userId, sessionId, body = {} }) {
  const participants = normalizedParticipants(body);
  if (!participants.length) return { status: 422, body: { error: 'participants_required' } };
  const sessionRows = await prisma.$queryRawUnsafe(
    `SELECT s.id,s.status,s.orchestration_mode,s.recording_policy_id,s.purposes,n.id AS notice_version_id
       FROM hivemind.meeting_sessions s
       JOIN hivemind.meeting_notice_versions n ON n.policy_id=s.recording_policy_id AND n.approved_at IS NOT NULL
      WHERE s.id=$1::uuid AND s.org_id=$2::uuid AND s.user_id=$3::uuid
        AND s.orchestration_mode LIKE 'workflow_v2:%'
      ORDER BY n.version DESC LIMIT 1`, sessionId, orgId, userId,
  ).catch(() => []);
  const session = sessionRows?.[0];
  if (!session) return { status: 404, body: { error: 'not_found' } };
  if (['cancelled', 'ready', 'failed'].includes(session.status)) return { status: 409, body: { error: 'session_not_mutable' } };
  const added = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const participant of participants) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT id FROM hivemind.meeting_participants WHERE session_id=$1::uuid AND org_id=$2::uuid
          AND (($3::uuid IS NOT NULL AND user_id=$3::uuid) OR ($4::text IS NOT NULL AND normalized_email=$4)) LIMIT 1`,
        sessionId, orgId, participant.user_id, participant.email || null,
      );
      if (existing?.[0]) continue;
      const pRows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.meeting_participants(session_id,org_id,user_id,normalized_email,display_name,participant_kind,required)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) RETURNING *`, sessionId, orgId, participant.user_id,
        participant.email || null, participant.display_name || null, participant.kind, participant.required,
      );
      const p = pRows[0];
      if (!p.normalized_email) throw Object.assign(new Error('participant_email_required'), { code: 'participant_email_required' });
      const secret = randomSecret(); const salt = randomSecret(16);
      const reqRows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.meeting_consent_requests(session_id,participant_id,org_id,token_hash,token_salt,delivery_secret_ciphertext,notice_version_id,requested_purposes,expires_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::uuid,$8::jsonb,now()+interval '72 hours') RETURNING id`,
        sessionId, p.id, orgId, sha256(`${salt}:${secret}`), salt, encryptDeliverySecret(secret), session.notice_version_id, JSON.stringify(session.purposes),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload)
         VALUES($1::uuid,$2::uuid,'meeting.authorization.invitation',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
        sessionId, orgId, `meeting:${sessionId}:participant:${p.id}:invitation:v1`, JSON.stringify({ request_id: reqRows[0].id, participant_id: p.id }),
      );
      created.push({ id: p.id, display_name: p.display_name, required: p.required, status: p.status });
    }
    if (created.length) {
      await tx.$executeRawUnsafe(
        `UPDATE hivemind.meeting_sessions SET status=CASE WHEN status='recording' THEN 'paused' ELSE status END,
           authorization_status='pending',consent_recorded=false,publication_allowed=false,current_stage='authorization',updated_at=now()
          WHERE id=$1::uuid AND org_id=$2::uuid`, sessionId, orgId,
      );
    }
    return created;
  });
  if (added.length) await enqueueMeetingOutbox(prisma, client, { sessionId, orgId });
  const state = await refreshAuthorizationSnapshot(prisma, orgId, sessionId);
  return { status: 201, body: { session_id: sessionId, added, authorization_status: state?.authorization_status || 'pending', recording_paused: added.length > 0 } };
}

export async function controlV2MeetingSession(prisma, { orgId, userId, sessionId, action, body = {} }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id,status,orchestration_mode,processing_restricted FROM hivemind.meeting_sessions
      WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid FOR UPDATE`, sessionId, orgId, userId,
  ).catch(() => []);
  const session = rows?.[0];
  if (!session || !String(session.orchestration_mode || '').startsWith('workflow_v2:')) return { status: 404, body: { error: 'not_found' } };
  if (action === 'pause') {
    await prisma.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET status='paused',current_stage='paused',updated_at=now() WHERE id=$1::uuid`, sessionId);
    return { status: 200, body: { session_id: sessionId, status: 'paused' } };
  }
  if (action === 'cancel') {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET status='cancelled',processing_restricted=true,publication_allowed=false,current_stage='cancelled',updated_at=now() WHERE id=$1::uuid`, sessionId);
      await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_processing_restrictions(session_id,org_id,restriction_type,reason,created_by) VALUES($1::uuid,$2::uuid,'cancelled',$3,$4::uuid)`, sessionId, orgId, String(body.reason || 'organizer cancelled meeting').slice(0, 500), userId);
    });
    return { status: 200, body: { session_id: sessionId, status: 'cancelled', processing_restriction: true } };
  }
  if (action === 'restrict') {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET status=CASE WHEN status='recording' THEN 'paused' ELSE status END,processing_restricted=true,publication_allowed=false,current_stage='restricted',updated_at=now() WHERE id=$1::uuid`, sessionId);
      await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_processing_restrictions(session_id,org_id,restriction_type,reason,created_by) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)`, sessionId, orgId, String(body.restriction_type || 'controller_restriction').slice(0, 80), String(body.reason || 'processing restricted by controller').slice(0, 500), userId);
    });
    return { status: 200, body: { session_id: sessionId, processing_restriction: true } };
  }
  if (action === 'erase') {
    const requestId = crypto.randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET processing_restricted=true,publication_allowed=false,current_stage='erasure_pending',updated_at=now() WHERE id=$1::uuid`, sessionId);
      await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_data_subject_requests(id,org_id,session_id,request_type,status,requested_at,result_receipt,created_by) VALUES($1::uuid,$2::uuid,$3::uuid,'erasure','received',now(),$4::jsonb,$5::uuid)`, requestId, orgId, sessionId, JSON.stringify({ reason: String(body.reason || '').slice(0, 500) }), userId);
      await tx.$executeRawUnsafe(`INSERT INTO hivemind.meeting_outbox(session_id,org_id,event_type,dedupe_key,payload) VALUES($1::uuid,$2::uuid,'meeting.erasure.requested',$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`, sessionId, orgId, `meeting:${sessionId}:erasure:${requestId}`, JSON.stringify({ request_id: requestId }));
    });
    return { status: 202, body: { session_id: sessionId, request_id: requestId, status: 'pending', processing_restriction: true } };
  }
  return { status: 400, body: { error: 'invalid_action' } };
}

export async function finalizeV2MeetingSession(prisma, client, { orgId, userId, sessionId, body }) {
  const state = await authorizationState(prisma, orgId, sessionId);
  if (!state || state.user_id !== userId) return { status: 404, body: { error: 'not_found' } };
  if (state.authorization_status !== 'ready_to_record' || state.processing_restricted) return { status: 409, body: { error: 'processing_restricted' } };
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.meeting_sessions SET status='queued',expected_segments=$1,finalization_payload=$2::jsonb,current_stage='queued',progress=25,updated_at=now() WHERE id=$3::uuid AND org_id=$4::uuid AND user_id=$5::uuid`,
    Number.isInteger(body?.expected_segments) ? body.expected_segments : null, JSON.stringify({ ...safeJson(body, {}), transcript: undefined }), sessionId, orgId, userId,
  );
  const instanceId = `meeting-${sessionId}-v2`;
  const mode = String(state.orchestration_mode || '').split(':')[1];
  if (!['workflow', 'full'].includes(mode)) return { status: 409, body: { error: 'durable_workflow_not_enabled_for_session' } };
  const started = await client.startWorkflow({ session_id: sessionId, org_id: orgId, user_id: userId, pipeline_version: 2, mode, instance_id: instanceId });
  await prisma.$executeRawUnsafe(`UPDATE hivemind.meeting_sessions SET workflow_instance_id=$1 WHERE id=$2::uuid AND org_id=$3::uuid`, started.instance_id || instanceId, sessionId, orgId);
  return { status: 202, body: { session_id: sessionId, status: 'queued', workflow_instance_id: started.instance_id || instanceId, stage: 'queued', progress: 25 } };
}

export const meetingLifecycleTest = { sha256, normalizeEmail, requiredPolicyFields, normalizedParticipants, encryptDeliverySecret, decryptDeliverySecret };
