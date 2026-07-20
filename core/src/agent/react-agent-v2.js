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
import { intentDecisionToPlan, parseChatIntent } from './chat-intent-decision.js';
import {
  chatCompletionFetch,
  DEFAULT_CHAT_PLANNER_MODEL,
  resolveChatSynthesisModel,
} from '../llm/chat-provider.js';

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
const RETRIEVAL_BUDGET_MS = Number(process.env.HIVEMIND_AGENT_RETRIEVAL_BUDGET_MS || 3_000);

// Model split:
//   • structured intent planning uses Gemini 2.5 Flash-Lite;
//   • final user-facing synthesis uses GPT-OSS 120B pinned to Cerebras;
//   • non-user-facing legacy helpers retain the internal Groq model.
// Both are env-overridable so we can A/B without code changes.
const INTERNAL_MODEL = process.env.HIVEMIND_AGENT_INTERNAL_MODEL || 'openai/gpt-oss-20b';
// The caller-selected model is reserved for user-facing synthesis below.
const INTENT_MODEL = process.env.CHAT_INTENT_MODEL || process.env.HIVEMIND_AGENT_INTENT_MODEL || DEFAULT_CHAT_PLANNER_MODEL;

export function resolveAnswerModel(selectedModel) {
  return resolveChatSynthesisModel(selectedModel);
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

async function callJsonLLM({ messages, model, apiKey, maxTokens, temperature = 0.1, signal }) {
  const resp = await chatCompletionFetch(model, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      max_completion_tokens: maxTokens,
      temperature,
    }),
    signal,
  }, { fallbackApiKey: apiKey });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat provider ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // Recover by extracting the first {...} block.
    const m = raw.match(/\{[\s\S]+\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }
  return { parsed, usage: data.usage };
}

// ── STEP 1 — quick direct-answer for greetings / smalltalk / self-Q ───

