/**
 * Talk-to-HIVE — Plan-then-Act agent (v2).
 *
 * Replaces the prompt-rule-heavy v1 ReAct loop with a structured 4-step
 * pipeline. Each step is a single LLM call with a JSON-schema'd output,
 * so behaviour is auditable and deterministic.
 *
 *   1. quick_gate   → cheap rule check: greeting / smalltalk / math /
 *                     self-Q → answer directly, skip planning.
 *   2. plan_step    → LLM emits {direct_answer, sub_queries[],
 *                     needs_traverse, needs_time_travel, needs_web,
 *                     intents[]}. No prose, structured JSON.
 *   3. evidence_step → orchestrator runs sub_queries in parallel via
 *                     dispatchTool(hivemind_recall) / hivemind_at /
 *                     hivemind_web_search. No LLM. Accumulates memories,
 *                     dedups, normalises.
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

// Retry router: transient failures (TIMEOUT/RATE_LIMIT) get ONE auto-retry
// with exponential backoff. AUTH_ERROR / INVALID_ARGS / UNKNOWN_TOOL pass
// through immediately — those are not transient.
const RETRYABLE_FAILURES = new Set(['TIMEOUT', 'RATE_LIMIT']);

async function dispatchTool(name, args, ctx, opts = {}) {
  const t0 = Date.now();
  const first = await _dispatchTool(name, args, ctx, opts);
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
  const second = await _dispatchTool(name, args, ctx, opts);
  if (second && !second.error) second._retried_after = first._failure_mode;
  logCall(second, first._failure_mode);
  return second;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// LLM budgets per step. gpt-oss reasoning models consume hidden
// reasoning_tokens before content tokens; budgets are sized so even
// chatty reasoning leaves room for the actual JSON output.
// Caps raised per user directive — internal steps and final answer
// both run on gpt-oss family; cost is acceptable, quality wins.
const PLAN_MAX_TOKENS    = Number(process.env.HIVEMIND_PLAN_MAX_TOKENS    || 4000);
const REFLECT_MAX_TOKENS = Number(process.env.HIVEMIND_REFLECT_MAX_TOKENS || 3000);
const ANSWER_MAX_TOKENS  = Number(process.env.HIVEMIND_ANSWER_MAX_TOKENS  || 8000);
const DIRECT_MAX_TOKENS  = Number(process.env.HIVEMIND_DIRECT_MAX_TOKENS  || 2000);
const TURN_BUDGET_MS     = Number(process.env.HIVEMIND_AGENT_TURN_BUDGET_MS || 60_000);

// Model split (per user directive 2026-05-24):
//   • internal steps (planner, reflection, classification, sub-tools) use
//     a fast/cheap model — gpt-oss-20b — so deep multi-hop reasoning stays
//     responsive.
//   • final user-facing answer uses gpt-oss-120b for top-quality natural
//     language synthesis.
// Both are env-overridable so we can A/B without code changes.
const INTERNAL_MODEL = process.env.HIVEMIND_AGENT_INTERNAL_MODEL || 'openai/gpt-oss-20b';
const FINAL_MODEL    = process.env.HIVEMIND_AGENT_FINAL_MODEL    || 'openai/gpt-oss-120b';

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

// ── Quick gates — cheap pattern match, no LLM ──────────────────────────

const GREETING_RE = /^\s*(hi|hello|hey|yo|hallo|guten\s*tag|bonjour|ciao|hola|namaste|namaskar|ola|olá|salam|salaam|shalom|merhaba|good\s*(morning|afternoon|evening|night))\b/i;
const SMALLTALK_RE = /^\s*(thanks|thank\s*you|thx|ok|okay|cool|nice|lol|got\s*it|sounds\s*good|np|no\s*problem|cheers|see\s*you|bye|good\s*night)\s*[!.?]*\s*$/i;
const SELF_Q_RE = /\b(who\s*are\s*you|what\s*can\s*you\s*do|what\s*('?s|\s+is)\s*(your|hivemind)|what\s*do\s*you\s*do|wer\s*bist\s*du|wie\s*hei[ßs]t\s*du|que\s+puedes\s+hacer|qui\s+es-tu)\b/i;

function quickGateClassify(message) {
  const t = (message || '').trim();
  if (!t) return null;
  if (GREETING_RE.test(t))  return 'greeting';
  if (SMALLTALK_RE.test(t)) return 'smalltalk';
  if (SELF_Q_RE.test(t))    return 'self_q';
  return null;
}

// ── Groq JSON helper ───────────────────────────────────────────────────

async function callJsonLLM({ messages, model, apiKey, maxTokens, temperature = 0.1, signal }) {
  const resp = await fetch(GROQ_URL, {
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
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text.slice(0, 400)}`);
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

async function answerDirectly({ message, gateKind, language, assistantName, orgName, model, apiKey, signal }) {
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
    general: `${LANG_BLOCK}\n\nYou are ${name}. Reply concisely. Plain text only. No JSON, no tool talk.`,
  };

  const resp = await fetch(GROQ_URL, {
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
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { response: text.trim(), usage: data.usage };
}

// ── STEP 2 — Plan ──────────────────────────────────────────────────────

function planPrompt({ language, assistantName, orgName, hasBrowserContext }) {
  const lang = languageName(language);
  const orgLabel = (!orgName || /^Local Org\b/i.test(orgName)) ? 'our HIVEMIND workspace' : orgName;
  return `You are a query planner for ${assistantName || 'HIVE'}, the memory-engine assistant for ${orgLabel}.

The user spoke in ${lang}. Decompose their request into recall sub-queries
the orchestrator will execute against HIVEMIND memory.

Today is ${new Date().toISOString().slice(0, 10)} (server clock). NEVER assume a year from your training data — use today's year for bare month/day phrases like "May 13". Date hallucination is the #1 cause of empty recall.

Output STRICT JSON (no prose, no code fence):
{
  "intent_kind": "lookup",        // REQUIRED. Single label picked by reading the user's message:
                                  //   'lookup'   — user wants info about something they already have/know
                                  //                (default for any question, any bare noun/name/filename,
                                  //                 any "tell me about X", any "what do you know about X")
                                  //   'save'     — explicit imperative to remember/log/store/note new info
                                  //                ("save this", "remember Y", "log decision Z", "store fact W")
                                  //   'update'   — user corrects or revises a prior fact
                                  //                ("actually it's X not Y", "no, the price changed to Z")
                                  //   'recap'    — user asks for a summary of history / sessions / period
                                  //                ("what did we do last week", "summarize my decisions")
                                  //   'greeting' — pure greeting / smalltalk / self-question (quick-gate normally handles)
                                  //   'general'  — public-knowledge / math / code question NOT about user's data
                                  //
                                  // STRICT RULE: a bare entity / filename / proper noun WITHOUT an explicit
                                  // imperative verb is ALWAYS 'lookup'. Never 'save' just because the user
                                  // dropped a filename — they want to RECALL it, not store it again.
  "intents": ["..."],            // 1-3 short phrases describing what the user actually wants
  "sub_queries": ["..."],        // 1-4 English recall queries, each focused on ONE entity/concept
  "named_entities": ["..."],     // proper nouns the user mentioned (people, projects, files, brands)
  "needs_traverse": false,        // true if recall should follow graph edges to find related memories
  "needs_time_travel": false,     // true ONLY for explicit temporal: "as of X", "before Y", "what changed between"
  "time_travel": { "transaction_time": null, "valid_time": null }, // ISO timestamps if needs_time_travel
  "needs_web": false,             // true ONLY if user explicitly asks for current external info NOT in HIVEMIND
  "action_intent": null,          // when user wants to PERFORM an action via a connector (not just recall),
                                  //   set this to one of: 'slack' | 'notion' | 'gmail' | 'github' | 'linear'.
                                  //   Triggers: 'post to slack', 'send a slack message', 'create notion page',
                                  //   'email X', 'open github issue', 'add linear task'. Even when phrased
                                  //   indirectly ('@channel let them know' → slack), the planner picks the
                                  //   right provider. Leave null for pure recall / read.
  "save_intent": null,            // ONLY when intent_kind === 'save'. {"title": "...", "content": "...", "tags": [...], "project_hint": "..."}. CONTENT MUST be a fully self-contained note — if the user used a pronoun ("save this", "save that"), resolve it by reading the previous turn in conversation history and copy the actual facts into content. NEVER emit save_intent with empty / pronoun-only content, NEVER emit content that is just the user's own message repeated verbatim, NEVER emit save_intent for a bare filename or entity-only message. If the referent is unrecoverable, set save_intent to null instead. If the user named a project ("save to Ashley", "in the SOLVIS project"), put that name in project_hint so the server can resolve it to a project_id.
  "ask_for_project": false,       // true if the user asked to save but did NOT specify a project AND no active project is set in the session. Server will respond by asking which project before saving.
  "update_intent": null,          // ONLY when intent_kind === 'update'. {"target_hint": "...", "new_value": "..."} if user corrected a prior fact
  "expected_evidence_types": []  // hint: ["fact"], ["decision"], ["preference"], etc
}

Rules:
  - sub_queries MUST be in ENGLISH even if user wrote in another language.
    Memory is stored cross-lingual; English queries hit best.
  - **Cast a wide net**. Emit 3-4 sub_queries that vary in scope:
       1) the BROADEST entity-only query (just "Dipesh", just "Dachmarke")
       2) the entity + closest noun ("Dipesh pitch deck")
       3) any related side-topic ("pitch deck slides", "Dipesh next steps")
       4) optional filename-style query if the user mentioned a doc
    Narrow phrases like "Dipesh pitch deck decision" miss because they
    constrain on the rarest token. The broad entity query always recovers
    the long tail. Better to over-recall (de-duped server-side) than
    return zero.
  - When the user mentions a filename (anything with .pdf/.docx/.png/etc),
    INCLUDE the literal filename AS A SUB_QUERY verbatim — recall has a
    tag-based exact-match path that needs the literal string.
  - When the user mentions a CONNECTOR (slack, notion, gmail, github,
    linear, jira, confluence, drive, calendar, outlook), put that
    keyword in named_entities AND in at least one sub_query. The
    orchestrator auto-injects tag filters for these so recall doesn't
    drown in unrelated FTS hits. Example for "what slack msgs as of May":
    sub_queries: ["Slack messages", "Slack channel content"], named_entities: ["slack"].
  - When the user uses TEMPORAL language ("as of X", "before Y", "since",
    "on date", "yesterday", "last week", any explicit date/month/year),
    set needs_time_travel=true and put a real ISO timestamp in
    time_travel.valid_time using TODAY'S YEAR for bare month/day.
    "as of May 13" → time_travel.valid_time = "${new Date().getUTCFullYear()}-05-13T23:59:59Z".
    "before March 2025" → valid_time = "2025-03-01T00:00:00Z".
    The orchestrator validates and rejects dates that look hallucinated;
    if unsure, leave valid_time=null and the deterministic extractor
    will fill it.
  - For "what was X before Y" / pronoun anaphora — resolve antecedent
    using the user's literal entity name in sub_queries.
  - Empty sub_queries = direct answer with no recall (greetings,
    math, public-knowledge explainers). Quick-gate already caught
    most of these but you may still emit [] here.
  - For save / update intents: still emit recall sub_queries so the
    save can verify there isn't a duplicate.
${hasBrowserContext ? '  - User pinned a browser selection. Treat distinctive nouns/names inside <METADATA:...> as sub_queries.\n' : ''}`;
}

async function planStep({ message, history, language, assistantName, orgName, hasBrowserContext, model, apiKey, signal, onEvent }) {
  onEvent?.({ type: 'plan_start' });
  const sys = planPrompt({ language, assistantName, orgName, hasBrowserContext });
  const tail = (history || []).slice(-4)
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }));
  const { parsed, usage } = await callJsonLLM({
    messages: [{ role: 'system', content: sys }, ...tail, { role: 'user', content: message }],
    model, apiKey, maxTokens: PLAN_MAX_TOKENS, signal,
  });
  // Defensive defaults + intent_kind invariant enforcement.
  const VALID_INTENT_KINDS = ['lookup', 'save', 'update', 'recap', 'greeting', 'general'];
  let intent_kind = typeof parsed.intent_kind === 'string' ? parsed.intent_kind.toLowerCase() : 'lookup';
  if (!VALID_INTENT_KINDS.includes(intent_kind)) intent_kind = 'lookup';

  // Invariant: save_intent / update_intent only valid when intent_kind matches.
  // Prevents planner from emitting save_intent on a bare-filename lookup
  // (e.g. user types "Branding Skizze1 (11).png" → must be lookup, never save).
  const save_intent   = intent_kind === 'save'   ? (parsed.save_intent   || null) : null;
  const update_intent = intent_kind === 'update' ? (parsed.update_intent || null) : null;

  // Defensive: reject planner-emitted dates whose year is >18 months
  // older than today's year. Planner LLMs routinely default to 2024 from
  // training data, returning empty recall on queries about current data.
  // Deterministic extractor downstream will fill from server clock.
  const sanitizeTimeTravel = (tt) => {
    if (!tt) return null;
    const nowYear = new Date().getUTCFullYear();
    const guard = (iso) => {
      if (!iso) return null;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      // Allow dates from (nowYear - 18 months) to (nowYear + 1)
      const minYear = nowYear - 2;
      const maxYear = nowYear + 1;
      const y = d.getUTCFullYear();
      if (y < minYear || y > maxYear) return null;
      return d.toISOString();
    };
    return {
      valid_time: guard(tt.valid_time),
      transaction_time: guard(tt.transaction_time),
    };
  };

  const VALID_ACTION_PROVIDERS = ['slack', 'notion', 'gmail', 'github', 'linear'];
  const rawActionIntent = typeof parsed.action_intent === 'string' ? parsed.action_intent.toLowerCase() : null;
  const action_intent = VALID_ACTION_PROVIDERS.includes(rawActionIntent) ? rawActionIntent : null;

  const plan = {
    intent_kind,
    user_message:          message,
    action_intent,
    intents:               Array.isArray(parsed.intents) ? parsed.intents.slice(0, 4) : [],
    sub_queries:           Array.isArray(parsed.sub_queries) ? parsed.sub_queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 4) : [],
    named_entities:        Array.isArray(parsed.named_entities) ? parsed.named_entities.slice(0, 6) : [],
    needs_traverse:        !!parsed.needs_traverse,
    needs_time_travel:     !!parsed.needs_time_travel,
    time_travel:           sanitizeTimeTravel(parsed.time_travel),
    needs_web:             !!parsed.needs_web,
    save_intent,
    ask_for_project:       intent_kind === 'save' ? !!parsed.ask_for_project : false,
    update_intent,
    expected_evidence_types: Array.isArray(parsed.expected_evidence_types) ? parsed.expected_evidence_types : [],
  };
  onEvent?.({ type: 'plan_done', plan });
  return { plan, usage };
}

// ── STEP 3 — Evidence gather (no LLM) ──────────────────────────────────

async function gatherEvidence({ plan, ctx, onEvent }) {
  const steps = [];
  const memoriesById = new Map();
  const liveItems = [];
  const evidenceItems = [];

  const recordTool = (tool, args, summary, payload) => {
    steps.push({ tool, args, result_summary: summary });
    onEvent?.({ type: 'tool_call', name: tool, arguments: JSON.stringify(args) });
    onEvent?.({ type: 'tool_result', name: tool, summary });
    return payload;
  };

  // Deterministic temporal+connector extraction from user's FULL message.
  // Sub_queries are short bag-of-keywords ("slack messages") and lose the
  // 'as of May 13' / 'slack' anchor. Re-attach them to each sub_query call
  // so hop1's tag-anchored + valid_at override always fires when the user
  // clearly asked for time-travel or connector-scoped recall.
  const ul = String(plan.user_message || '').toLowerCase();
  const CONNECTORS = ['slack', 'notion', 'gmail', 'github', 'linear', 'jira', 'confluence'];
  const userConnector = CONNECTORS.find(k => ul.includes(k));
  // Deterministic date extraction takes PRIORITY over planner LLM —
  // planner routinely hallucinates the year (defaults to 2024) when the
  // user says "May 13" without a year. We use server's current year so
  // bare month/day phrases resolve to the right calendar year.
  let derivedValidAt = null;
  if (/\b(as of|before|prior to|on|in|by|until)\b/.test(ul) || /\d{4}-\d{1,2}-\d{1,2}/.test(ul)) {
    const MONTH = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11, january:0, february:1, march:2, april:3, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
    const year = new Date().getUTCFullYear();
    let m = ul.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    let d = m ? new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 23,59,59)) : null;
    if (!d) {
      m = ul.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/);
      if (m && MONTH[m[1]] !== undefined) d = new Date(Date.UTC(+(m[3]||year), MONTH[m[1]], +m[2], 23,59,59));
    }
    if (d && !Number.isNaN(d.getTime())) derivedValidAt = d.toISOString();
  }
  // Fall back to planner's valid_time / transaction_time only when our
  // deterministic extractor found nothing.
  if (!derivedValidAt) {
    derivedValidAt = plan.time_travel?.valid_time || plan.time_travel?.transaction_time || null;
  }
  // Also overwrite plan.time_travel so the hivemind_at branch below
  // uses the corrected date (planner often hallucinated year=2024).
  if (derivedValidAt) {
    plan.needs_time_travel = true;
    plan.time_travel = { ...(plan.time_travel || {}), valid_time: derivedValidAt };
  }
  const recallExtras = {
    ...(userConnector ? { tags: [userConnector] } : {}),
    ...(derivedValidAt ? { valid_at: derivedValidAt } : {}),
  };

  // (a) Parallel recall on each sub_query
  if (plan.sub_queries.length > 0) {
    const recallResults = await Promise.all(
      plan.sub_queries.map(async (q) => {
        try {
          const r = await dispatchTool('hivemind_recall', { query: q, mode: 'quick', limit: 12, ...recallExtras }, ctx);
          const memCount = r?.memories?.length || 0;
          const liveCount = r?.live_count || 0;
          const evCount = r?.evidence_count || 0;
          const parts = [`${memCount} memories`];
          if (liveCount > 0) parts.push(`${liveCount} live`);
          if (evCount > 0) parts.push(`${evCount} evidence`);
          const summary = parts.join(' + ');
          recordTool('hivemind_recall', { query: q, ...recallExtras, mode: 'quick' }, summary, r);
          return r;
        } catch (err) {
          recordTool('hivemind_recall', { query: q }, `error: ${err.message}`, null);
          return null;
        }
      })
    );
    for (const r of recallResults) {
      for (const m of (r?.memories || [])) {
        if (!m?.id) continue;
        if (!memoriesById.has(m.id)) memoriesById.set(m.id, m);
      }
      for (const li of (r?.live || [])) {
        liveItems.push(li);
      }
      for (const ev of (r?.evidence || [])) {
        evidenceItems.push(ev);
      }
    }
  }

  // ─── Event-driven post-recall expansion ──────────────────────────────
  // Anthropic's "think between tool calls" guidance + the user's complaint
  // about hallucination boil down to: don't pre-decide tool sequence in
  // the planner. INSPECT what recall returned, then react.
  //
  // Triggers (all driven by hop1 output, no extra LLM):
  //   1. If any memory carries `slack`+`channel:*` tags and the question
  //      sounds temporal → fire hivemind_at on the latest slack memory's
  //      doc-date to anchor "as of now" / "latest".
  //   2. If any memory carries `entity:*` tags matching named_entities →
  //      auto-traverse_graph from the top such memory (depth 2).
  //   3. If filename anchor surfaced (filename:X tag on a memory but the
  //      caller didn't pass valid_at) → no time-travel, but traverse to
  //      find updates/derives chain.
  //   4. If hop1 returned ≤1 memory AND the query has a connector keyword
  //      → re-recall with looser filters (drop is_latest, widen tags).
  const allRecallMems = Array.from(memoriesById.values());
  const hasConnectorTagged = allRecallMems.some(m => (m.tags || []).some(t => CONNECTORS.includes(t)));
  const hasEntityTagged = allRecallMems.some(m => (m.tags || []).some(t => typeof t === 'string' && t.startsWith('entity:')));
  const TEMPORAL_HINT = /\b(latest|last|recent|today|yesterday|this week|now|currently|as of)\b/i;
  const isTemporalQuery = TEMPORAL_HINT.test(plan.user_message || '');

  // (b) Time-travel — planner-flagged OR auto-fire when temporal hint +
  // connector recall returned data.
  const wantTimeTravel =
    (plan.needs_time_travel && plan.time_travel && (plan.time_travel.transaction_time || plan.time_travel.valid_time))
    || (isTemporalQuery && hasConnectorTagged && !plan.time_travel?.valid_time);
  if (wantTimeTravel) {
    try {
      // Derive valid_time: planner first, else "now" (latest snapshot).
      const validTime = plan.time_travel?.valid_time
        || plan.time_travel?.transaction_time
        || new Date().toISOString();
      const connectorTag = userConnector || (allRecallMems
        .flatMap(m => m.tags || [])
        .find(t => CONNECTORS.includes(t)));
      const args = {
        valid_at: validTime,
        query: plan.sub_queries[0] || plan.user_message || 'recent',
        ...(connectorTag ? { tags: [connectorTag] } : {}),
      };
      const r = await dispatchTool('hivemind_at', args, ctx);
      recordTool('hivemind_at', args, `${(r?.memories?.length || 0)} historical memories`, r);
      for (const m of (r?.memories || [])) {
        if (m?.id && !memoriesById.has(m.id)) memoriesById.set(m.id, m);
      }
    } catch (err) {
      recordTool('hivemind_at', plan.time_travel || {}, `error: ${err.message}`, null);
    }
  }

  // (c) Graph traversal — fire whenever we got memories. Anthropic /
  // DeepMind 2026 pattern: always go one hop deeper because the related
  // memories often hold the answer the user actually wants (e.g. "X
  // decided to ship Y" only references X; the Y decision is the edge).
  const shouldTraverse = memoriesById.size > 0;
  if (shouldTraverse) {
    // Smarter seed selection. Build a ranked candidate list:
    //   1. Memories matching ANY named_entity in title/content/tags
    //   2. Memories with entity:* tags
    //   3. Top-fusion-score memory
    // Run traverse on UP TO 2 distinct seeds (covers ambiguous "X and Y"
    // queries where one seed alone misses the answer).
    const named = plan.named_entities.map(e => e.toLowerCase());
    const scoreSeed = (m) => {
      const hay = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
      let s = 0;
      for (const ent of named) {
        if (hay.includes(ent)) s += 3;
        if ((m.tags || []).some(t => typeof t === 'string' && t.toLowerCase().includes(ent))) s += 2;
      }
      if ((m.tags || []).some(t => typeof t === 'string' && t.startsWith('entity:'))) s += 1;
      return s;
    };
    const seeds = [...memoriesById.values()]
      .map(m => ({ m, s: scoreSeed(m) }))
      .sort((a, b) => b.s - a.s)
      .filter(x => x.s > 0 || memoriesById.size <= 4)
      .slice(0, 2)
      .map(x => x.m);
    if (seeds.length === 0 && memoriesById.size > 0) seeds.push([...memoriesById.values()][0]);
    const traversedIds = new Set();
    for (const seed of seeds) {
      if (!seed?.id || traversedIds.has(seed.id)) continue;
      traversedIds.add(seed.id);
      try {
        const args = { memory_id: seed.id, depth: 2, relationship: 'all' };
        const r = await dispatchTool('hivemind_traverse_graph', args, ctx);
        const found = r?.related || r?.memories || r?.nodes || [];
        recordTool('hivemind_traverse_graph', args, `seed=${seed.id.slice(0, 8)} → ${found.length} related`, r);
        for (const m of found.slice(0, 8)) {
          if (m?.id && !memoriesById.has(m.id)) memoriesById.set(m.id, m);
        }
      } catch (err) {
        recordTool('hivemind_traverse_graph', { seed: seed.id }, `error: ${err.message}`, null);
      }
    }
  }

  // (c2) Connector auto-fetch for read intents.
  // When user names a connector explicitly (notion/gmail) AND memory
  // recall returned <3 hits → activate the toolkit, run that connector's
  // primary search/list tool to back-fill live data. Slack handled via
  // memory-tap + recall already.
  // Per-connector read-intent dispatch. Triggers on:
  //   - User explicitly asks to READ/FETCH/GET from that connector
  //   - AND we have <3 cached memories OR query has 'latest/recent' cue
  const LIVE_READ_VERB_RE = /\b(read|fetch|get|pull|show|list)\b/i;
  const READ_CONNECTOR_TRIGGERS = {
    notion: { tool: 'notion-search', argMap: q => ({ query: q }) },
    slack: {
      tool: 'slack_read_channel',
      argMap: (q, mems) => {
        // Pull channel_id from a cached slack memory if present.
        const ch = mems
          .flatMap(m => (m.tags || []).filter(t => typeof t === 'string' && t.startsWith('slack-channel-id:')))
          .map(t => t.slice('slack-channel-id:'.length))[0];
        return { channel_id: ch || undefined, limit: 5 };
      },
      requires: (args) => !!args.channel_id,
    },
    gmail:  null, // gmail live recall already wired via persistent-retrieval live tier
  };
  const connectorTriggered = userConnector && READ_CONNECTOR_TRIGGERS[userConnector];
  const liveReadIntent = LIVE_READ_VERB_RE.test(plan.user_message || '');
  const lowRecall = memoriesById.size < 3;
  if (connectorTriggered && (lowRecall || (liveReadIntent && userConnector === 'slack')) && ctx.prisma && !plan.action_intent) {
    try {
      const { buildToolkitForUser } = await import('./toolkit-factory.js');
      const tk = await buildToolkitForUser({
        prisma: ctx.prisma, userId: ctx.userId, orgId: ctx.orgId, hivemindTools: [],
      });
      tk.resetEquippedTools([userConnector]);
      const cfg = connectorTriggered;
      const arg = cfg.argMap(plan.sub_queries[0] || plan.user_message || '', [...memoriesById.values()]);
      if (!cfg.requires || cfg.requires(arg)) {
        const resp = await tk.execute(cfg.tool, arg, {
          userId: ctx.userId, orgId: ctx.orgId, prisma: ctx.prisma,
          persistentMemoryEngine: ctx.persistentMemoryEngine,
        });
        const text = resp.content?.[0]?.text || '';
        recordTool(cfg.tool, arg, `${text.length}b live`, resp);
        if (text) {
          liveItems.push({
            source: userConnector,
            title: `live ${userConnector} result`,
            snippet: text.slice(0, 600),
          });
        }
      }
    } catch (err) {
      recordTool('connector_live_fallback', { provider: userConnector }, `error: ${err.message}`, null);
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
    steps,
    webJob,
  };
}

// ── STEP 4 — Reflect (decides if extra recall needed) ─────────────────

function reflectPrompt({ language }) {
  const lang = languageName(language);
  return `You are a recall reflector. The user's question was in ${lang}.

Given the user message + the memories already pulled, decide whether
ANOTHER recall pass would materially improve the answer.

Output STRICT JSON:
{
  "needs_more": false,           // true only if a 2nd pass would help
  "extra_queries": ["..."],      // up to 2 English recall queries
  "reason": "..."                 // one sentence justification
}

Heuristics for needs_more=true:
  - Evidence < 2 memories AND user asked about an entity / project /
    person you can name.
  - Memories returned don't cover all sub_queries the planner intended.
  - Pronoun anaphora unresolved (the message mentions "she/he/it/that"
    but no memory names the referent).

Default to false. Cheap to skip; expensive to call.`;
}

async function reflectStep({ message, plan, evidence, language, model, apiKey, signal }) {
  const sys = reflectPrompt({ language });
  const evidenceLines = evidence.memories.slice(0, 8).map((m, i) =>
    `  ${i + 1}. [${m.id?.slice(0, 8)}] ${(m.title || '').slice(0, 60)} — ${(m.content || '').slice(0, 120).replace(/\n/g, ' ')}`,
  ).join('\n') || '  (none)';

  const user = `User message: ${message}\n\nPlanner output: ${JSON.stringify(plan)}\n\nMemories pulled (${evidence.memories.length}):\n${evidenceLines}`;
  const { parsed, usage } = await callJsonLLM({
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    model, apiKey, maxTokens: REFLECT_MAX_TOKENS, signal,
  });
  return {
    needs_more:     !!parsed.needs_more,
    extra_queries:  Array.isArray(parsed.extra_queries) ? parsed.extra_queries.filter(q => typeof q === 'string').slice(0, 2) : [],
    reason:         typeof parsed.reason === 'string' ? parsed.reason : '',
    usage,
  };
}

// ── STEP 5 — Answer ────────────────────────────────────────────────────

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
2. **PARTIAL coverage = USE IT, don't bail.** If even ONE evidence
   row touches the user's question, build the answer around it. Quote
   memory titles inline. Only respond "I don't have notes on X" when
   the EVIDENCE / LIVE / DOC blocks are TRULY empty for that question.
   Saying "I don't have notes" while 10 relevant memories are listed
   above is a hard failure.
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
   without restating the saved content.
9. **NEVER deny write/post access.** When a user asks to send/post/draft
   a slack message (or any connector action), do NOT say "I don't have
   access" or "I can't send messages". The system DOES have write
   capability via the draft-approval gate — the agent's write-intent
   branch will create a draft for user approval. If the user's request
   is ambiguous about WHICH channel or recipient, ask a clarifying
   question instead of claiming inability.`;
}

async function answerStep({ message, history, evidence, plan, language, assistantName, orgName, model, apiKey, signal, ctx }) {
  const sys = answerPrompt({ language, assistantName, orgName });

  // Connector capability hint — built from active Nango connections so
  // the LLM knows write access exists + which channels/recipients are
  // resolvable. Prevents "I don't have access" hallucinations.
  let capabilityHint = '';
  if (ctx?.prisma?.nangoConnection) {
    try {
      const conns = await ctx.prisma.nangoConnection.findMany({
        where: { userId: ctx.userId, status: 'active' },
        select: { providerKey: true },
      });
      const providers = conns.map(c => c.providerKey);
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

  // Build EVIDENCE block (numbered, with short id)
  const evidenceLines = evidence.memories.slice(0, 12).map((m, i) => {
    const id8 = (m.id || '').slice(0, 8);
    const title = (m.title || '').replace(/\n/g, ' ').slice(0, 80);
    const content = (m.content || '').replace(/\n/g, ' ').slice(0, 240);
    const tags = (m.tags || []).slice(0, 3).join(', ');
    return `[${id8}] "${title}" — ${content}${tags ? ' :: ' + tags : ''}`;
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
    const body = (e.content || e.snippet || '').replace(/\n/g, ' ').slice(0, 320);
    return `[DOC/${doc}${page}] ${body}`;
  }).join('\n');

  const tail = (history || []).slice(-6)
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }));

  const userBlock = `EVIDENCE (${evidence.memories.length} memories):
${evidenceLines || '(none)'}${liveLines ? `\n\nLIVE WORKSPACE (${(evidence.live || []).length} fresh items — Gmail / Drive / Calendar):\n${liveLines}` : ''}${evLines ? `\n\nDOCUMENT SEGMENTS (${(evidence.evidence || []).length} non-promoted KB chunks — full source text):\n${evLines}` : ''}${capabilityHint}

PLANNER INTENT: ${(plan.intents || []).join(' / ') || '(unspecified)'}

USER MESSAGE:
${message}`;

  const { parsed, usage } = await callJsonLLM({
    messages: [{ role: 'system', content: sys }, ...tail, { role: 'user', content: userBlock }],
    model, apiKey, maxTokens: ANSWER_MAX_TOKENS, signal,
  });

  let response = typeof parsed.response === 'string' ? parsed.response.trim() : '';

  // Last-resort guard: if synthesis bailed ("I don't have...") but the
  // EVIDENCE block has memories tagged with a connector the user named,
  // re-ask the LLM once with an explicit nudge. Catches LLM stubbornness
  // when grounding rules are clear but the model gave up anyway.
  const bailedOut = /\b(i (don'?t|do not) have|no (record|records|memory|memories|notes) (of|about|on|for)|i can'?t find|nothing (in|about) (my )?memor)/i.test(response);
  if (bailedOut && evidence.memories.length > 0) {
    const ml = String(message).toLowerCase();
    const connectorMentioned = ['slack', 'notion', 'gmail', 'github', 'linear', 'jira', 'confluence']
      .find(k => ml.includes(k));
    if (connectorMentioned) {
      const hasConnectorTagged = evidence.memories.some(m =>
        (m.tags || []).some(t => t.toLowerCase() === connectorMentioned)
      );
      if (hasConnectorTagged) {
        try {
          const retry = await callJsonLLM({
            messages: [
              { role: 'system', content: sys },
              ...tail,
              { role: 'user', content: userBlock },
              { role: 'assistant', content: JSON.stringify(parsed) },
              {
                role: 'user',
                content: `Your previous reply bailed but the EVIDENCE block has ${connectorMentioned}-tagged memories. Re-read it and answer using those memories. Cite specific titles and dates. Same JSON shape.`,
              },
            ],
            model, apiKey, maxTokens: ANSWER_MAX_TOKENS, signal,
          });
          if (typeof retry.parsed?.response === 'string' && retry.parsed.response.trim()) {
            response = retry.parsed.response.trim();
            console.log(`[agent] retry recovered "${connectorMentioned}" answer (${evidence.memories.length} memories)`);
          }
        } catch (err) {
          console.warn('[agent] retry failed:', err.message);
        }
      }
    }
  }

  return {
    response,
    evidence_used: Array.isArray(parsed.evidence_used) ? parsed.evidence_used : [],
    confidence:    Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    gaps:          Array.isArray(parsed.gaps) ? parsed.gaps : [],
    usage,
  };
}

// ── Save / update side-effects (best-effort, async-fire-and-forget) ───

// Set of pronouns / placeholders that mean "the prior turn". Plain set
// lookup — no regex — so the rule is auditable and stable across locales.
const PRONOUN_PLACEHOLDERS = new Set([
  'this', 'that', 'it', 'these', 'those',
  'the above', 'the previous', 'the prior', 'the last one',
  'above', 'previous', 'prior', 'last one',
]);

// Imperative save-trigger phrases. When the user message IS one of these
// (or a confirmation), the save target is NOT the message itself — it's
// the prior conversation turn. Examples: "save it", "remember this",
// "ok save it", "yes please", "go ahead", "do it".
const SAVE_IMPERATIVE_PHRASES = new Set([
  'save it', 'save this', 'save that', 'save them', 'save these',
  'remember it', 'remember this', 'remember that', 'remember it please',
  'keep it', 'keep this', 'keep that', 'store it', 'store this',
  'note it', 'note this', 'note that', 'note it down', 'log it',
  'add to memory', 'add to hivemind', 'commit it', 'commit this',
  // Pure confirmations after the agent already proposed something
  'yes', 'yes please', 'yes go ahead', 'go ahead', 'do it',
  'sure', 'sure go ahead', 'ok', 'okay', 'confirmed', 'proceed',
]);

function _isPronounPlaceholder(s) {
  if (!s) return false;
  const norm = s.trim().replace(/[.!?,;:]+$/, '').toLowerCase();
  return PRONOUN_PLACEHOLDERS.has(norm);
}

// Returns true when the message is a bare imperative/confirmation that
// the save tool should NOT use as content. Strips "please", trailing
// punctuation. Multilingual variants would need translation — we keep
// English here and rely on _isPronounPlaceholder for cross-locale "it/this".
function _isSaveImperative(s) {
  if (!s) return false;
  let norm = s.trim().replace(/[.!?,;:]+$/, '').toLowerCase();
  norm = norm.replace(/\bplease\b/g, '').replace(/\s+/g, ' ').trim();
  if (SAVE_IMPERATIVE_PHRASES.has(norm)) return true;
  // Match "save X" / "remember X" / "note X" where X is a pronoun.
  const m = norm.match(/^(save|remember|store|note|keep|log)\s+(.+)$/);
  if (m && _isPronounPlaceholder(m[2])) return true;
  return false;
}

// ── Write-intent detection + toolkit action loop ──────────────────────
//
// Determines whether the user wants to ACT on a connector (post/send/
// draft a Slack msg, create a Notion page, etc.) vs query their memory.
// Pure regex — runs before LLM. Avoids spending a planner call on
// imperative phrasing.

// Wider verb set — catches "let X know", "tell Y", "remind Z", "ping",
// "ask", "announce", "broadcast" + the original action verbs.
const WRITE_VERB_RE = /\b(post|send|draft|schedule|message|dm|notify|reply|share|tell|ping|ask|let|inform|remind|announce|broadcast|update|alert|forward)\b/i;
const SLACK_HINT_RE = /(?:\b(?:slack|channel|@channel|@here|@everyone)\b|(?:^|\s)#[a-z0-9_-]+|(?:^|\s)@[a-z0-9_-]+)/i;
const NOTION_HINT_RE = /\b(notion|wiki|page|database)\b/i;
const GMAIL_HINT_RE = /\b(gmail|email|inbox)\b/i;

function detectWriteIntent(message) {
  const m = String(message || '');
  if (!WRITE_VERB_RE.test(m)) return null;
  if (SLACK_HINT_RE.test(m)) return { provider: 'slack' };
  if (NOTION_HINT_RE.test(m)) return { provider: 'notion' };
  if (GMAIL_HINT_RE.test(m)) return { provider: 'gmail' };
  return null;
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
- For Slack: the available tools are slack_read_channel, slack_read_thread, slack_send_message, slack_schedule_message, slack_send_message_draft. There is NO slack_search_channels tool — if you need to find a channel ID, ASK the user for the channel name or ID instead of inventing a tool.
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
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
    });
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
      throw new Error(`Groq ${resp.status}: ${errText.slice(0, 300)}`);
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
        if (toolResp.status === 'draft_created' && toolResp.meta?.draft_id) {
          draftIds.push(toolResp.meta.draft_id);
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
      }
      continue;
    }

    const final = (msg.content || '').trim();
    return { response: final, steps, draftIds };
  }

  return { response: 'Action chain exceeded iteration budget.', steps, draftIds };
}

async function maybeSaveOrUpdate({ plan, ctx, onEvent, message, history }) {
  if (plan.save_intent && typeof plan.save_intent === 'object') {
    // Resolve empty / pronoun-only / imperative content by harvesting
    // conversation history. User says "save this" / "save it" / "yes" →
    // grab the most recent assistant turn (their proposed text) OR the
    // last substantive user message.
    let content = (plan.save_intent.content || '').trim();
    let title   = (plan.save_intent.title   || '').trim();

    const msgIsImperative = _isSaveImperative(message);
    const contentIsBare = !content
      || _isPronounPlaceholder(content)
      || _isSaveImperative(content)
      // Planner echoed the trigger phrase as content — clearly wrong.
      || (message && content.toLowerCase() === message.trim().toLowerCase());

    if (contentIsBare || msgIsImperative) {
      const turns = Array.isArray(history) ? history.slice(-8) : [];
      // Prefer last assistant draft (often the thing being saved)
      const lastAssistant = [...turns].reverse().find(h => h?.role === 'assistant' && typeof h.content === 'string' && h.content.trim().length > 20);
      const lastUserPrior = [...turns].reverse().find(h => h?.role === 'user'
        && typeof h.content === 'string'
        && h.content.trim() !== (message || '').trim()
        && h.content.trim().length > 10
        // Don't pick another imperative as the source — the user's *prior*
        // substantive content is the target.
        && !_isSaveImperative(h.content)
      );
      // Prefer user turn when it carries the fact ("meet Ethan Tuesday 7pm")
      // and only fall back to assistant draft when no user content exists.
      content = (lastUserPrior?.content || lastAssistant?.content || '').trim();
    }

    // Final guard: never persist a save whose content equals the trigger.
    if (content && message && content.toLowerCase() === message.trim().toLowerCase()) {
      content = '';
    }
    // Also reject pure imperatives that slipped through.
    if (content && _isSaveImperative(content)) {
      content = '';
    }

    if (!content) {
      // Nothing to save — log and skip.
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
      ...(ctx.projectId && !plan.save_intent.project_id && !plan.save_intent.project_hint
        ? { project_id: ctx.projectId, scope: 'project' }
        : {}),
    };
    try {
      const r = await dispatchTool('hivemind_save_memory', args, ctx);
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify(args) });
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary: r?.id ? `saved ${(r.id || '').slice(0, 8)}` : 'saved' });
      return { tool: 'hivemind_save_memory', args, result_summary: r?.id ? `saved ${(r.id || '').slice(0, 8)}` : 'saved' };
    } catch (err) {
      return { tool: 'hivemind_save_memory', args, result_summary: `error: ${err.message}` };
    }
  }
  return null;
}

// ── Public entry — same signature as v1 ────────────────────────────────

export async function runReactAgentV2({
  message,
  history = [],
  model = process.env.HIVEMIND_AGENT_MODEL || 'openai/gpt-oss-120b',
  apiKey,
  assistantName,
  orgName,
  language,
  ctx,
  onEvent,
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY required');
  if (!message) throw new Error('message required');

  const abortCtrl = new AbortController();
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
  };
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
  ctx = { ...ctx, _tracedDispatch: tracedDispatch, _trace: trace };

  try {
    const hasBrowserContext = /<METADATA:(SELECTION|SECTION|BROWSER_CONTEXT)>/i.test(message || '');

    // STEP 1 — Quick gate (no LLM). Browser context bypasses the gate.
    const gateKind = hasBrowserContext ? null : quickGateClassify(message);
    if (gateKind) {
      onEvent?.({ type: 'gate', kind: gateKind });
      // Quick gate (greeting/math/definition) is user-facing → FINAL_MODEL
      const { response, usage } = await answerDirectly({
        message, gateKind, language, assistantName, orgName, model: FINAL_MODEL, apiKey, signal: abortCtrl.signal,
      });
      if (usage) usages.push(usage);
      onEvent?.({ type: 'finish', text: response });
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

    // STEP 2 — Plan (runs on INTERNAL_MODEL — fast/cheap reasoning)
    const planResult = await planStep({
      message, history, language, assistantName, orgName, hasBrowserContext,
      model: INTERNAL_MODEL, apiKey, signal: abortCtrl.signal, onEvent,
    });
    if (planResult.usage) usages.push(planResult.usage);
    const plan = planResult.plan;

    // Write-intent branch (post/send/draft slack message, etc).
    // Runs BEFORE the evidence/recall flow because the user wants to act,
    // not query memory. Planner-emitted action_intent takes priority over
    // the regex detector — the LLM catches indirect phrasing the regex
    // misses ("@team heads up", "ping the eng channel").
    const writeIntent = plan.action_intent
      ? { provider: plan.action_intent }
      : detectWriteIntent(message);
    if (writeIntent && ctx.prisma) {
      try {
        const { buildToolkitForUser } = await import('./toolkit-factory.js');
        const toolkit = await buildToolkitForUser({
          prisma: ctx.prisma,
          userId: ctx.userId,
          orgId: ctx.orgId,
          hivemindTools: [],
        });
        // Activate the matched connector group.
        const activation = toolkit.resetEquippedTools([writeIntent.provider]);
        if (activation.tools.length > 1) {
          onEvent?.({ type: 'tool_call', name: 'reset_equipped_tools', arguments: JSON.stringify({ group_names: [writeIntent.provider] }) });
          onEvent?.({ type: 'tool_result', name: 'reset_equipped_tools', summary: `activated ${writeIntent.provider} (${activation.tools.length} tools)` });
          steps.push({
            tool: 'reset_equipped_tools',
            args: { group_names: [writeIntent.provider] },
            result_summary: `${activation.tools.length} tools active`,
          });
          // Tool-call sub-loop is internal reasoning → INTERNAL_MODEL
          const sub = await runActionSubLoop({
            toolkit, message, history, model: INTERNAL_MODEL, apiKey, ctx, onEvent,
            provider: writeIntent.provider,
          });
          steps.push(...sub.steps);
          const finalText = sub.response || 'Done.';
          onEvent?.({ type: 'finish', text: finalText });
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
          };
        }
      } catch (err) {
        console.warn(`[agent] write-intent branch failed: ${err.message}`);
        // Fall through to normal recall flow if toolkit unavailable.
      }
    }

    // ── Continuation: prior assistant asked "which project?" ────────────
    //
    // When the immediately-previous assistant message asked the user to
    // choose a project AND the current user message is short (a project
    // name OR "org" OR a number), reconstruct the original save from the
    // user turn BEFORE the question, and attach the chosen project hint.
    // Without this, the planner sees "Ashley" and saves "Ashley" as a new
    // standalone memory — the bug the user reported.
    const PROJECT_QUESTION_MARKERS = [
      'Which project should I save this to',
      'In welches Projekt soll ich das speichern',
      '¿En qué proyecto guardo esto',
      "Dans quel projet dois-je l'enregistrer",
    ];
    const priorAssistant = Array.isArray(history) ? [...history].reverse().find(h => h?.role === 'assistant' && typeof h.content === 'string') : null;
    const isProjectAnswer = priorAssistant
      && PROJECT_QUESTION_MARKERS.some(m => priorAssistant.content.includes(m))
      && typeof message === 'string'
      && message.trim().length > 0
      && message.trim().length < 80;
    if (isProjectAnswer) {
      // Walk further back to find the original user save-request — the
      // first user turn before the project question that contained
      // substantive content (not another imperative).
      const turns = Array.isArray(history) ? history : [];
      // Find the index of priorAssistant in history (last assistant).
      let questionIdx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i] === priorAssistant) { questionIdx = i; break; }
      }
      let originalUserTurn = null;
      for (let i = questionIdx - 1; i >= 0 && i >= questionIdx - 5; i--) {
        const h = turns[i];
        if (h?.role === 'user' && typeof h.content === 'string' && h.content.trim().length > 8 && !_isSaveImperative(h.content)) {
          originalUserTurn = h.content.trim();
          break;
        }
      }
      const projectAnswer = message.trim();
      const wantsOrgScope = /^(org|organization|organisation|alle|todos|todas|none)$/i.test(projectAnswer);
      if (originalUserTurn) {
        plan.intent_kind = 'save';
        plan.save_intent = {
          title: originalUserTurn.slice(0, 60),
          content: originalUserTurn,
          tags: [],
          ...(wantsOrgScope ? {} : { project_hint: projectAnswer }),
        };
        // Skip the ask-project gate below — we have the answer now.
        plan.ask_for_project = false;
        // No need to recall again — just run the save branch.
        plan.sub_queries = [];
      }
    }

    // Save intent without a resolvable project scope → ASK *only* when:
    //   • the planner explicitly flagged ask_for_project, OR
    //   • content mentions a known project name OR
    //   • the user has multiple projects AND the content TOPICALLY MATCHES
    //     one of them (best-match score > 0.5 against project name).
    // Otherwise default to personal scope silently. Previously we asked on
    // every save when user had ≥2 projects — every chat turn got blocked
    // by "Which project?" question even for totally unrelated facts.
    if (plan.intent_kind === 'save' && plan.save_intent && (plan.ask_for_project || (!plan.save_intent.project_hint && !ctx.projectId))) {
      const accessProjectIds = (ctx.accessContext?.projectIds) || [];
      if (!plan.save_intent.project_hint && !ctx.projectId && accessProjectIds.length > 1) {
        let projects = [];
        try {
          if (ctx.persistentMemoryStore?.client?.project) {
            projects = await ctx.persistentMemoryStore.client.project.findMany({
              where: { id: { in: accessProjectIds }, orgId: ctx.orgId },
              select: { id: true, name: true },
              take: 12,
            });
          }
        } catch {}

        // Topic-match heuristic: any project name appears in the save
        // content / title / message OR the planner asked.
        const haystack = `${plan.save_intent.title || ''} ${plan.save_intent.content || ''} ${message || ''}`.toLowerCase();
        const topicMatches = projects.filter(p => {
          const n = (p.name || '').toLowerCase().trim();
          if (!n || n.length < 3) return false;
          return haystack.includes(n);
        });

        // Only ask when content TOPICALLY MATCHES a project name. Planner's
        // ask_for_project flag is too eager (defaults to true on every chat
        // save lacking explicit scope) — without topic match we'd block
        // every save with the same question. Default-personal is the right
        // safe behavior; user can move the memory later if needed.
        const shouldAsk = topicMatches.length >= 1;

        if (shouldAsk) {
          const lang = languageName(language);
          const list = projects.map(p => `• ${p.name}`).join('\n') || '(no projects found)';
          const ask = lang === 'German'
            ? `In welches Projekt soll ich das speichern?\n${list}\n\nOder sag "org" für die ganze Organisation.`
            : lang === 'Spanish'
            ? `¿En qué proyecto guardo esto?\n${list}\n\nO di "org" para guardarlo a nivel de organización.`
            : lang === 'French'
            ? `Dans quel projet dois-je l'enregistrer ?\n${list}\n\nOu dis "org" pour l'enregistrer au niveau de l'organisation.`
            : `Which project should I save this to?\n${list}\n\nOr say "org" to save it at the organisation level.`;
          onEvent?.({ type: 'finish', text: ask });
          return {
            response: ask, sources: [], steps,
            evidence_used: [], confidence: 1.0, gaps: ['project scope unresolved'],
            usage: sumUsage(usages),
            trace: finalizeTrace(trace, usages),
            assistant_name: assistantName || null,
          };
        }
        // No topic match — fall through to save with personal scope.
      }
    }

    // Pure save intent (no recall needed) — write the memory then ack.
    // Requires intent_kind === 'save' (enforced upstream in planStep) AND
    // a populated save_intent payload. Pure-noun / filename-only inputs
    // never reach this branch because intent_kind is forced to 'lookup'
    // and save_intent stripped during plan post-processing.
    if (plan.intent_kind === 'save' && plan.save_intent && plan.sub_queries.length === 0) {
      const saveStep = await maybeSaveOrUpdate({ plan, ctx, onEvent, message, history });
      if (saveStep) steps.push(saveStep);
      const lang = languageName(language);
      const scopeNote = saveStep?.args?.project_id || saveStep?.args?.project
        ? ` (project: ${saveStep.args.project || saveStep.args.project_id.slice(0, 8)})`
        : '';
      const ackText = lang === 'English' ? `Got it — saved${scopeNote}.` :
                      lang === 'German'  ? `Verstanden — gespeichert${scopeNote}.` :
                      lang === 'Spanish' ? `Entendido — guardado${scopeNote}.` :
                      lang === 'French'  ? `Compris — enregistré${scopeNote}.` :
                      `Got it — saved${scopeNote} (${lang}).`;
      onEvent?.({ type: 'finish', text: ackText });
      return {
        response: ackText, sources: [], steps,
        evidence_used: [], confidence: 1.0, gaps: [],
        usage: sumUsage(usages),
        trace: finalizeTrace(trace, usages),
        assistant_name: assistantName || null,
      };
    }

    // Direct answer if planner left sub_queries empty AND no side-effects.
    // Skip the evidence-gated answer step — its grounding rules cause
    // the model to refuse / return empty for self-contained questions
    // like '2+2' that have no recall context to lean on.
    if (plan.sub_queries.length === 0 && !plan.save_intent && !plan.needs_web) {
      // No-recall direct answer is user-facing → FINAL_MODEL
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model: FINAL_MODEL, apiKey, signal: abortCtrl.signal,
      });
      if (usage) usages.push(usage);
      onEvent?.({ type: 'finish', text: response });
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
    const evidence = await gatherEvidence({ plan, ctx, onEvent });
    steps.push(...evidence.steps);

    // STEP 4 — Reflect (only when evidence sparse + plan asked for stuff)
    if (evidence.memories.length < 2 && plan.sub_queries.length > 0) {
      try {
        // Reflection on sparse evidence → INTERNAL_MODEL (gap analysis)
        const reflect = await reflectStep({
          message, plan, evidence, language, model: INTERNAL_MODEL, apiKey, signal: abortCtrl.signal,
        });
        if (reflect.usage) usages.push(reflect.usage);
        if (reflect.needs_more && reflect.extra_queries.length > 0) {
          onEvent?.({ type: 'reflect', extra_queries: reflect.extra_queries, reason: reflect.reason });
          const extras = await Promise.all(reflect.extra_queries.map(async (q) => {
            try {
              const r = await dispatchTool('hivemind_recall', { query: q, mode: 'quick', limit: 12 }, ctx);
              steps.push({ tool: 'hivemind_recall', args: { query: q }, result_summary: `${r?.memories?.length || 0} memories` });
              onEvent?.({ type: 'tool_call', name: 'hivemind_recall', arguments: JSON.stringify({ query: q }) });
              onEvent?.({ type: 'tool_result', name: 'hivemind_recall', summary: `${r?.memories?.length || 0} memories` });
              return r;
            } catch (err) {
              return null;
            }
          }));
          const seen = new Set(evidence.memories.map(m => m.id));
          for (const r of extras) {
            for (const m of (r?.memories || [])) {
              if (m?.id && !seen.has(m.id)) {
                seen.add(m.id);
                evidence.memories.push(m);
              }
            }
          }
        }
      } catch (err) {
        // Reflect failure is non-fatal; proceed with what we have.
      }
    }

    // STEP 5 — Answer (runs on FINAL_MODEL — high-quality user-facing synthesis)
    let answer = await answerStep({
      message, history, evidence, plan, language, assistantName, orgName,
      model: FINAL_MODEL, apiKey, signal: abortCtrl.signal, ctx,
    });
    if (answer.usage) usages.push(answer.usage);

    // STEP 5b — Confidence-gated re-recall (Gemini / Composio pattern).
    // If the answer confidence is low AND we have explicit gaps[], re-recall
    // on those gaps + re-synthesize. Caps at 1 retry to avoid runaway loops.
    const CONF_THRESHOLD = Number(process.env.HIVEMIND_CONF_RETRY_THRESHOLD || 0.45);
    if (answer.confidence < CONF_THRESHOLD && Array.isArray(answer.gaps) && answer.gaps.length > 0) {
      onEvent?.({ type: 'reflect_low_confidence', confidence: answer.confidence, gaps: answer.gaps });
      try {
        // Take up to 2 gap phrases as targeted recall queries.
        const gapQueries = answer.gaps.filter(g => typeof g === 'string' && g.trim().length > 0).slice(0, 2);
        const extra = await Promise.all(gapQueries.map(async (q) => {
          try {
            const r = await dispatchTool('hivemind_recall', { query: q, mode: 'quick', limit: 8 }, ctx);
            recordTool('hivemind_recall', { query: q, mode: 'retry' }, `${r?.memories?.length || 0} memories`, r);
            return r;
          } catch { return null; }
        }));
        let mergedNew = 0;
        for (const r of extra) {
          for (const m of (r?.memories || [])) {
            if (m?.id && !evidence.memories.some(e => e.id === m.id)) {
              evidence.memories.push(m);
              mergedNew++;
            }
          }
        }
        if (mergedNew > 0) {
          // Re-run answer with augmented evidence (still FINAL_MODEL).
          const retry = await answerStep({
            message, history, evidence, plan, language, assistantName, orgName,
            model: FINAL_MODEL, apiKey, signal: abortCtrl.signal, ctx,
          });
          if (retry.usage) usages.push(retry.usage);
          if (retry.confidence >= answer.confidence) {
            answer = retry;
            onEvent?.({ type: 'reflect_recovered', confidence: retry.confidence });
          }
        }
      } catch (retryErr) {
        console.warn(`[agent] confidence retry failed: ${retryErr.message}`);
      }
    }

    // STEP 6 — Save intent fire-and-forget (don't block response).
    // Gated on intent_kind === 'save' so a lookup turn that happens to
    // include a filename never accidentally writes a memory.
    if (plan.intent_kind === 'save' && plan.save_intent) {
      const saveStep = await maybeSaveOrUpdate({ plan, ctx, onEvent, message, history });
      if (saveStep) steps.push(saveStep);
    }

    onEvent?.({ type: 'finish', text: answer.response });

    return {
      response:      answer.response,
      sources:       evidence.memories.slice(0, 10).map(m => ({
        id: m.id, title: m.title, snippet: m.content, score: m.score, tags: m.tags,
      })),
      steps,
      evidence_used: answer.evidence_used,
      confidence:    answer.confidence,
      gaps:          answer.gaps,
      usage:         sumUsage(usages),
      trace:         finalizeTrace(trace, usages),
      assistant_name: assistantName || null,
    };
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
