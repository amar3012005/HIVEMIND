import { generateMeetingInsights } from './meeting-insights.js';

const MAX_ATTEMPTS = Math.max(1, Number(process.env.MEETING_FINALIZATION_MAX_ATTEMPTS || 3));
const LEASE_MS = Math.max(60_000, Number(process.env.MEETING_FINALIZATION_LEASE_MS || 10 * 60 * 1000));
const ABANDONED_AFTER_MS = Math.max(5 * 60_000, Number(process.env.MEETING_ABANDONED_AFTER_MS || 30 * 60_000));

export function finalizationRetryDelayMs(attempt) {
  return Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, Number(attempt) - 1)));
}

export async function queueAbandonedMeetingSessions(prisma, { limit = 5, now = new Date() } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH candidates AS (
       SELECT s.id,s.org_id,s.user_id
         FROM hivemind.meeting_sessions s
        WHERE s.status='recording'
          AND s.consent_recorded=true
          AND s.updated_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
          AND EXISTS (
            SELECT 1 FROM hivemind.meeting_segments g
             WHERE g.session_id=s.id AND g.org_id=s.org_id AND g.user_id=s.user_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM hivemind.meeting_audio_segments a
             WHERE a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id
               AND a.status NOT IN ('transcribed','expired')
               AND NOT (a.status='error' AND a.attempts >= 3)
          )
        ORDER BY s.updated_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE hivemind.meeting_sessions s
        SET status='queued', expected_segments=NULL,
            finalization_payload=COALESCE(s.finalization_payload,'{}'::jsonb) ||
              jsonb_build_object('recovered_partial',true,'recovery_reason','recording_inactive','recovered_at',$1::timestamptz),
            finalization_next_attempt_at=NULL, finalization_lease_expires_at=NULL,
            failure_code=NULL, failure_detail=NULL, updated_at=now()
       FROM candidates c
      WHERE s.id=c.id AND s.org_id=c.org_id AND s.user_id=c.user_id
      RETURNING s.id,s.org_id,s.user_id`,
    now, ABANDONED_AFTER_MS, Math.max(1, Math.min(20, Number(limit) || 5)),
  );
  return rows || [];
}

export async function queueMeetingFinalization(prisma, { sessionId, orgId, userId, expectedSegments, payload }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.meeting_sessions
        SET status=CASE WHEN status='ready' THEN status ELSE 'queued' END,
            finalization_attempts=CASE WHEN status='failed' THEN 0 ELSE finalization_attempts END,
            expected_segments=COALESCE($4::int, expected_segments),
            finalization_payload=$5::jsonb,
            finalization_next_attempt_at=NULL,
            finalization_lease_expires_at=NULL,
            failure_code=NULL, failure_detail=NULL, updated_at=now()
      WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid
      RETURNING id,status,finalized_meeting_id,expected_segments`,
    sessionId, orgId, userId,
    Number.isInteger(Number(expectedSegments)) && Number(expectedSegments) >= 0 ? Math.min(1000, Number(expectedSegments)) : null,
    JSON.stringify(payload || {}),
  );
  // An explicit retry is also the recovery signal for segment enrichment that
  // exhausted its budget during the same provider outage. Finalization does not
  // depend on this projection, so failure to reset it must not strand the saved
  // meeting; the regular extraction reconciler owns the renewed bounded work.
  if (rows?.[0] && typeof prisma.$executeRawUnsafe === 'function') {
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.meeting_segments
          SET extraction_status='pending', extraction_attempts=0,
              extraction_next_attempt_at=NULL, extraction_lease_expires_at=NULL,
              extraction_last_error=NULL
        WHERE session_id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid
          AND extraction_status='error' AND extraction_attempts >= 3
          AND extraction IS NULL`,
      sessionId, orgId, userId,
    ).catch((error) => console.warn('[meeting-finalization] segment extraction requeue failed:', error?.message || error));
  }
  return rows?.[0] || null;
}

async function readiness(prisma, { sessionId, orgId, userId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.status,s.expected_segments,s.finalized_meeting_id,s.finalization_payload,s.finalization_attempts,
            COUNT(DISTINCT g.id)::int AS segment_count,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT g.idx ORDER BY g.idx),NULL) AS indexes,
            COUNT(DISTINCT a.id)::int AS audio_count,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status='transcribed')::int AS audio_transcribed,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status='error' AND a.attempts >= 3)::int AS audio_terminal_errors
       FROM hivemind.meeting_sessions s
       LEFT JOIN hivemind.meeting_segments g ON g.session_id=s.id AND g.org_id=s.org_id AND g.user_id=s.user_id
       LEFT JOIN hivemind.meeting_audio_segments a ON a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id
      WHERE s.id=$1::uuid AND s.org_id=$2::uuid AND s.user_id=$3::uuid
      GROUP BY s.id`, sessionId, orgId, userId,
  );
  const row = rows?.[0];
  if (!row) return { missing: true };
  const expected = row.expected_segments == null ? null : Number(row.expected_segments);
  const indexes = (row.indexes || []).map(Number).sort((a, b) => a - b);
  const missingIndexes = expected == null ? [] : Array.from({ length: expected }, (_, index) => index).filter((index) => !indexes.includes(index));
  return {
    row, expected, indexes, missingIndexes,
    waitingAudio: Number(row.audio_count || 0) !== Number(row.audio_transcribed || 0),
    terminalAudioErrors: Number(row.audio_terminal_errors || 0),
  };
}