async function answerDirectly({ message, gateKind, language, assistantName, orgName, model, apiKey, signal, plannerDraft = null }) {
  const lang = languageName(language);
  const orgLabel = (!orgName || /^Local Org\b/i.test(orgName)) ? 'this HIVEMIND workspace' : orgName;
  const name = assistantName || 'HIVE';

  const LANG_BLOCK = `LANGUAGE: ALL OUTPUT MUST BE IN ${lang.toUpperCase()}. Even if the user wrote in another language, you reply ONLY in ${lang}. This is non-negotiable.`;

  const prompts = {
    greeting: `${LANG_BLOCK}\n\nYou are ${name}. Reply with a warm one-line greeting + ONE short offer-to-help. Plain text only. No JSON, no tool talk.`,
    smalltalk: `${LANG_BLOCK}\n\nYou are ${name}. Reply with one short polite sentence. Plain text only. No follow-up question.`,
    self_q: `${LANG_BLOCK}\n\nYou are ${name}, the internal voice of ${orgLabel}. Reply in 2-3 sentences:\n` +
            `  - You carry persistent memory of our team's facts, decisions, projects, people.\n` +
            `  - You can recall, save, link, time-travel through that memory, and pull live web results when needed.\n` +
            `Do NOT cite memories. Do NOT mention internal tool names. Plain text only.`,
    general: plannerDraft
      ? `${LANG_BLOCK}\n\nYou are ${name}. Produce the final reply using the planner draft below only as a bounded intent draft. Preserve its meaning, answer the user concisely, and do not introduce claims or topics absent from the user request or draft. Plain text only.\n\nPLANNER DRAFT:\n${String(plannerDraft).slice(0, 1200)}`
      : `${LANG_BLOCK}\n\nYou are ${name}. Reply concisely and only address the user's request. Do not introduce unrelated claims. Plain text only. No JSON, no tool talk.`,
  };

  const resp = await chatCompletionFetch(model, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompts[gateKind] },
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

async function gatherEvidence({ plan, ctx, onEvent, deadlineAt }) {
  const steps = [];
  const memoriesById = new Map();
  const liveItems = [];
  const evidenceItems = [];
  // Typed graph edges returned by the shared recall service.
  const edgesByKey = new Map();   // key = `${from_id}|${to_id}|${type}` → edge
  // Synthesis evidence chains from insight-mode recall. Each chain is a
  // canonical-fact or synthesis-bridge memory + its top-4 evidence
  // memories. Passed to answerStep so the LLM can cite synth claims AND
  // their source rows in the same answer.
  const synthesisChains = new Map(); // key = synthesis_id → chain
  const recallPackets = [];
  const coMentions = [];
  let relationChecked = false;
  let aggregateResult = null;
  let activeDeadlineAt = deadlineAt;
  const remaining = () => Math.max(0, activeDeadlineAt - Date.now());
  const beforeDeadline = (promise) => {
    const ms = remaining();
    return ms > 0
      ? Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('recall deadline exceeded')), ms))])
      : Promise.reject(new Error('recall deadline exceeded'));
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

  const recallExtras = {
    _structured_intent: true,
    ...(plan.time?.valid_at ? { valid_at: plan.time.valid_at } : {}),
    ...(plan.time?.known_at ? { known_at: plan.time.known_at } : {}),
    ...(plan.time?.range ? { date_range: plan.time.range } : {}),
    ...(plan.source?.document_id ? { source_document_id: plan.source.document_id } : {}),
    ...(plan.source?.title ? { source_title: plan.source.title } : {}),
    ...(plan.scope_filter ? { scope_filter: plan.scope_filter } : {}),
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
  const recallLimit = recallMode === 'full' || recallMode === 'panorama'
    ? 14
    : recallMode === 'explain' || recallMode === 'insight'
      ? 12
      : 8;
  const evidenceSeen = new Set();
  const plannedQueries = [...new Set([
    plan.user_message,
    ...(Array.isArray(plan.sub_queries) ? plan.sub_queries : []),
  ].filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim()))].slice(0, 3);
  // Compile the planner's decomposition into one deterministic recall packet.
  // The shared router owns wide lexical/vector/entity lanes; firing several
  // independent recalls duplicates those lanes and makes latency/merging
  // nondeterministic under load.
  const dedicatedLane = plan.operation === 'aggregate' || plan.operation === 'connector_read' || plan.operation === 'relation_between';
  const recallQueries = !dedicatedLane && plannedQueries.length > 0
    ? [plannedQueries.join('\nRelated focus: ')]
    : [];
  if (recallQueries.length > 0) {
    const recallResults = await Promise.all(
      recallQueries.map(async (q) => {
        const args = {
          query: q,
          query_original: plan.query_original || plan.user_message || q,
          query_canonical_en: plan.query_canonical_en || q,
          entities: plan.named_entities || [],
          mode: recallMode,
          limit: recallLimit,
          _explicit_mode: !!plan.explicit_recall_mode,
          ...recallExtras,
        };
        try {
          startTool('hivemind_recall', args);
          const r = await beforeDeadline(dispatchTool('hivemind_recall', args, ctx));
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
    // T1-3: dedup evidence + live items by id across all recall passes so
    // the render slices (.slice(0,8) DOC, .slice(0,10) LIVE) hold distinct
    // rows instead of repeats — recovers prompt tokens AND improves coverage.
    const liveSeen = new Set();
    for (const r of recallResults) {
      if (r?.recall_plan) {
        plan.source = r.recall_plan.source?.requested ? r.recall_plan.source : plan.source;
        plan.time = r.recall_plan.time || plan.time;
        plan.named_entities = r.recall_plan.named_entities || r.recall_plan.entities || plan.named_entities;
      }
      for (const m of (r?.memories || [])) {
        if (!m?.id) continue;
        if (!memoriesById.has(m.id)) memoriesById.set(m.id, m);
      }
      for (const li of (r?.live || [])) {
        const k = li?.id || `${li?.source || '?'}|${li?.title || ''}`;
        if (liveSeen.has(k)) continue;
        liveSeen.add(k);
        liveItems.push(li);
      }
      for (const ev of (r?.evidence || [])) {
        const k = ev?.id || `${ev?.document_title || '?'}|${ev?.page || ''}|${(ev?.content || ev?.snippet || '').slice(0, 40)}`;
        if (evidenceSeen.has(k)) continue;
        evidenceSeen.add(k);
        evidenceItems.push(ev);
      }
      for (const edge of (r?.relationships || [])) {
        if (!edge?.from_id || !edge?.to_id || !edge?.type) continue;
        const key = `${edge.from_id}|${edge.to_id}|${edge.type}`;
        if (!edgesByKey.has(key)) edgesByKey.set(key, edge);
      }
      if (r?.evidence_packet) recallPackets.push(r.evidence_packet);
      // Synthesis evidence chains — pulled when recall_mode='insight'.
      // Each chain: { synthesis_id, synthesis_title, conf, rev, evidence[] }
      for (const chain of (r?.synthesis_evidence_chains || [])) {
        if (!synthesisChains.has(chain.synthesis_id)) {
          synthesisChains.set(chain.synthesis_id, chain);
        }
      }
    }
  }

  if (plan.operation === 'relation_between' && plan.relation_intent?.entities?.length >= 2 && remaining() > 0) {
    const relationArgs = {
      entities: plan.relation_intent.entities,
      query: plan.query_canonical_en || plan.user_message,
      mode: 'explain',
      ...(plan.source?.document_id ? { source_document_id: plan.source.document_id } : {}),
      ...(plan.source?.title ? { source_title: plan.source.title } : {}),
      ...(plan.time?.valid_at ? { valid_at: plan.time.valid_at } : {}),
      ...(plan.time?.known_at ? { known_at: plan.time.known_at } : {}),
    };
    try {
      startTool('hivemind_relation_between', relationArgs);
      const relationResult = await beforeDeadline(dispatchTool('hivemind_relation_between', relationArgs, ctx));
      relationChecked = true;
      recordTool(
        'hivemind_relation_between', relationArgs,
        `${relationResult?.direct_edges?.length || 0} typed edges + ${relationResult?.shared_paths?.length || 0} shared paths`,
        relationResult,
      );
      for (const memory of (relationResult?.memories || [])) {
        if (memory?.id && !memoriesById.has(memory.id)) memoriesById.set(memory.id, memory);
      }
      for (const item of (relationResult?.evidence || [])) {
        const key = item?.id || `${item?.document_title || '?'}|${item?.page || ''}|${String(item?.content || item?.snippet || '').slice(0, 40)}`;
        if (!evidenceSeen.has(key)) { evidenceSeen.add(key); evidenceItems.push(item); }
      }
      for (const edge of (relationResult?.relationships || [])) {
        if (edge?.from_id && edge?.to_id && edge?.type) edgesByKey.set(`${edge.from_id}|${edge.to_id}|${edge.type}`, edge);
      }
      coMentions.push(...(relationResult?.co_mentions || []));
      recallPackets.push(...(relationResult?.evidence_packets || []));
    } catch (error) {
      recordTool('hivemind_relation_between', relationArgs, `error: ${error.message}`, null);
    }
  }

  if (plan.aggregate?.parent && plan.aggregate?.kind && remaining() > 0) {
    const aggregateArgs = {
      parent_name: plan.aggregate.parent,
      parent_candidates: [...new Set([plan.aggregate.parent, ...(plan.named_entities || [])]
        .filter((value) => typeof value === 'string' && value.trim()))].slice(0, 12),
      entity_kind: plan.aggregate.kind,
      limit: 1000,
    };
    try {
      startTool('hivemind_aggregate_entities', aggregateArgs);
      aggregateResult = await beforeDeadline(
        dispatchTool('hivemind_aggregate_entities', aggregateArgs, ctx),
      );
      recordTool(
        'hivemind_aggregate_entities',
        aggregateArgs,
        aggregateResult?.coverage?.complete
          ? `${aggregateResult.count} distinct ${aggregateResult.entity_kind || plan.aggregate.kind}`
          : `incomplete aggregate (${aggregateResult?.coverage?.reason || 'unknown'})`,
        aggregateResult,
      );
    } catch (error) {
      recordTool('hivemind_aggregate_entities', aggregateArgs, `error: ${error.message}`, null);
    }
  }

  let coverage = assessRecallCoverage({
    plan,
    memories: [...memoriesById.values()],
    evidence: evidenceItems,
    relationships: [...edgesByKey.values()],
    co_mentions: coMentions,
  });
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
  if (remaining() > 0 && (!plan.explicit_recall_mode || (coverage.source_requested && !coverage.source_covered))) {
    const escalation = chooseRecallEscalation({
      plan,
      coverage,
      query: plan.user_message || recallQueries[0],
    });
    if (escalation) {
      escalationCount = 1;
      try {
        startTool('hivemind_recall', { ...recallExtras, ...escalation.args });
        const expanded = await beforeDeadline(dispatchTool('hivemind_recall', {
          ...recallExtras,
          ...escalation.args,
        }, ctx));
        recordTool(
          'hivemind_recall',
          escalation.args,
          `${expanded?.memories?.length || 0} memories + ${expanded?.evidence_count || 0} evidence (${escalation.reason})`,
          expanded,
        );
        for (const memory of (expanded?.memories || [])) {
          if (memory?.id && !memoriesById.has(memory.id)) memoriesById.set(memory.id, memory);
        }
        for (const item of (expanded?.evidence || [])) {
          const key = item?.id || `${item?.document_title || '?'}|${item?.page || ''}|${(item?.content || item?.snippet || '').slice(0, 40)}`;
          if (!evidenceSeen.has(key)) {
            evidenceSeen.add(key);
            evidenceItems.push(item);
          }
        }
        for (const edge of (expanded?.relationships || [])) {
          if (!edge?.from_id || !edge?.to_id || !edge?.type) continue;
          edgesByKey.set(`${edge.from_id}|${edge.to_id}|${edge.type}`, edge);
        }
        if (expanded?.evidence_packet) recallPackets.push(expanded.evidence_packet);
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

  // Connector reads use the same AgentScope-style toolkit as writes. The
  // selected group's read-only schemas drive a bounded tool loop, allowing
  // search -> read follow-ups without provider/tool-name switch statements.
  const selectedLiveGroups = Array.isArray(plan.tool_groups) ? plan.tool_groups : [];
  if (plan.operation === 'connector_read' && selectedLiveGroups.length > 0 && ctx._readToolkit) {
    try {
      const readResult = await beforeDeadline(runToolkitReadLoop({
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
        liveItems.push({
          source: selectedLiveGroups.join(','),
          title: 'live connector result',
          snippet: readResult.text.slice(0, 4000),
        });
      }
    } catch (err) {
      recordTool('connector_read_loop', { groups: selectedLiveGroups }, `error: ${err.message}`, null);
    }
  }

  // (d) Web — only when planner explicitly flagged needs_web AND we got
  // <2 memories. Saves credits + keeps HIVEMIND-first behaviour.
  let webJob = null;
  if (plan.needs_web && memoriesById.size < 2 && plan.sub_queries.length > 0) {
    try {
      const args = { query: plan.sub_queries[0], limit: 5 };
      const r = await dispatchTool('hivemind_web_search', args, ctx);
      webJob = r;
      recordTool('hivemind_web_search', args, r?.job_id ? `job ${(r.job_id || '').slice(0, 8)}` : 'submitted', r);
    } catch (err) {
      recordTool('hivemind_web_search', { query: plan.sub_queries[0] }, `error: ${err.message}`, null);
    }
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
    aggregate: aggregateResult,
    coverage: {
      ...coverage,
      ...(plan.requires_complete_coverage ? {
        aggregate_requested: true,
        aggregate_complete: aggregateResult?.coverage?.complete === true,
        complete: aggregateResult?.coverage?.complete === true,
        ...(aggregateResult?.coverage?.complete === true
          ? {}
          : { cutoff_reason: aggregateResult?.coverage?.reason || 'aggregate_coverage_incomplete' }),
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

You are ${name} — the internal voice of ${orgLabel}'s collective brain.

You will be given a user message + a numbered EVIDENCE block of memories
already retrieved for you. Compose the final answer using ONLY those
memories as ground truth. Today's date is ${new Date().toISOString().slice(0, 10)}.

OUTPUT — STRICT JSON (no prose, no code fence):
{
  "response":        "<final answer in ${lang}>",
  "claims":          [{"text":"<one user-visible claim>","grounded":true,"citation_ids":["P1-C1"]}],
  "evidence_used":   [<memory_id_short>, ...],   // first 8 chars of each id you actually relied on
  "confidence":      0.0,                          // [0,1] — how grounded the answer is in evidence
  "gaps":            ["..."]                       // what the user might want but the evidence didn't cover
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
11. **RELATIONS COME FROM EDGES BLOCK ONLY — NEVER INVENT.** When the
    user asks how memory X relates to memory Y, or what the connection
    between two people/projects/topics is, you must:
      (a) look up the GRAPH EDGES block above,
      (b) report ONLY edges that touch the relevant memory ids,
      (c) state edge type literally ("Updates", "Extends", "Mentions",
          "Derives", "Contradicts") with the confidence shown,
      (d) if NO edge in the EDGES block connects the two memories,
          answer "no recorded relation in the graph between these
          memories" — do NOT infer a relation from shared entities,
          co-occurring tags, or topic overlap. Co-mention in content
          is NOT a relation.
    The GRAPH EDGES block reflects what the cognition loop and
    smart-ingest actually wrote into the Relationship table; everything
    else is content co-occurrence, which is suggestive but not a
    relation. Misreporting this is the #1 source of hallucinated
    history. When in doubt, default to the literal absence of the edge.
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
    for (const citation of (packet?.citations || [])) {
      if (!citation?.id) continue;
      const citationId = `P${packetIndex + 1}-${citation.id}`;
      if (!usedIds.has(citationId) || seen.has(citationId)) continue;
      seen.add(citationId);
      const section = sectionsById.get(citation.segment_id) || {};
      sources.push({
        id: citation.segment_id || citationId,
        citation_id: citationId,
        segment_id: citation.segment_id || null,
        document_id: citation.document_id || section.document_id || null,
        title: citation.title || citation.source_label || section.document_title || 'Workspace source',
        snippet: section.snippet || section.content || citation.snippet || '',
        page: citation.page ?? section.page ?? null,
        source_type: citation.source_type || 'document_evidence',
        score: Number.isFinite(section.score) ? section.score : null,
      });
    }
  }
  return sources;
}

export function validateChatAnswer(payload, recallPackets = [], { allowGeneralKnowledge = false } = {}) {
  return validateGroundedClaims(
    payload,
    buildChatCitationPacket(recallPackets),
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
      en: `I found ${context || 'some related context'} — but nothing that directly answers your question. Share the document, decision, or message behind it and I'll connect it with what I already know.`,
    };
    return responses[lang] || responses.en;
  }

  const topic = String(message || '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 80);
  const responses = {
    de: `Dazu habe ich noch nichts in meinem Gedaechtnis — "${topic}" taucht bisher in keiner Quelle auf. Lade ein Dokument hoch oder erzaehl mir kurz davon, dann merke ich es mir und kann beim naechsten Mal antworten.`,
    fr: `Je n'ai encore rien en memoire a ce sujet — "${topic}" n'apparait dans aucune source pour l'instant. Importe un document ou raconte-le-moi, je m'en souviendrai la prochaine fois.`,
    es: `Todavia no tengo nada en mi memoria sobre eso — "${topic}" no aparece en ninguna fuente. Sube un documento o cuentamelo y lo recordare para la proxima vez.`,
    en: `I don't have anything in my memory about that yet — "${topic}" doesn't appear in any source so far. Upload a document or just tell me about it, and I'll remember it for next time.`,
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

export async function answerStep({ message, history, evidence, plan, language, assistantName, orgName, model, apiKey, signal, ctx, allowGeneralKnowledge = false }) {
  const sys = answerPrompt({ language, assistantName, orgName });
  if (plan.requires_complete_coverage && evidence.coverage?.aggregate_complete === true
      && Number.isInteger(evidence.aggregate?.count)) {
    const count = evidence.aggregate.count;
    const kind = evidence.aggregate.entity_kind || plan.aggregate?.kind || 'entities';
    const parent = evidence.aggregate.parent || plan.aggregate?.parent || '';
    const lang = String(language || 'en').slice(0, 2).toLowerCase();
    const responses = {
      de: `Das kanonische Register enthält ${count} für ${parent} als ${kind} klassifizierte Einträge.`,
      fr: `Le registre canonique contient ${count} entités associées à ${parent} classées comme ${kind}.`,
      es: `El registro canónico contiene ${count} entidades asociadas a ${parent} clasificadas como ${kind}.`,
      en: `The canonical registry contains ${count} entities associated with ${parent} classified as ${kind}${count === 1 ? '' : 's'}.`,
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
  const evidenceTopK = _eventWindowHits > 0
    ? _eventWindowHits
    : (recallMode === 'insight' ? 10 : (recallMode === 'panorama' ? 12 : 6));
  const evidenceLines = evidence.memories.slice(0, evidenceTopK).map((m, i) => {
    const id8 = (m.id || '').slice(0, 8);
    const title = (m.title || '').replace(/\n/g, ' ').slice(0, 80);
    const content = (m.content || '').replace(/\n/g, ' ').slice(0, 240);
    const tags = (m.tags || []).slice(0, 3).join(', ');
    // Synthesis detection: source_metadata.source_type OR tag fallback (FTS path).
    const srcType = m.source_metadata?.source_type || null;
    const memTags = m.tags || [];
    const isCanonical = srcType === 'canonical-fact' || memTags.includes('synthesis:canonical');
    const isBridge    = srcType === 'synthesis-bridge' || memTags.includes('synthesis:bridge');
    const synthTag = isCanonical ? '[SYNTH/CANONICAL] ' : isBridge ? '[SYNTH/BRIDGE] ' : '';
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
    return `${synthTag}[${id8}]${conf}${rev}${xClusterBoost} (${date}·${src}) "${title}" — ${content}${tags ? ' :: ' + tags : ''}`;
  }).join('\n');

  // Live Workspace block — Gmail / Drive / Calendar fetched in this turn.
  // Fresher than memory snapshots; agent should cite these when the user asks
  // about recent emails, meetings, or docs.
  const liveLines = (evidence.live || []).slice(0, 10).map((li) => {
    const src = (li.source || '?').toUpperCase();
    const date = li.date ? ` (${String(li.date).slice(0, 19)})` : '';
    const from = li.from ? ` from ${li.from}` : '';
    const title = (li.title || '').replace(/\n/g, ' ').slice(0, 100);
    const body = (li.snippet || '').replace(/\n/g, ' ').slice(0, 320);
    return `[LIVE/${src}]${date}${from} "${title}" — ${body}`;
  }).join('\n');

  // Doc segments that weren't promoted to memories — pulled from the
  // knowledge_segment evidence collection. Lets the agent ground on full
  // pitch decks / catalogs even when only 5-20 chunks made it into the
  // canonical memory layer.
  const evLines = (evidence.evidence || []).slice(0, 8).map((e) => {
    const doc = (e.document_title || 'unknown.pdf').replace(/\n/g, ' ').slice(0, 80);
    const page = e.page ? ` p.${e.page}` : '';
    // Evidence retrieval produces a query-centred snippet. Prefer it over the
    // start of a long source segment so exact policy questions retain the
    // matching sentence in the bounded answer prompt.
    const body = (e.snippet || e.content || '').replace(/\n/g, ' ').slice(0, 520);
    return `[DOC/${doc}${page}] ${body}`;
  }).join('\n');

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
  const idToTitle = new Map(evidence.memories.map(m => [m.id, (m.title || '').slice(0, 50)]));
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

  // SYNTHESIS CHAINS block — insight-mode recall returns curated
  // synthesis-tier memories + their evidence chain (top-4 source rows
  // each). Renders the claim + sources together so the LLM can cite the
  // synthesis with provenance in one answer.
  const chainLines = (evidence.synthesis_chains || []).slice(0, 5).map((c) => {
    const head = `[${(c.synthesis_id || '').slice(0, 8)}] (conf=${c.synthesis_confidence ?? '?'} rev=${c.synthesis_revision ?? '?'}) ${c.synthesis_title || ''}`;
    const evRows = (c.evidence || []).slice(0, 4).map(e =>
      `      ▸ [${(e.id || '').slice(0, 8)}] ${(e.title || '').slice(0, 60)} — ${(e.content || '').replace(/\n/g, ' ').slice(0, 180)}`
    ).join('\n');
    return `  ▶ ${head}\n${evRows}`;
  }).join('\n');

  const citationPacket = buildChatCitationPacket(evidence.recall_packets || []);
  const citationLines = citationPacket.citations.map((citation) =>
    `[${citation.id}] ${citation.source_label || citation.title || 'Workspace source'}${citation.page ? ` p.${citation.page}` : ''}`,
  ).join('\n');

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
  let personaNote = '';
  try {
    const { routePersona, isPersonaRouterEnabled } = await import('../memory/persona-router.js');
    if (isPersonaRouterEnabled()) {
      const { ProfileStore } = await import('../memory/profile-store.js');
      const ps = ctx?.prisma ? new ProfileStore(ctx.prisma) : null;
      const pr = await routePersona({ query: message, userId: ctx?.userId, orgId: ctx?.orgId, projectId: ctx?.projectId || null, profileStore: ps });
      if (pr.routed && pr.context) {
        personaNote = `\n\nUSER PERSONA (who you're talking to — use for personalization; never contradict; never invent beyond it):\n${pr.context}`;
      }
    }
  } catch (err) { console.warn('[agent] persona route failed (non-fatal):', err.message); }

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
    const deliveredText = [...evidence.memories.slice(0, evidenceTopK), ...(evidence.evidence || []).slice(0, 8)]
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

  const sourceFirst = evidence.coverage?.source_requested === true;
  const groundedEvidence = sourceFirst
    ? `${evLines ? `DOCUMENT SEGMENTS (${(evidence.evidence || []).length} exact-source passages):\n${evLines}\n\n` : ''}MEMORIES:\n${evidenceLines || '(none)'}`
    : `MEMORIES:\n${evidenceLines || '(none)'}${evLines ? `\n\nDOCUMENT SEGMENTS (${(evidence.evidence || []).length} non-promoted KB chunks):\n${evLines}` : ''}`;
  const userBlock = `EVIDENCE (${Math.min(evidence.memories.length, evidenceTopK)} of ${evidence.memories.length} memories):
${groundedEvidence}${citationLines ? `\n\nCITATION REGISTRY (server-owned IDs; claims may cite only these):\n${citationLines}` : ''}${chainLines ? `\n\nSYNTHESIS CHAINS (${(evidence.synthesis_chains || []).length} curated claims + sources — cite the claim, support with the evidence rows):\n${chainLines}` : ''}${edgeLines ? `\n\nGRAPH EDGES (${filteredEdges.length} typed relationships between the memories above — ONLY trust these for verified relation claims):\n${edgeLines}` : ''}${coMentionLines ? `\n\nCO-MENTIONS (${(evidence.co_mentions || []).length} shared-source paths — report as unverified co-mentions, never as typed relationships):\n${coMentionLines}` : ''}${liveLines ? `\n\nLIVE WORKSPACE (${(evidence.live || []).length} fresh items — Gmail / Drive / Calendar):\n${liveLines}` : ''}${capabilityHint}${windowNote}${personaNote}${coverageNote}

PLANNER INTENT: ${(plan.intents || []).join(' / ') || '(unspecified)'}

USER MESSAGE:
${message}`;

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
  const answerCap = process.env.HIVEMIND_ANSWER_MAX_TOKENS
    ? ANSWER_MAX_TOKENS
    : (answerMode === 'full' ? 8000 : answerMode === 'explain' ? 4000 : 2000);

  const { parsed, usage } = await callJsonLLM({
    messages: [{ role: 'system', content: sys }, ...tail, { role: 'user', content: userBlock }],
    model, apiKey, maxTokens: answerCap, signal,
  });

  let response = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  let answerPayload = parsed;
  let validated = validateChatAnswer({
    answer: response,
    claims: parsed.claims,
  }, evidence.recall_packets || [], { allowGeneralKnowledge });

  // The validator remains fail-closed. If the model ignored the citation
  // contract despite a non-empty packet, give it one bounded repair pass over
  // the same final context instead of discarding useful tenant evidence.
  let repairUsage = null;
  if (!validated.claims.length && hasGroundedPacketEvidence(evidence)) {
    const repairInstruction = `${sys}\n\nREPAIR PASS: The prior draft did not satisfy the citation contract. Use the same final evidence only. Return the strongest concise synthesis that the evidence supports, then name the specific part of the user's question that remains uncovered. Every sentence must be a grounded claim with one or more IDs from the CITATION REGISTRY. Do not output a blanket absence response while any cited evidence exists.`;
    const repaired = await callJsonLLM({
      messages: [{ role: 'system', content: repairInstruction }, ...tail, { role: 'user', content: userBlock }],
      model, apiKey, maxTokens: answerCap, signal,
    });
    repairUsage = repaired.usage;
    answerPayload = repaired.parsed;
    response = typeof repaired.parsed.response === 'string' ? repaired.parsed.response.trim() : '';
    validated = validateChatAnswer({
      answer: response,
      claims: repaired.parsed.claims,
    }, evidence.recall_packets || [], { allowGeneralKnowledge });
  }

  if (!validated.claims.length) {
    return {
      response: unavailableEvidenceResponse({ message, evidence, language }),
      claims: [],
      rejected_claims: validated.rejected_claims,
      grounded: false,
      evidence_used: [],
      confidence: 0,
      gaps: ['No citation-valid claim could be produced from the final recall packet.'],
      usage: repairUsage || usage,
    };
  }

  return {
    response: validated.answer,
    claims: validated.claims,
    rejected_claims: validated.rejected_claims,
    grounded: validated.grounded,
    evidence_used: Array.isArray(answerPayload.evidence_used) ? answerPayload.evidence_used : [],
    confidence:    Number.isFinite(answerPayload.confidence) ? Math.max(0, Math.min(1, answerPayload.confidence)) : 0.5,
    gaps:          Array.isArray(answerPayload.gaps) ? answerPayload.gaps : [],
    usage: repairUsage || usage,
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
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
      const name = call.function?.name;
      onEvent?.({ type: 'tool_started', name, tool_call_id: call.id, arguments: args });
      const toolResult = await toolkit.execute(name, args, ctx);
      const text = String(toolResult.content?.[0]?.text || '').slice(0, 8000);
      steps.push({ tool: name, args, result_summary: text.slice(0, 240), raw: toolResult.meta?.raw || null });
      if (text) resultTexts.push(text);
      onEvent?.({ type: 'tool_completed', name, tool_call_id: call.id, status: toolResult.status, summary: text.slice(0, 240) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: text });
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
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        onEvent?.({ type: 'tool_call', name: toolName, arguments: tc.function?.arguments || '{}' });
        let toolResp;
        try {
          toolResp = await toolkit.execute(toolName, toolArgs, ctx);
        } catch (err) {
          toolResp = { content: [{ type: 'text', text: `error: ${err.message}` }], status: 'error' };
        }
        const text = toolResp.content?.[0]?.text || '';
        onEvent?.({ type: 'tool_result', name: toolName, summary: text.slice(0, 140) });
        steps.push({ tool: toolName, args: toolArgs, result_summary: text.slice(0, 200) });
        // Capture a deferred-save project choice so the chat UI can render
        // project buttons (Org + each) instead of free-text asking.
        if (toolName === 'hivemind_save_memory') {
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.needs_project_choice) {
              projectChoice = { projects: parsed.projects || [], draft: parsed.draft || null };
            }
          } catch { /* result not JSON — ignore */ }
        }
        if (toolResp.status === 'draft_created' && toolResp.meta?.draft_id) {
          draftIds.push(toolResp.meta.draft_id);
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
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
      ...(plan.save_intent.memory_type ? { memory_type: plan.save_intent.memory_type } : {}),
      ...(plan.save_intent.entities?.length ? { entities: plan.save_intent.entities } : {}),
      ...(plan.save_intent.event_time ? { event_time: plan.save_intent.event_time } : {}),
      _source_id: ctx._trace?.traceId || null,
      _original_content: message,
      ...(ctx.projectId
        ? { project_id: ctx.projectId, scope: 'project' }
        : {}),
    };
    try {
      const r = await dispatchTool('hivemind_save_memory', args, ctx);
      if (r?.needs_project_choice) {
        return { tool: 'hivemind_save_memory', args, result_summary: 'needs project choice',
          project_choice: { projects: r.projects || [], draft: r.draft || null } };
      }
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify(args) });
      const summary = r?.error ? `error: ${r.error}` : (r?.id ? `saved ${(r.id || '').slice(0, 8)}` : 'saved');
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
      ...(as.entities?.length ? { entities: as.entities } : {}),
      ...(as.event_time ? { event_time: as.event_time } : {}),
      _source_id: ctx._trace?.traceId || null,
      _original_content: message,
      ...(ctx.projectId ? { project_id: ctx.projectId, scope: 'project' } : {}),
    };
    try {
      const r = await dispatchTool('hivemind_save_memory', args, ctx);
      if (r?.needs_project_choice) {
        return { tool: 'hivemind_save_memory', args, result_summary: 'needs project choice',
          project_choice: { projects: r.projects || [], draft: r.draft || null } };
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
    en: { saved: 'Saved to HIVEMIND.', updated: 'Memory updated.', needs_project_choice: 'Choose where this memory belongs.' },
    de: { saved: 'In HIVEMIND gespeichert.', updated: 'Erinnerung aktualisiert.', needs_project_choice: 'Wählen Sie aus, wohin diese Erinnerung gehört.' },
    fr: { saved: 'Enregistré dans HIVEMIND.', updated: 'Mémoire mise à jour.', needs_project_choice: 'Choisissez où enregistrer cette mémoire.' },
    es: { saved: 'Guardado en HIVEMIND.', updated: 'Memoria actualizada.', needs_project_choice: 'Elige dónde guardar esta memoria.' },
    hi: { saved: 'HIVEMIND में सहेजा गया।', updated: 'मेमोरी अपडेट की गई।', needs_project_choice: 'चुनें कि यह मेमोरी कहाँ सहेजी जाए।' },
    ar: { saved: 'تم الحفظ في HIVEMIND.', updated: 'تم تحديث الذاكرة.', needs_project_choice: 'اختر مكان حفظ هذه الذاكرة.' },
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

// ── Public entry — same signature as v1 ────────────────────────────────

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
  router: _deprecatedRouter,
  recallMode,
  recallSource,
  recallTime,
  allowGeneralKnowledge = false,
}) {
  if (!apiKey && !process.env.OPENROUTER_API_KEY && !process.env.CEREBRAS_API_KEY) {
    throw new Error('chat provider API key required');
  }
  if (!message) throw new Error('message required');
  const abortCtrl = new AbortController();
  const answerModel = resolveAnswerModel(model);
  const budgetTimer = setTimeout(() => abortCtrl.abort(), TURN_BUDGET_MS);
  const usages = [];
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
    models: {
      planner: INTENT_MODEL,
      synthesis: answerModel,
    },
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
    const intentParsed = await parseChatIntent({
      message, history, language,
      groupCatalog,
      projectCatalog,
      model: INTENT_MODEL,
      apiKey,
      signal: abortCtrl.signal,
    });
    _pt('intent_parse_ms', _ps);
    const intentDecision = intentParsed.decision;
    if (intentParsed.usage) usages.push(intentParsed.usage);
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
      side_effect_policy: intentDecision.side_effect_policy,
    };
    const hasBrowserContext = /<METADATA:(SELECTION|SECTION|BROWSER_CONTEXT)>/i.test(message || '');

    // The required structured intent call is the plan. This removes the old
    // quick-gate, JSON planner, tool-router switch, and phrase rescue stack.
    let plan = intentDecisionToPlan(intentDecision, message);
    if (hasBrowserContext && !plan.sub_queries.length && plan.operation !== 'direct') {
      plan.sub_queries = [message];
    }
    plan = applyExplicitRecallControls(plan, {
      mode: recallMode,
      source: recallSource,
      time: recallTime || intentDecision.relation?.time || intentDecision.time,
    });

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

    // The planner classifies direct turns, but user-facing prose always comes
    // from the synthesis model so every chat surface follows one model policy.
    if (intentDecision.operation === 'direct' && plan._direct_answer) {
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model: answerModel, apiKey, signal: abortCtrl.signal,
        plannerDraft: plan._direct_answer,
      });
      if (usage) usages.push(usage);
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
    }[intentDecision.operation];
    if (mutationTool) {
      const [toolName, toolArgs] = mutationTool;
      onEvent?.({ type: 'tool_started', name: toolName, arguments: toolArgs });
      const result = await dispatchTool(toolName, toolArgs, ctx);
      const succeeded = !result?.error && result?.updated !== false && result?.deleted !== false;
      onEvent?.({ type: 'tool_completed', name: toolName, status: succeeded ? 'ok' : 'error', result });
      const response = succeeded
        ? (intentDecision.operation === 'update'
            ? mutationConfirmation('updated', intentDecision.response_language || language, result)
            : intentDecision.acknowledgement)
        : `${intentDecision.failure_response || 'Memory update failed.'} (${result?.error || 'operation_failed'})`;
      onEvent?.({ type: 'finish', text: response });
      onEvent?.({ type: 'turn_completed', grounded: false, operation: intentDecision.operation, success: succeeded });
      return {
        response, sources: [], steps: [{ tool: toolName, args: toolArgs, result_summary: succeeded ? 'completed' : String(result?.error || 'failed') }],
        evidence_used: [], confidence: succeeded ? 1 : 0, gaps: succeeded ? [] : [String(result?.error || 'operation_failed')],
        usage: sumUsage(usages), trace: finalizeTrace(trace, usages), assistant_name: plan.assistant_name_intent || assistantName || null,
        action_result: succeeded && intentDecision.operation === 'update' ? buildActionResult('updated', result) : null,
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
    if (plan.sub_queries.length === 0 && !plan.save_intent && !plan.needs_web) {
      // No-recall direct answer uses the model selected by the caller.
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model: answerModel, apiKey, signal: abortCtrl.signal,
      });
      if (usage) usages.push(usage);
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

    // STEP 3 — Evidence
    onEvent?.({
      type: 'retrieval_planned',
      operation: intentDecision.operation,
      mode: plan.recall_mode,
      source: plan.source || null,
      aggregate: plan.aggregate || null,
    });
    _ps = Date.now();
    const evidence = await gatherEvidence({
      plan,
      ctx,
      onEvent,
      // Retrieval owns its own absolute budget. Planning latency must never
      // consume the evidence window.
      deadlineAt: Date.now() + RETRIEVAL_BUDGET_MS,
    });
    _pt('gather_evidence_ms', _ps);
    steps.push(...evidence.steps);
    trace.recall = {
      coverage: evidence.coverage,
      escalation_count: evidence.escalation_count,
    };
    onEvent?.({ type: 'coverage_assessed', coverage: evidence.coverage });

    // STEP 4 — Answer with the caller-selected user-facing model.
    _ps = Date.now();
    let answer = await answerStep({
      message, history, evidence, plan, language, assistantName, orgName,
      model: answerModel, apiKey, signal: abortCtrl.signal, ctx, allowGeneralKnowledge,
    });
    _pt('answer_step_ms', _ps);
    if (answer.usage) usages.push(answer.usage);
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
    onEvent?.({ type: 'finish', text: finalResponse });
    onEvent?.({ type: 'turn_completed', grounded: answer.grounded, confidence: answer.confidence });

    const citationPackets = answer.aggregate_citation_packet
      ? [...(evidence.recall_packets || []), answer.aggregate_citation_packet]
      : (evidence.recall_packets || []);
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
    const publicSources = evidence.coverage?.source_requested
      ? citationSources
      : [...citationSources, ...memorySources].slice(0, 10);

    return {
      project_choice: recallProjectChoice,
      // When a save was deferred for project choice, don't claim it was saved —
      // prompt the user to pick (the FE renders project buttons below).
      response: finalResponse,
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
      gaps:          answer.gaps,
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
  trace.ended_at = new Date().toISOString();
  trace.total_ms = new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime();
  return trace;
}

// Re-export TOOL_SCHEMAS so callers stay agnostic of which agent runs.
export { TOOL_SCHEMAS };
