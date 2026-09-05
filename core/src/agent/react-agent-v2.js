/**
 * Talk-to-HIVE — Plan-then-Act agent (v2).
 *
 * Replaces the prompt-rule-heavy v1 ReAct loop with a structured 4-step
 * pipeline. Each step is a single LLM call with a JSON-schema'd output,
 * so behaviour is auditable and deterministic.
 *
 *   1. intent_step  → fast language-agnostic LLM emits a required,
 *                     schema-validated route_chat_turn tool call.
 *   2. plan_step    → normalized intent emits {direct_answer, sub_queries[],
 *                     needs_traverse, needs_time_travel, needs_web,
 *                     intents[]}. No prose, structured JSON.
 *   3. evidence_step → one shared recall plan retrieves broad context,
 *                     checks coverage, and permits one typed escalation.
 *   4. answer_step   → LLM composes final response in the user's
 *                     selected language, grounded ONLY in the evidence
 *                     block. Returns {response, evidence_used:[ids],
 *                     confidence, gaps}.
 *
 * Endpoint contract identical to v1: { response, sources, usage,
 * assistant_name, steps[] } so FE/extension/CLI keep working unchanged.
 *
 * Language toggle (FE i18n) flows into plan_step (so non-English
 * intents parse correctly) AND answer_step (so the final reply is in
 * the chosen language). Sub-queries stay in English so memory recall
 * stays cross-lingual searchable.
 */

import { TOOL_SCHEMAS, dispatchTool as _dispatchTool } from './tool-registry.js';
import { validateGroundedClaims } from '../memory/recall-packet.js';
import { applyExplicitRecallControls, assessRecallCoverage, chooseRecallEscalation } from './chat-recall-policy.js';
import { projectRankedMemoryFallback } from './memory-evidence-projector.js';
import { appendGapClarification, buildSynthesisPromptArtifact, normalizeSearchableFollowUps, normalizeSuggestedFollowUps } from './chat-synthesis-prompt.js';
import { deriveAnswerContextStatus, normalizeAnswerCoverage, validateSupportedCoverage } from './chat-answer-coverage.js';
import { ORGANIZATIONAL_BRAIN_PERSONA, organizationalBrainIdentity } from './chat-persona-skill.js';
import { promptContributionTelemetry } from './chat-static-prompt-cache.js';
import { chooseSynthesisModel, hasGroundingEvidence, parseJsonObjectContent, scheduleShadowEvaluation, shouldOptimizeRecallQuery, shouldRetryAfterZeroCoverage, shouldRunRecallOptimizer, summarizeUsage } from './chat-synthesis-policy.js';
import { buildRecallIntentContext, fallbackRecallQueries, normalizeRecallOptimization } from './chat-query-optimizer.js';
import { buildProjectionCacheKey, getSharedChatProjectionCache } from './chat-cag-cache.js';
import { citationIdForEvidence, citationIdForMemory, ensureMemoryCitationPackets } from './chat-evidence-contract.js';
import {
  applyProgressiveRecallView,
  collapseNativeOnlyCompoundDecision,
  createProgressiveRecallSession,
  evidenceRenderLimit,
  evidenceWindowSizeForDepth,
} from './progressive-recall-session.js';
import { intentDecisionToPlan, parseChatIntent } from './chat-intent-decision.js';
import { enforceNativeGroundingDecision } from './chat-progressive-router.js';
import { buildStructuredRecallQuery } from './structured-recall-query.js';
import {
  chatCompletionFetch,
  chatCompletionStream,
  DEFAULT_CHAT_PLANNER_MODEL,
  DEFAULT_CHAT_SYNTHESIS_MODEL,
  resolveChatSynthesisModel,
} from '../llm/chat-provider.js';
import { remainingStageMs, runWithStageDeadline, StageDeadlineError } from '../runtime/stage-deadline.js';
import { promoteWebEvidenceWindow, publicWebFallbackEligible, recentPublicContextPacket, webResultPacket } from './web-fallback.js';

// Retry router: transient failures (TIMEOUT/RATE_LIMIT) get ONE auto-retry
// with exponential backoff. AUTH_ERROR / INVALID_ARGS / UNKNOWN_TOOL pass
// through immediately — those are not transient.
const RETRYABLE_FAILURES = new Set(['TIMEOUT', 'RATE_LIMIT']);

async function dispatchTool(name, args, ctx, opts = {}) {
  const t0 = Date.now();
  const invoke = async () => {
    if (ctx?._toolkit?.hasTool(name)) {
      const response = await ctx._toolkit.execute(name, args, ctx, {
        // These calls are assembled by the deterministic server orchestrator,
        // not copied from model-generated tool arguments.
        trustedInternalArgs: true,
      });
      if (response.status === 'error') {
        return { error: response.meta?.error || response.content?.[0]?.text || 'tool_error', _failure_mode: 'INVALID_ARGS' };
      }
      return response.meta?.raw ?? { content: response.content, status: response.status, ...response.meta };
    }
    return _dispatchTool(name, args, ctx, opts);
  };
  const first = await invoke();
  const logCall = (resp, retried) => {
    if (!ctx?._trace) return;
    ctx._trace.tool_calls.push({
      name, ms: Date.now() - t0,
      status: resp?.error ? 'error' : 'ok',
      ...(resp?._failure_mode ? { failure_mode: resp._failure_mode } : {}),
      ...(retried ? { retried_after: retried } : {}),
    });
  };
  if (!first?._failure_mode || !RETRYABLE_FAILURES.has(first._failure_mode)) {
    logCall(first, null);
    return first;
  }
  const backoff = first._failure_mode === 'RATE_LIMIT' ? 1500 : 400;
  if (remainingStageMs(Infinity) <= backoff) {
    logCall(first, null);
    return first;
  }
  await new Promise(r => setTimeout(r, backoff));
  const second = await invoke();
  if (second && !second.error) second._retried_after = first._failure_mode;
  logCall(second, first._failure_mode);
  return second;
}

// LLM budgets per step. gpt-oss reasoning models consume hidden
// reasoning_tokens before content tokens; budgets are sized so even
// chatty reasoning leaves room for the actual JSON output.
// Caps raised per user directive — internal steps and final answer
// both run on gpt-oss family; cost is acceptable, quality wins.
const PLAN_MAX_TOKENS    = Number(process.env.HIVEMIND_PLAN_MAX_TOKENS    || 4000);
const ANSWER_MAX_TOKENS  = Number(process.env.HIVEMIND_ANSWER_MAX_TOKENS  || 8000);
const DIRECT_MAX_TOKENS  = Number(process.env.HIVEMIND_DIRECT_MAX_TOKENS  || 2000);
const TURN_BUDGET_MS     = Number(process.env.HIVEMIND_AGENT_TURN_BUDGET_MS || 60_000);
// Recall retains one mixed top-15 pool. Semantic intent chooses one evidence
// window before synthesis (5/10/15); the turn never expands it afterward.
// Retrieval budget. 3000ms was BELOW this system's own measured retrieval latency: a cold recall
// runs to ~2600ms (keep-warm brings the warm floor to ~640ms, which is remote-Qdrant-bound), and
// evidence retrieval alone measured 258-967ms warm. So a cold turn had ~400ms of headroom for every
// hop combined and fell off the deadline — which is what produced a real "I don't have anything in
// my memory" for a topic the workspace DID hold, answered correctly on the retry seconds later.
// A slow answer is recoverable; a confident false negative is not, and the turn budget (60s) bounds
// the worst case anyway. Tune down only with a measurement, not a guess.
const RETRIEVAL_BUDGET_MS = Number(process.env.HIVEMIND_AGENT_RETRIEVAL_BUDGET_MS || 12_000);
// A remote synthesis provider must never consume the whole turn budget. The
// independent fallback exists precisely so one queued route can be abandoned.
// Keep this above measured normal fact synthesis (roughly 1-5s) while bounding
// the observed 53s provider tail.

// Model split:
//   • structured intent planning uses Gemini 2.5 Flash-Lite;
//   • final user-facing synthesis uses the low-latency Nitro route;
//   • non-user-facing legacy helpers retain the internal Groq model.
// Both are env-overridable so we can A/B without code changes.
const INTERNAL_MODEL = process.env.HIVEMIND_AGENT_INTERNAL_MODEL || 'openai/gpt-oss-20b';
const QUERY_OPTIMIZER_MODEL = process.env.CHAT_QUERY_OPTIMIZER_MODEL || DEFAULT_CHAT_PLANNER_MODEL;
// Keep GPT-OSS 20B Nitro as the low-latency primary, but use an independent
// safety model when its grounded/citation contract fails. Retrying the same
// model reproduced the same semantic failure even with complete rank-one
// evidence (for example, returning query_mismatch for an exact table row).
// Nemotron Lightning passed that identical evidence contract in production in
// ~4s, while GPT-OSS 120B Nitro still missed the language alias. This fallback
// never retrieves, reranks, plans, or executes tools; it only synthesizes the
// already-authorized evidence packet, so connector and approval behavior stay
// unchanged. Operators can still override it per deployment.
// The caller-selected model is reserved for user-facing synthesis below.
const INTENT_MODEL = process.env.CHAT_INTENT_MODEL || process.env.HIVEMIND_AGENT_INTENT_MODEL || DEFAULT_CHAT_PLANNER_MODEL;

export function resolveAnswerModel(selectedModel) {
  return resolveChatSynthesisModel(selectedModel);
}

export function evidenceExcerptForAnswer(item = {}, index = 0) {
  const full = String(item.content || '');
  const snippet = String(item.snippet || '');
  if (index === 0 && full) return full.slice(0, 2400);
  return (snippet || full).slice(0, 800);
}

// ISO 639-1 → human-readable name. Same map as v1 — keep in sync.
const LANGUAGE_NAMES = {
  en: 'English',  de: 'German',  es: 'Spanish',  fr: 'French',  it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',   cs: 'Czech',  sv: 'Swedish',
  no: 'Norwegian', fi: 'Finnish', el: 'Greek',   hu: 'Hungarian', ro: 'Romanian',
  sl: 'Slovenian', ar: 'Arabic',  he: 'Hebrew',  tr: 'Turkish',  ru: 'Russian',
  uk: 'Ukrainian', hi: 'Hindi',   bn: 'Bengali', ta: 'Tamil',    te: 'Telugu',
  ja: 'Japanese',  ko: 'Korean',  zh: 'Chinese', vi: 'Vietnamese', th: 'Thai',
  id: 'Indonesian', ms: 'Malay',  sk: 'Slovak',
};

function languageName(code) {
  if (!code) return 'English';
  return LANGUAGE_NAMES[String(code).slice(0, 2).toLowerCase()] || 'English';
}

// ── Provider-aware JSON helper ─────────────────────────────────────────

const GROUNDED_SYNTHESIS_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'hivemind_grounded_synthesis',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        response: { type: 'string' },
        claims: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              grounded: { type: 'boolean' },
              citation_ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['text', 'grounded', 'citation_ids'],
          },
        },
        evidence_used: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        gaps: { type: 'array', items: { type: 'string' } },
        follow_ups: {
          type: 'array',
          minItems: 0,
          maxItems: 3,
          items: { type: 'string' },
        },
        coverage: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              request: { type: 'string' },
              status: { type: 'string', enum: ['supported', 'unsupported'] },
              citation_ids: { type: 'array', items: { type: 'string' } },
            },
            required: ['request', 'status', 'citation_ids'],
          },
        },
        context_status: { type: 'string', enum: ['sufficient', 'relevant_but_incomplete', 'query_mismatch'] },
      },
      required: ['response', 'claims', 'evidence_used', 'confidence', 'gaps', 'follow_ups', 'coverage', 'context_status'],
    },
  },
};

async function callJsonLLM({ messages, model, apiKey, maxTokens, temperature = 0.1, signal, reasoningEffort, providerPolicy, promptCacheKey, responseFormat = null }) {
  const reasoningDisabled = String(model || '').startsWith('nvidia/nemotron-3.5-lightning');
  const resp = await chatCompletionFetch(model, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      response_format: responseFormat || { type: 'json_object' },
      max_completion_tokens: maxTokens,
      temperature,
      // GPT-OSS is a reasoning model: with no reasoning_effort it defaults to
      // HIGH and burns ~11s of hidden reasoning on a grounded-synthesis prompt
      // (measured), which was the dominant chat latency. Grounded synthesis
      // does not need deep reasoning — the evidence is already retrieved and
      // the job is to WRITE a cited answer. Pass a low/medium effort when the
      // caller asks. Harmless on non-reasoning providers (ignored field).
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(reasoningDisabled ? { reasoning: { enabled: false } } : {}),
      ...(providerPolicy ? { provider: providerPolicy } : {}),
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    }),
    signal,
  }, { fallbackApiKey: apiKey });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat provider ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  return { parsed: parseJsonObjectContent(raw), usage: data.usage };
}

async function callValidatedClaimStream({ message, messages, model, apiKey, maxTokens, signal, promptCacheKey, recallPackets, evidence, allowGeneralKnowledge, onEvent, language = 'en', source = null }) {
  const streamInstruction = `STREAMING OUTPUT CONTRACT: Return exactly one JSON object matching the supplied strict response schema and no markdown. Every factual sentence in response must have a corresponding claims item with valid delivered citation IDs. Decompose every independent requested detail in coverage. For broad, detailed, comprehensive, overview, comparison, or additional-information requests, use all distinct relevant delivered passages and normally produce 3-5 non-duplicate grounded claims when the evidence supports them. Never emit uncited prose or mark the response sufficient while a requested detail is absent.`;
  const streamedClaims = [];
  const rejectedClaims = [];
  let meta = {};
  let pending = '';
  let started = false;
  const searchableFollowUps = () => normalizeSearchableFollowUps(meta.follow_ups, {
    context: JSON.stringify(recallPackets),
    sourceTitles: recallPackets.flatMap((packet) => [
      ...(packet?.citations || []).map((citation) => citation.source_label || citation.title),
      ...(packet?.sourceSections || []).map((section) => section.source_label || section.title),
    ]).filter(Boolean),
    language,
  });
  const consumeConcatenatedJson = (raw) => {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          consumeLine(raw.slice(start, index + 1));
          start = -1;
        }
      }
    }
  };
  const consumeLine = (rawLine) => {
    const line = String(rawLine || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!line) return;
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (item?.type === 'meta') {
      meta = item;
      return;
    }
    if (item?.type !== 'claim' || typeof item.text !== 'string') return;
    const candidate = {
      text: item.text.trim(), grounded: true,
      citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids : [],
    };
    const validated = validateChatAnswer({ answer: candidate.text, claims: [candidate] }, recallPackets, { allowGeneralKnowledge });
    if (!validated.claims.length) {
      rejectedClaims.push(...(validated.rejected_claims || [candidate]));
      return;
    }
    const claim = validated.claims[0];
    streamedClaims.push(claim);
    if (!started) {
      onEvent?.({ type: 'answer_started', schema_version: 1, validated: true });
      started = true;
    }
    onEvent?.({ type: 'answer_delta', schema_version: 1, delta: `${claim.text}${/\s$/.test(claim.text) ? '' : ' '}`, validated: true, citation_ids: claim.citation_ids });
  };
  const reasoningDisabled = String(model || '').startsWith('nvidia/nemotron-3.5-lightning');
  const result = await chatCompletionStream(model, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: streamInstruction }, ...messages],
      max_completion_tokens: maxTokens,
      temperature: 0,
      // OpenRouter's GPT-OSS providers accept the OpenAI-compatible
      // reasoning_effort field. Sending the provider-specific `reasoning`
      // object together with require_parameters=true made every Nitro stream
      // fail with HTTP 400, forcing a second non-streamed synthesis. Nemotron
      // uses the explicit OpenRouter reasoning switch instead.
      ...(reasoningDisabled
        ? { reasoning: { enabled: false } }
        : { reasoning_effort: 'low' }),
      prompt_cache_key: promptCacheKey,
      response_format: GROUNDED_SYNTHESIS_RESPONSE_FORMAT,
    }),
    signal,
  }, {
    fallbackApiKey: apiKey,
    onContent: (delta) => {
      pending += delta;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      lines.forEach(consumeLine);
    },
  });
  consumeLine(pending);
  if (result.ok && streamedClaims.length === 0 && result.content) {
    // Several Nitro providers emit valid NDJSON objects back-to-back without
    // newline delimiters. Parse framing by balanced JSON objects; semantics and
    // citation validation remain identical.
    consumeConcatenatedJson(result.content);
  }
  // Some OpenRouter GPT-OSS providers buffer a valid standard synthesis JSON
  // object even when asked for NDJSON. That is still safe to stream after the
  // response completes: validate every claim against the same RecallPackets,
  // then emit only accepted claims. This avoids paying for a second LLM call
  // merely because the provider chose JSON-object framing over NDJSON framing.
  if (result.ok && streamedClaims.length === 0 && result.content) {
    const buffered = parseJsonObjectContent(result.content);
    const bufferedClaims = Array.isArray(buffered?.claims) ? buffered.claims : [];
    for (const item of bufferedClaims) {
      if (typeof item?.text !== 'string') continue;
      const candidate = {
        text: item.text.trim(),
        grounded: true,
        citation_ids: Array.isArray(item.citation_ids) ? item.citation_ids : [],
      };
      const validated = validateChatAnswer({ answer: candidate.text, claims: [candidate] }, recallPackets, { allowGeneralKnowledge });
      if (!validated.claims.length) {
        rejectedClaims.push(...(validated.rejected_claims || [candidate]));
        continue;
      }
      const claim = validated.claims[0];
      streamedClaims.push(claim);
      if (!started) {
        onEvent?.({ type: 'answer_started', schema_version: 1, validated: true });
        started = true;
      }
      onEvent?.({ type: 'answer_delta', schema_version: 1, delta: `${claim.text}${/\s$/.test(claim.text) ? '' : ' '}`, validated: true, citation_ids: claim.citation_ids });
    }
    meta = buffered || meta;
  }
  if (!result.ok) {
    const diagnostic = result.error || result.content || '';
    const detail = diagnostic ? `:${String(diagnostic).replace(/\s+/g, ' ').slice(0, 180)}` : '';
    throw new Error(`validated_stream_failed:${result.status || 'no_claims'}${detail}`);
  }
  if (!streamedClaims.length) {
    // A 200 meta-only response is a valid semantic result, not a transport
    // failure. Preserve the single synthesis call and deterministically expose
    // the already-ranked, citation-bearing recall packet instead of returning
    // a 502 or paying for another LLM pass.
    const recalled = groundedRecallFallback(evidence, language, message, { source });
    if (recalled) {
      onEvent?.({ type: 'answer_started', schema_version: 1, validated: true });
      onEvent?.({ type: 'answer_delta', schema_version: 1, delta: recalled.response, validated: true, citation_ids: recalled.claims.flatMap((claim) => claim.citation_ids) });
      onEvent?.({ type: 'answer_completed', schema_version: 1, validated: true });
      return {
        response: recalled.response,
        follow_ups: searchableFollowUps(),
        claims: recalled.claims,
        rejected_claims: rejectedClaims,
        grounded: true,
        evidence_used: recalled.claims.flatMap((claim) => claim.citation_ids),
        confidence: 0.7,
        gaps: Array.isArray(meta.gaps) ? meta.gaps : [],
        context_status: deriveAnswerContextStatus(meta),
        answer_coverage: normalizeAnswerCoverage(meta.coverage),
        recall_packets: recallPackets,
        usage: result.usage,
        usage_stages: { synthesis: result.usage },
        streaming_emitted: true,
      };
    }
  }
  if (!streamedClaims.length) {
    // No valid claim and no grounded packet is a normal empty-recall outcome.
    // It must remain an answerable 200 turn rather than becoming a proxy 502.
    const gap = Array.isArray(meta.gaps) && meta.gaps.length
      ? `I could not verify ${meta.gaps.join(' or ')} in the HIVEMIND context available to this chat.`
      : 'I could not verify a matching detail in the HIVEMIND context available to this chat.';
    onEvent?.({ type: 'answer_started', schema_version: 1, validated: true });
    onEvent?.({ type: 'answer_delta', schema_version: 1, delta: gap, validated: true, citation_ids: [] });
    onEvent?.({ type: 'answer_completed', schema_version: 1, validated: true });
    return {
      response: gap, follow_ups: [], claims: [], rejected_claims: rejectedClaims,
      grounded: false, evidence_used: [], confidence: 0,
      gaps: Array.isArray(meta.gaps) ? meta.gaps : [],
      context_status: deriveAnswerContextStatus(meta),
      answer_coverage: normalizeAnswerCoverage(meta.coverage),
      recall_packets: recallPackets, usage: result.usage,
      usage_stages: { synthesis: result.usage }, streaming_emitted: true,
    };
  }
  onEvent?.({ type: 'answer_completed', schema_version: 1, validated: true });
  return {
    response: streamedClaims.map((claim) => claim.text).join(' '),
    follow_ups: searchableFollowUps(),
    claims: streamedClaims,
    rejected_claims: rejectedClaims,
    grounded: true,
    evidence_used: [],
    confidence: Number.isFinite(meta.confidence) ? Math.max(0, Math.min(1, meta.confidence)) : 0.5,
    gaps: Array.isArray(meta.gaps) ? meta.gaps : [],
    context_status: deriveAnswerContextStatus(meta),
    answer_coverage: normalizeAnswerCoverage(meta.coverage),
    recall_packets: recallPackets,
    usage: result.usage,
    usage_stages: { synthesis: result.usage },
    streaming_emitted: true,
  };
}

// ── STEP 1 — quick direct-answer for greetings / smalltalk / self-Q ───

async function answerDirectly({ message, gateKind, language, assistantName, orgName, model, apiKey, signal, plannerDraft = null, profileContext = '' }) {
  const lang = languageName(language);
  const orgLabel = (!orgName || /^Local Org\b/i.test(orgName)) ? 'this HIVEMIND workspace' : orgName;
  const name = assistantName || 'HIVE';

  const LANG_BLOCK = `LANGUAGE: ALL OUTPUT MUST BE IN ${lang.toUpperCase()}. Even if the user wrote in another language, you reply ONLY in ${lang}. This is non-negotiable.`;
  // Always-on profile context: even a `direct` answer or a mis-routed identity
  // question ("Who am I?") gets the user's own facts, so it never answers blind.
  const PROFILE_BLOCK = profileContext
    ? `\n\nWHO YOU ARE TALKING TO (the authenticated user + their org — use directly for identity/personalization; never invent beyond it):\n${profileContext}`
    : '';

  const prompts = {
    greeting: `${LANG_BLOCK}\n\n${organizationalBrainIdentity({ name, orgLabel })}\n${ORGANIZATIONAL_BRAIN_PERSONA}\nReply with a warm one-line greeting + ONE short offer-to-help. Plain text only. No JSON, no tool talk.`,
    smalltalk: `${LANG_BLOCK}\n\n${organizationalBrainIdentity({ name, orgLabel })}\n${ORGANIZATIONAL_BRAIN_PERSONA}\nReply with one short, genuinely human sentence. Plain text only. No follow-up question.`,
    self_q: `${LANG_BLOCK}\n\n${organizationalBrainIdentity({ name, orgLabel })}\n${ORGANIZATIONAL_BRAIN_PERSONA}\nReply in 2-3 sentences:\n` +
            `  - You carry persistent memory of our team's facts, decisions, projects, people.\n` +
            `  - You can recall, save, link, time-travel through that memory, and pull live web results when needed.\n` +
            `Do NOT cite memories. Do NOT mention internal tool names. Plain text only.`,
    general: plannerDraft
      ? `${LANG_BLOCK}\n\n${organizationalBrainIdentity({ name, orgLabel })}\n${ORGANIZATIONAL_BRAIN_PERSONA}\nProduce the final reply using the planner draft below only as a bounded intent draft. Preserve its meaning, answer the user concisely, and do not introduce claims or topics absent from the user request or draft. Plain text only.\n\nPLANNER DRAFT:\n${String(plannerDraft).slice(0, 1200)}`
      : `${LANG_BLOCK}\n\n${organizationalBrainIdentity({ name, orgLabel })}\n${ORGANIZATIONAL_BRAIN_PERSONA}\nReply naturally and only address the user's request. Do not introduce unrelated claims. Plain text only. No JSON, no tool talk.`,
  };

  const resp = await chatCompletionFetch(model, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompts[gateKind] + PROFILE_BLOCK },
        { role: 'user', content: message },
      ],
      max_completion_tokens: DIRECT_MAX_TOKENS,
      temperature: 0.3,
    }),
    signal,
  }, { fallbackApiKey: apiKey });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat provider ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { response: text.trim(), usage: data.usage };
}


// ── STEP 3 — Evidence gather (no LLM) ──────────────────────────────────

// EvidenceBus (Stage C) — a plain-object factory (not a class, to match file
// style) that OWNS the 9 shared accumulators + their two dedup index sets, and
// encapsulates each merge pattern as a method. The factory returns the SAME
// Map/array references the merge code has always used, so aliasing the fields
// back to locals is a byte-identical drop-in. The merge methods formalize, in
// ONE place, the merge semantics that were previously scattered inline:
//   - mergeMemories flag precedence: _superseded_predecessor WINS over a prior
//     unflagged entry; _diff_removed inserts a tagged CLONE only when absent.
//   - mergeEvidence key modes: 'withPage' (base/relation/escalation) vs 'noPage'
//     (temporal) — the exact key strings are preserved, NOT unified.
//   - mergeEdges: {overwrite:false} (base if-absent) vs {overwrite:true}
//     (relation/escalation last-writer-wins).
//   - mergeLive: {dedup:true} (base, keyed id||source|title) vs raw push
//     (connector/profile).
// See gather-evidence-characterization.test.js (R1-R11) for the contract.
function createEvidenceBus() {
  const memoriesById = new Map();
  const liveItems = [];
  const evidenceItems = [];
  const edgesByKey = new Map();
  const synthesisChains = new Map();
  const recallPackets = [];
  const coMentions = [];
  const rankedCandidates = [];
  const recallTelemetry = [];
  const _evidenceSeen = new Set();
  const _liveSeen = new Set();

  return {
    memoriesById, liveItems, evidenceItems, edgesByKey,
    synthesisChains, recallPackets, coMentions, rankedCandidates, recallTelemetry,
    _evidenceSeen, _liveSeen,

    // rows: memory rows. opts:
    //   flags        — object of flags to apply (e.g. {_superseded_predecessor:true})
    //   absentOnly   — when true, only insert if id absent; never touch existing (default false)
    //   cloneOnFlag  — when inserting with flags, store {...row, ...flags} instead of mutating row
    // Behavior matrix (preserves the current three inline patterns exactly):
    //   base/relation/escalation: mergeMemories(rows)            → insert-if-absent, store row as-is
    //   temporal added:           mergeMemories(rows,{flags:{_superseded_predecessor}}) → flag WINS on existing
    //   diff removed:             mergeMemories(rows,{flags:{_diff_removed}, absentOnly:true, cloneOnFlag:true})
    mergeMemories(rows, { flags = null, absentOnly = false, cloneOnFlag = false } = {}) {
      for (const m of (rows || [])) {
        if (!m?.id) continue;
        if (!memoriesById.has(m.id)) {
          // On insert: clone-with-flags when cloneOnFlag (preserves the caller's
          // row identity, e.g. _diff_removed), else mutate the row in place so a
          // flag passed WITHOUT the row already carrying it is still applied
          // (e.g. Updates-walk predecessors flagged _superseded_predecessor).
          memoriesById.set(m.id, (flags && cloneOnFlag) ? { ...m, ...flags } : (flags ? Object.assign(m, flags) : m));
        } else if (flags && !absentOnly) {
          Object.assign(memoriesById.get(m.id), flags);
        }
      }
    },

    // keyMode: 'withPage' includes page in the dedup key (base/relation/escalation);
    // 'noPage' omits page (temporal). The exact key string per mode is preserved.
    mergeEvidence(rows, { keyMode = 'withPage' } = {}) {
      for (const ev of (rows || [])) {
        const stableId = ev?.id || ev?.segment_id || ev?.segmentId;
        const k = keyMode === 'noPage'
          ? (stableId || `${ev?.document_title || '?'}|${(ev?.content || ev?.snippet || '').slice(0, 40)}`)
          : (stableId || `${ev?.document_title || '?'}|${ev?.page || ''}|${String(ev?.content || ev?.snippet || '').slice(0, 40)}`);
        if (_evidenceSeen.has(k)) continue;
        _evidenceSeen.add(k);
        evidenceItems.push(ev);
      }
    },

    // overwrite:false — insert-if-absent (base). overwrite:true — last-writer-wins
    // (relation/escalation). Invalid edges (missing from/to/type) are skipped.
    mergeEdges(rows, { overwrite = false } = {}) {
      for (const edge of (rows || [])) {
        if (!edge?.from_id || !edge?.to_id || !edge?.type) continue;
        const key = `${edge.from_id}|${edge.to_id}|${edge.type}`;
        if (overwrite || !edgesByKey.has(key)) edgesByKey.set(key, edge);
      }
    },

    // dedup:true — base lane, keyed id || `${source}|${title}`. dedup:false —
    // connector/profile raw push (no dedup).
    mergeLive(rows, { dedup = false } = {}) {
      for (const li of (rows || [])) {
        if (dedup) {
          const k = li?.id || `${li?.source || '?'}|${li?.title || ''}`;
          if (_liveSeen.has(k)) continue;
          _liveSeen.add(k);
        }
        liveItems.push(li);
      }
    },

    // first-writer-wins by synthesis_id.
    mergeSynthesisChains(rows) {
      for (const chain of (rows || [])) {
        if (chain && !synthesisChains.has(chain.synthesis_id)) synthesisChains.set(chain.synthesis_id, chain);
      }
    },

    addPacket(packet) { if (packet) recallPackets.push(packet); },
    addPackets(list) { for (const p of (list || [])) recallPackets.push(p); },
    addCoMentions(list) { for (const c of (list || [])) coMentions.push(c); },
    addRecallTelemetry(trace) {
      if (!trace || typeof trace !== 'object') return;
      recallTelemetry.push({
        rerank_passes: Number(trace.rerank_passes) || 0,
        rerank_ms: Number(trace.rerank_ms) || 0,
        ranking_mode: trace.hybrid_ranking_mode || null,
      });
    },
    mergeRankedCandidates(rows) {
      const seen = new Set(rankedCandidates.map((row) => row.kind === 'memory'
        ? `memory:${row.memory_id}` : `evidence:${row.segment_id}`));
      for (const row of (rows || [])) {
        const key = row?.kind === 'memory' ? `memory:${row.memory_id}` : `evidence:${row?.segment_id}`;
        if (!row || seen.has(key)) continue;
        seen.add(key);
        rankedCandidates.push({ ...row, rank: rankedCandidates.length + 1 });
      }
    },
  };
}

// ── Capability executors (Stage C step 3) ────────────────────────────────
// Each executor mutates the bus and returns a small patch for the scalar(s) it
// owns (or undefined). Called from gatherEvidence in a fixed sequence that
// matches the original top-to-bottom order; each keeps its own run/skip guard.

