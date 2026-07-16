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
 * transcribeAudio() handles the two provider request shapes (Groq multipart whisper
 * / OpenRouter base64 parakeet), retries transient failures (+ Groq billing-block
 * 400s), and — when the OTHER provider's key is present — fails over once so STT
 * survives a single-provider outage or billing block.
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
 * @returns {{provider:string,url:string,key:string,model:string}}
 */
export function sttRoute(featureModel, providerOverride) {
  const provider = (providerOverride || process.env.STT_PROVIDER || 'groq').toLowerCase();
  if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
      url: process.env.OPENROUTER_STT_URL || 'https://openrouter.ai/api/v1/audio/transcriptions',
      key: process.env.OPENROUTER_API_KEY,
      // a Groq whisper model id is meaningless to OpenRouter STT → only honor the
      // feature model when forcing a provider that matches; otherwise parakeet.
      model: (providerOverride ? null : featureModel) || process.env.STT_MODEL || OPENROUTER_STT_DEFAULT,
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
    url: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '') + '/audio/transcriptions',
    key: process.env.GROQ_API_KEY || '',
    model: (providerOverride ? null : featureModel) || _groqSafeGlobal || process.env.GROQ_WHISPER_MODEL || GROQ_STT_DEFAULT,
  };
}

async function _post(route, opts, timeoutMs) {
  const { audio, filename, contentType, prompt, temperature, response_format } = opts;
  const signal = AbortSignal.timeout(timeoutMs);
  if (route.provider === 'openrouter') {
    const fmt = ((contentType || 'audio/wav').split('/')[1] || 'wav').split(';')[0];
    const b64 = Buffer.from(audio).toString('base64');
    return fetch(route.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${route.key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hivemind.davinciai.eu',
        'X-Title': 'HIVEMIND',
      },
      body: JSON.stringify({ model: route.model, input_audio: { data: b64, format: fmt } }),
      signal,
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
 * @param {string} [opts.prompt] - Groq whisper context prompt (ignored by OpenRouter)
 * @param {number} [opts.temperature]
 * @param {string} [opts.response_format='verbose_json']
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.timeoutMs=300000]
 * @returns {Promise<{ok:boolean,status:number,provider:string,model:string,text?:string,segments?:Array,language?:string,detail?:string,failedOver?:string}>}
 */
export async function transcribeAudio(opts) {
  const { model, maxAttempts = 3, timeoutMs = 300000 } = opts;
  const primary = sttRoute(model);
  const res = await _run(primary, opts, maxAttempts, timeoutMs);
  if (res.ok) return res;

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
