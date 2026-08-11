/**
 * HIVE-MIND — Single ground-truth Speech-to-Text (STT) route + transcription helper.
 *
 * ONE api reference: sttRoute() resolves provider + base url + key ONCE from
 * STT_PROVIDER (groq | openrouter) — the single ground truth shared by every STT
 * feature (AI meeting notes, audio-file ingestion, tara voice).
 *
 * PER-FEATURE model: each feature passes its OWN model env (e.g. MEETING_STT_MODEL,
 * INGEST_STT_MODEL). That precedence is: feature env → global STT_MODEL → provider
 * default. So one switch (STT_PROVIDER) picks the api reference; one env per feature
 * picks that feature's model.
 *
 * transcribeAudio() handles THREE provider request shapes:
 *   - Groq multipart whisper (/audio/transcriptions)
 *   - OpenRouter whisper-style STT (parakeet, /audio/transcriptions)
 *   - OpenRouter chat-audio (Gemini / gpt-audio via /chat/completions with an
 *     input_audio content part) — the multilingual batch path for meetings,
 *     which transcribes mixed German+English far better than parakeet.
 * It retries transient failures (+ Groq billing-block 400s), and — when the
 * OTHER provider's key is present — fails over once so STT survives a
 * single-provider outage or billing block.
 *
 * @module src/llm/stt-route
 */
const GROQ_STT_DEFAULT = 'whisper-large-v3';
const OPENROUTER_STT_DEFAULT = 'nvidia/parakeet-tdt-0.6b-v3';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Resolve the single STT api reference (provider + url + key) and the model for a
 * given feature. featureModel wins; else global STT_MODEL; else provider default.
 * @param {string} [featureModel] - the feature's own model env value
 * @param {string} [providerOverride] - force a provider (used for failover)
 * @returns {{provider:string,shape?:string,url:string,key:string,model:string}}
 */
export function sttRoute(featureModel, providerOverride) {
  const requestedProvider = (providerOverride || process.env.STT_PROVIDER || 'groq').toLowerCase();
  const provider = !providerOverride && requestedProvider === 'groq' && !process.env.GROQ_API_KEY && process.env.OPENROUTER_API_KEY
    ? 'openrouter'
    : (!providerOverride && requestedProvider === 'openrouter' && !process.env.OPENROUTER_API_KEY && process.env.GROQ_API_KEY
      ? 'groq'
      : requestedProvider);
  const switchedForAvailability = provider !== requestedProvider;
  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    const model = (providerOverride || switchedForAvailability ? null : featureModel) || process.env.STT_MODEL || OPENROUTER_STT_DEFAULT;
    // Multilingual audio-LLMs (Gemini, gpt-audio) transcribe via the CHAT
    // completions API with an input_audio content part — NOT the whisper-style
    // /audio/transcriptions endpoint parakeet uses. Route them there and mark
    // the shape so _post builds the chat body. This is what makes mixed
    // German+English meetings transcribe accurately (parakeet is en-centric).
    const isChatAudio = /^(google\/|openai\/gpt-audio)/i.test(model) || /gemini/i.test(model);
    return {
      provider: 'openrouter',
      shape: isChatAudio ? 'chat-audio' : 'whisper',
      url: isChatAudio
        ? (process.env.OPENROUTER_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions')
        : (process.env.OPENROUTER_STT_URL || 'https://openrouter.ai/api/v1/audio/transcriptions'),
      key: process.env.OPENROUTER_API_KEY,
      model,
    };
  }
  // Mirror of the openrouter branch's model guard: an OpenRouter model id
  // (e.g. nvidia/parakeet…) is meaningless to Groq whisper. When we're FORCED
  // onto groq (failover) — or the global STT_MODEL is an openrouter-style id —
  // fall back to the Groq whisper model instead of shipping a bad model id.
  const _globalModel = process.env.STT_MODEL || '';
  const _groqSafeGlobal = _globalModel && !_globalModel.includes('/') ? _globalModel : '';
  return {
    provider: 'groq',
    shape: 'whisper',
    url: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/audio/transcriptions',
    key: process.env.GROQ_API_KEY || '',
    model: (providerOverride || switchedForAvailability ? null : featureModel) || _groqSafeGlobal || process.env.GROQ_WHISPER_MODEL || GROQ_STT_DEFAULT,
  };
}