async function settleFailure(prisma, identity, attempts, error, { terminal = false, code = 'finalization_failed' } = {}) {
  const retryAt = !terminal && attempts < MAX_ATTEMPTS ? new Date(Date.now() + finalizationRetryDelayMs(attempts)) : null;
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.meeting_sessions
        SET status=$1, finalization_next_attempt_at=$2, finalization_lease_expires_at=NULL,
            failure_code=$3, failure_detail=$4, updated_at=now()
      WHERE id=$5::uuid AND org_id=$6::uuid AND user_id=$7::uuid`,
    retryAt ? 'error' : 'failed', retryAt, code, String(error?.message || error).slice(0, 1000),
    identity.sessionId, identity.orgId, identity.userId,
  ).catch(() => {});
  return { claimed: true, ok: false, terminal: !retryAt, retryAt, error: String(error?.message || error) };
}

export async function processMeetingFinalization(prisma, identity, { creditService = null } = {}) {
  const state = await readiness(prisma, identity);
  if (state.missing) return { claimed: false, missing: true };
  if (state.row.status === 'ready' && state.row.finalized_meeting_id) return { claimed: false, ok: true, existing: true, meetingId: state.row.finalized_meeting_id };
  if (state.terminalAudioErrors) return settleFailure(prisma, identity, Number(state.row.finalization_attempts || 0), new Error('transcription retry budget exhausted'), { terminal: true, code: 'transcription_failed' });
  if (state.waitingAudio) return { claimed: false, waiting: 'audio' };
  if (state.expected != null && state.missingIndexes.length) {
    return settleFailure(prisma, identity, Number(state.row.finalization_attempts || 0), new Error(`missing transcript segments: ${state.missingIndexes.join(',')}`), { terminal: true, code: 'missing_segments' });
  }
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.meeting_sessions
        SET status='analyzing', finalization_attempts=finalization_attempts+1,
            finalization_next_attempt_at=NULL, finalization_lease_expires_at=$5,
            failure_code=NULL,failure_detail=NULL,updated_at=now()
      WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid
        AND status IN ('queued','error','analyzing')
        AND finalization_attempts < $4
        AND (finalization_next_attempt_at IS NULL OR finalization_next_attempt_at <= now())
        AND (status <> 'analyzing' OR finalization_lease_expires_at < now())
      RETURNING finalization_payload,finalization_attempts`,
    identity.sessionId, identity.orgId, identity.userId, MAX_ATTEMPTS, new Date(Date.now() + LEASE_MS),
  );
  const job = claimed?.[0];
  if (!job) return { claimed: false };
  try {
    const segments = await prisma.$queryRawUnsafe(
      `SELECT idx,text,speakers,start_ms,end_ms FROM hivemind.meeting_segments
        WHERE session_id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid ORDER BY idx`,
      identity.sessionId, identity.orgId, identity.userId,
    );
    const transcript = (segments || []).map((segment) => segment.text).filter(Boolean).join('\n').trim();
    if (!transcript) throw new Error('no transcript available for finalization');
    const payload = job.finalization_payload && typeof job.finalization_payload === 'object' ? job.finalization_payload : {};
    const inferredDurationSec = Math.max(0, ...segments.map((segment) => Number(segment.end_ms || 0))) / 1000;
    const meetingMinutes = Math.max(1, Math.ceil((Number(payload.duration_sec) || inferredDurationSec || 60) / 60));
    const meetingCreditKey = `meeting:${identity.sessionId}`;
    const meetingCredit = creditService ? await creditService.reserve({
      orgId: identity.orgId, userId: identity.userId, service: 'meeting_minute', units: meetingMinutes,
      source: 'meeting_notes', idempotencyKey: meetingCreditKey,
      metadata: { session_id: identity.sessionId, minutes: meetingMinutes },
    }) : { admitted: true, duplicate: true };
    if (!meetingCredit.admitted) {
      return settleFailure(prisma, identity, Number(job.finalization_attempts), new Error('monthly credits exhausted'), { terminal: true, code: 'credits_exhausted' });
    }
    const speakerTranscript = segments.some((segment) => Array.isArray(segment.speakers) && segment.speakers.length)
      ? segments.flatMap((segment) => segment.speakers || []).map((item) => `${item.speaker || 'Speaker'}: ${item.text || ''}`).join('\n')
      : transcript;
    const { insights } = await generateMeetingInsights({
      prisma, orgId: identity.orgId, transcript: speakerTranscript,
      notes: payload.notes || '', participants: payload.participants || [],
    });
    if (payload.recovered_partial === true) {
      insights.recovery = {
        partial: true,
        reason: payload.recovery_reason || 'recording_inactive',
        recovered_at: payload.recovered_at || null,
        transcript_segments: segments.length,
      };
    }
    const scopes = new Set(['personal','project','team','organization']);
    const scope = scopes.has(String(payload.scope || '').toLowerCase()) ? String(payload.scope).toLowerCase() : null;
    const title = String(payload.title || insights.title || `Meeting ${new Date().toISOString().slice(0, 16)}`).slice(0, 300);
    const jsonArray = (value) => JSON.stringify(Array.isArray(value) ? value : []);
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.$queryRawUnsafe(
        `SELECT finalized_meeting_id FROM hivemind.meeting_sessions WHERE id=$1::uuid AND org_id=$2::uuid AND user_id=$3::uuid FOR UPDATE`,
        identity.sessionId, identity.orgId, identity.userId,
      );
      if (existing?.[0]?.finalized_meeting_id) return { id: existing[0].finalized_meeting_id, existing: true };
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO hivemind.meetings
           (user_id,org_id,project_id,title,summary,transcript,language,duration_sec,multi_speaker,speaker_count,
            action_items,decisions,key_points,questions,segments,topics,sentiment,notes,insights,participants,scope)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::text[],$17,$18,$19::jsonb,$20::jsonb,$21)
         RETURNING id,created_at`,
        identity.userId, identity.orgId, payload.project_id || null, title, insights.summary || null, transcript,
        payload.language || null, Number.isFinite(payload.duration_sec) ? payload.duration_sec : null,
        segments.some((segment) => Array.isArray(segment.speakers) && segment.speakers.length),
        Number.isFinite(payload.speaker_count) ? payload.speaker_count : null,
        jsonArray(insights.action_items), jsonArray(insights.decisions), jsonArray(insights.key_points), jsonArray(insights.questions),
        JSON.stringify(payload.segments || null), Array.isArray(insights.topics) ? insights.topics.slice(0, 20) : [],
        insights.sentiment || null, String(payload.notes || '').slice(0, 8000) || null, JSON.stringify(insights),
        JSON.stringify(Array.isArray(payload.participants) ? payload.participants.slice(0, 50) : []), scope,
      );
      const meetingId = rows[0].id;
      await tx.$executeRawUnsafe(
        `UPDATE hivemind.meeting_segments SET meeting_id=$1::uuid WHERE session_id=$2::uuid AND org_id=$3::uuid AND user_id=$4::uuid AND meeting_id IS NULL`,
        meetingId, identity.sessionId, identity.orgId, identity.userId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE hivemind.meeting_sessions SET status='ready',finalized_meeting_id=$1::uuid,finalized_at=now(),updated_at=now(),
                finalization_lease_expires_at=NULL,finalization_next_attempt_at=NULL,failure_code=NULL,failure_detail=NULL
          WHERE id=$2::uuid AND org_id=$3::uuid AND user_id=$4::uuid`, meetingId, identity.sessionId, identity.orgId, identity.userId,
      );
      return { id: meetingId, createdAt: rows[0].created_at };
    });
    if (creditService && !meetingCredit.duplicate) await creditService.settle({ orgId: identity.orgId, idempotencyKey: meetingCreditKey });
    return { claimed: true, ok: true, meetingId: result.id, existing: Boolean(result.existing) };
  } catch (error) {
    if (creditService) await creditService.release({ orgId: identity.orgId, idempotencyKey: `meeting:${identity.sessionId}` }).catch(() => {});
    return settleFailure(prisma, identity, Number(job.finalization_attempts), error);
  }
}

