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

// Live Grok voice roster. The adapter owns the xAI integration (it holds
// XAI_API_KEY and queries GET /v1/tts/voices + /v1/custom-voices), so core asks
// IT rather than duplicating the key here or hand-maintaining a list that drifts
// from xAI's catalogue. Cached 10 min; falls back to the documented built-ins
// above so the picker is never empty when the adapter is unreachable.
const GROK_VOICES_TTL_MS = 10 * 60 * 1000;
let _grokVoiceCache = { voices: null, expiresAt: 0 };
async function loadGrokVoices() {
  if (_grokVoiceCache.voices && _grokVoiceCache.expiresAt > Date.now()) return _grokVoiceCache.voices;
  const base = (process.env.TARA_GROK_INTERNAL_URL || 'http://tara-grok:8092').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/voices`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error(`adapter ${response.status}`);
    const data = await response.json();
    const voices = Array.isArray(data?.voices) ? data.voices.filter((v) => v && v.id) : [];
    if (!voices.length) throw new Error('empty roster');
    _grokVoiceCache = { voices, expiresAt: Date.now() + GROK_VOICES_TTL_MS };
    return voices;
  } catch (error) {
    console.warn('[tara-grok] voice roster unavailable, serving built-ins:', error.message);
    return GROK_VOICES;
  }
}

const GROK_CONFIG_KEYS = new Set([
  'model', 'voice_id', 'language', 'reasoning_effort', 'output_speed', 'keyterms',
  'pronunciation_replacements', 'vad_threshold', 'vad_silence_duration_ms',
  'vad_prefix_padding_ms',
]);
const DEFAULT_GROK_CONFIG = {
  model: GROK_MODEL, voice_id: 'eve', language: 'en', reasoning_effort: 'high',
  output_speed: 1, keyterms: [], pronunciation_replacements: {}, vad_threshold: 0.85,
  vad_silence_duration_ms: 650, vad_prefix_padding_ms: 333,
};

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
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function boundedString(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : null; }
function validatedGrokConfig(base, patch = {}) {
  if (!plainObject(patch)) throw Object.assign(new Error('invalid_grok_config'), { statusCode: 400 });
  for (const key of Object.keys(patch)) {
    if (!GROK_CONFIG_KEYS.has(key)) throw Object.assign(new Error(`unsupported_grok_config:${key}`), { statusCode: 400 });
  }
  const next = { ...DEFAULT_GROK_CONFIG, ...(plainObject(base) ? base : {}), ...patch, model: GROK_MODEL };
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(String(next.language))) throw Object.assign(new Error('invalid_language'), { statusCode: 400 });
  if (!['high', 'none'].includes(next.reasoning_effort)) throw Object.assign(new Error('invalid_reasoning_effort'), { statusCode: 400 });
  if (!Number.isFinite(Number(next.output_speed)) || Number(next.output_speed) < 0.7 || Number(next.output_speed) > 1.5) throw Object.assign(new Error('invalid_output_speed'), { statusCode: 400 });
  if (!Number.isFinite(Number(next.vad_threshold)) || Number(next.vad_threshold) < 0.1 || Number(next.vad_threshold) > 0.9) throw Object.assign(new Error('invalid_vad_threshold'), { statusCode: 400 });
  for (const key of ['vad_silence_duration_ms', 'vad_prefix_padding_ms']) if (!Number.isInteger(Number(next[key])) || Number(next[key]) < 0 || Number(next[key]) > 10_000) throw Object.assign(new Error(`invalid_${key}`), { statusCode: 400 });
  if (!Array.isArray(next.keyterms) || next.keyterms.length > 100 || next.keyterms.some((item) => !boundedString(item, 50))) throw Object.assign(new Error('invalid_keyterms'), { statusCode: 400 });
  if (!plainObject(next.pronunciation_replacements) || Object.keys(next.pronunciation_replacements).length > 100 || Object.entries(next.pronunciation_replacements).some(([from, to]) => !boundedString(from, 100) || !boundedString(to, 100))) throw Object.assign(new Error('invalid_pronunciation_replacements'), { statusCode: 400 });
  next.language = String(next.language);
  next.voice_id = boundedString(next.voice_id, 120) || 'eve';
  next.output_speed = Number(next.output_speed);
  next.vad_threshold = Number(next.vad_threshold);
  next.vad_silence_duration_ms = Number(next.vad_silence_duration_ms);
  next.vad_prefix_padding_ms = Number(next.vad_prefix_padding_ms);
  next.keyterms = next.keyterms.map((item) => boundedString(item, 50));
  return next;
}

export function createTaraGrokRuntime({ prisma, recallFn, memoryStore, getTaraConfig }) {
  const capabilitySecret = process.env.TARA_GROK_CAPABILITY_SECRET || '';
  const serviceToken = process.env.TARA_GROK_SERVICE_TOKEN || '';
  const grokPublicWs = (process.env.TARA_GROK_PUBLIC_WS_URL || 'wss://core.singulancelabs.com/voice-grok/voice').replace(/\/$/, '');

  async function configFor(orgId) {
    return prisma.taraRuntimeConfig.upsert({
      where: { orgId }, update: {},
      create: { orgId, defaultProvider: 'deepgram', deepgramConfig: {}, grokConfig: DEFAULT_GROK_CONFIG },
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
      let grok;
      try { grok = validatedGrokConfig(current.grokConfig, body.grok || {}); }
      catch (error) { return reply(res, { error: error.message }, error.statusCode || 400); }
      const saved = await prisma.taraRuntimeConfig.update({ where: { orgId }, data: { defaultProvider: provider, deepgramConfig: body.deepgram || current.deepgramConfig, grokConfig: grok, revision: { increment: 1 }, updatedBy: userId || null } });
      return reply(res, { config: publicConfig(saved) });
    }

    if (pathname === '/api/tara/voice-sessions' && method === 'POST') {
      if (!capabilitySecret) return reply(res, { error: 'grok_capability_not_configured' }, 503);
      const current = await configFor(orgId);
      const provider = current.defaultProvider;
      if (!PROVIDERS.has(provider)) return reply(res, { error: 'invalid_provider' }, 400);
      let providerConfig;
      try { providerConfig = provider === 'grok' ? validatedGrokConfig(current.grokConfig) : current.deepgramConfig || {}; }
      catch (error) { return reply(res, { error: error.message }, error.statusCode || 400); }
      const mode = body.mode === 'internal' ? 'internal' : 'external';
      const taraConfig = await getTaraConfig?.({ userId, orgId }).catch(() => null);
      const selectedSkillId = mode === 'internal' ? taraConfig?.selected_internal_skill_id : taraConfig?.selected_external_skill_id;
      const configuredPrompt = mode === 'internal' ? taraConfig?.internal_prompt : [taraConfig?.system_prompt, taraConfig?.clinical_prompt].filter(Boolean).join('\n\n');
      let effectiveProviderConfig = providerConfig;
      if (provider === 'grok') {
        try {
          effectiveProviderConfig = validatedGrokConfig(providerConfig, {
            ...(body.voice_id ? { voice_id: boundedString(body.voice_id, 120) } : {}),
            ...(body.language ? { language: boundedString(body.language, 16) } : {}),
          });
        } catch (error) { return reply(res, { error: error.message }, error.statusCode || 400); }
      }
      const snapshot = {
        ...effectiveProviderConfig,
        provider,
        model: provider === 'grok' ? GROK_MODEL : effectiveProviderConfig.model,
        voice_id: effectiveProviderConfig.voice_id || null,
        language: effectiveProviderConfig.language || 'en',
        mode,
        goal: boundedString(body.goal, 300) || '',
        skill_id: selectedSkillId || null,
        config_revision: current.revision,
        instructions: boundedString(configuredPrompt, 12_000) || '',
      };
      const jti = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 90_000);
      const session = await prisma.taraVoiceSession.create({ data: { orgId, userId, provider, mode: snapshot.mode, capabilityJti: jti, configSnapshot: snapshot, expiresAt } });
      const token = capability({ iss: 'hivemind-core', aud: `tara-${provider}`, sub: userId, org_id: orgId, session_id: session.id, jti, exp: expiresAt.getTime(), operations: ['voice'] }, capabilitySecret);
      return reply(res, { session_id: session.id, provider, ws_url: provider === 'grok' ? grokPublicWs : `${(process.env.TARA_DEEPGRAM_PUBLIC_WS_URL || 'wss://core.singulancelabs.com/voice2/voice')}`, capability: token, expires_at: expiresAt.toISOString(), config_revision: current.revision, audio_format: { type: 'pcm16', sample_rate: 16000 } });
    }

    if (pathname === '/api/tara/voices' && method === 'GET') {
      const provider = url.searchParams.get('provider') || (await configFor(orgId)).defaultProvider;
      if (!PROVIDERS.has(provider)) return reply(res, { error: 'invalid_provider' }, 400);
      const voices = provider === 'grok' ? await loadGrokVoices() : [];
      return reply(res, { provider, voices, delegated: provider !== 'grok' });
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
        const compactList = (value, maxItems, maxChars) => Array.isArray(value)
          ? value.slice(0, maxItems).map((item) => boundedString(item, maxChars)).filter(Boolean)
          : [];
        const state = {
          phase: boundedString(args.phase, 80),
          hypotheses: compactList(args.hypotheses, 4, 500),
          next_question_intent: boundedString(args.next_question_intent, 500),
          directive: boundedString(args.directive, 500),
          goal_progress: boundedString(args.goal_progress, 500),
          red_flags: compactList(args.red_flags, 8, 300),
          stop_reason: boundedString(args.stop_reason, 300),
        };
        await prisma.taraProviderEvent.create({ data: { provider: session.provider, providerEventId: eventId(), sessionId: session.id, orgId: session.orgId, eventType: 'strategy_state', payload: state } });
        return reply(res, { committed: true });
      }
      return reply(res, { error: 'tool_not_approved' }, 403);
    }
    return false;
  };
}