async function execRelationBetween(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  if (!(plan.operation === 'relation_between' && plan.relation_intent?.entities?.length >= 2 && remaining() > 0)) return;
  const relationArgs = {
    entities: plan.relation_intent.entities,
    query: plan.query_canonical_en || plan.user_message,
    mode: 'explain',
    ...(plan.source?.document_id ? { source_document_id: plan.source.document_id } : {}),
    ...(plan.source?.title ? { source_title: plan.source.title } : {}),
    ...(plan.source?.kind ? { source_kind: plan.source.kind } : {}),
    ...(plan.time?.kind === 'latest' || plan.time?.kind === 'earliest'
      ? { temporal_selector: plan.time.kind, temporal_axis: plan.time.axis || 'known_time' }
      : {}),
    ...(plan.time?.valid_at ? { valid_at: plan.time.valid_at } : {}),
    ...(plan.time?.known_at ? { known_at: plan.time.known_at } : {}),
  };
  try {
    startTool('hivemind_relation_between', relationArgs);
    const relationResult = await beforeDeadline(() => dispatchTool('hivemind_relation_between', relationArgs, ctx));
    recordTool(
      'hivemind_relation_between', relationArgs,
      `${relationResult?.direct_edges?.length || 0} typed edges + ${relationResult?.explicit_relation_claims?.length || 0} explicit claims + ${relationResult?.shared_paths?.length || 0} shared paths`,
      relationResult,
    );
    bus.mergeMemories(relationResult?.memories);
    bus.mergeEvidence(relationResult?.evidence, { keyMode: 'withPage' });
    bus.mergeEdges(relationResult?.relationships, { overwrite: true });
    bus.addCoMentions(relationResult?.co_mentions);
    bus.addPackets(relationResult?.evidence_packets);
    return { relationChecked: true, relationResult };
  } catch (error) {
    recordTool('hivemind_relation_between', relationArgs, `error: ${error.message}`, null);
  }
}

async function execAggregate(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  if (!(plan.aggregate?.parent && plan.aggregate?.kind && remaining() > 0)) return;
  const aggregateArgs = {
    parent_name: plan.aggregate.parent,
    parent_candidates: [...new Set([plan.aggregate.parent, ...(plan.named_entities || [])]
      .filter((value) => typeof value === 'string' && value.trim()))].slice(0, 12),
    entity_kind: plan.aggregate.kind,
    limit: 1000,
  };
  try {
    startTool('hivemind_aggregate_entities', aggregateArgs);
    const aggregateResult = await beforeDeadline(() => dispatchTool('hivemind_aggregate_entities', aggregateArgs, ctx));
    // rosemary Root Cause A1: surface the actual entity NAMES to synthesis, not
    // just a count. The tool already returns entities:[{name,aliases}]; the old
    // summary dropped them, so "list all X products" answered "12 distinct
    // products" with no names. recordTool stores only result_summary for
    // synthesis, so the names must live in the summary string. Bounded to 80
    // names to stay within the synthesis budget; cutoff marked with '+'.
    const _kind = aggregateResult?.entity_kind || plan.aggregate.kind;
    const _names = (aggregateResult?.entities || []).map((e) => e && e.name).filter(Boolean);
    let _summary;
    if (_names.length) {
      const _shown = _names.slice(0, 80).join(', ');
      const _more = _names.length > 80 ? `, …(+${_names.length - 80} more)` : '';
      const _plus = aggregateResult?.coverage?.cutoff ? '+' : '';
      _summary = `${_names.length}${_plus} ${_kind}: ${_shown}${_more}`;
    } else if (aggregateResult?.coverage?.complete) {
      _summary = `0 ${_kind} found`;
    } else {
      _summary = `incomplete aggregate (${aggregateResult?.coverage?.reason || 'unknown'})`;
    }
    recordTool('hivemind_aggregate_entities', aggregateArgs, _summary, aggregateResult);
    return { aggregateResult };
  } catch (error) {
    recordTool('hivemind_aggregate_entities', aggregateArgs, `error: ${error.message}`, null);
  }
}

// ── Temporal dispatch ─────────────────────────────────────────────────
// "What changed / version history / what was true on date X" — route to the
// bi-temporal tools. base recall already applied valid_at/known_at via
// recallExtras, so this ADDS the version chain / delta the plain recall lane
// cannot express. Merged into the same bus memory/evidence maps.
async function execTimeline(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  if (!((plan.operation === 'timeline' || plan.needs_time_travel) && remaining() > 0)) return;
  const t = plan.time_travel || plan.time || {};
  const topic = plan.query_canonical_en || plan.user_message
    || (Array.isArray(plan.named_entities) ? plan.named_entities.join(' ') : '');
  let temporalTool = null;
  let temporalArgs = null;
  if (t.range?.start) {
    // "since 2025" gives start with no end — diff from then to NOW.
    temporalTool = 'hivemind_diff';
    temporalArgs = { from: t.range.start, to: t.range.end || new Date().toISOString(), query: topic };
  } else if (t.valid_at || t.known_at) {
    temporalTool = 'hivemind_at';
    temporalArgs = { ...(t.valid_at ? { valid_at: t.valid_at } : {}), ...(t.known_at ? { known_at: t.known_at } : {}), query: topic };
  } else if (plan.operation === 'timeline') {
    temporalTool = 'hivemind_timeline';
    temporalArgs = { query: topic, limit: 20 };
  }
  if (!temporalTool) return;
  try {
    startTool(temporalTool, temporalArgs);
    const temporalResult = await beforeDeadline(() => dispatchTool(temporalTool, temporalArgs, ctx));
    // Normalise the varied temporal shapes into memories/evidence for synthesis.
    const tMems = temporalResult?.memories
      || temporalResult?.added || temporalResult?.results || [];
    const summary = temporalTool === 'hivemind_diff'
      ? `+${temporalResult?.added_count || 0} / -${temporalResult?.removed_count || 0} / =${temporalResult?.persisted_count || 0}`
      : `${(tMems || []).length} memories${temporalResult?.version_count ? ` + ${temporalResult.version_count} versions` : ''}`;
    recordTool(temporalTool, temporalArgs, summary, temporalResult);
    // The superseded-predecessor flag must WIN even if base recall already added
    // this id unflagged. bus.mergeMemories owns that precedence. Single pass to
    // preserve exact insertion order across mixed flagged/unflagged rows.
    for (const m of (tMems || [])) {
      if (m?._superseded_predecessor) bus.mergeMemories([m], { flags: { _superseded_predecessor: true } });
      else bus.mergeMemories([m]);
    }
    // hivemind_diff also carries removed rows — clone-if-absent, never overwrite.
    bus.mergeMemories(temporalResult?.removed, { flags: { _diff_removed: true }, absentOnly: true, cloneOnFlag: true });
    bus.mergeEvidence(temporalResult?.evidence, { keyMode: 'noPage' });
    bus.addPacket(temporalResult?.evidence_packet);
    for (const packet of temporalResult?.evidence_packets || []) bus.addPacket(packet);

    // fix #2 — this capability OWNS version-history end-to-end. The temporal tool
    // ranks the LATEST memory but the superseded predecessor (isLatest=false,
    // near-identical text) rarely ranks in, and hivemind_diff/hivemind_at do NOT
    // do the Updates walk at all — so "how has X changed over time" dropped the
    // prior value while "what was X before it changed" (which routes to
    // hivemind_timeline, whose handler walks Updates) surfaced it. Now execTimeline
    // walks the Updates chain from WHATEVER anchors we have (temporal result +
    // base-recall memories already in the bus) regardless of which temporal tool
    // fired, and merges predecessors via the ONE flag-owning method — so the flag
    // WINS over any prior unflagged base entry (bus contract, R2). This makes
    // "over time" and "before it changed" answer identically.
    await hydrateSupersededPredecessors(bus, ctx, { anchorMemories: tMems, plan });
    return {
      temporalCoverage: {
        tool: temporalTool,
        complete: (tMems?.length || 0) > 0 || (temporalResult?.evidence?.length || 0) > 0,
        reason: (tMems?.length || 0) || (temporalResult?.evidence?.length || 0) ? null : 'no_verified_temporal_material',
      },
    };
  } catch (error) {
    recordTool(temporalTool, temporalArgs, `error: ${error.message}`, null);
    return { temporalCoverage: { tool: temporalTool, complete: false, reason: 'temporal_tool_error' } };
  }
}

// Walk typed Updates edges from the anchor memories (temporal result ∪ whatever
// base recall already merged into the bus) and hydrate the predecessor rows,
// flagged _superseded_predecessor. Additive + best-effort: never throws into the
// timeline path. Owns fix #2's "previous value" so it is a single-place
// capability, not a 4-branch alignment.
async function hydrateSupersededPredecessors(bus, ctx, { anchorMemories = [], plan = {} } = {}) {
  try {
    // Test seam: ctx._loadTypedGraphEvidence overrides the real import so the
    // characterization suite can drive the Updates walk with a fake graph.
    const loadTypedGraphEvidence = ctx?._loadTypedGraphEvidence
      || (await import('../memory/recall-router.js')).loadTypedGraphEvidence;
    if (!ctx?.prisma || !loadTypedGraphEvidence || !ctx.persistentMemoryStore?.getMemories) return;
    // Anchors: temporal-result ids + everything already in the bus (base recall).
    const anchorIds = new Set([
      ...anchorMemories.map((m) => m?.id).filter(Boolean),
      ...bus.memoriesById.keys(),
    ]);
    // DETERMINISTIC ANCHORING (fix #2 reliability): a version-history answer must
    // NOT depend on whether the LATEST memory happened to rank into top-K recall
    // (run-to-run variance made "changed over time" surface the prior value only
    // sometimes). When the plan names entities, resolve their LATEST memories
    // directly and add them as anchors so the Updates walk always has a starting
    // point. Bounded + best-effort. Test seam: ctx._anchorMemoriesForEntities.
    try {
      const entities = (Array.isArray(plan.named_entities) ? plan.named_entities : [])
        .filter((e) => typeof e === 'string' && e.trim()).slice(0, 4);
      if (entities.length && ctx.prisma?.memory?.findMany) {
        const orClauses = entities.map((e) => ({ content: { contains: e, mode: 'insensitive' } }));
        const latest = await ctx.prisma.memory.findMany({
          where: { orgId: ctx.orgId, deletedAt: null, isLatest: true, OR: orClauses },
          select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 8,
        }).catch(() => []);
        for (const m of latest) if (m?.id) anchorIds.add(m.id);
      }
    } catch { /* entity anchoring is additive */ }
    if (!anchorIds.size) return;
    const anchorIdList = [...anchorIds];
    // Project-scope visibility: loadTypedGraphEvidence's visible() filter drops a
    // scope='project' edge unless accessContext.projectIds contains the project.
    // The version chain (e.g. launch-date Aug18→Aug19) is project-scoped, so if
    // the request carries the active project on ctx.projectId but not yet in
    // accessContext.projectIds, the predecessor edge is silently filtered out
    // (the live "changed over time drops the prior value" bug). Augment
    // projectIds with ctx.projectId — the same pattern the recall lane uses
    // (recall-router.js:366) — so project-scoped predecessors are visible.
    const walkAccess = {
      ...(ctx.accessContext || {}),
      projectIds: [...new Set([
        ...((ctx.accessContext && ctx.accessContext.projectIds) || []),
        ...(ctx.projectId ? [ctx.projectId] : []),
      ])],
    };
    const graph = await loadTypedGraphEvidence({
      prisma: ctx.prisma, memoryIds: anchorIdList,
      userId: ctx.userId, orgId: ctx.orgId, accessContext: walkAccess,
    }).catch(() => ({ items: [] }));
    const updatesEdges = (graph.items || []).filter((e) => String(e.type).toLowerCase() === 'updates');
    if (!updatesEdges.length) return;
    // Predecessor = edge.to_id (the superseded side of an Updates edge) not
    // already an anchor.
    const predIds = [...new Set(updatesEdges.map((e) => e.to_id).filter((id) => id && !anchorIds.has(id)))];
    if (predIds.length) {
      const predMap = await ctx.persistentMemoryStore.getMemories(predIds).catch(() => new Map());
      const preds = predIds.map((id) => predMap.get?.(id)).filter(Boolean);
      // mergeMemories with the flag: WINS over any prior unflagged entry (R2).
      bus.mergeMemories(preds, { flags: { _superseded_predecessor: true } });
    }
    // Surface the Updates edges themselves so synthesis can state the transition.
    bus.mergeEdges(updatesEdges.map((e) => ({ from_id: e.from_id, to_id: e.to_id, type: e.type || 'Updates', ...e })), { overwrite: false });
  } catch { /* additive — never break the timeline on it */ }
}

// ── Profile dispatch ──────────────────────────────────────────────────
// "What do you know about me / my company?" → the caller-scoped profile.
// get_user_profile takes NO id from the model (uses ctx.userId/orgId), so it can
// only return the authenticated caller's own profile.
async function execProfile(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  if (!(plan.operation === 'profile' && remaining() > 0)) return;
  try {
    startTool('get_user_profile', {});
    const profileResult = await beforeDeadline(() => dispatchTool('get_user_profile', {}, ctx));
    const profileContext = profileResult?.context || '';
    // Expose the profile as a citeable packet so the grounded-claim validator
    // (which fail-closes on uncited claims) accepts a profile-only answer.
    if (profileContext) {
      bus.addPacket({
        citations: [{
          id: 'PROFILE1',
          source_type: 'user_profile',
          source_label: 'Your maintained user + org profile',
          title: 'User + org profile',
          snippet: profileContext.slice(0, 1200),
        }],
      });
    }
    recordTool('get_user_profile', {}, `${profileResult?.fact_count || 0} profile facts`, profileResult);
    return { profileContext };
  } catch (error) {
    recordTool('get_user_profile', {}, `error: ${error.message}`, null);
  }
}

export function authorizedProjectsCitation(projects = []) {
  const rows = Array.isArray(projects) ? projects : [];
  return {
    id: 'PROJECTS1', source_type: 'authorized_projects', source_label: 'Authorized projects',
    title: 'Authorized projects',
    snippet: rows.length
      ? rows.map((project) => `${project.name} (${project.slug || project.id})`).join('\n').slice(0, 2000)
      : 'No active projects are authorized for this user in the current organization.',
  };
}

async function execProjects(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  if (!(plan.operation === 'projects' && remaining() > 0)) return;
  const args = { query: plan.project_prompt || plan.query_canonical_en || '' };
  try {
    startTool('hivemind_list_projects', args);
    const result = await beforeDeadline(() => dispatchTool('hivemind_list_projects', args, ctx));
    const projects = Array.isArray(result?.projects) ? result.projects : [];
    // An authorized empty result is completion evidence too. Without a
    // citation packet, synthesis treats "zero projects" as a retrieval outage
    // and emits an unrelated generic recall failure.
    bus.addPacket({ citations: [authorizedProjectsCitation(projects)] });
    recordTool('hivemind_list_projects', args, `${projects.length} authorized projects`, result);
    return { projectsResult: result };
  } catch (error) {
    recordTool('hivemind_list_projects', args, `error: ${error.message}`, null);
  }
}

async function execMappedNativeTool(bus, plan, ctx, { beforeDeadline, remaining, startTool, recordTool }) {
  const tool = plan.native_tool;
  if (!tool || remaining() <= 0) return;
  const args = {
    query: plan.queries?.[0] || plan.user_message,
    query_original: plan.user_message,
    title: plan.save_intent?.title,
    content: plan.save_intent?.content,
  };
  try {
    startTool(tool, args);
    const result = await beforeDeadline(() => dispatchTool(tool, args, ctx));
    if (Array.isArray(result?.memories)) bus.mergeMemories(result.memories);
    const snippet = String(result?.content || result?.answer || JSON.stringify(result || {})).replace(/\s+/g, ' ').slice(0, 1200);
    if (snippet && snippet !== '{}') {
      bus.addPacket({
        citations: [{
          id: 'NATIVE1',
          source_type: 'hivemind_tool',
          source_label: tool,
          title: tool,
          snippet,
        }],
      });
    }
    recordTool(tool, args, result?.error ? `error: ${result.error}` : 'ok', result);
    return { mappedNative: result };
  } catch (error) {
    recordTool(tool, args, `error: ${error.message}`, null);
  }
}

async function execConnectorRead(bus, plan, ctx, { beforeDeadline, recordTool, onEvent }) {
  const selectedLiveGroups = Array.isArray(plan.tool_groups) ? plan.tool_groups : [];
  if (!(plan.operation === 'connector_read' && selectedLiveGroups.length > 0 && ctx._readToolkit)) return;
  try {
    const readResult = await beforeDeadline(() => runToolkitReadLoop({
      toolkit: ctx._readToolkit,
      message: plan.user_message,
      history: [],
      model: ctx._internalModel,
      apiKey: ctx._apiKey,
      ctx,
      signal: ctx._signal,
      onEvent,
    }));
    for (const step of (readResult?.steps || [])) {
      recordTool(step.tool, step.args, step.result_summary, step.raw || null);
    }
    if (readResult?.text) {
      // Raw push (no dedup) — connector live rows were never deduped; preserve.
      bus.mergeLive([{
        source: selectedLiveGroups.join(','),
        title: 'live connector result',
        snippet: readResult.text.slice(0, 4000),
      }], { dedup: false });
    }
  } catch (err) {
    recordTool('connector_read_loop', { groups: selectedLiveGroups }, `error: ${err.message}`, null);
  }
}

