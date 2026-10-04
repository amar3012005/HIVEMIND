import { verifyHarnessRunnerServiceToken } from '../harness-chat/runner-service-token.js';
import { isHarnessSessionId } from '../harness-chat/connected-app-receipts.js';

// Only the authenticated runner assembles persona/context. Browser Tara requests
// cannot opt into this route or assert another native room's identity.
export async function handleNativeRuntimeVoice({ req, res, pathname, prisma, parseBody, jsonResponse, handler, secret }) {
  const match = pathname.match(/^\/internal\/v1\/harness-chat\/core\/v1\/tara\/native-voice(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) return false;
  let claims;
  try { claims = verifyHarnessRunnerServiceToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), { secret }); }
  catch { jsonResponse(res, { error: 'Unauthorized' }, 401); return true; }
  const member = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId: claims.sub, orgId: claims.org_id } }, select: { isActive: true } });
  if (!member?.isActive) { jsonResponse(res, { error: 'Organization membership required' }, 403); return true; }
  if (!match[1] && req.method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body || !isHarnessSessionId(body.session_id) || typeof body.instructions !== 'string' || !body.instructions.trim()
      || body.instructions.length > 60000 || typeof body.opening_instruction !== 'string' || body.opening_instruction.length > 4000
      || typeof body.initial_check_in !== 'boolean') {
      jsonResponse(res, { error: 'invalid_native_voice_context' }, 400); return true;
    }
    await handler({ req, res, pathname: '/api/tara/voice-sessions', method: 'POST', body: { mode: 'internal' },
      userId: claims.sub, orgId: claims.org_id, jsonResponse, nativeRuntimeContext: body });
    return true;
  }
  if (match[1] && req.method === 'GET') {
    const session = await prisma.taraVoiceSession.findFirst({ where: { id: match[1], userId: claims.sub, orgId: claims.org_id }, select: { configSnapshot: true } });
    const nativeId = session?.configSnapshot?.native_session_id;
    const expectedId = new URL(req.url, 'http://localhost').searchParams.get('session_id');
    if (!isHarnessSessionId(nativeId) || expectedId !== nativeId) { jsonResponse(res, { error: 'native_voice_not_found' }, 404); return true; }
    const call = await prisma.taraCall.findFirst({ where: { sessionId: match[1], userId: claims.sub, orgId: claims.org_id } });
    if (!call || !['completed', 'failed'].includes(call.status)) { jsonResponse(res, { status: 'pending' }, 202); return true; }
    const turns = call ? await prisma.taraTurn.findMany({ where: { callId: call.id, orgId: claims.org_id, userId: claims.sub }, orderBy: { seq: 'asc' }, take: 100 }) : [];
    const terminal = await prisma.taraProviderEvent.findFirst({ where: { sessionId: match[1], orgId: claims.org_id, eventType: { in: ['completed', 'failed'] } }, orderBy: { createdAt: 'desc' }, select: { payload: true } });
    jsonResponse(res, { had_user_speech: turns.some(turn => turn.userText?.trim()), initial_check_in: session.configSnapshot.initial_check_in === true, interrupted: call.status === 'failed' || terminal?.payload?.interrupted !== false, session_id: nativeId, call_id: match[1], status: call?.status || 'pending',
      turns: turns.map(turn => ({ seq: turn.seq, user_text: turn.userText, agent_text: turn.agentText })), failure_code: call?.failureCode || null });
    return true;
  }
  jsonResponse(res, { error: 'Method not allowed' }, 405); return true;
}
