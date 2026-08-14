import { groqFetch } from '../llm/groq-fallback.js';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 5 * 60 * 1000;
const EXTRACTION_PROMPT = 'Extract from this meeting transcript SEGMENT. STRICT JSON {"entities":{"people":string[],"organizations":string[]},"decisions":string[],"actions":[{"task":string,"owner":string|null}],"topics":string[]}. Faithful — never invent. Empty arrays when none.';

export function extractionRetryDelayMs(attempt) {
  return Math.min(15 * 60 * 1000, 30_000 * (2 ** Math.max(0, Number(attempt) - 1)));
}

async function extract(text) {
  const response = await groqFetch(`${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.MEETING_EXTRACT_MODEL || process.env.MEETING_INSIGHTS_MODEL || 'openai/gpt-oss-120b',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: EXTRACTION_PROMPT }, { role: 'user', content: String(text || '').slice(0, 20_000) }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`llm ${response.status}`);
  return JSON.parse((await response.json()).choices?.[0]?.message?.content || '{}');
}

/** Claim, extract, and settle exactly one segment. The conditional update is the
 * lease: a worker that loses the race does no external call. */
export async function processMeetingSegmentExtraction(prisma, { sessionId, idx, orgId, userId }) {
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  const claimed = await prisma.$queryRawUnsafe(
    `UPDATE hivemind.meeting_segments
        SET extraction_status='processing', extraction_attempts=extraction_attempts+1,
            extraction_next_attempt_at=NULL, extraction_lease_expires_at=$6, extraction_last_error=NULL
      WHERE session_id=$1::uuid AND idx=$2 AND org_id=$3::uuid AND user_id=$4::uuid
        AND (extraction_status IN ('pending','error') OR (extraction_status='processing' AND extraction_lease_expires_at < now()))
        AND extraction_attempts < $5
        AND (extraction_next_attempt_at IS NULL OR extraction_next_attempt_at <= now())
      RETURNING text, extraction_attempts`,
    sessionId, idx, orgId, userId, MAX_ATTEMPTS, leaseExpiresAt,
  );
  const row = claimed?.[0];
  if (!row) return { claimed: false };
  try {
    const result = await extract(row.text);
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.meeting_segments
          SET extraction=$1::jsonb, extraction_status='done', extraction_next_attempt_at=NULL, extraction_lease_expires_at=NULL, extraction_last_error=NULL
        WHERE session_id=$2::uuid AND idx=$3 AND org_id=$4::uuid AND user_id=$5::uuid`,
      JSON.stringify(result), sessionId, idx, orgId, userId,
    );
    return { claimed: true, ok: true };
  } catch (error) {
    const attempt = Number(row.extraction_attempts || 1);
    const retryAt = attempt < MAX_ATTEMPTS ? new Date(Date.now() + extractionRetryDelayMs(attempt)) : null;
    await prisma.$executeRawUnsafe(
      `UPDATE hivemind.meeting_segments
          SET extraction_status='error', extraction_next_attempt_at=$1, extraction_lease_expires_at=NULL, extraction_last_error=$2
        WHERE session_id=$3::uuid AND idx=$4 AND org_id=$5::uuid AND user_id=$6::uuid`,
      retryAt, String(error?.message || error).slice(0, 500), sessionId, idx, orgId, userId,
    ).catch(() => {});
    return { claimed: true, ok: false, retryAt, error: String(error?.message || error) };
  }
}

/** Maintenance worker: boundedly replays unfinished segment extraction after a
 * process restart, provider outage, or fire-and-forget loss. */
export async function reconcileMeetingSegmentExtractions(prisma, { limit = 25 } = {}) {
  // A process can die after taking a lease. If it was already on its final
  // attempt, surface a terminal error instead of leaving the session forever
  // "processing" with no retry and no explanation.
  await prisma.$executeRawUnsafe(
    `UPDATE hivemind.meeting_segments
        SET extraction_status='error', extraction_lease_expires_at=NULL,
            extraction_last_error=COALESCE(extraction_last_error, 'Extraction worker lease expired after final attempt')
      WHERE extraction_status='processing' AND extraction_attempts >= $1
        AND extraction_lease_expires_at < now()`,
    MAX_ATTEMPTS,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT session_id, idx, org_id, user_id
       FROM hivemind.meeting_segments
      WHERE (extraction_status IN ('pending','error') OR (extraction_status='processing' AND extraction_lease_expires_at < now()))
        AND extraction_attempts < $1
        AND (extraction_next_attempt_at IS NULL OR extraction_next_attempt_at <= now())
      ORDER BY created_at ASC
      LIMIT $2`,
    MAX_ATTEMPTS, Math.max(1, Math.min(100, Number(limit) || 25)),
  );
  const results = [];
  for (const row of rows || []) {
    results.push(await processMeetingSegmentExtraction(prisma, {
      sessionId: row.session_id, idx: row.idx, orgId: row.org_id, userId: row.user_id,
    }));
  }
  return { scanned: rows?.length || 0, completed: results.filter((result) => result.ok).length, failed: results.filter((result) => result.claimed && !result.ok).length };
}
