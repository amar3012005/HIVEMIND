import { transcribeAudio } from '../llm/stt-route.js';
import { amrMeetingAudioClaim, amrMeetingAudioPending, amrMeetingAudioSettle, amrMeetingSegmentWrite, amrRemoteOrgIds } from '../vector/mneme/driver.js';
import { audioRetryDelayMs } from './meeting-audio-worker.js';

// AMR is storage-only. This worker never writes raw bytes to core disk/DB: it
// obtains one agent-leased chunk into memory, executes the shared Singulance
// STT route, and settles transcript/status back on that same agent.
export async function processRemoteMeetingAudioSegment({ orgId, sessionId, idx, userId }) {
  const claim = await amrMeetingAudioClaim(orgId, { session_id: sessionId, idx, user_id: userId });
  const row = claim?.segment;
  if (!row) return { claimed: false };
  try {
    const audio = Buffer.from(String(row.audio_base64 || ''), 'base64');
    if (!audio.length) throw new Error('remote audio payload empty');
    const result = await transcribeAudio({ audio, contentType: row.content_type, filename: `meeting-${idx}`, model: process.env.MEETING_STT_MODEL, temperature: 0, response_format: 'verbose_json', timeoutMs: 300_000 });
    if (!result.ok || !String(result.text || '').trim()) throw new Error(result.detail || `transcription ${result.status || 'empty'}`);
    const stored = await amrMeetingSegmentWrite(orgId, { session_id: sessionId, user_id: userId, idx, text: String(result.text).slice(0, 200000), start_ms: row.start_ms ?? null, end_ms: row.end_ms ?? null });
    if (!stored?.ok) throw new Error('remote transcript persistence failed');
    await amrMeetingAudioSettle(orgId, { session_id: sessionId, user_id: userId, idx, status: 'transcribed' });
    return { claimed: true, ok: true };
  } catch (error) {
    const attempt = Number(row.attempts || 1);
    await amrMeetingAudioSettle(orgId, { session_id: sessionId, user_id: userId, idx, status: 'error', next_attempt_at: attempt < 3 ? new Date(Date.now() + audioRetryDelayMs(attempt)).toISOString() : null, last_error: String(error?.message || error) });
    return { claimed: true, ok: false, error: String(error?.message || error) };
  }
}

export async function reconcileRemoteMeetingAudio({ limitPerOrg = 10 } = {}) {
  let scanned = 0; let completed = 0; let failed = 0;
  for (const orgId of amrRemoteOrgIds()) {
    const rows = await amrMeetingAudioPending(orgId, limitPerOrg);
    for (const row of rows || []) {
      scanned += 1;
      const result = await processRemoteMeetingAudioSegment({ orgId, sessionId: row.session_id, idx: row.idx, userId: row.user_id });
      if (result.ok) completed += 1;
      else if (result.claimed) failed += 1;
    }
  }
  return { scanned, completed, failed };
}