const _OR_HEADERS = (key) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://hivemind.davinciai.eu',
  'X-Title': 'HIVEMIND',
});

async function _post(route, opts, timeoutMs) {
  const { audio, filename, contentType, prompt, temperature, response_format } = opts;
  const signal = AbortSignal.timeout(timeoutMs);
  const fmt = ((contentType || 'audio/wav').split('/')[1] || 'wav').split(';')[0];

  if (route.provider === 'openrouter') {
    const b64 = Buffer.from(audio).toString('base64');
    // Chat-audio shape (Gemini / gpt-audio): a strict verbatim-transcription
    // instruction + the audio as an input_audio content part. Multilingual by
    // default — we do NOT force a language so mixed de/en is transcribed as
    // spoken. temperature 0 for faithful transcription.
    if (route.shape === 'chat-audio') {
      const instr =
        'You are a verbatim speech-to-text engine. Transcribe the audio EXACTLY as spoken, in the '
        + 'original language(s). Meetings often mix German and English — keep each utterance in the '
        + 'language it was actually spoken; do NOT translate. Preserve names, numbers, company and '
        + 'product terms precisely. Start a new line when the speaker clearly changes. Output ONLY the '
        + 'raw transcript text — no preamble, no timestamps, no commentary.'
        + (prompt ? ` Names/terms that may appear: ${String(prompt).slice(0, 500)}` : '');
      return fetch(route.url, {
        method: 'POST', headers: _OR_HEADERS(route.key), signal,
        body: JSON.stringify({
          model: route.model,
          temperature: temperature ?? 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: instr },
              { type: 'input_audio', input_audio: { data: b64, format: fmt } },
            ],
          }],
        }),
      });
    }
    // Whisper-style OpenRouter STT (parakeet).
    return fetch(route.url, {
      method: 'POST', headers: _OR_HEADERS(route.key), signal,
      body: JSON.stringify({ model: route.model, input_audio: { data: b64, format: fmt } }),
    });
  }

  // Groq (OpenAI-compatible whisper): multipart.
  const ext = ((contentType || 'audio/webm').split('/')[1] || 'webm').split(';')[0];
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: contentType || 'audio/webm' }), filename || `audio.${ext}`);
  fd.append('model', route.model);
  fd.append('response_format', response_format || 'verbose_json');
  if (temperature !== undefined && temperature !== null) fd.append('temperature', String(temperature));
  if (prompt) fd.append('prompt', String(prompt));
  return fetch(route.url, { method: 'POST', headers: { Authorization: `Bearer ${route.key}` }, body: fd, signal });
}

