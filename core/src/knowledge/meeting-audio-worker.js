import { transcribeAudio } from '../llm/stt-route.js';
import { readMeetingAudio, removeMeetingAudio } from './meeting-audio-store.js';
import { processMeetingSegmentExtraction } from './meeting-segment-extractor.js';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60 * 1000;
export function audioRetryDelayMs(attempt) { return Math.min(30 * 60 * 1000, 30_000 * (2 ** Math.max(0, Number(attempt) - 1))); }

export async function processMeetingAudioSegment(prisma, { sessionId, idx, orgId, userId }) {
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.meeting_audio_segments
        SET status='processing', attempts=attempts+1, next_attempt_at=NULL,
            lease_expires_at=$6, last_error=NULL, updated_at=now()
      WHERE session_id=$1::uuid AND idx=$2 AND org_id=$3::uuid AND user_id=$4::uuid
        AND (status IN ('queued','error') OR (status='processing' AND lease_expires_at < now()))
        AND attempts < $5 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING storage_key, content_type, attempts, start_ms, end_ms`,
    sessionId, idx, orgId, userId, MAX_ATTEMPTS, new Date(Date.now() + LEASE_MS),
  );
  const row = claimed?.[0];
  if (!row) return { claimed: false };
  try {
    const audio = await readMeetingAudio(row.storage_key);
    const result = await transcribeAudio({
      audio, contentType: row.content_type, filename: `meeting-${idx}`, model: process.env.MEETING_STT_MODEL,
      temperature: 0, response_format: 'verbose_json', timeoutMs: 300_000,
    });
    if (!result.ok || !String(result.text || '').trim()) throw new Error(result.detail || `transcription ${result.status || 'empty'}`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO hivemind.meeting_segments (session_id, org_id, user_id, idx, text, start_ms, end_ms)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7)
       ON CONFLICT (session_id, idx) DO UPDATE SET text=EXCLUDED.text, start_ms=EXCLUDED.start_ms, end_ms=EXCLUDED.end_ms`,
      sessionId, orgId, userId, idx, String(result.text).slice(0, 200000), row.start_ms, row.end_ms,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.meeting_audio_segments SET status='transcribed', lease_expires_at=NULL, last_error=NULL, updated_at=now()
       WHERE session_id=$1::uuid AND idx=$2 AND org_id=$3::uuid AND user_id=$4::uuid`, sessionId, idx, orgId, userId,
    );
    void processMeetingSegmentExtraction(prisma, { sessionId, idx, orgId, userId }).catch(() => {});
    return { claimed: true, ok: true, language: result.language || null };
  } catch (error) {
    const retryAt = Number(row.attempts) < MAX_ATTEMPTS ? new Date(Date.now() + audioRetryDelayMs(row.attempts)) : null;
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.meeting_audio_segments SET status='error', next_attempt_at=$1, lease_expires_at=NULL, last_error=$2, updated_at=now()
       WHERE session_id=$3::uuid AND idx=$4 AND org_id=$5::uuid AND user_id=$6::uuid`,
      retryAt, String(error?.message || error).slice(0, 500), sessionId, idx, orgId, userId,
    ).catch(() => {});
    return { claimed: true, ok: false, retryAt, error: String(error?.message || error) };
  }
}

export async function reconcileMeetingAudioSegments(prisma, { limit = 10 } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT session_id, idx, org_id, user_id FROM hivemind.meeting_audio_segments
      WHERE (status IN ('queued','error') OR (status='processing' AND lease_expires_at < now()))
        AND attempts < $1 AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at ASC LIMIT $2`, MAX_ATTEMPTS, Math.max(1, Math.min(50, Number(limit) || 10)),
  );
  const results = [];
  for (const row of rows || []) results.push(await processMeetingAudioSegment(prisma, { sessionId: row.session_id, idx: row.idx, orgId: row.org_id, userId: row.user_id }));
  return { scanned: rows?.length || 0, completed: results.filter((r) => r.ok).length, failed: results.filter((r) => r.claimed && !r.ok).length };
}

// Keep raw audio long enough for support/recovery, but never indefinitely.
// Only a finalized meeting is eligible; failed/unfinished sessions retain their
// source bytes so they can be retried without asking the user to re-record.
export async function pruneFinalizedMeetingAudio(prisma, { limit = 50, retentionDays = 30 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(retentionDays) || 30) * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.session_id, a.idx, a.org_id, a.user_id, a.storage_key
       FROM hivemind.meeting_audio_segments a
       JOIN hivemind.meeting_sessions s ON s.id=a.session_id AND s.org_id=a.org_id AND s.user_id=a.user_id
      WHERE a.status='transcribed' AND s.status='ready' AND a.created_at < $1
      ORDER BY a.created_at ASC LIMIT $2`, cutoff, Math.max(1, Math.min(500, Number(limit) || 50)),
  );
  let removed = 0;
  for (const row of rows || []) {
    try {
      await removeMeetingAudio(row.storage_key);
      await prisma.$executeRawUnsafe(
        `UPDATE hivemind.meeting_audio_segments SET status='expired', updated_at=now()
          WHERE session_id=$1::uuid AND idx=$2 AND org_id=$3::uuid AND user_id=$4::uuid AND status='transcribed'`,
        row.session_id, row.idx, row.org_id, row.user_id,
      );
      removed += 1;
    } catch (error) { console.warn('[meeting-audio] retention cleanup failed:', error?.message || error); }
  }
  return { scanned: rows?.length || 0, removed };
}