async function waitForWebJob(jobId, ctx, remaining) {
  while (remaining() > 0) {
    const job = await ctx.webJobStore.get(jobId, { userId: ctx.userId, orgId: ctx.orgId });
    if (!job || ['failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'succeeded') return job;
    await new Promise((resolve) => setTimeout(resolve, Math.min(150, remaining())));
  }
  return null;
}

// Public web is a fallback lane, never a competing first retrieval system.
// Run it only after deterministic recall coverage proves a genuine gap. A
// timeout/outage is not a gap, and evidence-only hits count as workspace
// evidence just as much as memories do.
async function execWeb(bus, plan, ctx, { recordTool, startTool, remaining }, coverage) {
  const policy = plan.web_fallback || {};
  if (!publicWebFallbackEligible({
    plan, coverage,
    hasRuntime: Boolean(ctx.runWebSearchJob && ctx.webJobStore),
    remainingMs: remaining(),
    // Public web is deliberately opt-in. The planner may classify a request as
    // externally answerable, but the default chat contract remains the same
    // authorized memory+evidence synthesis on every turn. This also prevents a
    // depleted browser allowance from replacing a useful internal answer.
    enabled: process.env.HIVEMIND_CHAT_WEB_SEARCH_ENABLED === 'true',
  })) return;
  try {
    const args = { query: policy.query, limit: 8 };
    startTool('hivemind_web_search', args);
    const r = await dispatchTool('hivemind_web_search', args, ctx);
    if (!r?.job_id) {
      const error = r?.error || 'web_job_not_created';
      recordTool('hivemind_web_search', args, `error: ${error}`, null);
      return { webJob: r, webAttempted: true, webError: error };
    }
    const job = await waitForWebJob(r.job_id, ctx, remaining);
    const packet = webResultPacket(job, policy.query);
    if (packet) {
      bus.addPacket(packet);
      bus.mergeEvidence(packet.sourceSections, { keyMode: 'withPage' });
      // Web runs only when the workspace answer is incomplete (or the user
      // explicitly requested public web). Put those newly requested passages
      // at the front of the one synthesis window; appending them behind an
      // already-full top-15 pool made the tool succeed but guaranteed final
      // synthesis could never see its output.
      promoteWebEvidenceWindow(bus.evidenceItems, bus.rankedCandidates, packet.sourceSections);
    }
    recordTool('hivemind_web_search', args,
      packet ? `${packet.sourceSections.length} public web sources` : `job ${job?.status || 'incomplete'}`,
      packet ? job : null);
    return {
      webJob: job || r,
      webPacket: packet,
      webAttempted: true,
      webError: packet ? null : (job?.error || job?.status || 'web_search_incomplete'),
    };
  } catch (err) {
    recordTool('hivemind_web_search', { query: policy.query }, `error: ${err.message}`, null);
    return { webAttempted: true, webError: err.message };
  }
}

// Base recall — the always-on lane (skipped for dedicated lanes). Extracted LAST
// (dossier order) because it carries the plan-mutation SIDE EFFECT: recall_plan
// rewrites plan.source/time/named_entities, which the spine coverage + escalation
// + relation stages read AFTER. Must run before those. recallExtras/recallMode/
// recallLimit/recallQueries stay in gatherEvidence scope (escalation reuses them)
// and are passed in.
async function execBaseRecall(bus, plan, ctx, { beforeDeadline, startTool, recordTool }, { recallQueries, recallMode, recallLimit, recallExtras }) {
  if (recallQueries.length === 0) return;
  const recallResults = await Promise.all(
    recallQueries.map(async (q) => {
      const args = {
        query: q,
        // In progressive native chat, q is already the single planner's
        // intent-preserving optimized query. RecallRouter treats
        // query_original as its primary vector/hybrid query, so forwarding the
        // raw conversational message here silently bypassed optimization and
        // used the canonical query only as an alternate lexical hint.
        query_original: plan._native_single_call
          ? q
          : (plan.query_original || plan.user_message || q),
        query_canonical_en: plan.query_canonical_en || q,
        entities: plan.named_entities || [],
        ...(plan.answer_scope === 'exhaustive' && plan.answer_type ? { answer_type: plan.answer_type } : {}),
        mode: recallMode,
        limit: recallLimit,
        _explicit_mode: !!plan.explicit_recall_mode,
        ...recallExtras,
      };
      try {
        startTool('hivemind_recall', args);
        const r = await beforeDeadline(() => dispatchTool('hivemind_recall', args, ctx));
        if (r?.error) {
          const error = new Error(r.error);
          error.code = r._failure_mode || 'RECALL_FAILED';
          throw error;
        }
        const memCount = r?.memories?.length || 0;
        const liveCount = r?.live_count || 0;
        const evCount = r?.evidence_count || 0;
        const chainCount = (r?.synthesis_evidence_chains || []).length;
        const parts = [`${memCount} memories`];
        if (chainCount > 0) parts.push(`${chainCount} synth chains`);
        if (liveCount > 0) parts.push(`${liveCount} live`);
        if (evCount > 0) parts.push(`${evCount} evidence`);
        const summary = parts.join(' + ');
        recordTool('hivemind_recall', { query: q, ...recallExtras, mode: recallMode }, summary, r);
        return r;
      } catch (err) {
        recordTool('hivemind_recall', { query: q }, `error: ${err.message}`, null);
        return null;
      }
    })
  );
  // T1-3: dedup evidence + live items by id across all recall passes so the
  // render slices hold distinct rows instead of repeats.
  for (const r of recallResults) {
    // PLAN-MUTATION SIDE EFFECT — the recall router's resolved plan rewrites the
    // structured plan so coverage/escalation/relation read the resolved values.
    if (r?.recall_plan) {
      plan.source = r.recall_plan.source?.requested ? r.recall_plan.source : plan.source;
      plan.time = r.recall_plan.time || plan.time;
      plan.named_entities = r.recall_plan.named_entities || r.recall_plan.entities || plan.named_entities;
    }
    bus.mergeMemories(r?.memories);
    bus.mergeLive(r?.live, { dedup: true });
    bus.mergeEvidence(r?.evidence, { keyMode: 'withPage' });
    bus.mergeRankedCandidates(r?.ranked_candidates);
    bus.addRecallTelemetry(r?.trace);
    bus.mergeEdges(r?.relationships, { overwrite: false });
    bus.addPacket(r?.evidence_packet);
    // KB-answer fix: base recall returns evidence[] but NO evidence_packet, so
    // its segments were shown to synthesis yet were NOT citable — a claim
    // grounded in a KB segment failed citation validation → 0 claims →
    // "nothing directly answers", even though the answer (e.g. a spec value) was
    // right there in the retrieved evidence. Build a citable packet from the
    // segments (relation/temporal paths already do this; only base recall
    // didn't) so synthesis can ground a KB answer in evidence. Bounded to 8.
    if (Array.isArray(r?.evidence) && r.evidence.length) {
      bus.addPacket({
        sourceSections: r.evidence.slice(0, 15).map((e) => ({
          segment_id: e.segment_id || e.id,
          document_id: e.document_id || null,
          document_title: e.document_title || 'Document',
          snippet: String(e.snippet || e.content || '').replace(/\s+/g, ' ').slice(0, 1200),
          content: String(e.content || e.snippet || '').slice(0, 1200),
          page: e.page ?? null,
          score: Number.isFinite(e.score) ? e.score : null,
        })),
        citations: r.evidence.slice(0, 15).map((e, i) => ({
          id: `E${i + 1}`,
          segment_id: e.segment_id || e.id,
          source_type: 'evidence',
          source_label: e.document_title || 'Document',
          title: e.document_title || 'Document',
          snippet: String(e.content || e.snippet || '').replace(/\s+/g, ' ').slice(0, 600),
          document_id: e.document_id || null,
        })),
      });
    }
    bus.mergeSynthesisChains(r?.synthesis_evidence_chains);
  }
}

// Capability registry (Stage C step 4). The op-stage runs, in this fixed order,
// every executor whose predicate matches the plan. Order is preserved verbatim
// from the original top-to-bottom sequence:
//   relation_between → aggregate → timeline → profile.
// A plain registry[plan.operation] is INSUFFICIENT because timeline fires on
// `operation==='timeline' OR needs_time_travel` (a non-timeline op can request
// time-travel), so each entry carries an explicit predicate. relation/aggregate/
// profile are mutually exclusive by operation; timeline may co-fire — matching
// the original guards exactly. Each executor internally re-checks remaining().
const OP_STAGE = [
  { name: 'relation', predicate: (p) => p.operation === 'relation_between' && p.relation_intent?.entities?.length >= 2, exec: execRelationBetween, scalar: 'relationResult' },
  { name: 'aggregate', predicate: (p) => !!(p.aggregate?.parent && p.aggregate?.kind), exec: execAggregate, scalar: 'aggregateResult' },
  { name: 'timeline', predicate: (p) => p.operation === 'timeline' || p.needs_time_travel, exec: execTimeline, scalar: 'temporalCoverage' },
  { name: 'profile', predicate: (p) => p.operation === 'profile', exec: execProfile, scalar: 'profileContext' },
  { name: 'projects', predicate: (p) => p.operation === 'projects', exec: execProjects, scalar: 'projectsResult' },
  { name: 'mapped_native', predicate: (p) => Boolean(p.native_tool) && ![
    'hivemind_recall', 'get_user_profile', 'hivemind_list_projects',
    'hivemind_at', 'hivemind_diff', 'hivemind_timeline',
    'hivemind_relation_between', 'hivemind_aggregate_entities',
  ].includes(p.native_tool), exec: execMappedNativeTool, scalar: 'mappedNative' },
];

// Exported for the characterization test (gather-evidence-characterization.test.js),
// the Stage C refactor safety net. Tests drive it with an injected ctx._toolkit
// fake dispatcher — no real recall/LLM. Not part of the public module surface.
// ── Query optimisation ─────────────────────────────────────────────────────
// Query optimisation is an intent-preserving representation step, not a
// keyword stripper. Recall already performs multilingual hybrid retrieval;
// this stage removes conversational/workflow framing while retaining the
// entity, requested attribute, relation, qualifiers, negation, time window,
// and source constraint. The first query is always the most specific semantic
// expression because gatherEvidence treats it as canonical.
async function optimizeRecallQueries({ message, plan, model, apiKey, signal }) {
  const fallback = fallbackRecallQueries(message, plan);
  try {
    const intentContext = buildRecallIntentContext(message, plan);
    const { parsed, usage } = await callJsonLLM({
      messages: [
        { role: 'system', content: 'Understand the retrieval intent, then rewrite it as one compact semantic search expression. Return STRICT JSON {"semantic_query":string}. Preserve every answer-bearing constraint: named entity, requested attribute or small detail, relation/direction, qualifiers, negation, time window, and requested source. Remove only conversational filler and downstream workflow actions. Never reduce an attribute question to an entity-only topic. Use natural semantic language, not a bag of keywords. The memory store and embeddings are multilingual, so translate only when it faithfully improves cross-language retrieval without weakening the intent. Do not answer the question.' },
        { role: 'user', content: JSON.stringify(intentContext) },
      ],
      model, apiKey, maxTokens: 140, temperature: 0, signal, reasoningEffort: 'low',
    });
    return { queries: normalizeRecallOptimization(parsed, fallback), usage };
  } catch {
    return { queries: fallback, usage: null };
  }
}

export async function gatherEvidence({ plan, ctx, onEvent, deadlineAt }) {
  const steps = [];
  const bus = createEvidenceBus();
  // Alias bus accumulators back to the local names the inline merge code uses,
  // so Step 1 is a byte-identical wrapper: same Map/array references, existing
  // inline `if(!has)set` fragments keep compiling. Step 2 routes each fragment
  // through the bus.merge* methods one accumulator at a time.
  const { memoriesById, liveItems, evidenceItems, edgesByKey, synthesisChains, recallPackets, coMentions, rankedCandidates, recallTelemetry } = bus;
  const recentContextPacket = recentPublicContextPacket(plan.recent_public_sources, plan.recent_context_answer);
  if (recentContextPacket) {
    bus.addPacket(recentContextPacket);
    bus.mergeEvidence(recentContextPacket.sourceSections, { keyMode: 'withPage' });
    promoteWebEvidenceWindow(bus.evidenceItems, bus.rankedCandidates, recentContextPacket.sourceSections);
  }
  let relationChecked = false;
  let relationResult = null;
  let activeDeadlineAt = deadlineAt;
  const remaining = () => Math.max(0, activeDeadlineAt - Date.now());
  const beforeDeadline = (task) => {
    const ms = remaining();
    // Never start a new retrieval dependency after the parent turn has
    // already exhausted its budget. A zero-millisecond timer still permits
    // synchronous work in `task()` to begin before the timer callback runs,
    // which can leak a late result into an expired turn.
    if (ms <= 0) {
      return Promise.reject(new StageDeadlineError('chat-recall', activeDeadlineAt));
    }
    return runWithStageDeadline(task, {
      deadlineAt: activeDeadlineAt,
      timeoutMs: ms,
      label: 'chat-recall',
    });
  };

  const recordTool = (tool, args, summary, payload) => {
    steps.push({ tool, args, result_summary: summary });
    onEvent?.({ type: 'tool_completed', name: tool, summary, ok: !!payload });
    // Backward-compatible projections for existing clients.
    onEvent?.({ type: 'tool_result', name: tool, summary });
    return payload;
  };

  const startTool = (tool, args) => {
    onEvent?.({ type: 'tool_selected', name: tool, arguments: args });
    onEvent?.({ type: 'tool_started', name: tool, arguments: args });
    onEvent?.({ type: 'tool_call', name: tool, arguments: JSON.stringify(args) });
  };

  // Helpers bundle passed to every extracted executor. `remaining` is a live
  // getter (closes over activeDeadlineAt in this scope) — NOT a snapshot — so an
  // executor sees the budget consumed by earlier ones.
  const helpers = { beforeDeadline, remaining, startTool, recordTool, onEvent };

  const recallExtras = {
    _structured_intent: true,
    // Planner-extracted names are ranking/coverage anchors, not proof that
    // every historical row already has the canonical `entity:*` tag. A hard
    // tag predicate made pre-canonical memories disappear before the existing
    // text/entity compatibility check could run. `should` keeps the dedicated
    // entity lane and exact lexical query additive; downstream coverage still
    // requires every requested entity to occur in the delivered packet.
    entity_filter_mode: 'should',
    // Latched once by the authenticated chat route. The recall tool receives
    // the same fail-closed rollout decision as the public recall endpoint.
    reliability_v1: ctx.recallReliabilityV1 === true,
    // A planner-classified activity window gets a bounded date-indexed lane in
    // RecallRouter. This is distinct from snapshot time travel and keeps broad
    // questions independent of wording or language.
    ...(plan.time?.kind === 'event_range' ? { _event_range: true } : {}),
    // Keep a bounded semantic rerank pool when the legacy weighted floor has
    // no viable rows. This is part of the first structured-chat recall so a
    // failed fast path cannot consume the deadline before recovery runs. It
    // is language-neutral, changes no normally viable result set, and avoids
    // paying for a duplicate recall solely to recover small buried details.
    semantic_recovery: true,
    // The progressive planner extracts exact language-preserving entity
    // anchors in the same call that writes the canonical query. Forward them
    // into RecallRouter so its entity lane can protect a named subject from
    // being displaced by semantically broad but unrelated document evidence.
    ...(Array.isArray(plan.named_entities) && plan.named_entities.length
      ? { entities: plan.named_entities }
      : {}),
    // Internal-only delivery mode: ranking still runs on the canonical recall
    // path, but answer synthesis receives the complete authorized rows so its
    // semantic projector can recover details beyond the public 400-char preview.
    _include_full_memory_content: true,
    ...(plan.time?.valid_at ? { valid_at: plan.time.valid_at } : {}),
    ...(plan.time?.known_at ? { known_at: plan.time.known_at } : {}),
    ...(plan.time?.range ? { date_range: plan.time.range } : {}),
    ...(plan.source?.document_id ? { source_document_id: plan.source.document_id } : {}),
    ...(plan.source?.title ? { source_title: plan.source.title } : {}),
    ...(plan.source?.kind ? { source_kind: plan.source.kind } : {}),
    // A descriptive source label (for example "the pitch deck") is a semantic
    // hint, not a verified filename boundary. Permit this same recall pass to
    // continue through authorized hybrid evidence when no unique document
    // identity resolves. Literal filenames/document ids remain strict.
    ...(plan.operation === 'source_read' && plan.source?.title
      && !/\.[a-z0-9]{1,12}$/i.test(plan.source.title)
      && !plan.source?.document_id
      ? { allow_semantic_source_recovery: true }
      : {}),
    ...(plan.time?.kind === 'latest' || plan.time?.kind === 'earliest'
      ? { temporal_selector: plan.time.kind, temporal_axis: plan.time.axis || 'known_time' }
      : {}),
    // Scope: an EXPLICIT request scope (the chat's personal/organization/project selector,
    // ctx.scopeFilter) WINS over the planner's inferred scope — the user's chosen lens is
    // authoritative. 'organization'/none → no filter (everything accessible in the org).
    ...((ctx.scopeFilter || plan.scope_filter) ? { scope_filter: ctx.scopeFilter || plan.scope_filter } : {}),
  };

  // (a) Parallel recall on each sub_query — mode chosen by planner (quick
  // default, insight for relation queries, panorama for time/history).
  // Insight mode pulls synthesis_evidence_chains so the agent sees the
  // multi-source claim AND its source memories without a second call.
  const recallMode = plan.explicit_recall_mode
    || ({ quick: 'fact', panorama: 'explain', insight: 'explain' }[plan.recall_mode])
    || (['fact', 'explain', 'full'].includes(plan.recall_mode) ? plan.recall_mode : 'fact');
  // T1-4: mode-aware candidate limit. Quick mode (common path) fetches 8, not
  // 12 — render cap (evidenceTopK=6) is unchanged so zero answer-token / zero
  // quality change, but the recall-router runs MMR + score-floor over a
  // smaller set and downstream dedup carries less.
  const recallLimit = 15;
  // Lead with the optimised canonical-English query (set upstream by
  // optimizeRecallQueries) instead of the raw conversational message, so the
  // SEARCH uses the optimised version. Falls back to user_message if unset.
  const plannedQueries = [...new Set([
    plan.query_canonical_en || plan.user_message,
    ...(Array.isArray(plan.sub_queries) ? plan.sub_queries : []),
  ].filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim()))].slice(0, 3);
  // Compile the planner's decomposition into one deterministic recall packet.
  // The shared router owns wide lexical/vector/entity lanes; firing several
  // independent recalls duplicates those lanes and makes latency/merging
  // nondeterministic under load.
  // 'profile' is a dedicated lane: the get_user_profile tool IS the answer, so
  // do not also run blended recall — otherwise tenant-scoped-but-unrelated
  // memories compete with the profile facts in the synthesis prompt (review
  // MEDIUM: no precedence rule) and can be mistaken for authoritative profile.
  const dedicatedLane = plan.operation === 'aggregate' || plan.operation === 'connector_read' || plan.operation === 'relation_between' || plan.operation === 'profile' || plan.operation === 'projects';
  const recallQueries = !dedicatedLane && plannedQueries.length > 0
    ? [plan._native_single_call
      // The progressive native planner already performed semantic query
      // optimization. Preserve that exact entity/filename/qualifier-bearing
      // query for embedding, lexical retrieval and reranking; answer-shape
      // instructions belong to synthesis and can dilute the retrieval anchor.
      ? plannedQueries[0]
      : buildStructuredRecallQuery(plannedQueries, plan.answer_objective, plan.retrieval_shape)]
    : [];
  await execBaseRecall(bus, plan, ctx, helpers, { recallQueries, recallMode, recallLimit, recallExtras });

  // ── Op-stage: run each matching capability executor in the fixed registry
  // order, collecting the scalar patches. Replaces the four sequential guarded
  // blocks (relation/aggregate/timeline/profile) with one predicate-routed loop.
  let aggregateResult = null;
  let profileContext = '';
  let projectsResult = null;
  let temporalCoverage = null;
  for (const cap of OP_STAGE) {
    if (!cap.predicate(plan)) continue;
    const patch = await cap.exec(bus, plan, ctx, helpers);
    if (cap.name === 'relation' && patch?.relationChecked) {
      relationChecked = true;
      relationResult = patch?.relationResult || relationResult;
    }
    else if (cap.scalar === 'aggregateResult') aggregateResult = patch?.aggregateResult ?? aggregateResult;
    else if (cap.scalar === 'profileContext') profileContext = patch?.profileContext || profileContext;
    else if (cap.scalar === 'projectsResult') projectsResult = patch?.projectsResult ?? projectsResult;
    else if (cap.scalar === 'temporalCoverage') temporalCoverage = patch?.temporalCoverage ?? temporalCoverage;
  }

  let coverage = assessRecallCoverage({
    plan,
    memories: [...memoriesById.values()],
    evidence: evidenceItems,
    relationships: [...edgesByKey.values()],
    co_mentions: coMentions,
  });
  const retrievalHealth = () => ({
    retrieval_timed_out: steps.some((s) => /deadline exceeded|timed out/i.test(s?.result_summary || '')),
    retrieval_unavailable: steps.some((s) => /REMOTE_UNAVAILABLE|memory box unavailable|workspace unavailable/i.test(s?.result_summary || '')),
  });
  // DID RETRIEVAL ACTUALLY RUN? A hop that dies on the deadline is caught per-hop and contributes
  // nothing, which is indistinguishable downstream from "the workspace holds nothing" — and that is
  // exactly what shipped to a user: a recall timed out and the answer stated the topic "doesn't
  // appear in any source so far", while the very next attempt returned 5 memories + 8 evidence.
  // A false negative asserted as fact is the worst thing this pipeline can emit.
  // Derived from the steps ACTUALLY executed, never from intent, so it reports what happened.
  coverage = {
    ...coverage,
    ...retrievalHealth(),
  };
  if (temporalCoverage && temporalCoverage.complete !== true) {
    coverage = {
      ...coverage,
      temporal_requested: true,
      temporal_covered: false,
      temporal_tool: temporalCoverage.tool,
      cutoff_reason: temporalCoverage.reason,
      complete: false,
    };
  }
  if (plan.operation === 'relation_between' && relationChecked) {
    coverage = {
      ...coverage,
      graph_covered: true,
      complete: coverage.evidence_found
        && coverage.source_covered
        && coverage.entities_covered === coverage.entities_requested
        && (!coverage.temporal_requested || coverage.temporal_covered),
    };
  }
  let escalationCount = 0;
  if (!plan._native_single_call
      && remaining() > 0
      && !coverage.retrieval_timed_out
      && !coverage.retrieval_unavailable
      && (!plan.explicit_recall_mode || (coverage.source_requested && !coverage.source_covered))) {
    const escalation = chooseRecallEscalation({
      plan,
      coverage,
      query: plan.query_canonical_en || plan.user_message || recallQueries[0],
    });
    if (escalation) {
      escalationCount = 1;
      try {
        startTool('hivemind_recall', { ...recallExtras, ...escalation.args });
        const expanded = await beforeDeadline(() => dispatchTool('hivemind_recall', {
          ...recallExtras,
          ...escalation.args,
        }, ctx));
        recordTool(
          'hivemind_recall',
          escalation.args,
          `${expanded?.memories?.length || 0} memories + ${expanded?.evidence_count || 0} evidence (${escalation.reason})`,
          expanded,
        );
        bus.mergeMemories(expanded?.memories);
        bus.mergeEvidence(expanded?.evidence, { keyMode: 'withPage' });
        bus.mergeRankedCandidates(expanded?.ranked_candidates);
        bus.addRecallTelemetry(expanded?.trace);
        bus.mergeEdges(expanded?.relationships, { overwrite: true });
        bus.addPacket(expanded?.evidence_packet);
      } catch (error) {
        recordTool('hivemind_recall', escalation.args, `escalation error: ${error.message}`, null);
      }
      coverage = assessRecallCoverage({
        plan,
        memories: [...memoriesById.values()],
        evidence: evidenceItems,
        relationships: [...edgesByKey.values()],
      });
    }
  }

  // Connector reads use the same AgentScope-style toolkit as writes.
  await execConnectorRead(bus, plan, ctx, helpers);

  // (d) Public web fallback — after recall and semantic coverage only.
  const webPatch = await execWeb(bus, plan, ctx, helpers, coverage);
  const webJob = webPatch?.webJob ?? null;
  if (webPatch?.webPacket) {
    coverage = assessRecallCoverage({
      plan: { ...plan, source: null },
      memories: [...memoriesById.values()], evidence: evidenceItems,
      relationships: [...edgesByKey.values()],
    });
    coverage = { ...coverage, external_web_used: true, workspace_gap: true };
  } else if (webPatch?.webAttempted) {
    coverage = {
      ...coverage,
      external_web_requested: true,
      external_web_unavailable: webPatch.webError || 'web_search_unavailable',
      complete: false,
    };
  }

  // (e) Save intent — fire async after answer (handled in caller).

  return {
    memories: [...memoriesById.values()],
    live: liveItems,
    evidence: evidenceItems,
    // Typed graph edges between memories — used by answerStep to ground
    // "relation between X and Y" without hallucination.
    relationships: [...edgesByKey.values()],
    // Synthesis evidence chains from insight-mode recall.
    synthesis_chains: [...synthesisChains.values()],
    recall_packets: recallPackets,
    ranked_candidates: rankedCandidates,
    recall_telemetry: recallTelemetry,
    profile_context: profileContext,
    projects: projectsResult,
    aggregate: aggregateResult,
    relation: relationResult,
    coverage: {
      ...coverage,
      // Escalation recomputes semantic coverage. Reapply transport health from
      // the full executed step list so that recomputation cannot turn a real
      // outage into an apparent empty-result answer.
      ...retrievalHealth(),
      ...(plan.requires_complete_coverage ? {
        aggregate_requested: true,
        aggregate_complete: aggregateResult?.coverage?.complete === true,
        complete: aggregateResult?.coverage?.complete === true,
        ...(aggregateResult?.coverage?.complete === true
          ? {}
          : { cutoff_reason: aggregateResult?.coverage?.reason || 'aggregate_coverage_incomplete' }),
      } : {}),
      ...(temporalCoverage && temporalCoverage.complete !== true ? {
        temporal_requested: true,
        temporal_covered: false,
        temporal_tool: temporalCoverage.tool,
        cutoff_reason: temporalCoverage.reason,
        complete: false,
      } : {}),
    },
    escalation_count: escalationCount,
    steps,
    webJob,
  };
}

// ── STEP 4 — Answer ────────────────────────────────────────────────────

function answerPrompt({ language, assistantName, orgName }) {
  const lang = languageName(language);
  const orgLabel = (!orgName || /^Local Org\b/i.test(orgName)) ? 'this HIVEMIND workspace' : orgName;
  const name = assistantName || 'HIVE';
  return `LANGUAGE: ALL OUTPUT MUST BE IN ${lang.toUpperCase()}. Even if the user wrote in another language, the "response" field is written in ${lang}. Sub-queries and tool args may stay English (already executed); the user-facing prose is ${lang} only.

${organizationalBrainIdentity({ name, orgLabel })}
${ORGANIZATIONAL_BRAIN_PERSONA}

You will be given a user message + a numbered EVIDENCE block of memories
already retrieved for you. Compose the final answer using ONLY those
memories as ground truth. Today's date is ${new Date().toISOString().slice(0, 10)}.

OUTPUT — STRICT JSON (no prose, no code fence):
{
  "response":        "<final answer in ${lang}>",
  "claims":          [{"text":"<one user-visible claim>","grounded":true,"citation_ids":["P1-C1"]}],
  "evidence_used":   [<memory_id_short>, ...],   // first 8 chars of each id you actually relied on
  "confidence":      0.0,                          // [0,1] — how grounded the answer is in evidence
  "gaps":            ["..."],                      // what the user might want but the evidence didn't cover
  "context_status":  "sufficient|relevant_but_incomplete|query_mismatch"
}

CORE RULES:

1. GROUND every factual claim about the user / their people / projects /
   decisions / history in the EVIDENCE block, LIVE WORKSPACE block, or
   DOCUMENT SEGMENTS block. Don't invent. When citing a LIVE WORKSPACE
   item, reference it naturally (e.g. "your last email from X on
   <date> said…"); don't paste raw IDs.
   Every user-visible sentence must also appear as one item in claims.
   Use only IDs from the CITATION REGISTRY. Set grounded=false only
   when this request explicitly permits general knowledge.
2. **PARTIAL coverage = USE IT, don't bail.** If even ONE evidence
   row touches the user's question, first synthesize what that evidence
   establishes, then state the exact missing point as a gap and invite
   the user to add the relevant source or context. Never replace useful
   evidence with a blanket "I don't know" or "no evidence" response.
   Only say that a matching source is absent when the EVIDENCE / LIVE /
   DOC blocks are truly empty for that question. Every sentence in the
   synthesis still needs a valid citation.
   **Hard rule for connector queries (slack/notion/gmail/github/linear):**
   if the user asked about that connector AND the EVIDENCE block
   contains AT LEAST ONE memory carrying the connector tag (slack,
   notion, gmail, …), you MUST answer using those memories. Do NOT
   say "I don't have records of Slack messages" while Slack-tagged
   memories are listed.
   **Tag-anchored matches are real matches.** If the user asks about a
   file or entity by name and ANY memory carries the matching
   filename:<name> or entity:<name> tag, that memory IS about that
   file/entity — describe it accordingly using whatever content the
   memory has. Even if the memory's TITLE diverges from the user's
   exact wording (e.g. Groq vision misclassified an image), the tag is
   the source of truth for identity.
3. **Synthesize across memories.** Multiple rows about the same entity
   should be combined into one coherent reply, not treated as separate
   silos. Spot patterns: who's involved, what was decided, what's
   pending, what changed.
3b. **CONFLICTING EVIDENCE — resolve by priority, else surface. NEVER guess.**
   When two memories DISAGREE about the same fact (a different value/state
   for the same entity, or a Contradicts/Updates edge between them):
   (a) prefer the memory with the more RECENT recorded date (the later fact
       supersedes the earlier — dates are shown per memory);
   (b) if one source is clearly higher-authority than the other (an official
       document / decision outranks a passing chat mention or an inferred
       synthesis), prefer the authoritative source;
   (c) if you CANNOT confidently resolve it from recency or authority, DO NOT
       pick one side silently. State the disagreement explicitly: name BOTH
       claims, their sources/dates, and that they conflict — then give the
       most-likely reading if there is one, flagged as uncertain.
   When evidence genuinely conflicts, an honest "these disagree: X (older/Slack)
   vs Y (newer/decision doc)" is ALWAYS better than confidently asserting one.
4. NEVER paste a memory's content verbatim as the entire answer. NEVER
   reply with just a citation line or URL.
5. NEVER claim a third-party brand mentioned in memories IS us. Use
   first-person plural ("we", "our") only when an evidence row
   self-identifies our org ("we are X" / "our company is X").
6. Write in ${lang}, conversational and fluent. Keep brand names,
   project codes, file paths, URLs in original form.
7. Length: 2-5 sentences typical, longer only if user asked for a list
   or plan. No "Next steps:" / "How would you like to proceed?" boilerplate.
8. If the user message was a pure save/update/log intent (e.g. "save X",
   "remember Y"), acknowledge briefly ("Got it — saved.") in ${lang}
   without restating the saved content. **NEVER mention the auto-save
   pipeline.** When the planner silently auto-saved a durable fact from
   the user's message, do NOT tell them "I saved that for you" — answer
   the user's actual question (or just answer their statement) as if
   nothing happened. Auto-save is a background reflex, not a feature
   the user needs to be told about.
   ONE EXCEPTION, AND ONLY THIS ONE: if a save step's summary contains
   "CONFLICTS WITH:", the new fact contradicts something already stored.
   Say so in one short sentence naming the existing item, e.g.
   "Saved — note this
   Do not speculate about which is correct and do not ask a question;
   just surface the clash so the user can decide. If there is no
   "CONFLICTS WITH:" marker, stay silent about saving exactly as above.
9. **NEVER deny write/post access.** When a user asks to send/post/draft
   a slack message (or any connector action), do NOT say "I don't have
   access" or "I can't send messages". The system DOES have write
   capability via the draft-approval gate — the agent's write-intent
   branch will create a draft for user approval. If the user's request
   is ambiguous about WHICH channel or recipient, ask a clarifying
   question instead of claiming inability.
9b. **TEMPORAL SUMMARY enumeration.** When the user asks "what did I
   do today / yesterday / this week / last week / on <date>" AND the
   EVIDENCE block contains memories whose created_at or document_date
   falls in the requested window, you MUST enumerate them. Sort by
   created_at descending. Do NOT say "I don't have notes on today"
   when 5+ memories carry today's ts:* tag or created_at — that is a
   hard failure. Even minor activity (a purchase, a calendar event,
   a saved fact) counts; report it. Length: one bullet or sentence
   per memory, grouped by time-of-day if many.
10. **PREFER SYNTH-tier memories.** Lines prefixed [SYNTH/CANONICAL] or
    [SYNTH/BRIDGE] are curated distillations from the cognition loop —
    they fuse multiple raw memories into one confidence-scored claim
    with revision history (conf=X.XX, rev=N). When a SYNTH row covers
    the user's question, cite it directly and treat it as ground truth.
    Use raw evidence rows only to add detail the SYNTH row omits, or
    when no SYNTH row is on-topic. \`x-cluster=X.XX\` marks memories
    reinforced by neighbour clusters sharing entities — these are extra
    high-confidence cross-domain links worth surfacing in the answer.
11. **RELATIONS REQUIRE EDGES OR EXPLICIT CLAIMS — NEVER INVENT.** When the
    user asks how memory X relates to memory Y, or what the connection
    between two people/projects/topics is, you must:
      (a) look up the GRAPH EDGES block above,
      (b) report ONLY edges that touch the relevant memory ids,
      (c) state edge type literally ("Updates", "Extends", "Mentions",
          "Derives", "Contradicts") with the confidence shown,
      (d) an explicit delivered sentence relating both requested entities may
          be reported as that source's claim, preserving whether it is a user
          assertion or stored record; it is not a verified graph edge,
      (e) if neither an edge nor an explicit relation claim is delivered,
          answer that no recorded relation was found. Do NOT infer a relation
          from shared entities, co-occurring tags, or topic overlap.
    The GRAPH EDGES block reflects what the cognition loop and
    smart-ingest actually wrote into the Relationship table. An explicit
    sourced relation claim remains a claim, not an edge; everything else is
    content co-occurrence and is not a relation. When in doubt, preserve that
    distinction and never invent an edge.
11c. **[REMOVED/SUPERSEDED] rows are NO LONGER TRUE.** A row prefixed
    [REMOVED/SUPERSEDED] was superseded/removed as of the queried time window
    (from a temporal diff). Report it as a PAST value that changed ("the launch
    date WAS X but changed to Y"), never as a current fact. Prefer the
    non-removed row for the current value.
12. **NEVER CONTRADICT THE DELIVERED EVIDENCE.** If a name, product,
    entity, date, or fact literally appears in the EVIDENCE / DOCUMENT
    SEGMENTS / LIVE blocks above, you may NOT state that it is absent,
    unknown, or unmentioned. Answer per-entity: describe each entity the
    blocks DO cover, and only for an entity with genuinely zero rows say
    the evidence does not cover it. A COVERAGE DISCLOSURE line, when
    present, is authoritative about which requested entities are and are
    not covered — obey it exactly. Asserting blanket absence while
    matching rows are listed is a hard failure.`;
}

export function buildChatCitationPacket(recallPackets = []) {
  const citations = [];
  for (const [packetIndex, packet] of recallPackets.entries()) {
    for (const citation of (packet?.citations || [])) {
      if (!citation?.id) continue;
      citations.push({ ...citation, id: `P${packetIndex + 1}-${citation.id}` });
    }
  }
  return { citations };
}

export function buildChatCitationSources(recallPackets = [], claims = []) {
  const usedIds = new Set(
    (claims || [])
      .filter((claim) => claim?.grounded === true)
      .flatMap((claim) => Array.isArray(claim.citation_ids) ? claim.citation_ids : []),
  );
  const sources = [];
  const seen = new Set();

  for (const [packetIndex, packet] of (recallPackets || []).entries()) {
    const sectionsById = new Map(
      (packet?.sourceSections || [])
        .filter((section) => section?.segment_id)
        .map((section) => [section.segment_id, section]),
    );
    const factsById = new Map(
      (packet?.facts || [])
        .filter((fact) => fact?.id || fact?.memory_id || fact?.memoryId)
        .map((fact) => [fact.id || fact.memory_id || fact.memoryId, fact]),
    );
    for (const citation of (packet?.citations || [])) {
      if (!citation?.id) continue;
      const citationId = `P${packetIndex + 1}-${citation.id}`;
      if (!usedIds.has(citationId) || seen.has(citationId)) continue;
      seen.add(citationId);
      const section = sectionsById.get(citation.segment_id) || {};
      const fact = factsById.get(citation.memory_id) || {};
      sources.push({
        id: citation.segment_id || citation.memory_id || citationId,
        citation_id: citationId,
        segment_id: citation.segment_id || null,
        document_id: citation.document_id || section.document_id || null,
        title: citation.title || citation.source_label || section.document_title || 'Workspace source',
        snippet: section.snippet || section.content || citation.snippet || fact.content || '',
        page: citation.page ?? section.page ?? null,
        source_type: citation.source_type || (citation.memory_id ? 'memory_evidence' : 'document_evidence'),
        score: Number.isFinite(section.score) ? section.score : null,
        url: citation.url || section.url || null,
        retrieved_at: citation.retrieved_at || section.retrieved_at || null,
      });
    }
  }
  return sources;
}

export function validateChatAnswer(payload, recallPackets = [], { allowGeneralKnowledge = false } = {}) {
  // The server namespaces citations across recall packets (P1-C1, P2-E1) so
  // a claim can never accidentally cite the wrong subquery. Some providers
  // nevertheless reproduce the local, source-owned ID visible in an evidence
  // row (C1/E1). Preserve grounding without weakening it: resolve such an ID
  // only when exactly one delivered citation has that suffix. Ambiguous local
  // IDs remain invalid and model-invented IDs are still rejected.
  const packet = buildChatCitationPacket(recallPackets);
  const validIds = new Set(packet.citations.map((citation) => citation.id));
  const resolveCitation = (candidate) => {
    const id = typeof candidate === 'string' ? candidate.trim() : '';
    if (!id) return null;
    if (validIds.has(id)) return id;
    const matches = [...validIds].filter((known) => known.endsWith(`-${id}`));
    return matches.length === 1 ? matches[0] : null;
  };
  const normalizedPayload = {
    ...(payload && typeof payload === 'object' ? payload : {}),
    claims: Array.isArray(payload?.claims) ? payload.claims.map((claim) => {
      const rawIds = Array.isArray(claim?.citation_ids)
        ? claim.citation_ids
        : (Array.isArray(claim?.citations) ? claim.citations : []);
      return {
        ...claim,
        citation_ids: [...new Set(rawIds.map(resolveCitation).filter(Boolean))],
      };
    }) : [],
  };
  return validateGroundedClaims(
    normalizedPayload,
    packet,
    { allowGeneralKnowledge },
  );
}

function aggregateCitationPacket(aggregate) {
  if (!aggregate || !Number.isInteger(aggregate.count)) return null;
  const kind = aggregate.entity_kind || 'entity';
  const parent = aggregate.parent || 'workspace';
  const names = (aggregate.entities || [])
    .map((entity) => entity?.name)
    .filter(Boolean)
    .slice(0, 20);
  return {
    citations: [{
      id: 'A1',
      source_type: 'entity_aggregate',
      source_label: `Canonical ${kind} registry for ${parent}`,
      title: `Canonical ${kind} registry for ${parent}`,
      snippet: `Complete tenant-scoped canonical ${kind} aggregation: ${aggregate.count} distinct ${kind}${aggregate.count === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}.`,
    }],
  };
}

function hasGroundedPacketEvidence(evidence) {
  return (evidence?.recall_packets || []).some((packet) =>
    (packet?.facts?.length || 0) > 0
    || (packet?.sourceSections?.length || 0) > 0
    || (packet?.citations?.length || 0) > 0,
  );
}

export function groundedRecallFallback(evidence, language, message = '', { source = null } = {}) {
  const rows = [];
  const seen = new Set();
  const stop = new Set(['about', 'all', 'and', 'are', 'can', 'could', 'detail', 'detailed', 'does', 'everything', 'file', 'from', 'give', 'have', 'how', 'into', 'more', 'please', 'should', 'tell', 'that', 'the', 'their', 'this', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'would', 'your']);
  const queryTokens = [...new Set(String(message || '').normalize('NFKC').toLocaleLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((token) => token.length >= 3 && !stop.has(token)))];
  const relevant = (text, title) => {
    const requestedTitle = String(source?.title || '').normalize('NFKC').toLocaleLowerCase().trim();
    const actualTitle = String(title || '').normalize('NFKC').toLocaleLowerCase().trim();
    if (requestedTitle && (actualTitle === requestedTitle || actualTitle.startsWith(`${requestedTitle} :`))) return true;
    if (!queryTokens.length) return true;
    const haystack = `${title || ''} ${text || ''}`.normalize('NFKC').toLocaleLowerCase();
    const matches = queryTokens.filter((token) => haystack.includes(token)).length;
    return matches >= Math.min(2, queryTokens.length);
  };
  for (const [packetIndex, packet] of (evidence?.recall_packets || []).entries()) {
    const sections = new Map((packet?.sourceSections || [])
      .filter((section) => section?.segment_id)
      .map((section) => [section.segment_id, section]));
    const facts = new Map((packet?.facts || [])
      .filter((fact) => fact?.id || fact?.memory_id || fact?.memoryId)
      .map((fact) => [fact.id || fact.memory_id || fact.memoryId, fact]));
    for (const citation of (packet?.citations || [])) {
      if (!citation?.id) continue;
      const section = sections.get(citation.segment_id) || {};
      const fact = facts.get(citation.memory_id) || {};
      const rawText = String(
        section.snippet || section.content || fact.content || citation.snippet || '',
      );
      const cleaned = rawText
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/\|\s*:?-{3,}:?\s*/g, ' ')
        .replace(/[|*_>`~]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const sentences = cleaned.split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length >= 35);
      const text = String(sentences[0] || cleaned).slice(0, 360).trim();
      const title = String(citation.title || citation.source_label || section.document_title || '').trim().slice(0, 180);
      if (!relevant(text, title)) continue;
      const fingerprint = text.toLocaleLowerCase();
      if (!text || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      rows.push({
        text,
        title,
        citation_id: `P${packetIndex + 1}-${citation.id}`,
      });
      if (rows.length >= 5) break;
    }
    if (rows.length >= 5) break;
  }
  if (!rows.length) return null;
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const headings = {
    de: 'Das ist der verifizierte Inhalt, den ich dazu gefunden habe:',
    fr: 'Voici le contenu vérifié que j’ai trouvé à ce sujet :',
    es: 'Este es el contenido verificado que encontré al respecto:',
    en: 'Here is the verified information I found:',
  };
  return {
    response: `${headings[lang] || headings.en}\n${rows.map((row) => `- ${row.title ? `${row.title}: ` : ''}${row.text}`).join('\n')}`,
    claims: rows.map((row) => ({
      text: row.text,
      grounded: true,
      citation_ids: [row.citation_id],
      provenance: 'deterministic_recall_fallback',
    })),
  };
}

function unavailableEvidenceResponse({ message, evidence, language }) {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const memoryCount = evidence?.memories?.length || 0;
  const sectionCount = evidence?.evidence?.length || 0;
  const hasPartialContext = memoryCount > 0 || sectionCount > 0 || hasGroundedPacketEvidence(evidence);

  if (hasPartialContext) {
    const context = [
      memoryCount ? `${memoryCount} related memor${memoryCount === 1 ? 'y' : 'ies'}` : '',
      sectionCount ? `${sectionCount} source passage${sectionCount === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');
    // Human voice: first person, warm, no verbatim echo of a long question.
    const topic = String(message || '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 80);
    const responses = {
      de: `Ich habe ${context || 'etwas Kontext'} dazu gefunden — aber nichts, was deine Frage direkt beantwortet. Wenn du mir das passende Dokument, die Entscheidung oder die Nachricht dazu gibst, verbinde ich es mit dem, was ich schon weiss.`,
      fr: `J'ai trouve ${context || 'du contexte'} a ce sujet — mais rien qui reponde directement a ta question. Partage le document, la decision ou le message concerne et je le relierai a ce que je sais deja.`,
      es: `Encontre ${context || 'algo de contexto'} sobre esto — pero nada que responda directamente a tu pregunta. Compárteme el documento, la decision o el mensaje relacionado y lo conectare con lo que ya se.`,
      en: `I found ${context || 'some related context'} that may be useful, but the specific detail you asked for is not covered yet. If you tell me which person, project, date, document, or message you mean, I'll narrow it down and connect it with what I already know.`,
    };
    return responses[lang] || responses.en;
  }

  const topic = String(message || '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 80);

  // A TIMEOUT IS NOT AN ABSENCE. If retrieval never completed we know nothing about whether the
  // workspace holds an answer, so claiming the topic "doesn't appear in any source" is a fabricated
  // negative — and it is not hypothetical: a user asked a question whose answer WAS stored, the
  // lookup exceeded its budget, and this branch told them nothing was there. Say what happened and
  // invite a retry, which is what actually works. Mirrors sourceUnavailableResponse below, which
  // already distinguishes "could not retrieve" from "not present".
  if (evidence?.coverage?.retrieval_timed_out || evidence?.coverage?.retrieval_unavailable) {
    const unavailable = evidence?.coverage?.retrieval_unavailable;
    const timeoutResponses = {
      de: unavailable ? `Meine Memory Box ist gerade nicht erreichbar. Ich habe deshalb NICHT festgestellt, dass es dazu nichts gibt; ich konnte die Quellen nicht pruefen. Bitte versuche es gleich noch einmal.` : `Die Suche in meinem Gedaechtnis hat zu lange gedauert und wurde abgebrochen — ich habe also NICHT festgestellt, dass es dazu nichts gibt. Frag einfach noch einmal; meistens klappt es beim zweiten Versuch.`,
      fr: unavailable ? `Ma Memory Box est momentanement indisponible. Je n'ai donc PAS etabli qu'il n'y a rien a ce sujet; je n'ai pas pu verifier les sources. Reessaie dans un instant.` : `La recherche dans ma memoire a depasse le temps imparti et a ete interrompue — je n'ai donc PAS etabli qu'il n'y a rien a ce sujet. Repose la question, cela aboutit generalement au second essai.`,
      es: unavailable ? `Mi Memory Box no esta disponible en este momento. Por eso NO he comprobado que no haya nada sobre esto; no pude revisar las fuentes. Intentalo de nuevo en un momento.` : `La busqueda en mi memoria tardo demasiado y se cancelo — asi que NO he comprobado que no haya nada sobre esto. Preguntame otra vez; normalmente funciona en el segundo intento.`,
      en: unavailable ? `My Memory Box is temporarily unavailable, so I have NOT established that there's nothing on this — I couldn't inspect the sources. Please try again in a moment.` : `My memory lookup took too long and was cut off, so I have NOT established that there's nothing on this — I simply didn't get an answer back in time. Ask me again; it usually succeeds on the second attempt.`,
    };
    return timeoutResponses[lang] || timeoutResponses.en;
  }

  const responses = {
    de: `Dazu habe ich noch nichts in meinem Gedaechtnis — "${topic}" taucht bisher in keiner Quelle auf. Lade ein Dokument hoch oder erzaehl mir kurz davon, dann merke ich es mir und kann beim naechsten Mal antworten.`,
    fr: `Je n'ai encore rien en memoire a ce sujet — "${topic}" n'apparait dans aucune source pour l'instant. Importe un document ou raconte-le-moi, je m'en souviendrai la prochaine fois.`,
    es: `Todavia no tengo nada en mi memoria sobre eso — "${topic}" no aparece en ninguna fuente. Sube un documento o cuentamelo y lo recordare para la proxima vez.`,
    en: `I couldn't find a matching detail for "${topic}" in the sources I can currently see. If you can be more specific about the person, project, date, document, or message, I'll search that angle; you can also tell me the missing context and I'll remember it.`,
  };
  return responses[lang] || responses.en;
}

function publicWebUnavailableResponse({ evidence, language }) {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const reason = String(evidence?.coverage?.external_web_unavailable || 'web_search_unavailable');
  const quota = /plan_limit|quota|allowance|credit/i.test(reason);
  const responses = quota ? {
    de: 'Ich habe zuerst HIVEMIND durchsucht, konnte die angeforderte öffentliche Websuche aber nicht ausführen, weil das Web-Kontingent derzeit ausgeschöpft ist. Ich stelle internen Workspace-Kontext nicht als aktuelle öffentliche Information dar.',
    fr: "J'ai d'abord consulté HIVEMIND, mais je n'ai pas pu lancer la recherche Web publique demandée car le quota Web est épuisé. Je ne présenterai pas le contexte interne comme une information publique actuelle.",
    es: 'Primero busqué en HIVEMIND, pero no pude ejecutar la búsqueda web pública solicitada porque se agotó la cuota web. No presentaré el contexto interno como información pública actual.',
    en: 'I searched HIVEMIND first, but the requested public-web search could not run because the web allowance is currently exhausted. I will not present internal workspace context as current public information.',
  } : {
    de: 'Ich habe zuerst HIVEMIND durchsucht, aber die angeforderte öffentliche Websuche ist derzeit nicht verfügbar. Ich werde internen Workspace-Kontext nicht als aktuelle öffentliche Information ausgeben. Bitte versuche es gleich noch einmal.',
    fr: "J'ai d'abord consulté HIVEMIND, mais la recherche Web publique demandée est momentanément indisponible. Je ne présenterai pas le contexte interne comme une information publique actuelle. Réessaie dans un instant.",
    es: 'Primero busqué en HIVEMIND, pero la búsqueda web pública solicitada no está disponible ahora. No presentaré el contexto interno como información pública actual. Inténtalo de nuevo en un momento.',
    en: 'I searched HIVEMIND first, but the requested public-web search is temporarily unavailable. I will not present internal workspace context as current public information. Please try again in a moment.',
  };
  return responses[lang] || responses.en;
}

function sourceUnavailableResponse({ evidence, language }) {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const source = evidence?.coverage?.source?.title || evidence?.coverage?.source?.document_id || 'the requested source';
  const responses = {
    de: `HIVEMIND konnte keinen verifizierten Abschnitt aus "${source}" abrufen. Ich habe keine anderen Quellen als Ersatz verwendet, weil die Frage ausdruecklich dieses Dokument betrifft. Lade die Datei erneut hoch oder frage breiter nach dem Workspace-Kontext.`,
    fr: `HIVEMIND n'a trouve aucun passage verifie dans "${source}". Je n'ai pas substitue d'autres sources, car votre question porte explicitement sur ce document. Reimportez le fichier ou posez une question plus large sur l'espace de travail.`,
    es: `HIVEMIND no encontro ningun pasaje verificado en "${source}". No utilice otras fuentes como sustituto porque la pregunta se refiere explicitamente a este documento. Vuelve a cargar el archivo o pregunta de forma mas amplia sobre el espacio de trabajo.`,
    en: `HIVEMIND could not retrieve a verified passage from "${source}". I did not substitute other sources because your question explicitly concerns this document. Re-upload the file or ask a broader workspace question.`,
  };
  return responses[lang] || responses.en;
}

function temporalUnavailableResponse({ evidence, language }) {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const tool = evidence?.coverage?.temporal_tool;
  const isDiff = tool === 'hivemind_diff';
  const responses = {
    de: isDiff
      ? 'Ich konnte für diesen Zeitraum keine verifizierten zeitlich eingeordneten Datensätze vergleichen. Ich ersetze sie nicht durch aktuelle oder benachbarte Informationen.'
      : 'Ich konnte für diesen Zeitpunkt keinen verifizierten, zeitlich eingeordneten Datensatz finden. Ich ersetze ihn nicht durch aktuelle oder benachbarte Informationen.',
    fr: isDiff
      ? 'Je n’ai pas pu comparer de documents vérifiés et datés pour cette période. Je ne les remplace pas par des informations actuelles ou voisines.'
      : 'Je n’ai pas trouvé de document vérifié et daté pour ce moment précis. Je ne le remplace pas par des informations actuelles ou voisines.',
    es: isDiff
      ? 'No pude comparar registros verificados y fechados para ese periodo. No los sustituiré por información actual o cercana.'
      : 'No pude encontrar un registro verificado y fechado para ese momento concreto. No lo sustituiré por información actual o cercana.',
    en: isDiff
      ? 'I could not compare verified, time-qualified records for that period, so I will not substitute a current or nearby record.'
      : 'I could not find a verified, time-qualified record for that point in time, so I will not substitute a current or nearby record.',
  };
  return responses[lang] || responses.en;
}

function noVerifiedRelationResponse({ evidence, language }) {
  const lang = String(language || 'en').slice(0, 2).toLowerCase();
  const entities = evidence?.relation?.entities || [];
  const subject = entities.length >= 2 ? `${entities[0]} and ${entities[1]}` : 'those two subjects';
  const responses = {
    de: `Ich habe keine verifizierte Beziehung zwischen ${subject} im gespeicherten Graphen gefunden. Ich werde keine Beziehung aus lediglich ähnlichen oder benachbarten Notizen ableiten.`,
    fr: `Je n’ai trouvé aucune relation vérifiée entre ${subject} dans le graphe mémorisé. Je n’en déduirai pas une à partir de notes seulement similaires ou voisines.`,
    es: `No encontré una relación verificada entre ${subject} en el grafo almacenado. No inferiré una relación a partir de notas solo similares o cercanas.`,
    en: `I found no verified relationship between ${subject} in the stored graph, so I will not infer one from merely nearby or similar notes.`,
  };
  return responses[lang] || responses.en;
}

export async function answerStep({ message, history, evidence, plan, language, assistantName, orgName, model, apiKey, signal, ctx, allowGeneralKnowledge = false, preloadedProfileContext = '', streamValidated = false, onEvent = null }) {
  const synthesisPrompt = buildSynthesisPromptArtifact({
    language,
    operation: plan.operation,
    recallMode: plan.recall_mode,
    responseDepth: plan.response_depth,
    answerObjective: plan.answer_objective || message,
  });
  if (plan.web_fallback?.reason === 'explicit_web' && evidence.coverage?.external_web_unavailable) {
    return {
      response: publicWebUnavailableResponse({ evidence, language }),
      claims: [], rejected_claims: [], grounded: false, evidence_used: [], confidence: 0,
      gaps: ['The requested public-web search did not complete.'],
      context_status: 'relevant_but_incomplete', answer_coverage: [], usage: null,
    };
  }
  if (plan.requires_complete_coverage && evidence.coverage?.aggregate_complete === true
      && Number.isInteger(evidence.aggregate?.count)) {
    const count = evidence.aggregate.count;
    const kind = evidence.aggregate.entity_kind || plan.aggregate?.kind || 'entities';
    const parent = evidence.aggregate.parent || plan.aggregate?.parent || '';
    const lang = String(language || 'en').slice(0, 2).toLowerCase();
    // rosemary A1: LIST the actual entity names, not just the count. A "list all
    // X" question must answer with the names. Cap at 20 to match the aggregate
    // citation packet's name cap, so every listed name is present in the packet
    // snippet and validateChatAnswer keeps the claim grounded.
    const _names = (evidence.aggregate.entities || []).map((e) => e && e.name).filter(Boolean);
    const _shown = _names.slice(0, 20);
    const _more = _names.length > _shown.length ? ` (+${_names.length - _shown.length} more)` : '';
    const _tail = _shown.length ? `: ${_shown.join(', ')}${_more}` : '';
    const responses = {
      de: `Das kanonische Register enthält ${count} für ${parent} als ${kind} klassifizierte Einträge${_tail}.`,
      fr: `Le registre canonique contient ${count} entités associées à ${parent} classées comme ${kind}${_tail}.`,
      es: `El registro canónico contiene ${count} entidades asociadas a ${parent} clasificadas como ${kind}${_tail}.`,
      en: `The canonical registry contains ${count} entities associated with ${parent} classified as ${kind}${count === 1 ? '' : 's'}${_tail}.`,
    };
    const response = responses[lang] || responses.en;
    const aggregatePacket = aggregateCitationPacket(evidence.aggregate);
    const aggregatePackets = [...(evidence.recall_packets || []), aggregatePacket].filter(Boolean);
    const aggregateCitationId = `P${aggregatePackets.length}-A1`;
    const validated = validateChatAnswer({
      answer: response,
      claims: [{
        text: response,
        grounded: true,
        citation_ids: [aggregateCitationId],
        provenance: 'entity_aggregate',
      }],
    }, aggregatePackets, { allowGeneralKnowledge });
    return {
      response: validated.answer || response,
      claims: validated.claims,
      rejected_claims: validated.rejected_claims,
      grounded: validated.grounded,
      evidence_used: [],
      confidence: 0.99,
      gaps: [],
      usage: null,
      aggregate_citation_packet: aggregatePacket,
    };
  }
  if (plan.requires_complete_coverage && evidence.coverage?.aggregate_complete !== true) {
    const lang = String(language || 'en').slice(0, 2).toLowerCase();
    const responses = {
      de: 'Ich kann die genaue Anzahl aus einer Top-K-Suche nicht zuverlässig bestimmen. Dafür ist eine vollständige, deduplizierte Entitäts- oder Dokumentaggregation erforderlich.',
      fr: 'Je ne peux pas déterminer le nombre exact à partir d’une recherche top-K. Il faut une agrégation complète et dédupliquée des entités ou documents.',
      es: 'No puedo determinar el número exacto a partir de una búsqueda top-K. Se necesita una agregación completa y sin duplicados de entidades o documentos.',
      en: 'I cannot determine the exact count from top-K recall. A complete, deduplicated entity or document aggregation is required.',
    };
    return {
      response: responses[lang] || responses.en,
      claims: [],
      rejected_claims: [],
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['coverage_incomplete: exact aggregate executor did not prove complete coverage'],
      usage: null,
    };
  }
  if (plan.operation === 'relation_between'
      && evidence.relation?.verified_relation_found !== true
      && evidence.relation?.grounded_relation_claim_found !== true
      && !(['session', 'workflow', 'full'].includes(ctx?.durableChatMode) && hasGroundingEvidence(evidence))) {
    return {
      response: noVerifiedRelationResponse({ evidence, language }),
      claims: [],
      rejected_claims: [],
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['No direct typed relationship was verified between the requested entities.'],
      usage: null,
    };
  }
  if (evidence.coverage?.source_requested && !evidence.coverage.source_covered) {
    // A named source is a precision boundary. Do not substitute neighboring
    // documents when its own evidence was not recovered.
    return {
      response: sourceUnavailableResponse({ evidence, language }),
      claims: [],
      rejected_claims: [],
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['The requested source was not covered by retrieved source evidence.'],
      usage: null,
    };
  }
  if (evidence.coverage?.temporal_requested && evidence.coverage?.temporal_covered === false) {
    return {
      response: temporalUnavailableResponse({ evidence, language }),
      claims: [],
      rejected_claims: [],
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['No verified temporal material was retrieved for the requested point or range.'],
      usage: null,
    };
  }

  // Connector capability hint — built from active Nango connections so
  // the LLM knows write access exists + which channels/recipients are
  // resolvable. Prevents "I don't have access" hallucinations.
  let capabilityHint = '';
  if (ctx?.prisma?.nangoConnection) {
    try {
      const conns = await ctx.prisma.nangoConnection.findMany({
        where: { userId: ctx.userId, orgId: ctx.orgId, status: 'active' },
        select: { providerKey: true },
      });
      const providers = conns.map(c => c.providerKey);
      // Slack moved to native OAuth (PlatformIntegration) — Nango rows no
      // longer represent it. Include it when the native connector is active
      // so the agent knows the slack tool group exists.
      if (!providers.includes('slack') && ctx.prisma.platformIntegration) {
        const nativeSlack = await ctx.prisma.platformIntegration.findUnique({
          where: { userId_platformType: { userId: ctx.userId, platformType: 'slack' } },
          select: { isActive: true },
        }).catch(() => null);
        if (nativeSlack?.isActive) providers.push('slack');
      }
      if (providers.length > 0) {
        capabilityHint += `\n\nCONNECTED PROVIDERS (write available via draft-approval): ${providers.join(', ')}`;
      }
      // Slack channel directory for write-target resolution.
      if (providers.includes('slack') && ctx.prisma.memory) {
        const rows = await ctx.prisma.memory.findMany({
          where: { userId: ctx.userId, deletedAt: null, tags: { hasSome: ['slack'] } },
          select: { sourceMetadata: true, tags: true },
          take: 30, orderBy: { createdAt: 'desc' },
        });
        const channelMap = new Map();
        for (const r of rows) {
          const ch = (r.tags || []).find(t => typeof t === 'string' && t.startsWith('channel:'));
          const id = r.sourceMetadata?.slack_channel_id || r.sourceMetadata?.metadata?.slack_channel_id;
          if (ch && id) channelMap.set(ch.slice('channel:'.length), id);
        }
        if (channelMap.size > 0) {
          const lines = Array.from(channelMap.entries()).slice(0, 10)
            .map(([n, i]) => `  #${n} → ${i}`).join('\n');
          capabilityHint += `\n\nKNOWN SLACK CHANNELS (resolved channel_id):\n${lines}`;
        }
      }
    } catch {}
  }

  // Build EVIDENCE block (numbered, with short id).
  // Synthesis-tier memories (canonical-fact / synthesis-bridge from the
  // cognition loop) are pre-curated multi-source distillations carrying
  // confidence + revision history. Mark them with a [SYNTH] prefix so the
  // LLM can preferentially cite them over raw evidence — they reflect what
  // the system has REASONED about, not just what was logged. Phase 3
  // cross-cluster boost flag included when present so the LLM sees which
  // memories were reinforced by neighbour clusters.
  //
  // Top-K bound: quick mode shows 6, insight 10. Was 12 — cut bloat to
  // halve prompt tokens. Recall-router already applied MMR + score-floor
  // + cluster-collapse so the trimmed set is the tight relevance core.
  // ── Event-time ranking (gated EVENT_TIME_RANKING, default OFF) ──
  // For temporal queries ("early June", "what happened in March"), recall
  // returns a loose semantic tail (real in-window rows mixed with tangential
  // ones), and the answer model then bails ("no notes on early June") rather
  // than risk hallucinating off the noise. Here we REORDER evidence so
  // memories whose DATE falls in the query window come first, and TRIM the
  // delivered set to that in-window core — giving the model a tight, relevant
  // set like an explicit-date query gets. SOFT: if no in-window memory exists,
  // evidence is left untouched (never empties). Reorder/trim only, no recall
  // re-query, no hard DB filter (that earlier broke working queries).
  let _eventWindowHits = 0;
  if (process.env.EVENT_TIME_RANKING !== 'false' && Array.isArray(evidence.memories) && evidence.memories.length > 1) {
    try {
      const { expandTemporalQuery } = await import('../search/time-aware-expander.js');
      const te = expandTemporalQuery(message);
      if (te?.hasTemporalFilter && te.dateRange?.start) {
        const s = te.dateRange.start;
        const e = te.dateRange.end || te.dateRange.start;
        const inWindow = (m) => {
          const dates = [];
          for (const t of (m.tags || [])) {
            const mm = /^(?:ts|time):(\d{4}-\d{2}-\d{2})/.exec(t);
            if (mm) dates.push(mm[1]);
          }
          if (m.document_date) dates.push(String(m.document_date).slice(0, 10));
          for (const d of (m.event_dates || [])) dates.push(String(d).slice(0, 10));
          if (m.created_at) dates.push(String(m.created_at).slice(0, 10));
          return dates.some((d) => d >= s && d <= e);
        };
        const hits = evidence.memories.filter(inWindow);
        if (hits.length > 0) {
          const hitSet = new Set(hits.map((m) => m.id));
          const rest = evidence.memories.filter((m) => !hitSet.has(m.id));
          evidence = { ...evidence, memories: [...hits, ...rest] };
          // STRICT mode (gated EVENT_TIME_RANKING_STRICT, default OFF — opt-in):
          // boost ts:-tagged matches to the top + trim the tail HARD to top-N
          // (default 3, env EVENT_TIME_TOP_N to override). Tighter set than the
          // default cap-5 reorder. For A/B against the cap-5 reorder.
          const STRICT = process.env.EVENT_TIME_RANKING_STRICT === 'true';
          const TOP_N = STRICT ? Math.max(1, parseInt(process.env.EVENT_TIME_TOP_N || '3', 10)) : 5;
          _eventWindowHits = Math.min(hits.length, TOP_N);
          if (STRICT) {
            // Hard trim — kill the tail entirely so the answer model sees ONLY
            // in-window memories (the explicit-date-query feel for vague phrases).
            evidence = { ...evidence, memories: hits.slice(0, TOP_N) };
          }
        }
      }
    } catch { /* non-fatal — leave evidence as recalled */ }
  }

  const recallMode = plan?.recall_mode || 'quick';
  // Intent has already selected one unified window before answerStep. Do not
  // apply a second, smaller lane-local cap here: doing so silently discarded
  // ranks from detailed/comprehensive evidence-heavy answers after the one
  // authoritative mixed rerank. The fallback remains for non-progressive
  // callers such as legacy temporal/source paths.
  const evidenceTopK = evidenceRenderLimit({
    progressiveRecall: evidence.progressive_recall,
    eventWindowHits: _eventWindowHits,
    recallMode,
  });
  // Superseded predecessors / diff-removed rows are appended LAST by the
  // Updates-edge walk (execTimeline), so a plain top-K slice can drop them —
  // which is exactly the "changed over time" answer losing the prior value.
  // These rows ARE the answer to a version-history question, so always include
  // them: take the top-K, then union in any flagged rows the slice missed
  // (bounded — there are only ever a handful of superseded predecessors).
  const _topSlice = evidence.memories.slice(0, evidenceTopK);
  const _flaggedMissed = evidence.memories
    .slice(evidenceTopK)
    .filter((m) => m && (m._superseded_predecessor || m._diff_removed))
    .slice(0, 6);
  // Adaptive per-memory output budget. Selection scans the COMPLETE content
  // semantically before applying this output cap; it is no longer a prefix
  // slice. Thus a small fact near the end of a long ranked memory remains
  // visible while the final synthesis prompt stays bounded.
  const _evCount = _topSlice.length + _flaggedMissed.length;
  const _contentBudget = _evCount <= 4 ? 1400 : (_evCount <= 8 ? 700 : 300);
  const _selectedMemories = [..._topSlice, ..._flaggedMissed];
  const _projectionQuery = [
    message,
    plan?.query_canonical_en,
    ...(Array.isArray(plan?.sub_queries) ? plan.sub_queries : []),
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n');
  let _projectedMemories;
  try {
    const configuredEvidenceBudget = Number(process.env.HIVEMIND_ANSWER_EVIDENCE_CHAR_BUDGET || 12000);
    const projectionBudget = Math.max(1000, Math.min(
      Number.isFinite(configuredEvidenceBudget) ? configuredEvidenceBudget : 12000,
      Math.max(6000, _contentBudget * _selectedMemories.length),
    ));
    const cacheEligible = process.env.HIVEMIND_CHAT_CAG_ENABLED === 'true'
      && plan.operation === 'recall'
      && ctx?._chatUseTools !== true;
    const projectionCacheKey = cacheEligible ? buildProjectionCacheKey({
      orgId: ctx?.orgId,
      userId: ctx?.userId,
      projectIds: ctx?.accessContext?.projectIds || (ctx?.projectId ? [ctx.projectId] : []),
      scope: ctx?.scopeFilter || plan.scope_filter || '',
      query: _projectionQuery,
      budget: projectionBudget,
      recallMode,
      temporalControls: plan?.time || plan?.time_travel || null,
      contextRevision: ctx?.contextRevision || ctx?.accessContext?.contextRevision || null,
      projectorVersion: 'adaptive-v2',
      memories: _selectedMemories,
    }) : null;
    if (projectionCacheKey) {
      _projectedMemories = await getSharedChatProjectionCache().get(projectionCacheKey);
      if (ctx?._trace) ctx._trace.cag = { phase: 'projection-only', projection: _projectedMemories ? 'hit' : 'miss', key_version: 2 };
    }
    const selectedProjectionChars = _selectedMemories.reduce((sum, memory) => sum + String(memory?.content || '').length, 0);
    // Unified recall has already embedded the canonical query and performed
    // the one mixed rerank. Re-embedding selected passages here turned five
    // recalled memories into two additional provider batches. Preserve the
    // authoritative ranking and project excerpts deterministically instead.
    if (!_projectedMemories) {
      _projectedMemories = projectRankedMemoryFallback(_selectedMemories, {
        totalBudget: projectionBudget,
        lowerRankBudget: _contentBudget,
      });
      if (projectionCacheKey) await getSharedChatProjectionCache().set(projectionCacheKey, _projectedMemories);
    }
    if (ctx?._trace) {
      ctx._trace.evidence_projection = {
        mode: 'rank-preserving-coverage',
        memories: _selectedMemories.length,
        input_chars: selectedProjectionChars,
        output_chars: _projectedMemories.reduce((sum, item) => sum + String(item?.excerpt || '').length, 0),
      };
    }
  } catch (error) {
    // Availability fallback only. Preserve the complete highest-ranked row
    // under one global prompt budget instead of prefix-truncating every row.
    const warning = `evidence_projection_degraded:${error.message}`;
    console.warn(`[answerStep] ${warning}`);
    if (ctx?._trace) {
      if (!Array.isArray(ctx._trace.warnings)) ctx._trace.warnings = [];
      ctx._trace.warnings.push(warning);
      ctx._trace.evidence_projection = { mode: 'rank-preserving-fallback', memories: _selectedMemories.length };
    }
    _projectedMemories = projectRankedMemoryFallback(_selectedMemories, {
      totalBudget: Math.min(12000, Math.max(6000, _contentBudget * _selectedMemories.length)),
    });
  }
  // Every delivered memory carries its server-owned citation ID inline. This
  // replaces the old duplicate MEMORY + citation-registry representation: the
  // model sees the passage once, together with the only ID it may cite.
  evidence = { ...evidence, recall_packets: ensureMemoryCitationPackets(evidence.recall_packets || [], _selectedMemories, { mode: recallMode }) };
  const citationPacket = buildChatCitationPacket(evidence.recall_packets || []);
  const evidenceLines = _projectedMemories.map(({ memory: m, excerpt, tags: projectedTags }) => {
    const id8 = (m.id || '').slice(0, 8);
    const citationId = citationIdForMemory(citationPacket.citations, m);
    const title = String(m.title || '').replace(/\n/g, ' ').slice(0, 80);
    const content = String(excerpt || '').replace(/\n/g, ' ');
    const tags = projectedTags.join(', ');
    // Synthesis detection: source_metadata.source_type OR tag fallback (FTS path).
    const srcType = m.source_metadata?.source_type || null;
    const admission = m.source_metadata?.metadata?.memory_admission || 'trusted_fact';
    const memTags = m.tags || [];
    const isCanonical = srcType === 'canonical-fact' || memTags.includes('synthesis:canonical');
    const isBridge    = srcType === 'synthesis-bridge' || memTags.includes('synthesis:bridge');
    // A row that hivemind_diff flagged as REMOVED, OR a superseded predecessor
    // pulled via the Updates-edge traversal in hivemind_timeline, is NOT a
    // current fact — without this prefix synthesis renders it identically to
    // live facts and can assert a superseded value is still true. Mark it so
    // the model reports it as the PRIOR value ("was X, changed to Y").
    const removedTag = (m._diff_removed || m._superseded_predecessor) ? '[REMOVED/SUPERSEDED] ' : '';
    const trustTag = admission === 'user_assertion' ? '[USER ASSERTION / UNVERIFIED] ' : '';
    const synthTag = removedTag + trustTag + (isCanonical ? '[SYNTH/CANONICAL] ' : isBridge ? '[SYNTH/BRIDGE] ' : '');
    const conf = m.synthesis_confidence != null ? ` conf=${Number(m.synthesis_confidence).toFixed(2)}` : '';
    const rev = m.synthesis_revision && m.synthesis_revision > 1 ? ` rev=${m.synthesis_revision}` : '';
    const xClusterBoost = m._cross_cluster_boost && m._cross_cluster_boost > 1.0
      ? ` x-cluster=${Number(m._cross_cluster_boost).toFixed(2)}`
      : '';
    // Conflict-resolution metadata (rule 3b): recorded date (recency) + source
    // (authority). A raw decision/document outranks a chat mention or a SYNTH row;
    // a more recent date supersedes an older one.
    const rawDate = m.document_date || m.created_at || m.createdAt || m.valid_from;
    const date = rawDate ? new Date(rawDate).toISOString().slice(0, 10) : '?';
    const src = m.source_metadata?.source_platform || m.source_platform || m.memory_type || 'memory';
    const rank = m._progressive_rank || (_projectedMemories.findIndex((item) => item.memory?.id === m.id) + 1);
    const metadataClaim = m.metadata?.claim || {};
    const qualifiers = m.claimQualifiers || m.claim_qualifiers || metadataClaim.qualifiers || {};
    const claimSubject = m.claimSubject || m.claim_subject || metadataClaim.subject?.name || '';
    const claimPredicate = m.claimPredicate || m.claim_predicate || metadataClaim.predicate || '';
    const claimObject = qualifiers && typeof qualifiers === 'object' ? (qualifiers.object || '') : '';
    const claimShape = [claimSubject, claimPredicate, claimObject].filter(Boolean).join(' | ');
    return citationId ? `${synthTag}{citation_id:${citationId}, rank:${rank || '?'} source:${src}, date:${date}${claimShape ? `, claim:${JSON.stringify(claimShape)}` : ''}}${conf}${rev}${xClusterBoost} "${title}" — ${content}${tags ? ' :: ' + tags : ''}` : '';
  }).filter(Boolean).join('\n');

  // Live Workspace block — Gmail / Drive / Calendar fetched in this turn.
  // Fresher than memory snapshots; agent should cite these when the user asks
  // about recent emails, meetings, or docs.
  const liveLines = (evidence.live || []).slice(0, 10).map((li) => {
    const src = String(li.source || '?').toUpperCase();
    const date = li.date ? ` (${String(li.date).slice(0, 19)})` : '';
    const from = li.from ? ` from ${li.from}` : '';
    const title = String(li.title || '').replace(/\n/g, ' ').slice(0, 100);
    const body = String(li.snippet || '').replace(/\n/g, ' ').slice(0, 320);
    return `[LIVE/${src}]${date}${from} "${title}" — ${body}`;
  }).join('\n');

  // Doc segments that weren't promoted to memories — pulled from the
  // knowledge_segment evidence collection. Lets the agent ground on full
  // pitch decks / catalogs even when only 5-20 chunks made it into the
  // canonical memory layer.
  const evLines = (evidence.evidence || []).slice(0, evidenceTopK).map((e, index) => {
    const doc = String(e.document_title || 'unknown.pdf').replace(/\n/g, ' ').slice(0, 80);
    const page = e.page ? ` p.${e.page}` : '';
    // Evidence retrieval produces a query-centred snippet. Prefer it over the
    // start of a long source segment so exact policy questions retain the
    // matching sentence in the bounded answer prompt.
    const body = evidenceExcerptForAnswer(e, index).replace(/\n/g, ' ');
    const citationId = citationIdForEvidence(citationPacket.citations, e);
    const rank = e._progressive_rank || '?';
    return citationId ? `{citation_id:${citationId}, rank:${rank} source:document} [DOC/${doc}${page}] ${body}` : '';
  }).filter(Boolean).join('\n');

  // T2-1: distilled tail — depth 4 (or 6 on anaphora), assistant turns reduced
  // to their `.response` prose, each turn start-capped. Biggest answer-prompt
  // token saving with no accuracy loss for fresh queries.
  const tail = distillHistoryTail(history, message);

  // GRAPH EDGES block — typed relationships between evidence memories.
  // These come from real Relationship table rows (Updates/Extends/Mentions
  // /Derives/Contradicts) returned by shared recall. Agent MUST
  // ground any "relation between X and Y" claim on these edges. No edge
  // present = no recorded relation; LLM is NOT allowed to infer relations
  // from content overlap or co-mentioned entities (rule 11).
  const evidenceIdSet = new Set(evidence.memories.map(m => m.id));
  const idToTitle = new Map(evidence.memories.map(m => [m.id, String(m.title || '').slice(0, 50)]));
  const filteredEdges = (evidence.relationships || []).filter(e =>
    evidenceIdSet.has(e.from_id) || evidenceIdSet.has(e.to_id),
  );
  const edgeLines = filteredEdges.slice(0, 20).map(e => {
    const fromLabel = idToTitle.get(e.from_id) || e.from_id?.slice(0, 8);
    const toLabel   = idToTitle.get(e.to_id)   || e.to_id?.slice(0, 8);
    const conf = typeof e.confidence === 'number' ? ` (conf=${e.confidence.toFixed(2)})` : '';
    return `[${(e.from_id || '').slice(0, 8)}] "${fromLabel}" ─${e.type}${conf}→ [${(e.to_id || '').slice(0, 8)}] "${toLabel}"`;
  }).join('\n');
  const coMentionLines = (evidence.co_mentions || []).slice(0, 12).map((path) =>
    `[UNVERIFIED CO-MENTION/${path.source_id || 'unknown'}] ${(path.entities || []).join(' + ')}. This is shared-source evidence, not a typed graph relationship.`,
  ).join('\n');
  const relationClaimLines = (evidence.relation?.explicit_relation_claims || []).slice(0, 12).map((claim) => {
    const row = (evidence.memories || []).find((memory) => memory.id === claim.id);
    const citationId = row ? citationIdForMemory(citationPacket.citations, row) : null;
    const citation = citationId ? ` citation_id:${citationId}` : '';
    const warning = claim.unresolved_first_person
      ? ' FIRST-PERSON AUTHOR UNRESOLVED: do not equate "me" with the authenticated user.' : '';
    return `[EXPLICIT RELATION CLAIM status=${claim.citation_status}${citation}] ${String(claim.text || '').replace(/\n/g, ' ').slice(0, 500)}.${warning}`;
  }).join('\n');

  // SYNTHESIS CHAINS block — insight-mode recall returns curated
  // synthesis-tier memories + their evidence chain (top-4 source rows
  // each). Renders the claim + sources together so the LLM can cite the
  // synthesis with provenance in one answer.
  const chainLines = (evidence.synthesis_chains || []).slice(0, 5).map((c) => {
    const head = `[${(c.synthesis_id || '').slice(0, 8)}] (conf=${c.synthesis_confidence ?? '?'} rev=${c.synthesis_revision ?? '?'}) ${c.synthesis_title || ''}`;
    const evRows = (c.evidence || []).slice(0, 4).map(e =>
      `      ▸ [${String(e.id || '').slice(0, 8)}] ${String(e.title || '').slice(0, 60)} — ${String(e.content || '').replace(/\n/g, ' ').slice(0, 180)}`
    ).join('\n');
    return `  ▶ ${head}\n${evRows}`;
  }).join('\n');

  // When event-time ranking pre-filtered the evidence to the asked window,
  // tell the model these rows ARE "what happened" — docs/decisions/notes count
  // as activity. Stops the "no events" bail when in-window memories exist.
  // Safe: only fires when _eventWindowHits>0 (EVENT_TIME_RANKING trimmed to
  // genuinely in-window rows), so it can't force enumeration of off-window noise.
  const windowNote = _eventWindowHits > 0
    ? `\n\nTIME-WINDOW NOTE: the EVIDENCE above is pre-filtered to memories DATED in the period the user asked about. Treat every one of them as part of "what happened" / "what we worked on" in that period — documents, decisions, notes, and saved facts all count as activity. Enumerate them; do NOT reply "no events / no notes for that period" while these dated memories are listed.`
    : '';

  // WS5 step-6: persona injection. Routes user-about-self queries to the persona
  // lane (profile_<org> vector + Postgres profile fallback) and injects a compact
  // "who you're talking to" block. Flag-gated PERSONA_ROUTER_ENABLED → inert no-op
  // by default; intent-gated so non-persona queries skip it; never fatal.
  // Profile context, in priority order:
  //  1. evidence.profile_context — operation=profile explicitly fetched it (the
  //     authoritative answer for "what do you know about me").
  //  2. preloadedProfileContext — the ALWAYS-ON preload (every turn), so even a
  //     recall/source answer is personalized and identity questions that slipped
  //     past routing still have the user's facts.
  // The always-on preload supersedes the old flag-gated passive persona-router
  // (which only fired on persona-ish queries and only when a flag was set).
  const profileForAnswer = evidence.profile_context || preloadedProfileContext || '';
  const profileCitationId = citationPacket.citations.find((citation) => citation?.source_type === 'user_profile')?.id || null;
  const personaNote = profileForAnswer
    ? `\n\nUSER + ORG PROFILE (who you're talking to and their organization — authoritative for identity/personalization; the definitive answer to "what do you know about me/my company"; use it directly; never invent beyond it).\nIMPORTANT: this profile also holds the user's OWN goals, preferences, role, company, and strategies. When the question asks about the user's OWN goal/strategy/preference/plan ("what is MY … / my content strategy / my goals / how do I prefer …"), the matching profile fact IS the authoritative answer — state it directly. Do NOT answer "not found in the evidence" when a matching profile fact exists here, and do NOT let lower-ranked corpus passages override an explicit profile fact.${profileCitationId ? ` Every profile-derived factual claim MUST cite ${profileCitationId}.` : ''}\n${profileForAnswer}`
    : '';

  // COVERAGE DISCLOSURE (multi-entity compare/relation). When the planner
  // asked about 2+ named entities, tell the model — from the packet's OWN
  // delivered evidence — which requested entities have supporting rows and
  // which do not. Without this the model, seeing evidence for only one side
  // of a compare, over-generalises to "neither is present" and contradicts
  // the packet. This is descriptive metadata, not a new instruction to the
  // planner: it never fabricates coverage, it names what the delivered block
  // already contains. Absent entities are reported as an honest gap, present
  // entities MUST be used.
  let coverageNote = '';
  const requestedEntities = Array.isArray(plan.named_entities)
    ? [...new Set(plan.named_entities.filter((e) => typeof e === 'string' && e.trim()))]
    : [];
  if (requestedEntities.length >= 2) {
    const deliveredText = [...evidence.memories.slice(0, evidenceTopK), ...(evidence.evidence || []).slice(0, evidenceTopK)]
      .map((item) => [item?.title, item?.document_title, item?.content, item?.snippet, ...(Array.isArray(item?.tags) ? item.tags : [])]
        .filter(Boolean).join(' ').toLowerCase())
      .join(' ␟ ');
    // Word-boundary match, NOT a raw substring: a short entity like "Pia"
    // must not be reported "present" because it appears inside "Utopia" or
    // "Sophia". Boundaries are Unicode letter/number aware (names may be
    // non-ASCII); the entity is a real match only when flanked by a
    // non-alphanumeric char or a string edge. Escape regex metachars in the
    // entity — product names can contain '.', '+', etc.
    const entityMatches = (entity) => {
      const esc = entity.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(deliveredText);
      } catch {
        // Defensive: if the built pattern is somehow invalid, fall back to a
        // conservative substring test rather than throwing in the answer path.
        return deliveredText.includes(entity.toLowerCase());
      }
    };
    const present = requestedEntities.filter(entityMatches);
    const missing = requestedEntities.filter((e) => !present.includes(e));
    if (present.length && missing.length) {
      coverageNote = `\n\nCOVERAGE DISCLOSURE: the evidence above DOES contain material on ${present.join(', ')}. It does NOT contain material on ${missing.join(', ')}. You MUST describe what the evidence establishes for ${present.join(', ')}, then state plainly that no evidence was found for ${missing.join(', ')} and invite the user to add a source. NEVER claim the evidence lacks ALL of them while rows about ${present.join(', ')} are present — that contradicts the packet and is a hard failure.`;
    }
  }

  const rankOfLine = (line) => Number(line.match(/\brank:(\d+)/)?.[1] || Number.MAX_SAFE_INTEGER);
  const groundedEvidenceRows = [
    ...String(evidenceLines || '').split('\n').filter(Boolean),
    ...String(evLines || '').split('\n').filter(Boolean),
  ].sort((left, right) => rankOfLine(left) - rankOfLine(right));
  const groundedEvidence = `RANKED CONTEXT (memories and exact document passages share one relevance order):\n${groundedEvidenceRows.join('\n') || '(none)'}`;

  // PHASE 1 — combined evidence budget, priority-ordered truncation.
  //
  // Before this, six OPTIONAL sections (synthesis chains, graph edges,
  // co-mentions, live workspace — document segments and citation registry are
  // folded into groundedEvidence/kept always) were unconditionally
  // concatenated whenever non-empty, with no combined cap. Each section has a
  // carefully-tuned PER-ITEM cap already (the adaptive _contentBudget, the
  // 520/320/180-char slices above) — none of that changes here. What was
  // missing is a ceiling on the SUM. A real trace showed 7185 prompt tokens
  // against 772 completion tokens: 90% of chat's cost is this input block,
  // not the model's output.
  //
  // groundedEvidence (memories + document segments) is NEVER dropped — each
  // delivered passage carries its own citation ID, so there is no separate
  // registry to duplicate. Only the four sections below are subject to the budget,
  // dropped WHOLE (never mid-string — a partial synthesis chain or a citation
  // id cut in half is worse than the section being absent), lowest priority
  // first, until the remainder fits.
  const EVIDENCE_CHAR_BUDGET = Number(process.env.HIVEMIND_ANSWER_EVIDENCE_CHAR_BUDGET || 12000);
  const relationCritical = relationClaimLines
    ? `EXPLICIT RELATION CLAIMS (${(evidence.relation?.explicit_relation_claims || []).length} sourced claims; preserve verification and author status):\n${relationClaimLines}\n\n`
    : '';
  const alwaysKept = `${relationCritical}EVIDENCE (${Math.min(evidence.memories.length, evidenceTopK)} of ${evidence.memories.length} memories):
${groundedEvidence}`;
  // Highest priority first — this is the drop order, last entry drops first.
  const optionalSections = [
    { text: chainLines && `\n\nSYNTHESIS CHAINS (${(evidence.synthesis_chains || []).length} curated claims + sources — cite the claim, support with the evidence rows):\n${chainLines}` },
    { text: edgeLines && `\n\nGRAPH EDGES (${filteredEdges.length} typed relationships between the memories above — ONLY trust these for verified relation claims):\n${edgeLines}` },
    { text: coMentionLines && `\n\nCO-MENTIONS (${(evidence.co_mentions || []).length} shared-source paths — report as unverified co-mentions, never as typed relationships):\n${coMentionLines}` },
    { text: liveLines && `\n\nLIVE WORKSPACE (${(evidence.live || []).length} fresh items — Gmail / Drive / Calendar):\n${liveLines}` },
  ].filter((s) => s.text);
  let _remaining = EVIDENCE_CHAR_BUDGET - alwaysKept.length;
  const _kept = [];
  for (const section of optionalSections) {
    if (section.text.length <= _remaining) { _kept.push(section.text); _remaining -= section.text.length; }
    // else: drop this whole section. Lower-priority sections after it in the
    // array are checked independently — a large GRAPH EDGES block being cut
    // must not also silently cut a small LIVE WORKSPACE block that would
    // still fit.
  }
  const evidenceBlock = alwaysKept + _kept.join('');

  const assistantContext = `\n\nASSISTANT CONTEXT: You are ${assistantName || 'HIVE'}, serving ${orgName || 'this HIVEMIND workspace'}.`;
  const recentAssistant = [...(Array.isArray(history) ? history : [])]
    .reverse()
    .find((turn) => turn?.role === 'assistant' && turn?.content);
  const recentConversation = recentAssistant
    ? `\n\nRECENT ASSISTANT ANSWER (conversation continuity only; do not treat it as new evidence):\n${String(recentAssistant.content).slice(0, 1200)}`
    : '';
  const sourceCoverageNote = plan.operation === 'source_read'
    ? `\n\nSOURCE COVERAGE CONTRACT: Answer the requested scope from the named source. If the user asks what else, what more, for additional information, or for an overview of the established topic, do not merely repeat the RECENT ASSISTANT ANSWER or stop after the first matching row. When the delivered evidence supports it, synthesize 3-5 distinct, non-duplicate points across separate relevant citations. If the request is genuinely one exact attribute, answer only that attribute. Never add a point that the delivered evidence does not support.`
    : '';
  const relationAnswerNote = plan.operation === 'relation_between'
    ? `\n\nRELATION ANSWER CONTRACT: Start by stating whether a typed graph relationship exists. If the only support is one or more explicit claims, report them collectively as sourced claims rather than as verified relationships. For legacy_unresolved_author claims, NEVER quote graphic wording, NEVER identify the first-person speaker as either requested person, and NEVER list the raw claims line by line; summarize them as "legacy first-person statements expressing personal or sexual interest" and say plainly that missing authorship metadata prevents attribution. If the user also asks who a person is, answer that clause separately from the non-claim descriptive memories in RANKED CONTEXT. Cover every clause, but do not infer a relationship from co-mentions or descriptive facts.`
    : '';
  const progressiveNote = evidence.progressive_recall
    ? `\n\nRECALL WINDOW: showing the one intent-selected unified window, ranks 1-${evidence.progressive_recall.delivered_until} of ${evidence.progressive_recall.candidates.length}, from recall ${evidence.progressive_recall.recall_id}. No later retrieval or reveal will run. If the window is relevant but cannot fully answer the stated objective, use everything useful it does support, identify only the requested missing detail, and set context_status="relevant_but_incomplete". If it is off-topic because retrieval misunderstood the request, set context_status="query_mismatch". Otherwise set "sufficient".`
    : '';
  const userBlock = `${evidenceBlock}${progressiveNote}${assistantContext}${recentConversation}${sourceCoverageNote}${relationAnswerNote}${capabilityHint}${windowNote}${personaNote}${coverageNote}

PLANNER INTENT: ${(plan.intents || []).join(' / ') || '(unspecified)'}

USER MESSAGE:
${message}`;
  if (ctx?._trace) {
    const seenExcerpts = new Set();
    const duplicateChars = _projectedMemories.reduce((sum, item) => {
      const excerpt = String(item?.excerpt || '');
      if (!excerpt || !seenExcerpts.has(excerpt)) {
        if (excerpt) seenExcerpts.add(excerpt);
        return sum;
      }
      return sum + excerpt.length;
    }, 0);
    ctx._trace.evidence_delivery = {
      ranked_chars: _selectedMemories.reduce((sum, memory) => sum + String(memory?.content || '').length, 0),
      delivered_chars: _projectedMemories.reduce((sum, item) => sum + String(item?.excerpt || '').length, 0),
      duplicate_chars: duplicateChars,
      citation_chars: citationPacket.citations.reduce((sum, citation) => sum + String(citation?.id || '').length, 0),
      delivery_modes: [...new Set(_projectedMemories.map((item) => item?.projection).filter(Boolean))],
      memories: _projectedMemories.map(({ memory: item, excerpt, projection, selected_passage_indexes }, index) => ({
        rank: index + 1,
        memory_id: item?.id || null,
        full_chars: String(item?.content || '').length,
        delivered_chars: String(excerpt || '').length,
        projection,
        selected_passage_indexes: selected_passage_indexes || null,
      })),
    };
    ctx._trace.synthesis_prompt = {
      static_chars: synthesisPrompt.static_prompt.length,
      dynamic_system_chars: synthesisPrompt.dynamic_prompt.length,
      evidence_chars: evidenceBlock.length,
      profile_chars: personaNote.length,
      history_chars: tail.reduce((sum, item) => sum + String(item?.content || '').length, 0),
      total_user_chars: userBlock.length,
      static_prompt_cag: synthesisPrompt.cache,
      provider_prefix: promptContributionTelemetry({
        staticPrompt: synthesisPrompt.static_prompt,
        dynamicPrompt: `${synthesisPrompt.dynamic_prompt}\n${tail.map((item) => String(item?.content || '')).join('\n')}\n${userBlock}`,
      }),
    };
  }

  // Mode-aware answer-token cap. GPT-OSS is a reasoning model — it spends
  // hidden reasoning_tokens up toward the ceiling regardless of how short
  // the final prose is, so a flat 8000-token cap makes a 3-sentence fact
  // answer as slow as a full document reconstruction. A fact answer is 2-5
  // sentences (see answerPrompt rule 7); explain/full genuinely need room
  // for multi-source synthesis. Cap per mode to hit the per-family latency
  // targets (fact ≤1.5s, explain/full ≤3s) without truncating real answers.
  // Env override (HIVEMIND_ANSWER_MAX_TOKENS) still wins for A/B.
  const answerMode = plan.explicit_recall_mode
    || ({ quick: 'fact', panorama: 'explain', insight: 'explain' }[plan.recall_mode])
    || plan.recall_mode || 'fact';
  const depthCap = {
    standard: 3000,
    detailed: 6000,
    comprehensive: 8000,
  }[plan.response_depth || 'standard'] || 3000;
  const modeCap = answerMode === 'full' ? 8000 : answerMode === 'explain' ? 5000 : 3000;
  const answerCap = process.env.HIVEMIND_ANSWER_MAX_TOKENS
    ? ANSWER_MAX_TOKENS
    : Math.max(depthCap, modeCap);
  // Grounded synthesis over a focused answer needs little reasoning.  A user
  // who asked for a detailed/comprehensive account expects the model to
  // reconcile the complete selected window, so use deliberate reasoning only
  // for that opt-in depth (or full reconstruction). Env-overridable.
  const answerReasoning = process.env.HIVEMIND_ANSWER_REASONING_EFFORT
    || (answerMode === 'full' || ['detailed', 'comprehensive'].includes(plan.response_depth) ? 'medium' : 'low');
  const finalSynthesisProviderOrder = String(
    process.env.OPENROUTER_DEEPSEEK_SYNTHESIS_PROVIDER_ORDER || 'baidu,digitalocean,streamlake',
  ).split(',').map((value) => value.trim()).filter(Boolean);
  const finalSynthesisProviderPolicy = String(model || '').startsWith('deepseek/')
    && finalSynthesisProviderOrder.length
    ? { order: finalSynthesisProviderOrder }
    : undefined;

  if (streamValidated) {
    return callValidatedClaimStream({
      // Streaming has its own NDJSON output contract, but it must retain the
      // same persona and grounding voice as non-streamed synthesis. Keep the
      // persona module here without duplicating the JSON-object contract.
      messages: [
        { role: 'system', content: ORGANIZATIONAL_BRAIN_PERSONA },
        { role: 'system', content: synthesisPrompt.dynamic_prompt },
        ...tail,
        { role: 'user', content: userBlock },
      ],
      model, apiKey, maxTokens: answerCap, signal,
      promptCacheKey: synthesisPrompt.cache.key,
      recallPackets: evidence.recall_packets || [], evidence, allowGeneralKnowledge, onEvent,
      language, message, source: plan.source || null,
    });
  }

  const { parsed, usage } = await callJsonLLM({
    // temperature:0 — grounded synthesis over already-ranked evidence must be
    // DETERMINISTIC. At 0.1 the model occasionally picked a competing memory
    // (e.g. the Feb "Kommunikation" phase over the 18-Aug "Launch PIA" event)
    // for the same query on different turns — the flakiness users saw.
    messages: [...synthesisPrompt.messages, ...tail, { role: 'user', content: userBlock }],
    model, apiKey, maxTokens: answerCap, signal, reasoningEffort: answerReasoning,
    providerPolicy: finalSynthesisProviderPolicy, temperature: 0,
    promptCacheKey: synthesisPrompt.cache.key,
    responseFormat: GROUNDED_SYNTHESIS_RESPONSE_FORMAT,
  });

  let response = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  let answerPayload = parsed;
  response = appendGapClarification(response, answerPayload.gaps, language);
  let validated = validateChatAnswer({
    answer: response,
    claims: parsed.claims,
  }, evidence.recall_packets || [], { allowGeneralKnowledge });
  const initialContextStatus = deriveAnswerContextStatus(answerPayload);
  const initialCoverage = validateSupportedCoverage(answerPayload?.coverage, validated.claims);
  const supportedCoverageCount = initialCoverage.filter((item) => item.status === 'supported').length;
  const completionRequirement = plan.answer_completion_requirement || 'single_answer';
  // The planner already made the language-independent breadth decision. Enforce
  // that contract here so citation-valid prose cannot silently answer only one
  // clause of a compound request. This never triggers another retrieval pass;
  // one bounded synthesis repair sees the same ranked packet.
  const coverageIncomplete = initialCoverage.length === 0
    || (completionRequirement === 'multi_facet' && supportedCoverageCount < 2)
    || (completionRequirement === 'complete_set'
      && initialContextStatus === 'sufficient'
      && supportedCoverageCount < 1);
  // `context_status` is model telemetry, not a second retrieval policy. A
  // model can conservatively label the packet query_mismatch while still
  // producing citation-valid claims that directly answer the objective. The
  // citation validator is the factual authority: keep its valid claims and
  // expose the context label only as telemetry. This prevents useful recalled
  // material from being replaced by the generic "I found related context"
  // response without weakening grounding or accepting uncited prose.

  // The validator remains fail-closed. If the model ignored the citation
  // contract despite a non-empty packet, give it one bounded repair pass over
  // the same final context instead of discarding useful tenant evidence.
  let repairUsage = null;
  if (String(process.env.HIVEMIND_SYNTHESIS_REPAIR_ENABLED || 'true').toLowerCase() !== 'false'
      && (!validated.claims.length || coverageIncomplete)
      && hasGroundedPacketEvidence(evidence)) {
    const repairInstruction = `REPAIR PASS: The prior draft did not satisfy the citation or request-completion contract. Use the same final evidence only; do not retrieve again. The planner classified this request as ${completionRequirement}. Decompose every independent requested detail, cover every supported detail, and explicitly mark unsupported details in coverage and gaps. Return a natural, useful synthesis of everything relevant that the evidence supports, including closely related grounded details when helpful, then name the specific part of the user's question that remains uncovered. If any gap remains, the visible response must end with one targeted clarification question that would help close it. Every factual sentence must be a grounded claim with one or more inline citation_id values from the delivered evidence objects. Do not output a blanket absence response while any cited evidence exists.`;
    // PHASE 1 — cheaper repair, correctly scoped. The repair call is a FRESH,
    // stateless API call — it must still see the full evidence in userBlock
    // (already shrunk by the combined budget above) or it has nothing left to
    // cite and would fail worse than the draft it's fixing. What it does NOT
    // need is the draft's own answer-length ceiling: it is reformatting an
    // already-derived synthesis for citation compliance, not deriving new
    // content, so a smaller output cap and low reasoning effort are safe
    // regardless of the original answerMode (a 'full' mode repair does not
    // need 'medium' reasoning to re-cite the same facts).
    const repairCap = Math.min(answerCap, Number(process.env.HIVEMIND_REPAIR_MAX_TOKENS || 1500));
    const repaired = await callJsonLLM({
      messages: [
        { role: 'system', content: synthesisPrompt.static_prompt },
        { role: 'system', content: `${synthesisPrompt.dynamic_prompt}\n${repairInstruction}` },
        ...tail,
        { role: 'user', content: userBlock },
      ],
      model, apiKey, maxTokens: repairCap, signal, reasoningEffort: 'low',
      providerPolicy: finalSynthesisProviderPolicy, temperature: 0,
      promptCacheKey: synthesisPrompt.cache.key,
      responseFormat: GROUNDED_SYNTHESIS_RESPONSE_FORMAT,
    });
    repairUsage = repaired.usage;
    answerPayload = repaired.parsed;
    response = typeof repaired.parsed.response === 'string' ? repaired.parsed.response.trim() : '';
    response = appendGapClarification(response, answerPayload.gaps, language);
    validated = validateChatAnswer({
      answer: response,
      claims: repaired.parsed.claims,
    }, evidence.recall_packets || [], { allowGeneralKnowledge });
  }

  // Legacy AMR rows can contain a first-person relation statement without a
  // surviving author row.  This case must not depend on model phrasing: two
  // identical turns previously alternated between verbatim sexual text,
  // attributing "me" to the current user, and omitting the relationship
  // caveat altogether.  Present the already-retrieved facts deterministically
  // while retaining citation-bearing descriptive rows for compound questions.
  const unresolvedRelationClaims = plan.operation === 'relation_between'
    ? (evidence.relation?.explicit_relation_claims || []).filter((claim) => claim.unresolved_first_person)
    : [];
  if (unresolvedRelationClaims.length
      && evidence.relation?.verified_relation_found !== true
      && unresolvedRelationClaims.length === (evidence.relation?.explicit_relation_claims || []).length) {
    const entities = evidence.relation?.entities || plan.relation_intent?.entities || [];
    const subject = entities.length >= 2 ? `${entities[0]} and ${entities[1]}` : 'the requested people';
    const asksWho = /\bwho\s+is\b/iu.test(message);
    const whoMatch = String(message || '').match(/\bwho\s+is\s+([^,?.]+)/iu);
    const describedEntity = whoMatch?.[1]?.trim()
      || entities.find((entity) => new RegExp(`\\bwho\\s+is\\s+${String(entity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(message));
    const claimIds = new Set(unresolvedRelationClaims.map((claim) => claim.id).filter(Boolean));
    const descriptionClaims = asksWho && describedEntity
      ? (evidence.memories || []).filter((memory) => {
        if (!memory?.id || claimIds.has(memory.id)) return false;
        const text = `${memory.title || ''} ${memory.content || ''}`;
        return text.toLocaleLowerCase().includes(String(describedEntity).toLocaleLowerCase())
          && !/\b(?:want|sleep|sex|fuck|gangbang)\b/iu.test(text)
          && !/\buser profile\b/iu.test(text);
      }).map((memory) => {
        const citationId = citationIdForMemory(citationPacket.citations, memory);
        const text = String(memory.content || memory.title || '').trim();
        return citationId && text ? { text, citation_ids: [citationId] } : null;
      }).filter(Boolean).filter((claim, index, rows) =>
        rows.findIndex((candidate) => candidate.text === claim.text) === index).slice(0, 3)
      : [];
    const description = descriptionClaims.length
      ? `${describedEntity} is described in the stored memories as follows: ${descriptionClaims.map((claim) => claim.text).join(' ')} `
      : '';
    const response = `${description}No typed or otherwise verified relationship between ${subject} is stored. HIVEMIND found legacy first-person statements expressing personal or sexual interest, but their authorship metadata is missing, so they cannot be attributed to either person or used to establish a relationship.`;
    const relationCitationIds = unresolvedRelationClaims.map((claim) => {
      const row = (evidence.memories || []).find((memory) => memory.id === claim.id);
      return row ? citationIdForMemory(citationPacket.citations, row) : null;
    }).filter(Boolean);
    const relationClaim = {
      text: 'Legacy first-person statements express personal or sexual interest, but their author is unresolved.',
      citation_ids: [...new Set(relationCitationIds)],
    };
    const claims = [...descriptionClaims, ...(relationClaim.citation_ids.length ? [relationClaim] : [])];
    return {
      response,
      claims,
      rejected_claims: validated.rejected_claims,
      grounded: claims.length > 0,
      evidence_used: claims.flatMap((claim) => claim.citation_ids),
      confidence: 0.9,
      gaps: ['Legacy first-person authorship metadata is unavailable.'],
      context_status: 'relevant_but_incomplete',
      answer_coverage: normalizeAnswerCoverage(answerPayload?.coverage),
      recall_packets: evidence.recall_packets || [],
      usage: repairUsage || usage,
      usage_stages: { synthesis: usage, ...(repairUsage ? { repair: repairUsage } : {}) },
    };
  }

  if (!validated.claims.length) {
    // A failed model formatting/relevance judgment must not erase authorized,
    // citable recall. Fall back to a deterministic extractive answer over the
    // already-ranked packet. This introduces no new facts and no extra model
    // or retrieval call; the generic absence response remains reserved for an
    // actually empty or uncitable packet.
    const recalled = groundedRecallFallback(evidence, language, message, { source: plan.source || null });
    if (recalled) {
      return {
        response: recalled.response,
        claims: recalled.claims,
        rejected_claims: validated.rejected_claims,
        grounded: true,
        evidence_used: recalled.claims.flatMap((claim) => claim.citation_ids),
        confidence: 0.7,
        gaps: Array.isArray(answerPayload?.gaps) ? answerPayload.gaps : [],
        context_status: deriveAnswerContextStatus(answerPayload),
        answer_coverage: normalizeAnswerCoverage(answerPayload?.coverage),
        recall_packets: evidence.recall_packets || [],
        usage: repairUsage || usage,
        usage_stages: { synthesis: usage, ...(repairUsage ? { repair: repairUsage } : {}) },
      };
    }
    return {
      response: unavailableEvidenceResponse({ message, evidence, language }),
      claims: [],
      rejected_claims: validated.rejected_claims,
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['No citation-valid claim could be produced from the final recall packet.'],
      context_status: answerPayload?.context_status === 'query_mismatch' ? 'query_mismatch' : 'relevant_but_incomplete',
      answer_coverage: normalizeAnswerCoverage(answerPayload?.coverage),
      recall_packets: evidence.recall_packets || [],
      usage: repairUsage || usage,
      usage_stages: { synthesis: usage, ...(repairUsage ? { repair: repairUsage } : {}) },
    };
  }

  return {
    // Validation deliberately reconstructs prose from factual claims, which
    // drops non-factual clarification questions. Re-attach only the bounded
    // gap question after claims have passed the fail-closed citation check.
    response: appendGapClarification(validated.answer, answerPayload.gaps, language),
    follow_ups: normalizeSearchableFollowUps(answerPayload.follow_ups, {
      context: JSON.stringify(evidence.recall_packets || []),
      sourceTitles: (evidence.recall_packets || []).flatMap((packet) => [
        ...(packet?.citations || []).map((citation) => citation.source_label || citation.title),
        ...(packet?.sourceSections || []).map((section) => section.source_label || section.title),
      ]).filter(Boolean),
      language,
    }),
    claims: validated.claims,
    rejected_claims: validated.rejected_claims,
    grounded: validated.grounded,
    evidence_used: Array.isArray(answerPayload.evidence_used) ? answerPayload.evidence_used : [],
    confidence:    Number.isFinite(answerPayload.confidence) ? Math.max(0, Math.min(1, answerPayload.confidence)) : 0.5,
    gaps:          Array.isArray(answerPayload.gaps) ? answerPayload.gaps : [],
    context_status: deriveAnswerContextStatus(answerPayload),
    answer_coverage: normalizeAnswerCoverage(answerPayload.coverage),
    recall_packets: evidence.recall_packets || [],
    usage: repairUsage || usage,
    usage_stages: { synthesis: usage, ...(repairUsage ? { repair: repairUsage } : {}) },
  };
}

// ── Save / update side-effects (best-effort, async-fire-and-forget) ───

function distillHistoryTail(history, message, { perTurnCap = 600 } = {}) {
  return (history || [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-6)
    .map((h) => {
      let content = h.content;
      if (typeof content !== 'string') {
        // assistant turns are objects/JSON — keep only the prose reply
        content = content?.response || content?.answer || content?.text || JSON.stringify(content);
      } else if (h.role === 'assistant' && content.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(content);
          content = parsed?.response || parsed?.answer || content;
        } catch { /* not JSON — keep as-is */ }
      }
      content = String(content);
      if (content.length > perTurnCap) content = `${content.slice(0, perTurnCap)} …`;
      return { role: h.role, content };
    });
}


// PHASE 2 — parallel tool-call execution within a round.
//
// A single model round emits all tool_calls against the SAME message history,
// so no call in the round can reference another call's *result* (none have run
// yet). The only real dependency is when a call's arguments reference a prior
// round's tool_call_id or a prior tool's result. Independent calls therefore
// run via Promise.all; a call that references a prior result stays sequential
// after that result resolves. Results are re-ordered back to the original call
// order so the assembled messages/steps arrays stay deterministic regardless of
// completion timing.
function isDependentCall(args, priorResultIds) {
  if (!priorResultIds || priorResultIds.size === 0) return false;
  const blob = JSON.stringify(args || {});
  for (const id of priorResultIds) {
    if (blob.includes(id)) return true;
  }
  return false;
}

// Executes a batch of tool calls, running independent ones concurrently.
// `execute` is `(name, args, ctx) => result`. Returns results in the same
// order as `calls`. `priorResultIds` is the set of tool_call_ids from earlier
// rounds whose results are already in the message history.
async function executeToolCallsInParallel(calls, execute, ctx, priorResultIds) {
  const results = new Array(calls.length);
  // Walk in order; a dependent call must wait for the prior result it
  // references, so it is awaited inline. Independent calls are collected and
  // fired together.
  let i = 0;
  while (i < calls.length) {
    const call = calls[i];
    let args = {};
    try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
    if (isDependentCall(args, priorResultIds)) {
      results[i] = await execute(call, args, ctx);
      i += 1;
      continue;
    }
    // Collect the maximal run of independent calls and fire them together.
    const batch = [];
    const batchIdx = [];
    while (i < calls.length) {
      const c = calls[i];
      let a = {};
      try { a = JSON.parse(c.function?.arguments || '{}'); } catch {}
      if (isDependentCall(a, priorResultIds)) break;
      batch.push({ call: c, args: a });
      batchIdx.push(i);
      i += 1;
    }
    const batchResults = await Promise.all(batch.map(({ call, args }) => execute(call, args, ctx)));
    batchResults.forEach((r, k) => { results[batchIdx[k]] = r; });
  }
  return results;
}

async function runToolkitReadLoop({ toolkit, message, history, model, apiKey, ctx, signal, onEvent }) {
  const schemas = toolkit.getJsonSchemas({ readOnlyOnly: true });
  if (schemas.length === 0) return { text: '', steps: [] };
  const messages = [
    {
      role: 'system',
      content: 'Use only the provided read-only tools to answer the request. Select tools from their schemas and descriptions. Preserve the user language and exact identifiers. Stop after sufficient current evidence; never propose or perform a mutation.',
    },
    ...distillHistoryTail(history, message, { perTurnCap: 400 }).slice(-4),
    { role: 'user', content: message },
  ];
  const steps = [];
  const resultTexts = [];
  for (let round = 0; round < 3; round++) {
    const response = await chatCompletionFetch(model, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, tools: schemas, tool_choice: 'auto', temperature: 0, max_tokens: 900 }),
      signal,
    }, { fallbackApiKey: apiKey });
    if (!response.ok) throw new Error(`connector_read_model_${response.status}`);
    const data = await response.json();
    const msg = data?.choices?.[0]?.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      const final = String(msg.content || '').trim();
      return { text: final || resultTexts.join('\n\n'), steps };
    }
    messages.push(msg);
    // PHASE 2 — run independent calls in parallel, preserve original order.
    const priorResultIds = new Set(
      messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    );
    const results = await executeToolCallsInParallel(calls, async (call, args, ctx) => {
      const name = call.function?.name;
      onEvent?.({ type: 'tool_started', name, tool_call_id: call.id, arguments: args });
      const toolResult = await toolkit.execute(name, args, ctx);
      // TOOL RESULTS WERE BLIND-TRUNCATED AT 8000 CHARS, SILENTLY. That is the mechanism behind
      // "chat sometimes says it has nothing" on content that is definitely present.
      // Measured on org 1380251c (hybrid): recall delivers 5 memories + 8 evidence segments;
      // segments average 645 chars but reach 39,655, so ONE oversized segment can consume the whole
      // window and evict the 693-char segment that actually holds the answer. Six identical chat
      // requests: 4 found the article number, 2 answered "I don't have anything in my memory" — two
      // of them with BYTE-IDENTICAL retrieval counters, so the instability is here, after retrieval.
      //
      // Fixed by budgeting PER ROW instead of cutting one blob: every retrieved row stays visible to
      // the model, each bounded, so no single long row can starve the rest. Falls back to the old
      // slice for non-JSON results, and either way it now SAYS when it truncated — a silent cap on
      // the evidence path is indistinguishable from "there was no evidence".
      const _rawText = String(toolResult.content?.[0]?.text || '');
      const _cap = Math.max(2000, Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS || 24000));
      let text = _rawText;
      if (_rawText.length > _cap) {
        let shaped = null;
        try {
          const parsed = JSON.parse(_rawText);
          const key = ['memories', 'results', 'rows', 'items', 'evidence']
            .find((k) => Array.isArray(parsed?.[k]) && parsed[k].length);
          if (key) {
            const rows = parsed[key];
            // Divide the budget evenly, so N rows are ALL represented rather than the first few
            // verbatim and the rest dropped.
            const per = Math.max(200, Math.floor(_cap / rows.length) - 80);
            parsed[key] = rows.map((r) => {
              if (!r || typeof r !== 'object') return r;
              const out = { ...r };
              for (const f of ['content', 'text', 'snippet', 'preview', 'excerpt']) {
                if (typeof out[f] === 'string' && out[f].length > per) out[f] = `${out[f].slice(0, per)}…`;
              }
              return out;
            });
            parsed._truncation = { per_row_chars: per, rows: rows.length, original_chars: _rawText.length };
            shaped = JSON.stringify(parsed);
          }
        } catch { /* not JSON — fall through to the blunt slice */ }
        if (shaped && shaped.length <= _cap * 1.2) {
          text = shaped;
          console.warn(`[agent] ${name} result ${_rawText.length} chars -> per-row budget `
            + `(cap ${_cap}); every row kept, each bounded`);
        } else {
          text = _rawText.slice(0, _cap);
          console.warn(`[agent] ${name} result TRUNCATED ${_rawText.length} -> ${_cap} chars as one blob `
            + `(no row array found). Rows past the cut are INVISIBLE to the model — if this tool feeds `
            + `answers, that is a wrong-answer risk, not a formatting detail.`);
        }
      }
      return { name, args, callId: call.id, toolResult, text };
    }, ctx, priorResultIds);
    for (const { name, args, callId, toolResult, text } of results) {
      steps.push({ tool: name, args, result_summary: text.slice(0, 240), raw: toolResult.meta?.raw || null });
      if (text) resultTexts.push(text);
      onEvent?.({ type: 'tool_completed', name, tool_call_id: callId, status: toolResult.status, summary: text.slice(0, 240) });
      messages.push({ role: 'tool', tool_call_id: callId, content: text });
    }
  }
  return { text: resultTexts.join('\n\n'), steps };
}

/**
 * Run a tool-calling sub-loop using the Toolkit + Groq's native tool API.
 * Returns { response, steps, draftIds } — `response` is the agent's
 * final user-facing summary; `draftIds` lists any pending_writes created.
 */
async function runActionSubLoop({ toolkit, message, history, model, apiKey, ctx, onEvent, provider }) {
  const schemas = toolkit.getJsonSchemas();
  const steps = [];
  const draftIds = [];
  let projectChoice = null; // set when a save deferred for project selection
  const toolNames = schemas.map(s => s.function.name);

  // Provider context hint: for Slack, pre-fetch channel directory so the
  // LLM can map "#all-davinci-ai" → C0AEN1R98BV without inventing a
  // search tool. Pulled from cached memory rows (channel:<name> tags
  // include the channel_id in source_metadata). Cheap DB query.
  let contextHint = '';
  if (provider === 'slack' && ctx.prisma) {
    try {
      const rows = await ctx.prisma.memory.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          tags: { hasSome: ['slack'] },
        },
        select: { sourceMetadata: true, tags: true },
        take: 30,
        orderBy: { createdAt: 'desc' },
      });
      const channelMap = new Map();
      for (const r of rows) {
        const ch = (r.tags || []).find(t => t.startsWith('channel:'));
        const id = r.sourceMetadata?.slack_channel_id || r.sourceMetadata?.metadata?.slack_channel_id;
        if (ch && id) channelMap.set(ch.slice('channel:'.length), id);
      }
      if (channelMap.size > 0) {
        const lines = Array.from(channelMap.entries()).slice(0, 10)
          .map(([name, id]) => `  #${name} → ${id}`).join('\n');
        contextHint = `\n\nKNOWN SLACK CHANNELS (use these channel_id values verbatim):\n${lines}\n`;
      }
    } catch {}
  }

  const sys = `You are HIVE acting on the user's request.

AVAILABLE TOOLS (USE ONLY THESE — inventing tool names will fail validation):
${toolNames.map(n => `- ${n}`).join('\n')}

RULES:
- Call only the tools listed above. Tool names are case-sensitive.
- For Slack: trust the registered tool names and descriptions above. Use slack_list_channels when it is registered and a channel id must be resolved; otherwise ask the user instead of inventing a tool.
- If the user names a channel like "#all-davinci-ai" without giving you an ID, either (a) reuse a channel_id from prior context in this conversation, or (b) ask the user for it.
- Write tools (send/schedule/draft) go through a draft-approval gate. When a tool returns status="draft_created", do NOT claim the message was sent. Tell the user the draft was created and is awaiting their approval.
- campaign_create is an internal planning handoff: call it directly when requested, then report the returned Campaign and Campaign Room links. It never publishes; do not claim the campaign is live.
- Be concise. Output a single sentence after the tool call completes.${contextHint}`;
  const messages = [
    { role: 'system', content: sys },
    ...(Array.isArray(history) ? history.slice(-6).filter(h => (h.role === 'user' || h.role === 'assistant') && h.content) : []),
    { role: 'user', content: message },
  ];

  // Max 3 iterations — enough for tool_call → tool_result → final answer.
  for (let iter = 0; iter < 3; iter++) {
    const resp = await chatCompletionFetch(model, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: schemas,
        tool_choice: 'auto',
        max_completion_tokens: 1500,
        temperature: 0.2,
      }),
      signal: ctx._signal,
    }, { fallbackApiKey: apiKey });
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 500);
      // Groq returns 400 with code=tool_use_failed when the LLM hallucinated
      // a tool name. Append a corrective message and retry once.
      if (resp.status === 400 && /tool_use_failed|was not in request\.tools/i.test(errText) && iter < 2) {
        const m = errText.match(/'(\w+)' which was not in request\.tools/);
        const badName = m ? m[1] : 'an unknown tool';
        messages.push({
          role: 'system',
          content: `Last attempt failed — you tried to call '${badName}' but it is not an available tool. ONLY use tools from the list in the system prompt. If you cannot accomplish the task with available tools, tell the user what's missing instead of inventing tools.`,
        });
        continue;
      }
      throw new Error(`Chat provider ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) break;

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      messages.push(msg);
      // PHASE 2 — run independent calls in parallel, preserve original order.
      const priorResultIds = new Set(
        messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
      );
      const results = await executeToolCallsInParallel(msg.tool_calls, async (tc, toolArgs, ctx) => {
        const toolName = tc.function?.name;
        onEvent?.({ type: 'tool_call', name: toolName, arguments: tc.function?.arguments || '{}' });
        let toolResp;
        try {
          toolResp = await toolkit.execute(toolName, toolArgs, ctx);
        } catch (err) {
          toolResp = { content: [{ type: 'text', text: `error: ${err.message}` }], status: 'error' };
        }
        const text = toolResp.content?.[0]?.text || '';
        return { toolName, toolArgs, callId: tc.id, toolResp, text };
      }, ctx, priorResultIds);
      for (const { toolName, toolArgs, callId, toolResp, text } of results) {
        onEvent?.({ type: 'tool_result', name: toolName, summary: text.slice(0, 140) });
        steps.push({ tool: toolName, args: toolArgs, result_summary: text.slice(0, 200) });
        // Capture a deferred-save project choice so the chat UI can render
        // project buttons (Org + each) instead of free-text asking.
        if (toolName === 'hivemind_save_memory') {
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.needs_project_choice) {
              projectChoice = {
                projects: parsed.projects || [],
                scope_options: parsed.scope_options || [],
                draft: parsed.draft || null,
              };
            }
          } catch { /* result not JSON — ignore */ }
        }
        if (toolResp.status === 'draft_created' && toolResp.meta?.draft_id) {
          draftIds.push(toolResp.meta.draft_id);
        }
        messages.push({ role: 'tool', tool_call_id: callId, content: text });
      }
      continue;
    }

    const final = (msg.content || '').trim();
    return { response: final, steps, draftIds, project_choice: projectChoice };
  }

  return { response: 'Action chain exceeded iteration budget.', steps, draftIds, project_choice: projectChoice };
}

async function maybeSaveOrUpdate({ plan, ctx, onEvent, message, history }) {
  if (plan.save_intent && typeof plan.save_intent === 'object') {
    let content = (plan.save_intent.content || '').trim();
    let title   = (plan.save_intent.title   || '').trim();

    if (!content) {
      // The structured parser must resolve references from history. Never
      // guess the save target through locale-specific phrase matching.
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary: 'skipped (empty content)' });
      return { tool: 'hivemind_save_memory', args: plan.save_intent, result_summary: 'skipped (empty content)' };
    }
    if (!title) title = content.slice(0, 60).replace(/\s+/g, ' ').trim();

    const args = {
      title,
      content,
      tags: Array.isArray(plan.save_intent.tags) ? plan.save_intent.tags : [],
      // Pass project_hint as `project` (name/slug); tool-registry resolves
      // it to project_id against the user's access list. ctx.projectId is
      // the implicit fallback handled inside the handler, but we also
      // forward it explicitly here as project_id so audit-logged args (and
      // any downstream code that bypasses the fallback) carry the scope.
      ...(plan.save_intent.project_hint ? { project: plan.save_intent.project_hint } : {}),
      ...(plan.save_intent.project_id ? { project_id: plan.save_intent.project_id, scope: 'project' } : {}),
      ...(plan.save_intent.scope ? { scope: plan.save_intent.scope } : {}),
      ...(plan.save_intent.memory_type ? { memory_type: plan.save_intent.memory_type } : {}),
      ...(plan.save_intent.entities?.length ? { entities: plan.save_intent.entities } : {}),
      ...(plan.save_intent.event_time ? { event_time: plan.save_intent.event_time } : {}),
      _memory_admission: plan.save_intent.admission_class || 'trusted_fact',
      _source_id: ctx._trace?.traceId || null,
      _original_content: message,
      // Chat saves must never inherit a project merely because the user happens
      // to be viewing it. The planner may carry an explicitly stated scope, and
      // a resumed scope choice may carry an explicit project id; otherwise the
      // save tool returns a destination choice before any write.
      _require_explicit_scope: true,
    };
    try {
      const r = await dispatchTool('hivemind_save_memory', args, ctx);
      if (r?.needs_project_choice) {
        return { tool: 'hivemind_save_memory', args, result_summary: 'needs project choice',
          project_choice: { projects: r.projects || [], scope_options: r.scope_options || [], draft: r.draft || null } };
      }
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify(args) });
      // A detected contradiction must reach the ANSWER model, not just the DB.
      // The step summary is what the answer step reads, so a save that conflicts
      // says so here or the user never learns of it.
      const _conf = Array.isArray(r?.conflicts) ? r.conflicts : [];
      const _confNote = _conf.length
        ? ` — CONFLICTS WITH: ${_conf.map((c) => c.title || c.snippet || c.memory_id).join(' | ')}`
        : '';
      const summary = r?.error
        ? `error: ${r.error}`
        : (r?.id ? `saved ${(r.id || '').slice(0, 8)}${_confNote}` : `saved${_confNote}`);
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary });
      return { tool: 'hivemind_save_memory', args, result: r, result_summary: summary };
    } catch (err) {
      return { tool: 'hivemind_save_memory', args, result_summary: `error: ${err.message}` };
    }
  }

  // Auto-save path — fires when planner judged the user's message contains
  // a durable fact even though the user did NOT say "save". Goes through
  // the same hivemind_save_memory tool (which routes via canonical smart-
  // ingest pipeline → engine.ingestMemory → entity_co_mention + conflict-
  // detector + relationship classifier). Smart-ingest's NOOP detector
  // skips duplicates so unprompted re-saves of known facts are cheap. The
  // user-facing response acknowledges briefly (rule 8 in answerPrompt).
  if (plan.auto_save_intent && typeof plan.auto_save_intent === 'object') {
    const as = plan.auto_save_intent;
    const args = {
      title: as.title,
      content: as.content,
      tags: Array.isArray(as.tags) ? as.tags : [],
      source_type: ['decision','preference','event','goal','lesson','relationship'].includes(as.memory_type) ? as.memory_type : 'text',
      ...(as.project_id ? { project_id: as.project_id, scope: 'project' } : {}),
      ...(as.project_hint ? { project: as.project_hint } : {}),
      ...(as.scope ? { scope: as.scope } : {}),
      ...(as.entities?.length ? { entities: as.entities } : {}),
      ...(as.event_time ? { event_time: as.event_time } : {}),
      _memory_admission: as.admission_class || 'trusted_fact',
      _source_id: ctx._trace?.traceId || null,
      _original_content: message,
      _require_explicit_scope: true,
    };
    try {
      const r = await dispatchTool('hivemind_save_memory', args, ctx);
      if (r?.needs_project_choice) {
        return { tool: 'hivemind_save_memory', args, result_summary: 'needs project choice',
          project_choice: { projects: r.projects || [], scope_options: r.scope_options || [], draft: r.draft || null } };
      }
      const summary = r?.id ? `auto-saved ${(r.id || '').slice(0, 8)} (conf=${as.confidence.toFixed(2)})` : 'auto-saved';
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify({ ...args, __auto: true }) });
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary });
      return { tool: 'hivemind_save_memory', args, result: r, result_summary: summary };
    } catch (err) {
      return { tool: 'hivemind_save_memory', args, result_summary: `auto-save error: ${err.message}` };
    }
  }
  return null;
}

function mutationConfirmation(operation, language, result = {}) {
  const lang = String(language || 'en').toLowerCase().split('-')[0];
  const labels = {
    en: { saved: 'Saved to HIVEMIND.', updated: 'Memory updated.', profile_updated: 'Your profile has been updated.', assistant_renamed: 'Done — I\'ll go by that name now.', needs_project_choice: 'Choose where this memory belongs.' },
    de: { saved: 'In HIVEMIND gespeichert.', updated: 'Erinnerung aktualisiert.', profile_updated: 'Dein Profil wurde aktualisiert.', assistant_renamed: 'Erledigt — ich heiße jetzt so.', needs_project_choice: 'Wählen Sie aus, wohin diese Erinnerung gehört.' },
    fr: { saved: 'Enregistré dans HIVEMIND.', updated: 'Mémoire mise à jour.', profile_updated: 'Votre profil a été mis à jour.', assistant_renamed: 'C\'est fait — je porte ce nom désormais.', needs_project_choice: 'Choisissez où enregistrer cette mémoire.' },
    es: { saved: 'Guardado en HIVEMIND.', updated: 'Memoria actualizada.', profile_updated: 'Tu perfil ha sido actualizado.', assistant_renamed: 'Listo — ahora me llamo así.', needs_project_choice: 'Elige dónde guardar esta memoria.' },
    hi: { saved: 'HIVEMIND में सहेजा गया।', updated: 'मेमोरी अपडेट की गई।', profile_updated: 'आपकी प्रोफ़ाइल अपडेट कर दी गई।', assistant_renamed: 'हो गया — अब मैं इसी नाम से जाना जाऊँगा।', needs_project_choice: 'चुनें कि यह मेमोरी कहाँ सहेजी जाए।' },
    ar: { saved: 'تم الحفظ في HIVEMIND.', updated: 'تم تحديث الذاكرة.', profile_updated: 'تم تحديث ملفك الشخصي.', assistant_renamed: 'تم — سأحمل هذا الاسم الآن.', needs_project_choice: 'اختر مكان حفظ هذه الذاكرة.' },
  };
  const table = labels[lang] || labels.en;
  const key = result.needs_project_choice ? 'needs_project_choice' : operation;
  return table[key] || labels.en[key] || labels.en.saved;
}

function buildActionResult(operation, result = {}) {
  if (result.needs_project_choice) {
    return {
      operation: 'needs_project_choice', memory_id: null, project_id: null,
      project_name: null, deprecated_ids: [], edges_created: [],
    };
  }
  return {
    operation,
    memory_id: result.id || null,
    project_id: result.project_id || null,
    project_name: result.project || null,
    deprecated_ids: result.deprecated_id ? [result.deprecated_id] : [],
    edges_created: result.edges_created || (operation === 'updated' && result.deprecated_id && result.id
      ? [{ type: 'Updates', from_id: result.id, to_id: result.deprecated_id }]
      : []),
  };
}

/**
 * Produce the user-facing answer for a completed governed compound run.
 *
 * Tool execution remains authoritative and entirely separate from this
 * function: synthesis can explain completed read/recall results, but it can
 * neither select another tool nor alter arguments, drafts, approvals, or
 * provider receipts. The same function is used for initial and resumed runs
 * so a human-input continuation cannot fall back to a terse step counter.
 */
export async function synthesizeCompoundUserResponse({
  message,
  history = [],
  compound,
  language = 'en',
  model,
  apiKey,
  signal,
  onEvent,
  onUsage,
}) {
  if (compound?.status !== 'completed'
      || (!compound?.readResults?.length && !compound?.recallResults?.length)) {
    return { text: compound?.summary || 'Done.', usage: [] };
  }

  const { buildCompoundSynthesisPayload, compoundSynthesisResultsLabel } = await import('./compound-orchestrator.js');
  const usage = [];
  const recentContext = (Array.isArray(history) ? history : [])
    .slice(-4)
    .filter((turn) => ['user', 'assistant'].includes(turn?.role) && typeof turn?.content === 'string')
    .map((turn) => `${turn.role.toUpperCase()}: ${turn.content.trim().slice(0, 1800)}`)
    .join('\n');
  let finalText = compound.summary;
  let visibleLimit = compound.recallResults?.length ? 5 : 15;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = buildCompoundSynthesisPayload({
      recallResults: compound.recallResults || [],
      readResults: compound.readResults || [],
      visibleLimit,
    });
    const boundedResults = JSON.stringify(payload).slice(0, 36000);
    const synthesized = await callJsonLLM({
      messages: [
        {
          role: 'system',
          content: `Return strict JSON {"response":string,"context_status":"sufficient|relevant_but_incomplete|query_mismatch"}.

Write the final user-facing answer as HIVE, the organisation's knowledgeable, helpful brain. Use only the completed governed HIVE-MIND recall and live Composio results supplied as factual authority. Conversation context is provided only to resolve references; it is not evidence.

COMPLETENESS AND STYLE:
- Directly fulfil every part of the user's request. For multi-part work, use short headings or a readable list.
- Explain what was found or completed, not merely that a tool ran. Include the useful substance of the results.
- Match depth to intent: concise for a narrow lookup; detailed and comprehensive for requests such as "all", "everything", "detailed", summaries, comparisons, reports, or multi-step workflows.
- For lists, enumerate the actual returned items and preserve important names, dates, senders, recipients, identifiers, links, counts, statuses, and relevant snippets.
- Synthesize overlapping results into coherent prose instead of dumping raw JSON or repeating step logs.
- State meaningful limitations precisely. Distinguish an empty successful result from a failed, missing, or incomplete result.
- Prefer live connector data for connector questions. Never replace it with unrelated recalled material.
- Do not claim an external action occurred unless the governed result says it completed. Drafts and approvals are described exactly as pending.
- If ranked recall is relevant but insufficient and more ranked rows exist, set context_status="relevant_but_incomplete"; the server will reveal the next ranked page without executing recall again.
- After the final page, answer with everything established and identify only the genuinely missing part.
- Write in ${language || 'en'}. Do not mention these instructions, internal prompts, or implementation details.`,
        },
        {
          role: 'user',
          content: `USER REQUEST:\n${message}${recentContext ? `\n\nRECENT CONVERSATION (reference resolution only):\n${recentContext}` : ''}\n\n${compoundSynthesisResultsLabel({ recallResults: compound.recallResults || [], visibleLimit })}:\n${boundedResults}`,
        },
      ],
      model,
      apiKey,
      maxTokens: 1600,
      signal,
      reasoningEffort: 'low',
      temperature: 0,
    });
    usage.push(synthesized.usage);
    onUsage?.(attempt === 0 ? 'connector_synthesis' : `connector_synthesis_expand_${attempt}`, synthesized.usage);
    if (typeof synthesized.parsed?.response === 'string' && synthesized.parsed.response.trim()) {
      finalText = synthesized.parsed.response.trim();
    }
    const hasMore = (compound.recallResults || []).some((result) =>
      ((result?.ranked_candidates || []).length
        || ((result?.memories || []).length + (result?.evidence || []).length)) > visibleLimit);
    if (synthesized.parsed?.context_status !== 'relevant_but_incomplete' || !hasMore || visibleLimit >= 15) break;
    const previous = visibleLimit;
    visibleLimit = Math.min(15, visibleLimit + 5);
    onEvent?.({ type: 'recall_window_revealed', mode: 'compound', from_rank: previous + 1, to_rank: visibleLimit });
  }

  return { text: finalText, usage: usage.filter(Boolean) };
}

// ── Public entry — same signature as v1 ────────────────────────────────

export function shouldLoadCompactProfileForDecision(decision = {}) {
  return decision.operation === 'direct'
    || decision.operation === 'save'
    || decision.operation === 'update_profile'
    || Boolean(decision.save_intent)
    || Boolean(decision.auto_save_intent);
}

export async function runReactAgentV2({
  message,
  history = [],
  model = process.env.HIVEMIND_AGENT_MODEL || null,
  apiKey,
  assistantName,
  orgName,
  language,
  ctx,
  onEvent,
  streamAnswer = false,
  router: _deprecatedRouter,
  recallMode,
  recallSource,
  recallTime,
  allowGeneralKnowledge = false,
  // ADDITIVE per-turn capability gate (default false). When true, connected
  // Composio apps / external tools become ELIGIBLE for this turn. Omitted or
  // false keeps the current HIVE-MIND-only path unchanged.
  useTools = false,
  // Route-owned override used by the isolated /v2/chat acceptance surface.
  // This never mutates process-wide feature flags and cannot enable V2 for
  // connector turns.
  nativeOrchestrator = null,
}) {
  if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.CEREBRAS_API_KEY) {
    throw new Error('chat provider API key required');
  }
  if (!message) throw new Error('message required');
  const abortCtrl = new AbortController();
  const requestedAnswerModel = resolveAnswerModel(model);
  let answerModel = requestedAnswerModel;
  const budgetTimer = setTimeout(() => abortCtrl.abort(), TURN_BUDGET_MS);
  const usages = [];
  const usageStages = {};
  const recordUsage = (stage, usage) => {
    if (!usage) return;
    usages.push(usage);
    usageStages[stage] = usage;
  };
  const steps = [];
  // Structured trace — enterprise observability layer.
  // Anthropic / DeepMind 2025-26 pattern: every agent turn carries a
  // unique traceId + per-phase timings + tool durations + cost.
  // Returned alongside the response so prod dashboards can aggregate.
  const trace = {
    traceId: (globalThis.crypto?.randomUUID?.() || `t_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
    started_at: new Date().toISOString(),
    phases: {},        // { plan_ms, evidence_ms, answer_ms, ... }
    tool_calls: [],    // [{ name, ms, status, failure_mode? }]
    cost: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      usd: 0,
    },
    failure_mode: null,
    confidence_path: [],
    warnings: [],
    models: {
      // Set these only when the corresponding call actually runs. The
      // progressive router can select a different primary/fallback model than
      // the legacy INTENT_MODEL, and native single-call turns intentionally do
      // not run the separate query optimizer.
      planner: null,
      query_optimizer: null,
      synthesis: requestedAnswerModel,
    },
    usage_stages: usageStages,
  };
  let eventSequence = 0;
  const userOnEvent = onEvent;
  onEvent = (event) => userOnEvent?.({
    ...event,
    schema_version: 1,
    trace_id: trace.traceId,
    sequence: ++eventSequence,
  });
  // Wrap dispatchTool so every call lands in the trace.
  const tracedDispatch = async (name, args, c, opts) => {
    const t0 = Date.now();
    const r = await dispatchTool(name, args, c, opts);
    trace.tool_calls.push({
      name,
      ms: Date.now() - t0,
      status: r?.error ? 'error' : 'ok',
      ...(r?._failure_mode ? { failure_mode: r._failure_mode } : {}),
      ...(r?._retried_after ? { retried_after: r._retried_after } : {}),
    });
    return r;
  };
  // Shim ctx so downstream uses traced dispatch automatically without
  // having to refactor every call site.
  ctx = {
    ...ctx,
    _tracedDispatch: tracedDispatch,
    _trace: trace,
    _signal: abortCtrl.signal,
    _apiKey: apiKey,
    _internalModel: INTERNAL_MODEL,
    _chatUseTools: useTools === true,
    _originalUserMessage: message,
  };

  const serveDurableAgent = async () => {
        const { runGovernedToolsAgent } = await import('./governed-agent-adapter.js');
        const durable = await runGovernedToolsAgent({
          message,
          ctx: {
            ...ctx,
            language,
            conversationHistory: history,
            composioCallbackOrigin: ctx.composioCallbackOrigin || process.env.HIVEMIND_FRONTEND_URL || undefined,
          },
          onEvent,
          prisma: ctx.prisma,
        });
        let continuation = null;
        if (durable.status === 'needs_input' && durable.resumeState && durable.inputRequests?.length) {
          const { createChatContinuation } = await import('./chat-continuation-store.js');
          const stored = await createChatContinuation({
            userId: ctx.userId, orgId: ctx.orgId, message, language,
            conversationHistory: durable.run?.scratch?.conversation_context || [],
            historyTurns: ctx.historyTurns,
            threadId: ctx.threadId || ctx.conversationId || ctx._conversationId || null,
            resumeState: durable.resumeState,
          }, {
            prisma: ctx.prisma,
            durable: ['session', 'workflow', 'full'].includes(ctx.durableChatMode),
            parentTurnId: ctx.durableChatTurnId || null,
          });
          continuation = {
            schema_version: 1,
            token: stored.token,
            expires_at: stored.expires_at,
            requests: durable.inputRequests,
          };
          onEvent?.({ type: 'orchestration_input_required', schema_version: 1, ...continuation });
        }
        let finalText = durable.summary;
        onEvent?.({ type: 'finish', text: finalText });
        onEvent?.({ type: 'turn_completed', grounded: false, operation: 'durable_agent', success: durable.status !== 'error' });
        return {
          response: finalText,
          answer_mode: 'compound',
          sources: [],
          citations: [],
          relationships: [],
          synthesis_chains: [],
          evidence_packets: [],
          steps: durable.steps || [],
          evidence_used: [],
          claims: [],
          rejected_claims: [],
          grounded: durable.status === 'completed',
          confidence: durable.status === 'completed' ? 1.0 : 0.5,
          gaps: durable.status === 'error' ? ['durable_agent_failed'] : [],
          scopes_found: [],
          project_choice: null,
          aggregate: null,
          action_result: null,
          assistant_name: assistantName || null,
          usage: sumUsage(usages),
          trace: finalizeTrace(trace, usages),
          draft_ids: durable.draftIds || [],
          pending_actions: durable.pendingActions || [],
          compound_status: durable.status,
          harness_version: durable.run?.scratch?.harness_version || null,
          continuation,
          execution: {
            harness_version: durable.run?.scratch?.harness_version || null,
            status: durable.status,
            steps: durable.steps,
            draft_ids: durable.draftIds || [],
            pending_actions: durable.pendingActions || [],
            run_id: durable.run?.id || null,
            session_id: durable.run?.composioSessionId || null,
          },
        };
  };

  try {
    if (ctx.projectId) {
      const authorizedProjects = Array.isArray(ctx.accessContext?.projectIds)
        ? ctx.accessContext.projectIds
        : [];
      if (!authorizedProjects.includes(ctx.projectId)) {
        trace.failure_mode = 'PROJECT_ACCESS_DENIED';
        onEvent?.({ type: 'scope_rejected', project_id: ctx.projectId, reason: 'project_access_denied' });
        return {
          response: 'You do not have access to the requested project scope.',
          error: 'project_access_denied',
          sources: [], steps: [], evidence_used: [], claims: [], rejected_claims: [],
          grounded: false, confidence: 0, gaps: ['Requested project is not authorized.'],
          usage: null, trace: finalizeTrace(trace, usages), assistant_name: assistantName || null,
        };
      }
    }
    onEvent?.({
      type: 'scope_bound',
      project_id: ctx.projectId || null,
      authorized_project_count: ctx.accessContext?.projectIds?.length || 0,
    });
    onEvent?.({ type: 'turn_accepted', schema_version: 1, trace_id: trace.traceId });

    // The enabled harness plans once, progressively; avoid loading the legacy router/catalog.
    if (useTools === true) {
      const { isProgressiveHarnessEnabled } = await import('./progressive-harness.js');
      const { isUseToolsDurableAgentEnabled } = await import('./use-tools-durable-agent-flag.js');
      if (isProgressiveHarnessEnabled(process.env, ctx) && await isUseToolsDurableAgentEnabled()) {
        return await serveDurableAgent();
      }
    }

    if (useTools !== true) {
      const { isEnableToolsHitlEnabled } = await import('./enable-tools-hitl-flag.js');
      if (await isEnableToolsHitlEnabled()) {
      const { destinationAppsForEnableTools, enableToolsRequest } = await import('./chat-enable-tools-gate.js');
      const apps = destinationAppsForEnableTools(message);
      if (apps.length) {
        const request = {
          ...enableToolsRequest(apps),
          step_index: 0,
          step_id: 'step-1',
        };
        const { createChatContinuation } = await import('./chat-continuation-store.js');
        const { buildProgressiveConversationContext } = await import('./progressive-harness.js');
        const stored = await createChatContinuation({
          userId: ctx.userId,
          orgId: ctx.orgId,
          message,
          language,
          conversationHistory: buildProgressiveConversationContext(history, ctx.historyTurns),
          historyTurns: ctx.historyTurns,
          threadId: ctx.threadId || ctx.conversationId || ctx._conversationId || null,
          resumeState: {
            kind: 'enable_tools',
            results: [{ inputRequest: request }],
          },
        }, {
          prisma: ctx.prisma,
          durable: ['session', 'workflow', 'full'].includes(ctx.durableChatMode),
          parentTurnId: ctx.durableChatTurnId || null,
        });
        const continuation = {
          schema_version: 1,
          token: stored.token,
          expires_at: stored.expires_at,
          requests: [request],
        };
        onEvent?.({ type: 'orchestration_input_required', schema_version: 1, ...continuation });
        onEvent?.({ type: 'finish', text: request.prompt });
        onEvent?.({ type: 'turn_completed', grounded: false, operation: 'enable_tools', success: true });
        return {
          response: request.prompt,
          answer_mode: 'compound',
          sources: [],
          citations: [],
          relationships: [],
          synthesis_chains: [],
          evidence_packets: [],
          steps: [],
          evidence_used: [],
          claims: [],
          rejected_claims: [],
          grounded: false,
          confidence: 0.5,
          gaps: [],
          scopes_found: [],
          project_choice: null,
          aggregate: null,
          action_result: null,
          assistant_name: assistantName || null,
          usage: sumUsage(usages),
          trace: finalizeTrace(trace, usages),
          draft_ids: [],
          pending_actions: [],
          compound_status: 'needs_input',
          continuation,
        };
      }
      }
    }

    // Build one per-turn toolkit before intent parsing. The parser sees only
    // capability names/descriptions available to this user and organization;
    // the same instance executes any selected connector/native tools later.
    const { buildToolkitForUser, getCapabilityCatalogForUser } = await import('./toolkit-factory.js');
    const _pt = (k, start) => { trace.phases[k] = Date.now() - start; };
    let _ps = Date.now();
    const groupCatalog = await getCapabilityCatalogForUser({ prisma: ctx.prisma, userId: ctx.userId, orgId: ctx.orgId });
    _pt('capability_catalog_ms', _ps);
    const authorizedProjectIds = Array.isArray(ctx.accessContext?.projectIds) ? ctx.accessContext.projectIds : [];
    const projectCatalog = authorizedProjectIds.length && ctx.prisma?.project
      ? await ctx.prisma.project.findMany({
          where: { id: { in: authorizedProjectIds }, orgId: ctx.orgId, status: 'active' },
          select: { id: true, name: true, slug: true, description: true },
          orderBy: { updatedAt: 'desc' },
          take: 24,
        }).catch(() => [])
      : [];
    _ps = Date.now();
    // Profile discovery is lazy. The semantic planner only needs to know that
    // a caller-scoped profile capability exists; it does not need the caller's
    // profile values on every turn. Resolve the bounded persona packet only
    // after planning selects a direct/personalized or memory-write path. A
    // dedicated profile read continues through get_user_profile below.
    let compactProfilePromise = null;
    const getCompactProfileContext = () => {
      if (compactProfilePromise) return compactProfilePromise;
      compactProfilePromise = (async () => {
        if (!ctx?.prisma) return '';
        try {
          const { getSharedProfileStore } = await import('../memory/profile-store.js');
          const ps = getSharedProfileStore(ctx.prisma);
          return (await ps.buildCompactProfileContext(ctx.userId, ctx.orgId, ctx.projectId || null)) || '';
        } catch { return ''; }
      })();
      return compactProfilePromise;
    };
    // FLAG: CHAT_ROUTER=progressive swaps ONLY the intent-selection stage for
    // the 6-tool Cerebras-direct progressive router. The adapter returns the
    // SAME decision shape, so intentDecisionToPlan + everything downstream is
    // unchanged. Default (unset/any other value) = the current parseChatIntent.
    let intentParsed;
    const nativeV2Module = useTools !== true ? await import('./v2/orchestrator.js') : null;
    const nativeV2Mode = nativeOrchestrator === 'v2' && useTools !== true
      ? 'serve'
      : (nativeV2Module?.nativeV2RoutingMode({ useTools, seed: ctx.userId || trace.traceId }) || 'off');
    const nativeV2Input = async () => ({
      message, history, language, apiKey, signal: abortCtrl.signal,
      // Native V2 discovers profile values through the caller-scoped profile
      // capability. Supplying values here would turn progressive discovery
      // back into an always-on prompt preload.
      profileContext: '', projectCatalog,
      orgId: ctx.orgId, userId: ctx.userId, threadId: ctx.threadId || null,
      timezone: ctx.timezone || ctx.accessContext?.timezone || 'UTC', now: new Date().toISOString(),
    });
    if (nativeV2Mode === 'serve') {
      // One turn owns one planner request. Provider failover belongs to the
      // Cloudflare route; invoking the progressive planner here paid for a
      // second LLM decision and could execute a different plan.
      intentParsed = await nativeV2Module.parseNativeTurnV2(await nativeV2Input());
    } else {
      if (nativeV2Mode === 'shadow') {
        void nativeV2Input()
          .then((input) => nativeV2Module.parseNativeTurnV2(input))
          .then((shadow) => console.info(`[chat:native-v2-shadow] trace=${trace.traceId} operation=${shadow.decision.operation} tool=${shadow.decision.native_tool || 'none'} validation=${shadow.validation?.status || 'unknown'}`))
          .catch((error) => console.warn(`[chat:native-v2-shadow] trace=${trace.traceId} failed=${error.message}`));
      }
      if (useTools && process.env.HOSTED_COMPOSIO_PLANNER_ENABLED === 'true') {
        try {
          const { planHostedComposioWorkflow } = await import('./hosted-composio-planner.js');
          const hostedPlan = await planHostedComposioWorkflow({
            request: message,
            history,
            language,
            apiKey,
            signal: abortCtrl.signal,
            orgId: ctx?.orgId,
          });
          intentParsed = {
            decision: {
              ...hostedPlan._decision,
              _hosted_planner: true,
              _hosted_plan_id: hostedPlan.plan_id,
              _connected_providers: hostedPlan.connected_providers,
            },
            usage: hostedPlan.usage,
          };
        } catch (hostedPlannerError) {
          // Explicit compatibility fallback: preserve the pre-existing
          // progressive planner if connection discovery or hosted planning
          // fails before any tool has executed. The trace carries the reason;
          // this is never a silent downgrade.
          console.warn(`[chat:hosted-planner] fallback: ${hostedPlannerError.message}`);
          const progressive = await import('./chat-progressive-router.js');
          intentParsed = await progressive.parseChatIntentProgressive({
            message, history, language, apiKey, signal: abortCtrl.signal, useTools,
          });
          intentParsed.decision = {
            ...intentParsed.decision,
            _hosted_planner: false,
            _hosted_planner_fallback: hostedPlannerError.message,
          };
        }
      } else if (process.env.CHAT_ROUTER === 'progressive') {
        intentParsed = await (await import('./chat-progressive-router.js')).parseChatIntentProgressive({
          message, history, language, apiKey, signal: abortCtrl.signal, useTools,
        });
      } else {
        intentParsed = await parseChatIntent({
          message, history, language,
          groupCatalog,
          projectCatalog,
          model: INTENT_MODEL,
          apiKey,
          signal: abortCtrl.signal,
        });
      }
    }
    trace.models.planner = intentParsed?.usage?.routing_model || INTENT_MODEL;
    trace.native_v2 = {
      mode: nativeV2Mode,
      served: intentParsed?.decision?._router === 'native-v2',
      schema_version: intentParsed?.plan?.schema_version || null,
      validation_status: intentParsed?.validation?.status || null,
      deterministic_repairs: intentParsed?.validation?.repairs || [],
      planned_steps: intentParsed?.plan?.steps?.length || null,
    };
    _pt('intent_parse_ms', _ps);
    let intentDecision = collapseNativeOnlyCompoundDecision(intentParsed.decision, message);
    if (intentDecision._native_v2_fallback) {
      trace.warnings.push(`native_v2_planner_fallback:${intentDecision._native_v2_fallback}`);
    }
    // `use_tools` is an authority boundary, not a prompt hint. A legacy or
    // malformed router decision therefore cannot disclose or execute an
    // external capability unless the API caller opted in for this turn.
    if (!useTools && ['connector_read', 'connector_write', 'compound'].includes(intentDecision.operation)) {
      intentDecision = {
        ...intentDecision,
        operation: 'recall',
        connector_provider: null,
        tool_groups: ['hivemind-recall'],
        subtasks: undefined,
        queries: intentDecision.queries?.length ? intentDecision.queries : [message],
      };
    }
    // Final native-grounding boundary for the progressive native planner after
    // every normalization seam and before the direct-answer fast path. It
    // shares the router's rule so no progressive model-provided direct or
    // profile label can bypass tenant-scoped recall.
    // Legacy direct turns retain their explicit compatibility contract; the
    // live native router is `CHAT_ROUTER=progressive`.
    const nativeGrounding = intentDecision._router === 'progressive'
      ? enforceNativeGroundingDecision(intentDecision, message, { useTools })
      : { decision: intentDecision, overridden: false };
    intentDecision = nativeGrounding.decision;
    if (nativeGrounding.overridden) {
      trace.warnings.push('native_knowledge_grounding_override');
      console.warn(`[chat-router] native knowledge decision overridden to recall trace=${trace.traceId}`);
    }
    // A single connected-app intent is an external execution plan with one
    // step. Route it through the same Composio-backed path as multi-step plans
    // so `use_tools:true` works for ordinary Gmail/Calendar/Docs reads too.
    if (useTools
        && process.env.COMPOUND_ORCHESTRATOR_ENABLED === 'true'
        && ['connector_read', 'connector_write'].includes(intentDecision.operation)
        && intentDecision.connector_provider) {
      const isWrite = intentDecision.operation === 'connector_write';
      intentDecision = {
        ...intentDecision,
        operation: 'compound',
        subtasks: [{
          operation: isWrite ? 'write' : 'read',
          tool_groups: [intentDecision.connector_provider],
          depends_on: null,
          message: intentDecision.queries?.[0] || message,
          retrieval: intentDecision.connector_retrieval || {
            result_order: 'provider_default', result_limit: null, has_explicit_filter: false,
          },
        }],
        tool_groups: [],
      };
    }
    recordUsage('router', intentParsed.usage);
    const preloadedProfileContext = shouldLoadCompactProfileForDecision(intentDecision)
      ? await getCompactProfileContext()
      : '';
    // Request-scoped identity for deterministic first-person resolution in
    // user-authored relation claims. It is never persisted or sent as a
    // caller-controlled tool argument.
    ctx._compactProfileContext = preloadedProfileContext;
    _ps = Date.now();
    const turnToolkit = await buildToolkitForUser({
      prisma: ctx.prisma,
      userId: ctx.userId,
      orgId: ctx.orgId,
      persistentMemoryEngine: ctx.persistentMemoryEngine,
      selectedGroups: intentDecision.tool_groups,
    });
    _pt('toolkit_build_ms', _ps);
    turnToolkit.resetEquippedTools(intentDecision.tool_groups);
    ctx._toolkit = turnToolkit;
    onEvent?.({ type: 'intent_decided', schema_version: 1, trace_id: trace.traceId, decision: intentDecision });
    trace.intent = {
      version: intentDecision.version,
      operation: intentDecision.operation,
      language: intentDecision.response_language,
      answer_scope: intentDecision.answer_scope || 'bounded',
      answer_type: intentDecision.answer_type || 'fact',
      response_depth: intentDecision.response_depth || 'standard',
      retrieval_shape: intentDecision.retrieval_shape || 'fact',
      answer_objective: intentDecision.answer_objective || message,
      side_effect_policy: intentDecision.side_effect_policy,
    };
    const hasBrowserContext = /<METADATA:(SELECTION|SECTION|BROWSER_CONTEXT)>/i.test(message || '');

    // The required structured intent call is the plan. This removes the old
    // quick-gate, JSON planner, tool-router switch, and phrase rescue stack.
    let plan = intentDecisionToPlan(intentDecision, message);
    // Suppress legacy retry/escalation seams only for the single-call native
    // planner. Tool-enabled/Composio turns retain their existing orchestration.
    plan._native_single_call = useTools !== true
      && ['progressive', 'native-v2'].includes(intentDecision._router);
    if (hasBrowserContext && !plan.sub_queries.length && plan.operation !== 'direct') {
      plan.sub_queries = [message];
    }
    plan = applyExplicitRecallControls(plan, {
      mode: recallMode,
      source: recallSource,
      time: recallTime || intentDecision.relation?.time || intentDecision.time,
    });
    const modelPolicy = chooseSynthesisModel({
      currentModel: requestedAnswerModel,
      operation: plan.operation,
      recallMode: plan.recall_mode,
      useTools,
    });
    answerModel = modelPolicy.served;
    trace.models.synthesis = answerModel;
    trace.model_policy = modelPolicy;

    // API/UI recall controls are server-owned requirements, not hints for the
    // intent model. A direct-answer plan must never bypass an explicit source,
    // time, or mode request, otherwise the endpoint can answer a named
    // document without reading it.
    const explicitRetrievalRequested = Boolean(
      recallMode
      || recallSource?.document_id
      || recallSource?.documentId
      || recallSource?.title
      || recallTime?.valid_at
      || recallTime?.known_at
      || recallTime?.range,
    );
    if (explicitRetrievalRequested) {
      plan.operation = 'recall';
      delete plan._direct_answer;
      if (!plan.sub_queries.length) plan.sub_queries = [message];
    }

    // PHASE 3 — compound multi-step orchestrator. Flag-gated (default off).
    // The progressive router emits operation='compound' with a `subtasks`
    // array when a request needs multiple sequential steps (e.g. recall →
    // create a Doc → email it). Executed by compound-orchestrator.js. Reads go
    // through ConnectorRuntime.executeTool; writes go through the legacy
    // pendingWrite draft flow. A draft_created result is reported as pending,
    // never as done.
    if (useTools === true) {
      const { isUseToolsDurableAgentEnabled } = await import('./use-tools-durable-agent-flag.js');
      if (await isUseToolsDurableAgentEnabled()) return await serveDurableAgent();
    }
    if (intentDecision.operation === 'compound'
        && process.env.COMPOUND_ORCHESTRATOR_ENABLED === 'true'
        && useTools === true
        && Array.isArray(intentDecision.subtasks) && intentDecision.subtasks.length > 0) {
      const { runCompoundOrchestrator } = await import('./compound-orchestrator.js');
      const priorAssistantContext = [...(Array.isArray(history) ? history : [])]
        .reverse()
        .find((turn) => turn?.role === 'assistant' && typeof turn?.content === 'string' && turn.content.trim())
        ?.content.trim().slice(0, 6000) || null;
      const compound = await runCompoundOrchestrator({
        subtasks: intentDecision.subtasks,
        ctx,
        apiKey,
        signal: abortCtrl.signal,
        onEvent,
        conversationContext: priorAssistantContext,
      });
      let continuation = null;
      if (compound.status === 'needs_input' && compound.resumeState && compound.inputRequests?.length) {
        const { createChatContinuation } = await import('./chat-continuation-store.js');
        const stored = await createChatContinuation({
          userId: ctx.userId, orgId: ctx.orgId, message, language,
          resumeState: compound.resumeState,
        }, {
          prisma: ctx.prisma,
          durable: ['session', 'workflow', 'full'].includes(ctx.durableChatMode),
          parentTurnId: ctx.durableChatTurnId || null,
        });
        continuation = {
          schema_version: 1,
          token: stored.token,
          expires_at: stored.expires_at,
          requests: compound.inputRequests,
        };
        onEvent?.({ type: 'orchestration_input_required', schema_version: 1, ...continuation });
      }
      steps.push(...compound.steps);
      let finalText = compound.summary;
      try {
        const synthesized = await synthesizeCompoundUserResponse({
          message, history, compound, language,
          model: requestedAnswerModel,
          apiKey,
          signal: abortCtrl.signal,
          onEvent,
          onUsage: recordUsage,
        });
        finalText = synthesized.text;
      } catch (error) {
        trace.warnings.push(`connector_synthesis_degraded:${error.message}`);
      }
      onEvent?.({ type: 'finish', text: finalText });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: 'compound', success: compound.status !== 'error' });
      // UNIFIED compound response: retains the normal chat evidence fields
      // (empty where a compound turn has no recall evidence) so clients can
      // rely on one shape, and adds a stable `execution` object describing the
      // multi-step run. `compound_status` / `draft_ids` are kept for backward
      // compatibility with the earlier reduced payload.
      return {
        response: finalText,
        answer_mode: 'compound',
        sources: [],
        citations: [],
        relationships: [],
        synthesis_chains: [],
        evidence_packets: [],
        steps,
        evidence_used: [],
        claims: [],
        rejected_claims: [],
        grounded: compound.status === 'completed',
        confidence: compound.status === 'completed' ? 1.0 : 0.5,
        gaps: compound.status === 'error' ? ['compound_step_failed'] : [],
        scopes_found: [],
        project_choice: null,
        aggregate: null,
        action_result: null,
        assistant_name: assistantName || null,
        usage: sumUsage(usages),
        trace: finalizeTrace(trace, usages),
        draft_ids: compound.draftIds,
        pending_actions: compound.pendingActions || [],
        compound_status: compound.status,
        execution: {
          status: compound.status,
          steps: compound.steps,
          draft_ids: compound.draftIds,
          pending_actions: compound.pendingActions || [],
        },
        continuation,
      };
    }

    // Native V2 owns context-free prose inside its single typed planner call.
    // Serving that validated draft directly removes a redundant synthesis call
    // for greetings, thanks and other friendly turns. Legacy routers keep their
    // existing answerDirectly compatibility path.
    if (intentDecision.operation === 'direct' && plan._direct_answer) {
      if (intentDecision._router === 'native-v2') {
        const response = String(plan._direct_answer).trim();
        const recentSources = intentDecision.uses_recent_public_sources
          ? (intentDecision.recent_public_sources || []).map((source, index) => ({
            id: `recent-public-${index + 1}`,
            title: source.title || source.url,
            url: source.url,
            retrieved_at: source.retrieved_at || null,
            source_type: 'public_web',
          }))
          : [];
        onEvent?.({ type: 'finish', text: response });
        onEvent?.({ type: 'turn_completed', grounded: recentSources.length > 0, operation: 'direct' });
        return {
          response, sources: recentSources, citations: recentSources,
          steps, evidence_used: recentSources.map((source) => source.id),
          grounded: recentSources.length > 0, confidence: 0.95, gaps: [],
          usage: sumUsage(usages), trace: finalizeTrace(trace, usages),
          assistant_name: assistantName || null,
        };
      }
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model: answerModel, apiKey, signal: abortCtrl.signal,
        plannerDraft: plan._direct_answer,
        profileContext: preloadedProfileContext,
      });
      recordUsage('direct', usage);
      onEvent?.({ type: 'finish', text: response });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: 'direct' });
      return {
        response,
        sources: [], steps, evidence_used: [], confidence: 0.9, gaps: [],
        usage: sumUsage(usages), trace: finalizeTrace(trace, usages),
        assistant_name: assistantName || null,
      };
    }

    const mutationTool = {
      update: plan.update_intent ? ['hivemind_update_memory', plan.update_intent] : null,
      // Destructive memory deletion is never executed from a model decision.
      // It requires the server approval flow to inject a one-time token.
      delete: null,
      rename_assistant: plan.assistant_name_intent ? ['hivemind_set_assistant_name', { name: plan.assistant_name_intent }] : null,
      // Caller-scoped profile write — "change MY name/role/company/preferences".
      update_profile: plan.profile_update_intent
        ? ['update_user_profile', { fields: plan.profile_update_intent.fields || {}, preferences: plan.profile_update_intent.preferences || [] }]
        : null,
    }[intentDecision.operation];
    if (mutationTool) {
      const [toolName, toolArgs] = mutationTool;
      onEvent?.({ type: 'tool_started', name: toolName, arguments: toolArgs });
      const result = await dispatchTool(toolName, toolArgs, ctx);
      // DISAMBIGUATION IS NOT A FAILURE.
      // The memory tools answer { updated:false, needs_memory_choice:true,
      // candidates:[...] } when a target_query matches several memories — a
      // request for the user to pick, deliberately NOT an error. Every other
      // failure path carries an `error` string; this one does not, so it fell
      // through to the generic branch below and rendered as
      // "That change could not be completed. (operation_failed)" — the fallback
      // used when result.error is empty. The candidates were computed, then
      // thrown away.
      //
      // Measured: "replace TARA with TARAXHIVE" against 5 memories mentioning
      // TARA, and "change it to Aug 25th" — both ambiguous, both reported to the
      // user as an opaque failure they could not act on.
      if (result?.needs_memory_choice) {
        const cands = (result.candidates || []).slice(0, 5);
        const lines = cands.map((c, i) => {
          const label = c.title || String(c.snippet || '').slice(0, 90) || c.id;
          return `${i + 1}. ${label}`;
        });
        // NO CANDIDATES IS NOT A QUESTION — IT IS A NEW FACT.
        //
        // With several matches, asking which one is right. With ZERO matches there
        // is nothing to disambiguate, and the old copy ("Name it more specifically
        // and I will update it") threw the user's statement away. Measured:
        // "SINGULANCE is the new name of Davinci AI" — a durable, declarative fact
        // about a rename — produced needs_memory_choice with an empty candidate
        // list and was never persisted. The next recall still answered "Davinciai
        // (DaVinci AI) is developing…" from 5 stale memories, because the
        // correction was never stored anywhere.
        //
        // A statement the user asserts is worth keeping whether or not it happens
        // to match an existing row. Save it as a new memory and let the engine's
        // own relationship pass do what it already does — Updates / Supersedes /
        // Contradicts against the memories that mention the old name. That is
        // strictly better than discarding it: worst case the graph holds one extra
        // fact, best case the rename propagates.
        //
        // Only for update intents (the user asserted something). Ambiguous matches
        // still ask, and nothing here deletes or overwrites.
        let savedFallback = null;
        if (!cands.length && intentDecision.operation === 'update' && String(message || '').trim().length > 8) {
          try {
            const _stmt = String(message).trim();
            const saveRes = await dispatchTool('hivemind_save_memory', {
              title: _stmt.split(/[.!?\n]/)[0].slice(0, 80) || 'Statement',
              content: _stmt,
              memory_type: 'decision',
              tags: ['source:chat', 'update-fallback'],
              _original_content: message,
              // An update fallback is still a new durable write. It must not
              // inherit the project that happens to be open in the UI.
              _require_explicit_scope: true,
            }, ctx);
            // needs_project_choice carries NO error field but has NOT saved
            // anything — it is a draft awaiting a scope pick. Counting it as saved
            // would tell the user their fact was stored when it was not, which is
            // the same class of lie as the empty-document `ready` state.
            if (saveRes && !saveRes.error && !saveRes.needs_project_choice) {
              savedFallback = saveRes;
            } else if (saveRes?.needs_project_choice) {
              console.warn('[update-fallback] save returned needs_project_choice — not counting as saved');
            }
          } catch (saveErr) {
            // Never let the fallback turn a soft outcome into a hard failure —
            // the disambiguation reply below still goes out.
            console.warn(`[update-fallback] save failed: ${saveErr.message}`);
          }
        }
        const ask = cands.length
          ? `That matches ${cands.length} memories — which one should I change?\n${lines.join('\n')}`
          : (savedFallback
            ? 'I could not find an existing memory to update, so I saved that as a new one and linked it to what I already know.'
            : 'I could not tell which memory you meant. Name it more specifically and I will update it.');
        // A saved fallback is a COMPLETED turn, not a pending question. Reporting
        // needs_input/success:false there would leave the FE waiting for a choice
        // the user does not need to make, and would mark a turn that did persist
        // the fact as a failure.
        onEvent?.({ type: 'tool_completed', name: toolName, status: savedFallback ? 'ok' : 'needs_input', result });
        onEvent?.({ type: 'finish', text: ask });
        onEvent?.({ type: 'turn_completed', grounded: false, operation: intentDecision.operation, success: Boolean(savedFallback) });
        return {
          response: ask,
          sources: [],
          steps: [{ tool: toolName, args: toolArgs, result_summary: savedFallback ? 'update_unresolved_saved_new' : 'needs_memory_choice' }],
          evidence_used: [], confidence: 0,
          gaps: savedFallback ? [] : ['needs_memory_choice'],
          needs_memory_choice: !savedFallback,
          candidates: cands,
          action_result_saved: savedFallback ? (savedFallback.memoryId || savedFallback.id || true) : null,
          usage: sumUsage(usages), trace: finalizeTrace(trace, usages),
          assistant_name: plan.assistant_name_intent || assistantName || null,
          action_result: null,
        };
      }
      const succeeded = !result?.error && result?.updated !== false && result?.deleted !== false && result?.set !== false;
      onEvent?.({ type: 'tool_completed', name: toolName, status: succeeded ? 'ok' : 'error', result });
      // TERMINAL: every write returns a server-owned confirmation here and never
      // falls through to recall-synthesis (which produced "I couldn't find
      // relevant information" after a completed write). A confirmation is always
      // produced on success — no reliance on a possibly-empty acknowledgement.
      const confirmOp = intentDecision.operation === 'update' ? 'updated'
        : intentDecision.operation === 'update_profile' ? 'profile_updated'
        : intentDecision.operation === 'rename_assistant' ? 'assistant_renamed'
        : 'saved';
      const response = succeeded
        ? (mutationConfirmation(confirmOp, intentDecision.response_language || language, result) || intentDecision.acknowledgement || 'Done.')
        : `${intentDecision.failure_response || 'That change could not be completed.'} (${result?.error || 'operation_failed'})`;
      onEvent?.({ type: 'finish', text: response });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: intentDecision.operation, success: succeeded });
      return {
        response, sources: [], steps: [{ tool: toolName, args: toolArgs, result_summary: succeeded ? 'completed' : String(result?.error || 'failed') }],
        evidence_used: [], confidence: succeeded ? 1 : 0, gaps: succeeded ? [] : [String(result?.error || 'operation_failed')],
        usage: sumUsage(usages), trace: finalizeTrace(trace, usages), assistant_name: plan.assistant_name_intent || assistantName || null,
        action_result: succeeded ? buildActionResult(confirmOp, result) : null,
      };
    }

    if (intentDecision.operation === 'delete') {
      const response = intentDecision.response_language?.startsWith('de')
        ? 'Das Löschen erfordert eine ausdrückliche Bestätigung in der Speicheransicht.'
        : 'Deletion requires explicit confirmation in the Memories view.';
      onEvent?.({ type: 'turn_completed', grounded: false, operation: 'delete', success: false, reason: 'confirmation_required' });
      return {
        response, sources: [], steps: [], evidence_used: [], confidence: 1, gaps: [],
        usage: sumUsage(usages), trace: finalizeTrace(trace, usages), assistant_name: assistantName || null,
        action_result: { operation: 'confirmation_required', memory_id: plan.delete_intent?.id || null },
      };
    }

    // Activate exactly the groups selected from their schemas/descriptions by
    // the structured parser. No provider-name or write-verb text matching.
    const selectedGroups = intentDecision.tool_groups || [];
    const readIntents = intentDecision.operation === 'connector_read' ? selectedGroups : [];
    let readToolkit = null;
    if (readIntents.length > 0) {
      try {
        readToolkit = turnToolkit;
        const activation = readToolkit.resetEquippedTools(readIntents);
        if (activation.tools.length > 1) {
          onEvent?.({
            type: 'tool_call',
            name: 'reset_equipped_tools',
            arguments: JSON.stringify({ group_names: readIntents }),
          });
          onEvent?.({
            type: 'tool_result',
            name: 'reset_equipped_tools',
            summary: `activated [${readIntents.join(',')}] (${activation.tools.length} tools, read-intent)`,
          });
          steps.push({
            tool: 'reset_equipped_tools',
            args: { group_names: readIntents },
            result_summary: `${activation.tools.length} tools active (read)`,
          });
          // Stash toolkit on ctx for later steps (evidence/answer) to call
          // tools on demand. Tools surface in ctx._readToolkit so the
          // answer step can invoke them when memory recall is sparse.
          ctx._readToolkit = readToolkit;
        }
      } catch (toolErr) {
        console.warn('[agent] read-intent toolkit failed:', toolErr.message);
      }
    }

    const writeIntent = plan.action_intent ? { provider: plan.action_intent } : null;
    if (writeIntent) {
      let writeFailure = null;
      try {
        const toolkit = turnToolkit;
        // Activate the matched connector group.
        const actionGroups = selectedGroups.length ? selectedGroups : [writeIntent.provider];
        const activation = toolkit.resetEquippedTools(actionGroups);
        if (activation.tools.length > 1) {
          onEvent?.({ type: 'tool_call', name: 'reset_equipped_tools', arguments: JSON.stringify({ group_names: actionGroups }) });
          onEvent?.({ type: 'tool_result', name: 'reset_equipped_tools', summary: `activated ${writeIntent.provider} (${activation.tools.length} tools)` });
          steps.push({
            tool: 'reset_equipped_tools',
            args: { group_names: actionGroups },
            result_summary: `${activation.tools.length} tools active`,
          });
          // The planner selected the connector; Cerebras executes the tool
          // turn and synthesizes the user-facing result.
          const sub = await runActionSubLoop({
            toolkit, message, history, model: answerModel, apiKey, ctx, onEvent,
            provider: writeIntent.provider,
          });
          steps.push(...sub.steps);
          const finalText = sub.response || plan.acknowledgement;
          onEvent?.({ type: 'finish', text: finalText });
          onEvent?.({ type: 'turn_completed', grounded: false, operation: 'connector_write', success: true });
          return {
            response: finalText,
            sources: [],
            steps,
            evidence_used: [],
            confidence: 1.0,
            gaps: [],
            usage: sumUsage(usages),
        trace: finalizeTrace(trace, usages),
            assistant_name: assistantName || null,
            draft_ids: sub.draftIds,
            project_choice: sub.project_choice || null,
          };
        }
        writeFailure = 'connector_toolkit_unavailable';
      } catch (err) {
        console.warn(`[agent] write-intent branch failed: ${err.message}`);
        writeFailure = 'connector_toolkit_failed';
      }
      if (writeFailure) {
        const response = plan.failure_response;
        onEvent?.({ type: 'finish', text: response });
        onEvent?.({ type: 'turn_completed', grounded: false, operation: 'connector_write', success: false, error: writeFailure });
        return {
          response, sources: [], steps, evidence_used: [], confidence: 0,
          gaps: [writeFailure], usage: sumUsage(usages), trace: finalizeTrace(trace, usages),
          assistant_name: assistantName || null,
        };
      }
    }

    // Pure save intent (no recall needed) — write the memory then ack.
    // Requires intent_kind === 'save' (enforced upstream in parseChatIntent /
    // intentDecisionToPlan) AND
    // a populated save_intent payload. Pure-noun / filename-only inputs
    // never reach this branch because intent_kind is forced to 'lookup'
    // and save_intent stripped during plan post-processing.
    if (plan.intent_kind === 'save' && plan.save_intent && plan.sub_queries.length === 0) {
      const saveStep = await maybeSaveOrUpdate({ plan, ctx, onEvent, message, history });
      if (saveStep) steps.push(saveStep);
      // Deferred for project choice — ask (the FE renders project buttons),
      // do NOT claim it was saved.
      if (saveStep?.project_choice) {
        const askText = mutationConfirmation('saved', intentDecision.response_language || language, { needs_project_choice: true });
        onEvent?.({ type: 'finish', text: askText });
        onEvent?.({ type: 'turn_completed', grounded: false, operation: 'save', success: false, reason: 'project_scope_unresolved' });
        return {
          response: askText, sources: [], steps,
          evidence_used: [], confidence: 1.0, gaps: [],
          usage: sumUsage(usages),
          trace: finalizeTrace(trace, usages),
          assistant_name: assistantName || null,
          project_choice: saveStep.project_choice,
          action_result: buildActionResult('saved', { needs_project_choice: true }),
        };
      }
      const saveResult = saveStep?.result || {};
      const saveSucceeded = saveResult.saved !== false && !saveResult.error;
      const ackText = saveSucceeded
        ? mutationConfirmation('saved', intentDecision.response_language || language, saveResult)
        : `${intentDecision.failure_response || 'Memory save failed.'} (${saveResult.error || 'operation_failed'})`;
      onEvent?.({ type: 'finish', text: ackText });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: 'save', success: saveSucceeded });
      return {
        response: ackText, sources: [], steps,
        evidence_used: [], confidence: saveSucceeded ? 1.0 : 0, gaps: saveSucceeded ? [] : [saveResult.error || 'operation_failed'],
        usage: sumUsage(usages),
        trace: finalizeTrace(trace, usages),
        assistant_name: assistantName || null,
        action_result: saveSucceeded ? buildActionResult('saved', saveResult) : null,
      };
    }

    // Direct answer if planner left sub_queries empty AND no side-effects.
    // Skip the evidence-gated answer step — its grounding rules cause
    // the model to refuse / return empty for self-contained questions
    // like '2+2' that have no recall context to lean on.
    // Only a genuine direct plan may skip the capability stage. Dedicated
    // native reads such as caller profile, aggregate, relation, and timeline
    // intentionally have no recall sub-query; treating that absence as a
    // direct answer bypasses their authoritative server-side tool.
    if (plan.operation === 'direct' && plan.sub_queries.length === 0 && !plan.save_intent && !plan.needs_web) {
      // No-recall direct answer uses the model selected by the caller.
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model: answerModel, apiKey, signal: abortCtrl.signal,
        profileContext: preloadedProfileContext,
      });
      recordUsage('direct', usage);
      onEvent?.({ type: 'finish', text: response });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: 'direct', success: true });
      return {
        response,
        sources: [],
        steps,
        evidence_used: [],
        confidence: 1.0,
        gaps: [],
        usage: sumUsage(usages),
        trace: finalizeTrace(trace, usages),
        assistant_name: assistantName || null,
      };
    }

    // STEP 2.5 — Optimise the recall query into an intent-preserving semantic
    // expression instead of searching the raw conversational prompt. Only on blended
    // recall turns — dedicated lanes (aggregate/connector_read/relation_between/
    // profile) run no sub_query recall, so optimising is a wasted model call.
    // The answer LLM still receives the user's original message.
    const _dedicatedLane = !shouldRunRecallOptimizer(plan);
    let queryOptimizerRan = false;
    if (!_dedicatedLane
        && shouldOptimizeRecallQuery({
          router: intentDecision._router,
          canonicalQuery: plan.query_canonical_en,
          useTools,
        })) {
      const optimizerStartedAt = Date.now();
      try {
        trace.models.query_optimizer = QUERY_OPTIMIZER_MODEL;
        const optimizedResult = await optimizeRecallQueries({
          message, plan, model: QUERY_OPTIMIZER_MODEL, apiKey, signal: abortCtrl.signal,
        });
        const optimized = optimizedResult.queries;
        queryOptimizerRan = true;
        recordUsage('query_optimizer', optimizedResult.usage);
        if (optimized.length) {
          plan.query_canonical_en = optimized[0];
          const fileQueries = plan.sub_queries.filter((q) => typeof q === 'string' && /\.\w{2,4}\b/.test(q));
          plan.sub_queries = [...new Set([...optimized, ...fileQueries])].slice(0, 3);
          onEvent?.({ type: 'query_optimized', queries: plan.sub_queries });
        }
      } catch { /* keep planner queries on any failure */ }
      trace.phases.query_optimizer_ms = (trace.phases.query_optimizer_ms || 0) + (Date.now() - optimizerStartedAt);
    }

    // STEP 3 — Evidence
    onEvent?.({
      type: 'retrieval_planned',
      operation: intentDecision.operation,
      mode: plan.recall_mode,
      source: plan.source || null,
      aggregate: plan.aggregate || null,
    });
    _ps = Date.now();
    let retrievalPasses = 1;
    let evidence = await gatherEvidence({
      plan,
      ctx,
      onEvent,
      // Retrieval owns its own absolute budget. Planning latency must never
      // consume the evidence window.
      deadlineAt: Date.now() + RETRIEVAL_BUDGET_MS,
    });
    _pt('gather_evidence_ms', _ps);
    steps.push(...evidence.steps);
    const durableRecoveryEnabled = ['session', 'workflow', 'full'].includes(ctx?.durableChatMode);
    // A relationship graph is deliberately conservative and may not yet have
    // projected a freshly saved, explicit assertion. In durable mode, a zero
    // graph result gets one source-backed recall pass. This does not manufacture
    // an edge: synthesis must still ground the answer in the recovered memory.
    if (_dedicatedLane
        && durableRecoveryEnabled
        && plan.operation === 'relation_between'
        && evidence?.coverage?.evidence_found === false
        && Array.isArray(plan.named_entities)
        && plan.named_entities.length >= 2) {
      const saved = {
        operation: plan.operation,
        relation: plan.relation,
        canonical: plan.query_canonical_en,
        subQueries: plan.sub_queries,
        entities: plan.named_entities,
        answerType: plan.answer_type,
        recallMode: plan.recall_mode,
      };
      const relationshipQuery = `source for relationship between ${plan.named_entities.slice(0, 2).join(' and ')}`;
      plan.operation = 'recall';
      plan.relation = null;
      plan.query_canonical_en = relationshipQuery;
      plan.sub_queries = [relationshipQuery];
      plan.named_entities = [];
      plan.answer_type = 'fact';
      plan.recall_mode = 'fact';
      onEvent?.({ type: 'query_optimized', queries: plan.sub_queries, reason: 'durable_relationship_evidence_recovery' });
      const recovered = await gatherEvidence({
        plan, ctx, onEvent, deadlineAt: Date.now() + RETRIEVAL_BUDGET_MS,
      });
      retrievalPasses += 1;
      steps.push(...recovered.steps);
      Object.assign(plan, {
        operation: saved.operation,
        relation: saved.relation,
        query_canonical_en: saved.canonical,
        sub_queries: saved.subQueries,
        named_entities: saved.entities,
        answer_type: saved.answerType,
        recall_mode: saved.recallMode,
      });
      if (recovered?.coverage?.evidence_found === true) evidence = recovered;
    }
    if (!_dedicatedLane && shouldRetryAfterZeroCoverage({
      router: intentDecision._router,
      canonicalQuery: plan.query_canonical_en,
      coverage: evidence.coverage,
      alreadyOptimized: queryOptimizerRan,
      useTools,
    })) {
      const retryOptimizerStartedAt = Date.now();
      trace.models.query_optimizer = QUERY_OPTIMIZER_MODEL;
      const retryResult = await optimizeRecallQueries({
        message, plan, model: QUERY_OPTIMIZER_MODEL, apiKey, signal: abortCtrl.signal,
      });
      trace.phases.query_optimizer_ms = (trace.phases.query_optimizer_ms || 0) + (Date.now() - retryOptimizerStartedAt);
      recordUsage('query_optimizer_retry', retryResult.usage);
      queryOptimizerRan = true;
      if (retryResult.queries.length) {
        plan.query_canonical_en = retryResult.queries[0];
        plan.sub_queries = [...new Set(retryResult.queries)].slice(0, 3);
        onEvent?.({ type: 'query_optimized', queries: plan.sub_queries, reason: 'zero_coverage_retry' });
        const retried = await gatherEvidence({
          plan, ctx, onEvent, deadlineAt: Date.now() + RETRIEVAL_BUDGET_MS,
        });
        retrievalPasses += 1;
        steps.push(...retried.steps);
        evidence = retried;
      }
    }
    // Native V2 planning can produce a precise but embedding-hostile rewrite
    // (for example "<entity> approval and effective dates") even though the
    // entity's canonical memory is present. In durable modes, make one bounded,
    // deterministic entity-anchor recovery pass. This is intentionally behind
    // durable_chat_agent_v1 so flag-off Chat V2 remains byte-compatible.
    const durableEntityRecoveryEnabled = durableRecoveryEnabled;
    const entityAnchor = Array.isArray(plan.named_entities)
      ? plan.named_entities.find((value) => typeof value === 'string' && value.trim())
      : null;
    if (!_dedicatedLane
        && durableEntityRecoveryEnabled
        && evidence?.coverage?.evidence_found === false
        && entityAnchor
        && String(plan.query_canonical_en || '').trim().toLocaleLowerCase() !== entityAnchor.trim().toLocaleLowerCase()) {
      const originalCanonicalQuery = plan.query_canonical_en;
      const originalSubQueries = plan.sub_queries;
      const originalNamedEntities = plan.named_entities;
      const originalAnswerType = plan.answer_type;
      // Ask for the source-backed record rather than repeating the failed
      // attribute phrase. This broadens semantic retrieval while remaining
      // tenant-scoped and evidence-only; synthesis still answers the original
      // user question and must cite the recovered record.
      const recoveryQuery = `source for claims about ${entityAnchor.trim()}`;
      plan.query_canonical_en = recoveryQuery;
      plan.sub_queries = [recoveryQuery];
      plan.answer_type = 'fact';
      // Planner entities are relevance hints, not proof that entity projection
      // has already completed. Clear the hard entity filter for this recovery
      // pass so a freshly saved, source-grounded memory remains retrievable.
      plan.named_entities = [];
      onEvent?.({
        type: 'query_optimized',
        queries: plan.sub_queries,
        reason: 'durable_entity_anchor_recovery',
      });
      const recovered = await gatherEvidence({
        plan, ctx, onEvent, deadlineAt: Date.now() + RETRIEVAL_BUDGET_MS,
      });
      plan.query_canonical_en = originalCanonicalQuery;
      plan.sub_queries = originalSubQueries;
      plan.named_entities = originalNamedEntities;
      plan.answer_type = originalAnswerType;
      retrievalPasses += 1;
      steps.push(...recovered.steps);
      if (recovered?.coverage?.evidence_found === true) {
        evidence = recovered;
      }
    }
    trace.recall = {
      coverage: evidence.coverage,
      escalation_count: evidence.escalation_count,
      retrieval_passes: retrievalPasses,
      rerank_passes: (evidence.recall_telemetry || []).reduce((total, item) => total + item.rerank_passes, 0),
      rerank_ms: (evidence.recall_telemetry || []).reduce((total, item) => total + item.rerank_ms, 0),
    };
    onEvent?.({ type: 'coverage_assessed', coverage: evidence.coverage });

    // Recall always retains one authoritative mixed top-15 ranking. Intent
    // selects exactly one synthesis window before the model runs: ordinary
    // turns see five, detailed turns ten, comprehensive turns fifteen. There
    // is no post-answer reveal, retrieval retry, rerank, or synthesis hop.
    const evidenceWindowSize = evidenceWindowSizeForDepth(plan.response_depth, {
      nativeSingleCall: plan._native_single_call === true,
    });
    const progressiveSession = createProgressiveRecallSession({
      rankedCandidates: evidence.ranked_candidates || [],
      memories: evidence.memories || [],
      evidence: evidence.evidence || [],
      query: plan.query_canonical_en || message,
      initialSize: evidenceWindowSize,
      pageSize: 5,
      maxVisible: 15,
    });
    if (progressiveSession.candidates.length > 0) {
      evidence = applyProgressiveRecallView(evidence, progressiveSession);
    }
    trace.recall.progressive = {
      recall_id: progressiveSession.recall_id,
      candidate_count: progressiveSession.candidates.length,
      delivered_until: progressiveSession.delivered_until,
      selected_depth: plan.response_depth || 'standard',
      selected_window: evidenceWindowSize,
      degraded_order: progressiveSession.degraded_order,
      expansion_count: 0,
    };
    onEvent?.({
      type: 'recall_window_revealed', recall_id: progressiveSession.recall_id,
      from_rank: 1, to_rank: progressiveSession.delivered_until,
      candidate_count: progressiveSession.candidates.length,
    });

    // STEP 4 — Answer with the caller-selected user-facing model.
    _ps = Date.now();
    const answerInput = {
      message, history, evidence, plan,
      // The structured planner detects the language of this turn. A stored UI
      // preference is only a fallback; otherwise a German question can be
      // correctly planned as German and still synthesized in English.
      language: intentDecision.response_language || language,
      assistantName, orgName,
      apiKey, signal: abortCtrl.signal, ctx, allowGeneralKnowledge, preloadedProfileContext,
      streamValidated: streamAnswer, onEvent,
    };
    let synthesisPasses = 0;
    // One turn owns one synthesis request. Provider failover belongs behind
    // the Cloudflare route; application-level model loops produced duplicate
    // answers and contradictory validation outcomes.
    synthesisPasses = 1;
    const answer = await answerStep({ ...answerInput, model: answerModel });
    if (modelPolicy.shadow) {
      const servedSummary = {
        claim_count: answer.claims?.length || 0,
        citation_count: (answer.claims || []).reduce((sum, claim) => sum + (claim.citation_ids?.length || 0), 0),
      };
      scheduleShadowEvaluation({
        timeoutMs: Number(process.env.HIVEMIND_DEEPSEEK_SHADOW_TIMEOUT_MS || 15000),
        execute: (shadowSignal) => answerStep({
          ...answerInput,
          signal: shadowSignal,
          ctx: { ...ctx, _trace: { warnings: [] } },
          model: modelPolicy.shadow,
        }),
        onResult: (result) => {
          const shadow = result.answer;
          console.log('[chat-shadow-evaluation]', JSON.stringify({
            model: modelPolicy.shadow,
            ms: result.ms,
            ok: result.ok,
            valid_json_contract: result.ok && Array.isArray(shadow?.claims),
            grounded: shadow?.grounded === true,
            claim_count: shadow?.claims?.length || 0,
            citation_count: (shadow?.claims || []).reduce((sum, claim) => sum + (claim.citation_ids?.length || 0), 0),
            ...servedSummary,
            usage: shadow?.usage || null,
            error: result.ok ? null : (result.error?.message || 'shadow_failed'),
          }));
        },
      });
    }
    _pt('answer_step_ms', _ps);
    for (const [stage, usage] of Object.entries(answer.usage_stages || { synthesis: answer.usage })) {
      recordUsage(stage, usage);
    }
    trace.recall.synthesis_passes = synthesisPasses;
    onEvent?.({
      type: 'answer_validated',
      grounded: answer.grounded,
      confidence: answer.confidence,
      rejected_claim_count: answer.rejected_claims?.length || 0,
    });

    // STEP 5 — Save intent fire-and-forget (don't block response).
    // Save dispatch — fires on either:
    //   (a) explicit save: intent_kind === 'save' + save_intent populated
    //   (b) proactive auto-save: planner detected durable fact with
    //       confidence >= 0.75 in any intent_kind. The function checks
    //       both intents and prefers explicit save when both present.
    let recallProjectChoice = null;
    let recallActionResult = null;
    let recallSaveResult = null;
    if ((plan.intent_kind === 'save' && plan.save_intent) || plan.auto_save_intent) {
      const saveStep = await maybeSaveOrUpdate({ plan, ctx, onEvent, message, history });
      if (saveStep) steps.push(saveStep);
      if (saveStep?.project_choice) recallProjectChoice = saveStep.project_choice;
      if (saveStep?.result?.saved) {
        recallSaveResult = saveStep.result;
        recallActionResult = buildActionResult('saved', saveStep.result);
      }
    }

    const savedDisclosure = recallActionResult
      ? `\n\n${mutationConfirmation('saved', intentDecision.response_language || language, recallSaveResult)}`
      : '';
    const finalResponse = recallProjectChoice
      ? mutationConfirmation('saved', intentDecision.response_language || language, { needs_project_choice: true })
      : `${answer.response}${savedDisclosure}`;
    if (streamAnswer && answer.streaming_emitted !== true) {
      onEvent?.({ type: 'answer_started', schema_version: 1, validated: true });
      const chunks = String(finalResponse).match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^\n]+\n+|[^.!?\n]+$/g) || [String(finalResponse)];
      for (const delta of chunks) {
        onEvent?.({ type: 'answer_delta', schema_version: 1, delta, validated: true });
        // Yield between validated sentence chunks so proxies and browsers can
        // flush incrementally without ever exposing unvalidated model JSON.
        await new Promise((resolve) => setImmediate(resolve));
      }
      onEvent?.({ type: 'answer_completed', schema_version: 1, validated: true });
    }
    onEvent?.({ type: 'finish', text: finalResponse });
    onEvent?.({ type: 'turn_completed', grounded: answer.grounded, confidence: answer.confidence });

    const answerRecallPackets = answer.recall_packets || evidence.recall_packets || [];
    const citationPackets = answer.aggregate_citation_packet
      ? [...answerRecallPackets, answer.aggregate_citation_packet]
      : answerRecallPackets;
    const citationSources = buildChatCitationSources(citationPackets, answer.claims);
    const memorySources = evidence.memories.slice(0, 10).map(m => {
      const tags = m.tags || [];
      const isSynth = (m.source_metadata?.source_type === 'canonical-fact')
                   || (m.source_metadata?.source_type === 'synthesis-bridge')
                   || tags.includes('synthesis:canonical')
                   || tags.includes('synthesis:bridge');
      const synthType = tags.includes('synthesis:canonical') ? 'canonical-fact'
                      : tags.includes('synthesis:bridge')    ? 'synthesis-bridge'
                      : null;
      return {
        id: m.id,
        title: m.title,
        snippet: m.content,
        score: typeof m.score === 'number' ? Number(m.score.toFixed(3)) : null,
        tags,
        memory_type: m.memory_type,
        // Scope provenance so the chat can show WHERE each memory was found
        // (personal / project / team / organization) — mirrors the Memories
        // page ScopeBadge. Populated for every lane now that recall hydrates
        // scope + project on delivered memories.
        scope: m.scope || null,
        project: m.project || null,
        project_id: m.project_id || null,
        rank_trace: {
          is_synthesis: !!isSynth,
          synthesis_type: synthType,
          synthesis_confidence: m.synthesis_confidence ?? null,
          synthesis_revision: m.synthesis_revision ?? null,
          cross_cluster_boost: m._cross_cluster_boost != null ? Number(Number(m._cross_cluster_boost).toFixed(3)) : null,
          cross_cluster_overlap: m._cross_cluster_overlap ?? null,
          synthesis_boosted: !!m._synthesis_boosted,
        },
      };
    });
    // A precision source request may resolve to a direct upload represented by
    // a memory (for example a knowledge-upload image) rather than a document
    // evidence segment. Keep the source boundary, but surface that selected
    // memory when there is no document citation packet.
    const sourcePool = evidence.coverage?.source_requested
      ? (citationSources.length ? citationSources : memorySources)
      : [...citationSources, ...memorySources];
    const publicSources = [...new Map(sourcePool.map((source) => [
      source?.segment_id || source?.id || source?.citation_id,
      source,
    ])).values()].slice(0, 10);
    // Distinct scopes the answer's memories were drawn from — the chat renders
    // "(memory found in <scope>)" so the user sees which tier(s) answered
    // (my-space / project:<name> / org-wide). Default ALL recall spans all
    // accessible tiers, so this makes the tenant scoping visible per turn.
    const scopesFound = await (async () => {
      const tiers = new Set();          // 'personal' | 'organization' | 'team'
      const projectIds = new Set();     // distinct project ids seen
      const projectNames = new Set();   // project names already on the memory
      // BOTH LANES, not just memories. An answer built purely from uploaded documents
      // (a KB question — the evidence lane) has an empty `memories` BY DESIGN, so this
      // reported no scope at all on exactly the turns where the answer came from an
      // upload. Evidence segments now carry the tier derived from their document's
      // scope-key tag (documentScopeFromTags in knowledge/evidence-retrieval.js), so the
      // chip is accurate for uploads too. Same shape for both, so one loop covers them.
      for (const m of [...(evidence.memories || []), ...(evidence.evidence || [])]) {
        const s = m && m.scope;
        if (!s) continue;
        if (s === 'project') {
          if (m.project) projectNames.add(String(m.project));
          else if (m.project_id) projectIds.add(String(m.project_id));
          else tiers.add('project');
        } else {
          tiers.add(s);
        }
      }
      // Resolve project_id → name (single batched read) so the chip shows the
      // real project (e.g. "project:SOLVIS"), not a bare uuid. Best-effort.
      if (projectIds.size && ctx.prisma?.project?.findMany) {
        try {
          const rows = await ctx.prisma.project.findMany({
            where: { id: { in: [...projectIds] } }, select: { id: true, name: true },
          });
          const byId = new Map(rows.map((r) => [r.id, r.name]));
          for (const id of projectIds) projectNames.add(byId.get(id) || 'Project');
        } catch { for (const _ of projectIds) projectNames.add('Project'); }
      }
      return [
        ...[...tiers],
        ...[...projectNames].map((n) => `project:${n}`),
      ];
    })();

    // ── HOW WAS THIS ANSWERED? ───────────────────────────────────────────────
    // "The 5 most relevant memories say two" and "there are exactly two" are
    // different claims, and the response could not tell them apart. An answer
    // built from a top-K SAMPLE looked identical to one built from a complete
    // SCAN — which is exactly how a sampled count gets read as a fact.
    //
    // Derived from the steps ACTUALLY executed this turn, never from intent
    // guessing, so it reports what happened rather than what was planned.
    const _toolsUsed = [...new Set((steps || [])
      .map((s) => s?.tool || s?.name)
      .filter((n) => typeof n === 'string' && n))];
    const _counted = _toolsUsed.includes('hivemind_count_where')
      || _toolsUsed.includes('hivemind_aggregate_entities');
    const _answerMode = _counted ? 'counted'
      : _toolsUsed.some((n) => ['hivemind_timeline', 'hivemind_at', 'hivemind_diff'].includes(n)) ? 'temporal'
      : _toolsUsed.some((n) => ['hivemind_traverse_graph', 'hivemind_relation_between'].includes(n)) ? 'graph'
      : 'sampled';

    return {
      project_choice: recallProjectChoice,
      scopes_found: scopesFound,
      // How this answer was obtained. 'sampled' = top-K similarity, so any number
      // in the prose is indicative, not exhaustive. 'counted' = a real aggregate.
      answer_mode: _answerMode,
      answer_basis: {
        mode: _answerMode,
        exhaustive: _counted,
        sampled_sources: Array.isArray(publicSources) ? publicSources.length : 0,
        tools_used: _toolsUsed,
      },
      // When a save was deferred for project choice, don't claim it was saved —
      // prompt the user to pick (the FE renders project buttons below).
      response: finalResponse,
      follow_ups: recallProjectChoice ? [] : normalizeSuggestedFollowUps(answer.follow_ups),
      // Sources include recall-trace metadata so the FE can render WHY a
      // memory ranked (synth boost, x-cluster overlap, raw score). Helps
      // users trust the answer + spot mis-ranking.
      sources: publicSources,
      citations: citationSources,
      // Typed graph edges between sources — FE renders edge chips.
      relationships: (evidence.relationships || []).slice(0, 30).map(e => ({
        from_id: e.from_id,
        to_id: e.to_id,
        type: e.type,
        confidence: typeof e.confidence === 'number' ? Number(e.confidence.toFixed(2)) : null,
      })),
      // Synthesis chains (insight-mode only) — FE renders claim + sources tree.
      synthesis_chains: (evidence.synthesis_chains || []).slice(0, 5),
      evidence_packets: citationPackets.slice(0, 3),
      aggregate: evidence.aggregate || null,
      steps,
      evidence_used: answer.evidence_used,
      claims:        answer.claims,
      rejected_claims: answer.rejected_claims,
      grounded:      answer.grounded,
      confidence:    answer.confidence,
      // A server-authorized empty project list is a complete negative result,
      // not a missing-context gap invented by synthesis.
      gaps:          plan.operation === 'projects' && evidence.projects?.count === 0
        ? []
        : answer.gaps,
      usage:         sumUsage(usages),
      trace:         finalizeTrace(trace, usages),
      assistant_name: assistantName || null,
      action_result: recallProjectChoice
        ? buildActionResult('saved', { needs_project_choice: true })
        : recallActionResult,
    };
  } catch (error) {
    onEvent?.({ type: 'turn_failed', error: error?.code || error?.name || 'chat_orchestration_failed' });
    throw error;
  } finally {
    clearTimeout(budgetTimer);
  }
}

