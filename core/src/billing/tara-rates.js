/**
 * TARA per-call cost model — ONE place, like plans.js holds limits.
 * Nobody hardcodes a rate anywhere else. Every value is env-overridable so the
 * real bill can correct an estimate without a code change.
 *
 * Output unit: micros (1e-6 USD). estimated_cost_micros on tara_calls.
 *
 * Grok: xAI bills the realtime voice session by wall-clock. Measured live at
 *   $0.0495/min = 825 micros/sec. That IS the bill — no token math needed.
 * Deepgram: BYO-LLM+BYO-TTS tier. Cost = agent wall-clock + Cartesia wall-clock
 *   + the grounded-answer LLM tokens (gpt-oss-120b via OpenRouter/Cerebras).
 */
const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };

const RATES = {
  // Grok realtime — bill-derived, single number.
  grokMicrosPerSec: n(process.env.TARA_RATE_GROK_MICROS_PER_SEC, 825),
  // Deepgram Voice Agent BYO-LLM+TTS tier ($0.050/min PAYG → 833 micros/sec).
  deepgramAgentMicrosPerSec: n(process.env.TARA_RATE_DG_AGENT_MICROS_PER_SEC, 833),
  // Cartesia Sonic TTS, usage-metered (~$0.02/min equivalent → 333 micros/sec).
  cartesiaMicrosPerSec: n(process.env.TARA_RATE_CARTESIA_MICROS_PER_SEC, 333),
  // Grounded-answer LLM (gpt-oss-120b): OpenRouter list ≈ $0.15/1M in, $0.60/1M out.
  llmInMicrosPerToken: n(process.env.TARA_RATE_LLM_IN_MICROS_PER_TOKEN, 0.15),
  llmOutMicrosPerToken: n(process.env.TARA_RATE_LLM_OUT_MICROS_PER_TOKEN, 0.60),
};

/**
 * @param {{provider?:string, durationMs?:number, promptTokens?:number, completionTokens?:number}} call
 * @returns {number} integer micros (>= 0)
 */
function computeTaraCostMicros(call = {}) {
  const sec = Math.max(0, Number(call.durationMs) || 0) / 1000;
  const pt = Math.max(0, Number(call.promptTokens) || 0);
  const ct = Math.max(0, Number(call.completionTokens) || 0);
  const provider = String(call.provider || '').toLowerCase();
  let micros;
  if (provider === 'grok') {
    micros = sec * RATES.grokMicrosPerSec;
  } else {
    // deepgram (default): agent + cartesia wall-clock + LLM tokens
    micros = sec * (RATES.deepgramAgentMicrosPerSec + RATES.cartesiaMicrosPerSec)
           + pt * RATES.llmInMicrosPerToken
           + ct * RATES.llmOutMicrosPerToken;
  }
  return Math.round(micros);
}

export { RATES as TARA_RATES, computeTaraCostMicros };
