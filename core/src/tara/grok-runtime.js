import crypto from 'node:crypto';

const PROVIDERS = new Set(['deepgram', 'grok']);
const GROK_MODEL = 'grok-voice-think-fast-1.0';
const GROK_VOICES = [
  ['eve', 'Eve', 'feminine', 'Clear, warm and conversational'],
  ['ara', 'Ara', 'feminine', 'Calm and professional'],
  ['rex', 'Rex', 'masculine', 'Confident and direct'],
  ['sal', 'Sal', 'neutral', 'Balanced and natural'],
  ['leo', 'Leo', 'masculine', 'Warm and measured'],
].map(([id, name, gender, description]) => ({ id, provider: 'grok', name, gender, description, language: 'en', custom: false }));

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
function safeEqual(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function capability(payload, secret) {
  const body = b64(payload);
  return `${body}.${sign(body, secret)}`;
}
function verifyCapability(token, secret) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature || !safeEqual(signature, sign(body, secret))) return null;
  try { const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return value.exp > Date.now() ? value : null; } catch { return null; }
}
function eventId() { return crypto.randomUUID(); }

export function createTaraGrokRuntime({ prisma, recallFn, memoryStore }) {
  const capabilitySecret = process.env.TARA_GROK_CAPABILITY_SECRET || '';
  const serviceToken = process.env.TARA_GROK_SERVICE_TOKEN || '';
  const grokPublicWs = (process.env.TARA_GROK_PUBLIC_WS_URL || 'wss://core.singulancelabs.com/voice-grok/voice').replace(/\/$/, '');

  async function configFor(orgId) {
    return prisma.taraRuntimeConfig.upsert({
      where: { orgId }, update: {},
      create: { orgId, defaultProvider: 'deepgram', deepgramConfig: {}, grokConfig: { model: GROK_MODEL, reasoning_effort: 'high', voice_id: 'eve', language: 'en', output_speed: 1 } },
    });
  }
  function serviceAuthorized(req) {
    const header = String(req.headers.authorization || '');
    return !!serviceToken && safeEqual(header, `Bearer ${serviceToken}`);
  }
  function publicConfig(row) {
    return { default_provider: row.defaultProvider, revision: row.revision, deepgram: row.deepgramConfig || {}, grok: row.grokConfig || {} };
  }

  return async function handle({ pathname, method, body, url, req, res, userId, orgId, jsonResponse, accessContext }) {
    const reply = (...args) => { jsonResponse(...args); return true; };
    if (pathname === '/api/tara/runtime-config') {
      if (!orgId) return reply(res, { error: 'org_required' }, 401);
      const current = await configFor(orgId);
      if (method === 'GET') return reply(res, { config: publicConfig(current) });
      if (method !== 'PATCH') return false;
      const expected = Number(body.expected_revision);
      if (!Number.isInteger(expected) || expected !== current.revision) return reply(res, { error: 'stale_revision', revision: current.revision }, 409);
      const provider = body.default_provider || current.defaultProvider;
      if (!PROVIDERS.has(provider)) return reply(res, { error: 'invalid_provider' }, 400);
      const grok = { ...(current.grokConfig || {}), ...(body.grok || {}) };
      if (grok.model && grok.model !== GROK_MODEL) return reply(res, { error: 'grok_model_must_be_pinned' }, 400);
      const saved = await prisma.taraRuntimeConfig.update({ where: { orgId }, data: { defaultProvider: provider, deepgramConfig: body.deepgram || current.deepgramConfig, grokConfig: { ...grok, model: GROK_MODEL }, revision: { increment: 1 }, updatedBy: userId || null } });
      return reply(res, { config: publicConfig(saved) });
    }

    if (pathname === '/api/tara/voice-sessions' && method === 'POST') {
      if (!capabilitySecret) return reply(res, { error: 'grok_capability_not_configured' }, 503);
      const current = await configFor(orgId);
      const provider = body.provider || current.defaultProvider;
      if (!PROVIDERS.has(provider)) return reply(res, { error: 'invalid_provider' }, 400);
      const providerConfig = provider === 'grok' ? current.grokConfig || {} : current.deepgramConfig || {};
      const snapshot = { ...providerConfig, provider, model: provider === 'grok' ? GROK_MODEL : providerConfig.model, voice_id: body.voice_id || providerConfig.voice_id || null, language: String(body.language || providerConfig.language || 'en').slice(0, 16), mode: body.mode === 'internal' ? 'internal' : 'external', goal: String(body.goal || '').slice(0, 300), skill_id: body.skill_id || null };
      const jti = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 90_000);
      const session = await prisma.taraVoiceSession.create({ data: { orgId, userId, provider, mode: snapshot.mode, capabilityJti: jti, configSnapshot: snapshot, expiresAt } });
      const token = capability({ iss: 'hivemind-core', aud: `tara-${provider}`, sub: userId, org_id: orgId, session_id: session.id, jti, exp: expiresAt.getTime(), operations: ['voice'] }, capabilitySecret);
      return reply(res, { session_id: session.id, provider, ws_url: provider === 'grok' ? grokPublicWs : `${(process.env.TARA_DEEPGRAM_PUBLIC_WS_URL || 'wss://core.singulancelabs.com/voice2/voice')}`, capability: token, expires_at: expiresAt.toISOString(), config_revision: current.revision, audio_format: { type: 'pcm16', sample_rate: 16000 } });
    }

    if (pathname === '/api/tara/voices' && method === 'GET') {
      const provider = url.searchParams.get('provider') || (await configFor(orgId)).defaultProvider;
      if (!PROVIDERS.has(provider)) return reply(res, { error: 'invalid_provider' }, 400);
      return reply(res, { provider, voices: provider === 'grok' ? GROK_VOICES : [], delegated: provider !== 'grok' });
    }

    const consume = pathname.match(/^\/internal\/v1\/tara\/calls\/([0-9a-f-]{36})\/consume$/i);
    if (consume && method === 'POST') {
      if (!serviceAuthorized(req)) return reply(res, { error: 'unauthorized' }, 401);
      const claims = verifyCapability(body.capability, capabilitySecret);
      if (!claims || claims.aud !== 'tara-grok' || claims.session_id !== consume[1]) return reply(res, { error: 'invalid_capability' }, 401);
      const changed = await prisma.taraVoiceSession.updateMany({ where: { id: consume[1], capabilityJti: claims.jti, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
      if (!changed.count) return reply(res, { error: 'capability_consumed_or_expired' }, 409);
      const session = await prisma.taraVoiceSession.findUnique({ where: { id: consume[1] } });
      return reply(res, { session_id: session.id, config: session.configSnapshot, org_id: session.orgId, user_id: session.userId });
    }

    const events = pathname.match(/^\/internal\/v1\/tara\/calls\/([0-9a-f-]{36})\/events$/i);
    if (events && method === 'POST') {
      if (!serviceAuthorized(req)) return reply(res, { error: 'unauthorized' }, 401);
      const session = await prisma.taraVoiceSession.findUnique({ where: { id: events[1] } });
      if (!session) return reply(res, { error: 'session_not_found' }, 404);
      const id = String(body.event_id || '');
      if (!id) return reply(res, { error: 'event_id_required' }, 400);
      try { await prisma.taraProviderEvent.create({ data: { provider: session.provider, providerEventId: id, sessionId: session.id, orgId: session.orgId, eventType: String(body.type || 'unknown'), payload: body.payload || {} } }); }
      catch (error) { if (error.code === 'P2002') return reply(res, { ok: true, duplicate: true }); throw error; }
      const snapshot = session.configSnapshot || {};
      const call = await prisma.taraCall.upsert({ where: { orgId_sessionId: { orgId: session.orgId, sessionId: session.id } }, update: {}, create: { orgId: session.orgId, userId: session.userId, sessionId: session.id, provider: session.provider, providerModel: snapshot.model || null, configRevision: Number(snapshot.config_revision || 1), mode: session.mode, voiceId: snapshot.voice_id || null, language: snapshot.language || 'en', goal: snapshot.goal || null } });
      if (body.type === 'completed' || body.type === 'failed') await prisma.taraCall.update({ where: { id: call.id }, data: { status: body.type === 'completed' ? 'completed' : 'failed', endedAt: new Date(), failureCode: body.payload?.failure_code || null } });
      return reply(res, { ok: true });
    }

    const toolCall = pathname.match(/^\/internal\/v1\/tara\/calls\/([0-9a-f-]{36})\/tools$/i);
    if (toolCall && method === 'POST') {
      if (!serviceAuthorized(req)) return reply(res, { error: 'unauthorized' }, 401);
      const session = await prisma.taraVoiceSession.findUnique({ where: { id: toolCall[1] } });
      if (!session) return reply(res, { error: 'session_not_found' }, 404);
      const name = String(body.name || '');
      const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
      if (name === 'hivemind_recall') {
        const query = String(args.query || '').trim().slice(0, 500);
        if (!query) return reply(res, { error: 'query_required' }, 400);
        const recalled = await recallFn(memoryStore, { query_context: query, user_id: session.userId, org_id: session.orgId, max_memories: 5 });
        const evidence = (recalled?.memories || recalled?.results || []).slice(0, 5).map((item) => ({ title: item.title || null, content: String(item.content || item.text || '').slice(0, 800), source: item.source || null }));
        await prisma.taraProviderEvent.create({ data: { provider: session.provider, providerEventId: eventId(), sessionId: session.id, orgId: session.orgId, eventType: 'tool_called', payload: { name, query } } });
        return reply(res, { evidence });
      }
      if (name === 'commit_strategy_state') {
        const state = { phase: args.phase || null, hypotheses: Array.isArray(args.hypotheses) ? args.hypotheses.slice(0, 4) : [], next_question_intent: args.next_question_intent || null, directive: args.directive || null, goal_progress: args.goal_progress || null, red_flags: Array.isArray(args.red_flags) ? args.red_flags.slice(0, 8) : [], stop_reason: args.stop_reason || null };
        await prisma.taraProviderEvent.create({ data: { provider: session.provider, providerEventId: eventId(), sessionId: session.id, orgId: session.orgId, eventType: 'strategy_state', payload: state } });
        return reply(res, { committed: true });
      }
      return reply(res, { error: 'tool_not_approved' }, 403);
    }
    return false;
  };
}