async function _run(route, opts, maxAttempts, timeoutMs) {
  let status = 0;
  let detail = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await _post(route, opts, timeoutMs);
      if (r.ok) {
        const j = await r.json();
        // Chat-audio returns the transcript in the chat message content; whisper
        // shapes return { text, segments, language }.
        if (route.shape === 'chat-audio') {
          const text = j.choices?.[0]?.message?.content || '';
          return { ok: true, status: 200, provider: route.provider, model: route.model, text: String(text).trim(), segments: [], language: null };
        }
        return {
          ok: true, status: 200, provider: route.provider, model: route.model,
          text: j.text || '', segments: Array.isArray(j.segments) ? j.segments : [], language: j.language || null,
        };
      }
      status = r.status;
      detail = (await r.text().catch(() => '')).slice(0, 200);
      // Retry ONLY transient classes (429/5xx) on the same provider. A billing
      // block (400 organization_delinquent) or a client error won't recover by
      // retrying — break immediately so transcribeAudio fails over fast.
      const transient = RETRYABLE_STATUS.has(r.status);
      if (!transient || attempt === maxAttempts) break;
      const retryAfter = Number(r.headers.get('retry-after')) || 0;
      await new Promise((rs) => setTimeout(rs, retryAfter > 0 ? retryAfter * 1000 : Math.min(800 * 2 ** (attempt - 1), 4000)));
    } catch (e) {
      status = 0;
      detail = e && e.name === 'TimeoutError' ? `timeout (${timeoutMs}ms)` : (e && e.message) || 'network error';
      if (attempt === maxAttempts) break;
      await new Promise((rs) => setTimeout(rs, Math.min(800 * 2 ** (attempt - 1), 4000)));
    }
  }
  return { ok: false, status, detail, provider: route.provider, model: route.model };
}

/**
 * Transcribe audio through the single ground-truth STT route, with retry + a
 * one-shot cross-provider failover when the other provider's key is present.
 *
 * @param {Object} opts
 * @param {Buffer|Uint8Array} opts.audio
 * @param {string} [opts.filename]
 * @param {string} [opts.contentType]
 * @param {string} [opts.model] - the feature's model env value (e.g. MEETING_STT_MODEL)
 * @param {string} [opts.prompt] - context (names/terms); used by Groq whisper + chat-audio
 * @param {number} [opts.temperature]
 * @param {string} [opts.response_format='verbose_json']
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.timeoutMs=300000]
 * @returns {Promise<{ok:boolean,status:number,provider:string,model:string,text?:string,segments?:Array,language?:string,detail?:string,failedOver?:string}>}
 */
export async function transcribeAudio(opts) {
  const { model, maxAttempts = 3, timeoutMs = 300000 } = opts;
  const primary = sttRoute(model);
  let res = await _run(primary, opts, maxAttempts, timeoutMs);
  if (res.ok) return res;

  // OpenRouter intermittently returns a 400 "model does not exist" for a model
  // that DOES exist (upstream routing flake — verified: the same request
  // succeeds on retry). _run treats 400 as non-transient, so retry chat-audio
  // ONCE here before falling back.
  if (!res.ok && primary.shape === 'chat-audio' && /does not exist|no (?:allowed )?providers|not a valid model/i.test(res.detail || '')) {
    const retry = await _run(primary, opts, 1, timeoutMs);
    if (retry.ok) return retry;
    res = retry;
  }

  // Same-provider model fallback: a chat-audio (Gemini) model that keeps failing
  // on OpenRouter degrades to OpenRouter's whisper-style STT (parakeet) — still
  // multilingual-capable, always available — before we cross providers.
  if (primary.provider === 'openrouter' && primary.shape === 'chat-audio' && process.env.OPENROUTER_API_KEY) {
    const parakeet = sttRoute(process.env.OPENROUTER_STT_FALLBACK_MODEL || OPENROUTER_STT_DEFAULT);
    if (parakeet.shape === 'whisper') {
      const r1 = await _run(parakeet, opts, 2, timeoutMs);
      if (r1.ok) {
        r1.failedOver = `${primary.model}→${parakeet.model}`;
        return r1;
      }
    }
  }

  // Single-shot cross-provider failover (outage / billing block) so STT never goes dark.
  const altProvider = primary.provider === 'groq' ? 'openrouter' : 'groq';
  const altUsable = altProvider === 'openrouter' ? !!process.env.OPENROUTER_API_KEY : !!process.env.GROQ_API_KEY;
  if (altUsable) {
    const alt = sttRoute(model, altProvider);
    const r2 = await _run(alt, opts, 1, timeoutMs);
    if (r2.ok) {
      r2.failedOver = primary.provider;
      return r2;
    }
  }
  return res; // surface the primary failure (status/detail) to the caller
}

export default transcribeAudio;