function sumUsage(arr) {
  if (!arr.length) return null;
  return arr.reduce((acc, u) => ({
    prompt_tokens:     (acc.prompt_tokens     || 0) + (u.prompt_tokens     || 0),
    completion_tokens: (acc.completion_tokens || 0) + (u.completion_tokens || 0),
    total_tokens:      (acc.total_tokens      || 0) + (u.total_tokens      || 0),
  }), {});
}

// Approximate Groq pricing (USD per 1M tokens) for cost telemetry.
// gpt-oss-120b: $0.15 input / $0.75 output. llama-3.3-70b-versatile:
// $0.59 input / $0.79 output. Conservative estimates used here for
// observability; for billing use the actual Groq invoice.
const COST_USD_PER_1M = {
  prompt: 0.30,
  completion: 0.80,
};
function estimateCostUsd(usage) {
  if (!usage) return 0;
  const pt = (usage.prompt_tokens || 0) / 1_000_000;
  const ct = (usage.completion_tokens || 0) / 1_000_000;
  return +(pt * COST_USD_PER_1M.prompt + ct * COST_USD_PER_1M.completion).toFixed(6);
}

// Finalize trace before returning. Mutates trace in place.
function finalizeTrace(trace, usages) {
  const u = sumUsage(usages) || {};
  trace.cost.prompt_tokens = u.prompt_tokens || 0;
  trace.cost.completion_tokens = u.completion_tokens || 0;
  trace.cost.total_tokens = u.total_tokens || 0;
  trace.cost.usd = estimateCostUsd(u);
  trace.usage_breakdown = summarizeUsage(trace.usage_stages || {});
  trace.ended_at = new Date().toISOString();
  trace.total_ms = new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime();
  return trace;
}

// Re-export TOOL_SCHEMAS so callers stay agnostic of which agent runs.
export { TOOL_SCHEMAS };
