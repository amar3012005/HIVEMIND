/** Only authenticated native answers to a saved same-room question confirm direction. */
export function nativeAnsweredAgendaSource(source, actorUserId, orgId) {
  return source?.kind === 'user-question-reply' && source.outcome === 'answered'
    && typeof source.callId === 'string' && source.callId.length > 0
    && source.questionCallId === source.callId && source.questionEventId === `late-${source.callId}`
    && source.questionAnswer === true && source.questionAnswerSubmission === true
    && source.authenticatedActor?.userId === actorUserId && source.authenticatedActor?.orgId === orgId;
}

/** SQL scope is supplied by the caller; a different room/org cannot witness this answer. */
export async function savedNativeAgendaQuestion(tx, schema, principal, source, replySeq) {
  if (!nativeAnsweredAgendaSource(source, principal.actorUserId ?? principal.userId, principal.orgId)) return false;
  const calls = await tx.$queryRawUnsafe(`SELECT payload FROM ${schema}.harness_session_events
    WHERE session_id=$1 AND org_id=$2::uuid AND user_id=$3::uuid AND event_type='tool/call'
      AND sequence<$4::bigint AND COALESCE(payload->'data',payload)->>'callId'=$5 LIMIT 2`,
    principal.runtimeSessionId, principal.orgId, principal.userId, replySeq, source.callId);
  if (calls.length !== 1) return false;
  const call = calls[0].payload.data ?? calls[0].payload;
  return call.name === 'ask_user_question' && call.callId === source.callId
    && Array.isArray(call.arguments?.questions) && call.arguments.questions.length > 0;
}
