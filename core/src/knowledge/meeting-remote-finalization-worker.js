import {
  amrMeetingSegmentList, amrMeetingSessionClaim, amrMeetingSessionPending,
  amrMeetingSessionSettle, amrMeetingWrite, amrRemoteOrgIds,
} from '../vector/mneme/driver.js';
import { generateMeetingInsights } from './meeting-insights.js';
import { finalizationRetryDelayMs } from './meeting-finalization-worker.js';

export async function processRemoteMeetingFinalization({ orgId, sessionId, userId }) {
  const claim = await amrMeetingSessionClaim(orgId, { id: sessionId, user_id: userId });
  const job = claim?.session;
  if (!job) return { claimed: false };
  try {
    const segments = await amrMeetingSegmentList(orgId, { session_id: sessionId, user_id: userId });
    if (!segments) throw new Error('tenant transcript storage unavailable');
    const indexes = segments.map((segment) => Number(segment.idx)).filter(Number.isInteger).sort((a, b) => a - b);
    const expected = job.expected_segments == null ? null : Number(job.expected_segments);
    if (expected != null) {
      const missing = Array.from({ length: expected }, (_, index) => index).filter((index) => !indexes.includes(index));
      if (missing.length) {
        await amrMeetingSessionSettle(orgId, { id: sessionId, user_id: userId, status: 'failed', failure_code: 'missing_segments', failure_detail: `missing transcript segments: ${missing.join(',')}` });
        return { claimed: true, ok: false, terminal: true };
      }
    }
    const transcript = segments.map((segment) => segment.text).filter(Boolean).join('\n').trim();
    if (!transcript) throw new Error('no transcript available for finalization');
    const payload = job.finalization_payload && typeof job.finalization_payload === 'object' ? job.finalization_payload : {};
    const speakerTranscript = segments.some((segment) => Array.isArray(segment.speakers) && segment.speakers.length)
      ? segments.flatMap((segment) => segment.speakers || []).map((item) => `${item.speaker || 'Speaker'}: ${item.text || ''}`).join('\n')
      : transcript;
    const { insights } = await generateMeetingInsights({ orgId, transcript: speakerTranscript, notes: payload.notes || '', participants: payload.participants || [] });
    const meeting = await amrMeetingWrite(orgId, {
      user_id: userId, session_id: sessionId, project_id: payload.project_id || null,
      title: String(payload.title || insights.title || 'Meeting').slice(0, 300), summary: insights.summary || null,
      transcript, language: payload.language || null, duration_sec: Number.isFinite(payload.duration_sec) ? payload.duration_sec : null,
      multi_speaker: segments.some((segment) => Array.isArray(segment.speakers) && segment.speakers.length),
      speaker_count: Number.isFinite(payload.speaker_count) ? payload.speaker_count : null,
      action_items: insights.action_items || [], decisions: insights.decisions || [], key_points: insights.key_points || [],
      questions: insights.questions || [], segments: payload.segments || null, topics: insights.topics || [], sentiment: insights.sentiment || null,
      notes: String(payload.notes || '').slice(0, 8000) || null, insights,
      participants: Array.isArray(payload.participants) ? payload.participants.slice(0, 50) : [], scope: payload.scope || null,
    });
    if (!meeting?.ok || !meeting.id) throw new Error(meeting?.error || 'tenant meeting persistence failed');
    await amrMeetingSessionSettle(orgId, { id: sessionId, user_id: userId, status: 'ready', meeting_id: meeting.id });
    return { claimed: true, ok: true, meetingId: meeting.id };
  } catch (error) {
    const attempt = Number(job.finalization_attempts || 1);
    const terminal = attempt >= 3;
    await amrMeetingSessionSettle(orgId, {
      id: sessionId, user_id: userId, status: terminal ? 'failed' : 'error',
      failure_code: 'finalization_failed', failure_detail: String(error?.message || error),
      next_attempt_at: terminal ? null : new Date(Date.now() + finalizationRetryDelayMs(attempt)).toISOString(),
    });
    return { claimed: true, ok: false, terminal, error: String(error?.message || error) };
  }
}

export async function reconcileRemoteMeetingFinalizations({ limitPerOrg = 5 } = {}) {
  let scanned = 0; let completed = 0; let failed = 0;
  for (const orgId of amrRemoteOrgIds()) {
    const sessions = await amrMeetingSessionPending(orgId, limitPerOrg);
    for (const session of sessions || []) {
      scanned += 1;
      const result = await processRemoteMeetingFinalization({ orgId, sessionId: session.id, userId: session.user_id });
      if (result.ok) completed += 1; else if (result.claimed) failed += 1;
    }
  }
  return { scanned, completed, failed };
}