export async function reconcileMeetingFinalizations(prisma, { limit = 5, creditService = null } = {}) {
  const recovered = await queueAbandonedMeetingSessions(prisma, { limit });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id,s.org_id,s.user_id FROM hivemind.meeting_sessions s
      WHERE (s.status IN ('queued','error') OR (s.status='analyzing' AND s.finalization_lease_expires_at < now()))
        AND s.finalization_attempts < $1
        AND (s.finalization_next_attempt_at IS NULL OR s.finalization_next_attempt_at <= now())
        AND NOT EXISTS (
          SELECT 1 FROM hivemind.meeting_audio_segments a
           WHERE a.session_id=s.id AND a.org_id=s.org_id AND a.user_id=s.user_id
             AND a.status NOT IN ('transcribed','expired')
             AND NOT (a.status='error' AND a.attempts >= 3)
        )
      ORDER BY s.updated_at ASC LIMIT $2`, MAX_ATTEMPTS, Math.max(1, Math.min(20, Number(limit) || 5)),
  );
  const results = [];
  for (const row of rows || []) results.push(await processMeetingFinalization(prisma, { sessionId: row.id, orgId: row.org_id, userId: row.user_id }, { creditService }));
  return { recovered: recovered.length, scanned: rows?.length || 0, completed: results.filter((result) => result.ok).length, failed: results.filter((result) => result.claimed && !result.ok).length };
}

export const __test = { readiness, abandonedAfterMs: ABANDONED_AFTER_MS };
