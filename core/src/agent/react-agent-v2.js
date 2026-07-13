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
import { resolveProjectForSave } from '../memory/project-classifier.js';

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
  "sub_queries": ["..."],        // 1-4 recall queries in the user's language, each focused on ONE entity/concept
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
                                  //   CRITICAL: an imperative verb (send/schedule/post/draft/email/notify/
                                  //   message/dm/ping/announce/broadcast/share/forward/compose) addressed
                                  //   at a connector is ALWAYS action_intent. Ambiguity about channel /
                                  //   recipient is NOT a reason to skip — the downstream sub-loop will ask
                                  //   the user OR create a draft awaiting approval. Asking clarification
                                  //   here is WRONG; emit action_intent and let the action path handle it.
  "save_intent": null,            // ONLY when intent_kind === 'save'. {"title": "...", "content": "...", "tags": [...], "project_hint": "..."}. CONTENT MUST be a fully self-contained note enriched with WHO/WHAT/WHEN entities the user mentioned. If the user used a pronoun ("save this"), resolve it from the previous turn. NEVER emit empty / pronoun-only content, NEVER emit content that is just the user's own message verbatim — distill key entities, dates, facts into a structured note. NEVER emit save_intent for a bare filename or entity-only message. If unrecoverable, set null. If user named a project ("save to Ashley", "in the SOLVIS project"), put that name in project_hint.
  "ask_for_project": false,       // true if the user asked to save but did NOT specify a project AND no active project is set in the session. Server will respond by asking which project before saving.
  "auto_save_intent": null,       // PROACTIVE save when the user has NOT explicitly said "save" but their message contains a NEW DURABLE FACT worth memorizing — even when the same message ALSO asks a question. You MUST emit auto_save_intent whenever the user narrates a past event ("I just went to X", "Met Y today", "Yesterday Z called"), states a plan ("I'm flying to Berlin June 5", "We decided to ship Friday"), declares a preference ("I prefer X to Y"), reports a status change ("X moved to Y company"), or commits to a future action ("I'll register the UG next week"). The trigger is INDEPENDENT of intent_kind — a single user turn can be intent_kind='lookup' (they asked a follow-up question) AND emit auto_save_intent simultaneously when the message embeds a fact. Emit {"title": "...", "content": "...", "tags": [...], "memory_type": "fact|decision|preference|event|goal|lesson", "confidence": 0.0-1.0}. Relationships are typed graph edges, never memory objects. Threshold confidence >= 0.70 fires the save.
                                  // MOOD IS THE PRIMARY SIGNAL: an INTERROGATIVE ("what is X?", "who is Y?", "tell me about Z") → recall ONLY, never save. A DECLARATIVE assertion (a statement, no question mark, not a question word) that teaches a durable fact → recall to check existing AND emit auto_save_intent for the new fact. When the user TELLS you something true about their world, you SAVE it; when they ASK, you recall.
                                  // THIRD-PERSON DECLARATIVES FIRE TOO — not just first-person "I" narration. Any statement asserting a NEW STATE or RELATIONSHIP about a company, product, project, org, or person the user works with MUST fire: "X is Y", "X is now Y", "X is the parent/owner/subsidiary of Y", "we renamed/rebranded X to Y", "X acquired/merged with Y", "X replaced Y", "X reports to Y", "X moved to Y". These are the user teaching the system durable structural facts and are the MOST important to capture.
                                  // DO NOT fire on: pure questions ("What is X?"), recall requests ("tell me about Y"), hypotheticals ("what if I did X"), or opinions / general-knowledge about the OUTSIDE world ("AI is overhyped", "Paris is in France"). CRITICAL: a factual declaration about the USER's OWN company / org / products / projects / people is NEVER an "external topic" — it fires even when phrased encyclopedically ("Acme is now a subsidiary of Globex"). If in doubt whether a declarative is about the user's world, FIRE (over-saving is cheap; smart-ingest dedups).
                                  // DO FIRE on: any first-person past-event narration, any future commitment, any preference, ANY declarative assertion of a new state/relationship/rename/restructure about the user's entities/company/people/products (even third-person). Title MUST be a short noun phrase extracting the fact (e.g. "Nbank sponsorship appointment 9:00-10:30" — NOT "user said Nbank"). Content MUST be third-person self-contained with entities + dates + duration + outcome. Tags MUST include entity:<Name> for each named entity + topic tag. Examples that MUST trigger auto_save_intent (illustrative):
  // - "I just went for an Nbank sponsorship appointment from 9-10:30" → {title: "Nbank sponsorship appointment", content: "Amar attended an Nbank sponsorship appointment from 09:00 to 10:30 on YYYY-MM-DD to discuss startup sponsorship registration.", tags: ["entity:Nbank", "topic:sponsorship", "topic:startup-registration"], memory_type: "event", confidence: 0.9}
  // - "I'll register the UG next week" → {title: "UG registration planned next week", content: "Amar plans to register the German UG within the next week.", tags: ["entity:UG", "topic:legal", "topic:germany"], memory_type: "goal", confidence: 0.85}
  // - "Felix from Cherry Ventures said he wants a follow-up call" → {title: "Felix at Cherry Ventures requests follow-up", content: "Felix at Cherry Ventures asked for a follow-up call after the Berlin meeting.", tags: ["entity:Felix", "entity:Cherry_Ventures", "topic:investor-pipeline"], memory_type: "fact", confidence: 0.9}
  // - (third-person structural fact — placeholder names) "Acme is now the parent company of Beta Corp and is the rebranded name of Gamma AI" → {title: "Acme parent of Beta Corp, rebrand of Gamma AI", content: "Acme is the parent company of Beta Corp and is the new rebranded name of the former Gamma AI.", tags: ["entity:Acme", "entity:Beta_Corp", "entity:Gamma_AI", "topic:org-structure"], memory_type: "fact", confidence: 0.9}
  // Be liberal — missing an auto-save is worse than over-saving (smart-ingest NOOP detects duplicates). A declarative statement teaching a NEW fact about the user's world should almost always fire.
  "update_intent": null,          // ONLY when intent_kind === 'update'. {"target_hint": "...", "new_value": "..."} if user corrected a prior fact
  "recall_mode": "quick",         // 'quick' (default — fast semantic), 'panorama' (temporal/historical browse), or 'insight' (deep — expands synthesis evidence chains + traverses bridges). Use 'insight' when the user asks about RELATIONSHIPS between memories, multi-entity connections, or cross-topic context ("how is X connected to Y", "what's the relation between X and Y", "what links X to my work on Y", "give me the full story on X"). Use 'panorama' for "what happened last week", "show me my history with X", "timeline of Y". Default 'quick' for direct lookups.
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

  // Auto-save intent — can fire on ANY intent_kind. Planner decides if the
  // user's message contains a durable fact worth memorizing unprompted.
  // Guard: requires structured object + confidence >= 0.70 + non-empty
  // title + content >= 30 chars. Filters out garbage like
  // {"title": "X", "content": "X"}.
  let auto_save_intent = null;
  const rawAS = parsed.auto_save_intent;
  if (rawAS && typeof rawAS === 'object'
      && typeof rawAS.title === 'string' && rawAS.title.trim().length >= 5
      && typeof rawAS.content === 'string' && rawAS.content.trim().length >= 30
      && typeof rawAS.confidence === 'number' && rawAS.confidence >= 0.70) {
    // Reject when content is just user's message verbatim (cheap dedup).
    const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm(rawAS.content) !== norm(message)) {
      auto_save_intent = {
        title: rawAS.title.trim().slice(0, 200),
        content: rawAS.content.trim().slice(0, 4000),
        tags: Array.isArray(rawAS.tags) ? rawAS.tags.filter(t => typeof t === 'string').slice(0, 12) : [],
        memory_type: ['fact','decision','preference','event','goal','lesson'].includes(rawAS.memory_type) ? rawAS.memory_type : 'fact',
        confidence: rawAS.confidence,
      };
    }
  }

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
    sub_queries:           Array.isArray(parsed.sub_queries) ? parsed.sub_queries.filter(q => typeof q === 'string' && q.trim()) : [],
    named_entities:        Array.isArray(parsed.named_entities) ? parsed.named_entities.slice(0, 6) : [],
    needs_traverse:        !!parsed.needs_traverse,
    needs_time_travel:     !!parsed.needs_time_travel,
    time_travel:           sanitizeTimeTravel(parsed.time_travel),
    needs_web:             !!parsed.needs_web,
    save_intent,
    auto_save_intent,
    ask_for_project:       intent_kind === 'save' ? !!parsed.ask_for_project : false,
    update_intent,
    // Recall mode — insight expands synthesis chains, panorama gives
    // temporal browse, quick is default fast semantic. Validated to one
    // of the three; bad input falls to 'quick'.
    recall_mode:           ['quick','panorama','insight'].includes(parsed.recall_mode) ? parsed.recall_mode : 'quick',
    expected_evidence_types: Array.isArray(parsed.expected_evidence_types) ? parsed.expected_evidence_types : [],
  };

  // Deterministic relation-query detection — overrides planner choice
  // when patterns are unambiguous. LLM planners on smaller models miss
  // these consistently. Forces mode=insight so synthesis chains + edge
  // expansion fire.
  const ml = (message || '').toLowerCase();
  const RELATION_PATTERNS = [
    /\b(relation|relationship|connection)\s+between\b/,
    /\bhow\s+(?:is|are)\s+\w+(?:\s+\w+){0,4}\s+(?:connect|relat|link|tie)/,
    /\bwhat\s+(?:links?|connects?|ties?)\b/,
    /\bfull\s+story\s+(?:on|about|of)\b/,
    /\bgive\s+me\s+(?:the\s+)?(?:full|whole|complete)\s+(?:context|picture|story)\b/,
  ];
  if (RELATION_PATTERNS.some(re => re.test(ml))) {
    plan.recall_mode = 'insight';
  }

  // Sub-query budget by intent — narrows wide-net recall when the question
  // is unambiguous. Bloat reduction: 4 parallel recalls → 2 for direct
  // single-entity lookups halves prompt-token cost without losing recall
  // (server-side dedup handles overlap anyway). Heuristic:
  //   single named entity + intent_kind=lookup → 2 queries
  //   relation queries (insight mode) → 3 queries
  //   recap / panorama → 4 queries
  //   default → 3 queries
  // T1-5: date-anchored, no-entity queries ("what did we do around 2026-06-06")
  // need ONE windowed recall — the date_range/valid_at filter already narrows
  // it. Capping to 1 stops the planner emitting paraphrase duplicates.
  const msgLower = (plan.user_message || '').toLowerCase();
  const dateAnchored = /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(msgLower)
    || /\b(today|yesterday|this week|last week|this month|last month|around|earlier)\b/.test(msgLower);
  const subQueryCap =
    plan.named_entities.length === 0 && dateAnchored && plan.recall_mode !== 'insight' ? 1 :
    plan.recall_mode === 'panorama' ? 4 :
    plan.recall_mode === 'insight'  ? 3 :
    plan.intent_kind === 'lookup' && plan.named_entities.length <= 1 ? 2 :
    3;
  plan.sub_queries = plan.sub_queries.slice(0, subQueryCap);

  // T1-1: dedup near-identical sub_queries BEFORE gather. The planner often
  // emits paraphrases of one intent ("activities on 2026-06-06" vs
  // "2026-06-06 work") which fire two full recall passes over the same rows —
  // wasted round-trips + duplicate evidence downstream. Normalize to a sorted
  // content-token key (tiny entity-free stopword list so genuinely distinct
  // queries never collapse) and keep the first of each key.
  {
    const SQ_STOP = new Set(['work', 'activities', 'activity', 'did', 'do', 'done', 'stuff', 'things', 'thing', 'on', 'around', 'about', 'the', 'a', 'an', 'of', 'for', 'our', 'we', 'us', 'my']);
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !SQ_STOP.has(w)).sort().join(' ');
    const seen = new Set();
    plan.sub_queries = plan.sub_queries.filter((q) => {
      const k = norm(q);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  onEvent?.({ type: 'plan_done', plan });
  return { plan, usage };
}

// ── STEP 2 (ALT) — Tool-decision router (CHAT_ROUTER=tool) ──────────────
// Language-agnostic replacement for the regex gate + the big JSON planStep.
// ONE cheap LLM call with a TINY tool set decides what to do:
//   • recall(queries, mode) → memory lookup (the common path)
//   • act(provider)         → connector action (delegated to the existing
//                             action_intent flow downstream)
//   • no tool call          → direct answer (greeting / smalltalk / general),
//                             already produced in the user's language → carried
//                             on plan._direct_answer so the caller short-circuits.
// Returns the SAME { plan, usage } contract as planStep so every downstream
// step (gather/reflect/answer/confidence-retry/save/return) is reused verbatim.
// Connector tool schemas are NOT loaded here — only when act() is chosen does
// the downstream action sub-loop load them (lazy, token-cheap).
const ROUTER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search the organisation memory. Use for ANY question about specific facts, the org, its people, products, projects, documents, history, numbers, or the world. When in doubt, recall — never answer specific questions from your own knowledge.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' }, description: 'EXACTLY 1-3 semantic search queries. Preserve names and meaning in the user\'s language; multilingual retrieval handles them directly.' },
          mode: { type: 'string', enum: ['fact', 'explain', 'full'], description: 'fact = cheap current answer; explain = evidence and typed relations; full = explicit source reconstruction only when the user asks for complete context.' },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Perform an action through a connector (send / create / schedule / draft a message). Use ONLY when the user explicitly asks to perform such an action.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['slack', 'notion', 'gmail', 'github', 'linear'] },
        },
        required: ['provider'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'live_lookup',
      description: 'Pull FRESH/LIVE data straight from the user\'s connected apps (email, chat, docs, notes) to answer about recent or real-time things — "my latest emails", "what was said in the #channel", "today\'s calendar", "the latest Notion page". Use when the answer needs current connector data rather than (or in addition to) stored memory. Only connected apps are queried; pick the relevant ones. You may ALSO let recall run by including a query.',
      parameters: {
        type: 'object',
        properties: {
          providers: { type: 'array', items: { type: 'string', enum: ['gmail', 'slack', 'notion', 'google-drive', 'google-calendar', 'google-docs'] }, description: 'Which connected app(s) to pull live data from' },
          query: { type: 'string', description: 'ENGLISH search query / what to look for in those apps' },
        },
        required: ['providers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Save a durable fact to memory. Call this when the user (a) explicitly asks to save/remember/note something, OR (b) STATES a durable fact about their own world — their org, people, products, projects, decisions, plans ("X is now Y", "we decided Z", "the launch is March 2026"). Do NOT call for questions, opinions, or general world knowledge. The fact is also recalled to check for existing/conflicting memory.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the fact' },
          content: { type: 'string', description: 'The fact as a clear, self-contained statement (3rd person, ENGLISH)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'optional entity:/topic: tags' },
        },
        required: ['content'],
      },
    },
  },
];

async function routerPlan({ message, history, language, assistantName, orgName, model, apiKey, signal, onEvent }) {
  const basePlan = {
    intent_kind: 'lookup', user_message: message, action_intent: null, intents: [],
    sub_queries: [], named_entities: [], needs_traverse: false, needs_time_travel: false,
    time_travel: null, needs_web: false, save_intent: null, auto_save_intent: null,
    ask_for_project: false, update_intent: null, recall_mode: 'fact', expected_evidence_types: [],
  };

  const name = assistantName || 'HIVE';
  const orgLabel = (!orgName || /^Local Org\b/i.test(orgName)) ? 'this workspace' : orgName;
  const sys = `You are ${name}, the persistent memory of ${orgLabel}. For the user's latest message, choose ONE:
- Call recall(queries) for ANY question seeking specific information — about ${orgLabel}, its people, products, projects, documents, history, numbers, or the outside world. Bias strongly toward recall: if the message asks anything specific, recall.
- Call remember(content) when the user asks to save/remember something OR STATES a durable fact about their own world (org/people/products/projects/decisions/plans — "X is now Y", "we decided Z", "launch is March 2026"). NOT for questions, opinions, or general world knowledge.
- Call live_lookup(providers, query) when the answer needs FRESH/CURRENT data from the user's connected apps — latest emails, recent chat messages, today's calendar, a current doc/note. Pick the relevant connected app(s). Only connected apps are queried.
- Call act(provider) ONLY when the user explicitly asks to send/create/schedule/draft something via a connector.
- Call NO tool, and instead write a short direct reply, ONLY for greetings, small talk, thanks, or trivial general knowledge you are fully certain of.
CRITICAL: recall queries MUST be in ENGLISH — translate the user's terms (German/French/etc. → English) before searching; memory is English and ranks poorly on foreign-language queries.
Whenever you reply DIRECTLY (no tool), reply in the SAME language the user wrote in.`;

  const histMsgs = Array.isArray(history)
    ? history.slice(-4).filter(h => h && (h.role === 'user' || h.role === 'assistant') && h.content)
        .map(h => ({ role: h.role, content: String(h.content).slice(0, 1500) }))
    : [];

  const routerModel = process.env.CHAT_ROUTER_MODEL || model || INTERNAL_MODEL;
  const body = {
    model: routerModel,
    messages: [{ role: 'system', content: sys }, ...histMsgs, { role: 'user', content: message }],
    tools: ROUTER_TOOLS,
    tool_choice: 'auto',
    max_tokens: 500,
    temperature: 0,
  };

  let data = null;
  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const t = (await resp.text().catch(() => '')).slice(0, 200);
      throw new Error(`router ${resp.status}: ${t}`);
    }
    data = await resp.json();
  } catch (err) {
    // Router call failed → safe default: recall the raw message (never strand the user).
    onEvent?.({ type: 'plan', routed: 'recall_fallback', reason: err.message });
    return { plan: { ...basePlan, sub_queries: [message] }, usage: null };
  }

  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const usage = data.usage || null;
  const tc = Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null;

  if (!tc) {
    // No tool → direct answer already written in the user's language.
    const direct = (msg.content || '').trim();
    onEvent?.({ type: 'plan', routed: 'direct' });
    // Empty content (model emitted nothing) → fall back to recall so the user
    // still gets a grounded answer rather than silence.
    if (!direct) return { plan: { ...basePlan, sub_queries: [message] }, usage };
    return { plan: { ...basePlan, sub_queries: [], _direct_answer: direct }, usage };
  }

  let args = {};
  try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
  const fn = tc.function?.name;

  if (fn === 'act') {
    const VALID = ['slack', 'notion', 'gmail', 'github', 'linear'];
    const provider = VALID.includes(String(args.provider || '').toLowerCase()) ? String(args.provider).toLowerCase() : null;
    onEvent?.({ type: 'plan', routed: 'act', provider });
    return { plan: { ...basePlan, intent_kind: 'action', action_intent: provider }, usage };
  }

  if (fn === 'remember') {
    const content = (typeof args.content === 'string' && args.content.trim()) ? args.content.trim() : message;
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : content.slice(0, 60);
    const tags = Array.isArray(args.tags) ? args.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 8) : [];
    onEvent?.({ type: 'plan', routed: 'remember' });
    // Save the fact AND recall to surface existing/conflicting memory (mirrors
    // v2's save+recall). intent_kind 'save' + save_intent → maybeSaveOrUpdate fires.
    return {
      plan: {
        ...basePlan,
        intent_kind: 'save',
        save_intent: { title, content, tags },
        sub_queries: [content.slice(0, 120)],
        recall_mode: 'fact',
      },
      usage,
    };
  }

  if (fn === 'live_lookup') {
    const VALID = ['gmail', 'slack', 'notion', 'google-drive', 'google-calendar', 'google-docs'];
    const providers = (Array.isArray(args.providers) ? args.providers : [])
      .map(p => String(p || '').toLowerCase()).filter(p => VALID.includes(p));
    const q = (typeof args.query === 'string' && args.query.trim()) ? args.query.trim() : message;
    onEvent?.({ type: 'plan', routed: 'live_lookup', providers });
    // Run memory recall on the query AND fetch live from the chosen connected
    // apps (gatherEvidence honours plan.live_providers). Combined evidence.
    return { plan: { ...basePlan, sub_queries: [q], recall_mode: 'fact', live_providers: providers }, usage };
  }

  // Default: recall (also the safe catch-all for an unknown tool name).
  const queries = (Array.isArray(args.queries) ? args.queries : [])
    .filter(q => typeof q === 'string' && q.trim()).slice(0, 3);
  const mode = ['fact', 'explain', 'full'].includes(args.mode) ? args.mode : 'fact';
  onEvent?.({ type: 'plan', routed: 'recall', queries });
  return { plan: { ...basePlan, sub_queries: queries.length ? queries : [message], recall_mode: mode }, usage };
}

// ── STEP 3 — Evidence gather (no LLM) ──────────────────────────────────

async function gatherEvidence({ plan, ctx, onEvent }) {
  const steps = [];
  const memoriesById = new Map();
  const liveItems = [];
  const evidenceItems = [];
  // Typed graph edges harvested from hivemind_traverse_graph. Passed to
  // answerStep so the LLM can ground "relation between X and Y" answers
  // on actual edge records instead of inventing relations from content
  // co-occurrence. Anti-hallucination invariant.
  const edgesByKey = new Map();   // key = `${from_id}|${to_id}|${type}` → edge
  // Synthesis evidence chains from insight-mode recall. Each chain is a
  // canonical-fact or synthesis-bridge memory + its top-4 evidence
  // memories. Passed to answerStep so the LLM can cite synth claims AND
  // their source rows in the same answer.
  const synthesisChains = new Map(); // key = synthesis_id → chain
  const recallPackets = [];

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
  // Today / yesterday / this-week extraction — answer-step bails with
  // confidence 0.2 when recall returns 15 memories spanning weeks and
  // the LLM cannot tell which fall on the user's target day. Compute a
  // hard date_range so recall returns only memories whose document_date
  // or created_at falls in the requested window. Today = UTC day boundary.
  let derivedDateRange = null;
  const ulRaw = String(plan.user_message || '').toLowerCase();
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (/\btoday\b/.test(ulRaw)) {
    derivedDateRange = {
      start: todayUtc.toISOString(),
      end: new Date(todayUtc.getTime() + dayMs - 1).toISOString(),
    };
  } else if (/\byesterday\b/.test(ulRaw)) {
    const y = new Date(todayUtc.getTime() - dayMs);
    derivedDateRange = {
      start: y.toISOString(),
      end: new Date(todayUtc.getTime() - 1).toISOString(),
    };
  } else if (/\bthis\s+week\b/.test(ulRaw)) {
    // ISO week (Mon=1). Find Monday of current week.
    const dow = todayUtc.getUTCDay() || 7; // Sun=0 → 7
    const monday = new Date(todayUtc.getTime() - (dow - 1) * dayMs);
    derivedDateRange = {
      start: monday.toISOString(),
      end: new Date(todayUtc.getTime() + dayMs - 1).toISOString(),
    };
  } else if (/\blast\s+week\b/.test(ulRaw)) {
    const dow = todayUtc.getUTCDay() || 7;
    const thisMon = new Date(todayUtc.getTime() - (dow - 1) * dayMs);
    const lastMon = new Date(thisMon.getTime() - 7 * dayMs);
    derivedDateRange = {
      start: lastMon.toISOString(),
      end: new Date(thisMon.getTime() - 1).toISOString(),
    };
  }

  const recallExtras = {
    ...(userConnector ? { tags: [userConnector] } : {}),
    ...(derivedValidAt ? { valid_at: derivedValidAt } : {}),
    ...(derivedDateRange ? { date_range: derivedDateRange } : {}),
  };

  // (a) Parallel recall on each sub_query — mode chosen by planner (quick
  // default, insight for relation queries, panorama for time/history).
  // Insight mode pulls synthesis_evidence_chains so the agent sees the
  // multi-source claim AND its source memories without a second call.
  const recallMode = plan.recall_mode || 'quick';
  // T1-4: mode-aware candidate limit. Quick mode (common path) fetches 8, not
  // 12 — render cap (evidenceTopK=6) is unchanged so zero answer-token / zero
  // quality change, but the recall-router runs MMR + score-floor over a
  // smaller set and downstream dedup carries less.
  const recallLimit = recallMode === 'full' ? 14 : recallMode === 'explain' || recallMode === 'insight' ? 12 : 8;
  if (plan.sub_queries.length > 0) {
    const recallResults = await Promise.all(
      plan.sub_queries.map(async (q) => {
        try {
          const r = await dispatchTool('hivemind_recall', { query: q, mode: recallMode, limit: recallLimit, ...recallExtras }, ctx);
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
    const evidenceSeen = new Set();
    const liveSeen = new Set();
    for (const r of recallResults) {
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
  // connector recall returned data OR deterministic date extractor produced
  // a valid_at (catches "as of May 13" even when planner missed it).
  const ASOF_RE = /\b(as of|before|prior to|on or before|until|by)\b/i;
  const wantTimeTravel =
    (plan.needs_time_travel && plan.time_travel && (plan.time_travel.transaction_time || plan.time_travel.valid_time))
    || (isTemporalQuery && hasConnectorTagged && !plan.time_travel?.valid_time)
    || (derivedValidAt && ASOF_RE.test(plan.user_message || ''));
  // T1-2: skip the dedicated hivemind_at snapshot when recall was ALREADY
  // as-of-scoped (recallExtras.valid_at set from the same derived date) AND
  // returned enough rows — it would re-fetch the same window. Keep it as a
  // safety net when recall came back thin (<3) or wasn't date-scoped.
  if (wantTimeTravel && (!recallExtras.valid_at || memoriesById.size < 3)) {
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
  // T1-6: traverse is for relation/entity questions. On pure temporal/history
  // queries (no named entities, healthy recall) it adds round-trips that often
  // return 0 edges. Gate on relational intent when the flag is on; otherwise
  // preserve the original always-on behaviour for safe A/B rollout.
  const traverseRelationalOnly = process.env.HIVEMIND_TRAVERSE_RELATIONAL_ONLY === 'true';
  const isRelational = (plan.named_entities?.length || 0) > 0 || plan.recall_mode === 'insight';
  const shouldTraverse = memoriesById.size > 0
    && (!traverseRelationalOnly || (isRelational && memoriesById.size < 8));
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
      // T1-6: only widen to 2 seeds for genuinely multi-entity ("X and Y")
      // questions; a single entity / history query needs just the top seed.
      .slice(0, plan.named_entities.length >= 2 ? 2 : 1)
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
        const edges = Array.isArray(r?.edges) ? r.edges : [];
        recordTool('hivemind_traverse_graph', args, `seed=${seed.id.slice(0, 8)} → ${edges.length} edges, ${found.length} related`, r);
        for (const m of found.slice(0, 8)) {
          if (m?.id && !memoriesById.has(m.id)) memoriesById.set(m.id, m);
        }
        // Collect typed edges (dedup by from|to|type). Anchor seed id too —
        // answerStep needs edges touching ANY memory in the evidence set.
        for (const e of edges) {
          if (!e?.from_id || !e?.to_id || !e?.type) continue;
          const k = `${e.from_id}|${e.to_id}|${e.type}`;
          if (!edgesByKey.has(k)) edgesByKey.set(k, e);
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
        // Fallback: extract channel name from query — Nango Slack proxy
        // accepts either id or name in `channel` field. Priority order:
        //   1. #channel hashtag
        //   2. "channel <name>" / "in #<name>"
        //   3. "in <name>" — only if <name> looks like a real channel slug
        //      (kebab/snake with at least one separator) to avoid matching
        //      "in slack" → name="slack".
        const STOP_WORDS = /^(the|that|this|a|an|slack|notion|gmail|github|linear|jira|drive|calendar|outlook|channel|thread|message|messages|msg|msgs)$/i;
        let channelName = null;
        const hash = (q || '').match(/#([a-z0-9][a-z0-9._-]+)/i);
        if (hash) channelName = hash[1];
        if (!channelName) {
          const m2 = (q || '').match(/\bchannel\s+#?([a-z0-9][a-z0-9._-]{2,40})\b/i);
          if (m2 && !STOP_WORDS.test(m2[1])) channelName = m2[1];
        }
        if (!channelName) {
          const m3 = (q || '').match(/\bin\s+([a-z0-9][a-z0-9._-]*[-_][a-z0-9][a-z0-9._-]*)\b/i);
          if (m3 && !STOP_WORDS.test(m3[1])) channelName = m3[1];
        }
        return {
          channel_id: ch || undefined,
          channel: !ch && channelName ? channelName : undefined,
          limit: 5,
        };
      },
      // Allow live call if EITHER id or channel name resolved.
      requires: (args) => !!(args.channel_id || args.channel),
    },
    gmail:  null, // gmail live recall already wired via persistent-retrieval live tier
  };
  const liveReadIntent = LIVE_READ_VERB_RE.test(plan.user_message || '');
  const lowRecall = memoriesById.size < 3;
  // NB: removed !plan.action_intent gate — planner sometimes flags read
  // queries as action_intent. Live-read should always fire when query has
  // explicit read verb + connector keyword + extractable target.
  //
  // Connectors to live-fetch come from TWO sources:
  //   (1) plan.live_providers — the tool-router's EXPLICIT, language-robust
  //       choice (CHAT_ROUTER=tool → live_lookup). Always fires (the model
  //       already judged live data is needed), no lowRecall gate.
  //   (2) userConnector — the keyword-detected connector (legacy path), which
  //       fires only on low recall / slack read-verb.
  // Filtered to providers that have a READ_CONNECTOR_TRIGGER (notion/slack).
  // gmail live flows via recall's live tier already; drive/calendar/docs have
  // no read-trigger yet (recall live tier / future read sub-loop).
  const explicitLive = Array.isArray(plan.live_providers) ? plan.live_providers : [];
  const keywordLive = (userConnector && READ_CONNECTOR_TRIGGERS[userConnector]
    && (lowRecall || (liveReadIntent && userConnector === 'slack'))) ? [userConnector] : [];
  const connectorsToFetch = [...new Set([...explicitLive, ...keywordLive])]
    .filter(p => READ_CONNECTOR_TRIGGERS[p]);
  if (connectorsToFetch.length > 0 && ctx.prisma) {
    try {
      const { buildToolkitForUser } = await import('./toolkit-factory.js');
      const tk = await buildToolkitForUser({
        prisma: ctx.prisma, userId: ctx.userId, orgId: ctx.orgId, hivemindTools: [],
      });
      for (const provider of connectorsToFetch) {
        try {
          tk.resetEquippedTools([provider]);
          const cfg = READ_CONNECTOR_TRIGGERS[provider];
          const arg = cfg.argMap(plan.sub_queries[0] || plan.user_message || '', [...memoriesById.values()]);
          if (!cfg.requires || cfg.requires(arg)) {
            const resp = await tk.execute(cfg.tool, arg, {
              userId: ctx.userId, orgId: ctx.orgId, prisma: ctx.prisma,
              persistentMemoryEngine: ctx.persistentMemoryEngine,
            });
            const text = resp.content?.[0]?.text || '';
            recordTool(cfg.tool, arg, `${text.length}b live`, resp);
            if (text) {
              liveItems.push({ source: provider, title: `live ${provider} result`, snippet: text.slice(0, 600) });
            }
          }
        } catch (e) {
          recordTool('connector_live_fallback', { provider }, `error: ${e.message}`, null);
        }
      }
    } catch (err) {
      recordTool('connector_live_fallback', { providers: connectorsToFetch }, `error: ${err.message}`, null);
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
    history. When in doubt, default to the literal absence of the edge.`;
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
    const body = (e.content || e.snippet || '').replace(/\n/g, ' ').slice(0, 320);
    return `[DOC/${doc}${page}] ${body}`;
  }).join('\n');

  // T2-1: distilled tail — depth 4 (or 6 on anaphora), assistant turns reduced
  // to their `.response` prose, each turn start-capped. Biggest answer-prompt
  // token saving with no accuracy loss for fresh queries.
  const tail = distillHistoryTail(history, message);

  // GRAPH EDGES block — typed relationships between evidence memories.
  // These come from real Relationship table rows (Updates/Extends/Mentions
  // /Derives/Contradicts) returned by hivemind_traverse_graph. Agent MUST
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

  const userBlock = `EVIDENCE (${Math.min(evidence.memories.length, evidenceTopK)} of ${evidence.memories.length} memories):
${evidenceLines || '(none)'}${chainLines ? `\n\nSYNTHESIS CHAINS (${(evidence.synthesis_chains || []).length} curated claims + sources — cite the claim, support with the evidence rows):\n${chainLines}` : ''}${edgeLines ? `\n\nGRAPH EDGES (${filteredEdges.length} typed relationships between the memories above — ONLY trust these for relation claims):\n${edgeLines}` : ''}${liveLines ? `\n\nLIVE WORKSPACE (${(evidence.live || []).length} fresh items — Gmail / Drive / Calendar):\n${liveLines}` : ''}${evLines ? `\n\nDOCUMENT SEGMENTS (${(evidence.evidence || []).length} non-promoted KB chunks — full source text):\n${evLines}` : ''}${capabilityHint}${windowNote}${personaNote}

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

    // Temporal-summary retry: user asked "what did I do today / yesterday
    // / this week" AND evidence has memories matching the window, but LLM
    // bailed. Force enumeration with explicit list-the-memories nudge.
    const TEMPORAL_SUMMARY_RE = /\b(today|yesterday|this\s+week|last\s+week|on\s+\d{4}-\d{2}-\d{2}|on\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
    if (TEMPORAL_SUMMARY_RE.test(String(message))) {
      try {
        const retry = await callJsonLLM({
          messages: [
            { role: 'system', content: sys },
            ...tail,
            { role: 'user', content: userBlock },
            { role: 'assistant', content: JSON.stringify(parsed) },
            {
              role: 'user',
              content: `Your previous reply bailed on a temporal-summary question. The EVIDENCE block above lists memories with ts:* tags or recent created_at. ENUMERATE them — title + short context per memory. Even one matching memory means the answer is NOT "I don't have notes". Same JSON shape.`,
            },
          ],
          model, apiKey, maxTokens: ANSWER_MAX_TOKENS, signal,
        });
        if (typeof retry.parsed?.response === 'string' && retry.parsed.response.trim()) {
          response = retry.parsed.response.trim();
          parsed.response = response;
          parsed.evidence_used = Array.isArray(retry.parsed.evidence_used) ? retry.parsed.evidence_used : parsed.evidence_used;
          parsed.confidence = Number.isFinite(retry.parsed.confidence) ? retry.parsed.confidence : parsed.confidence;
          console.log(`[agent] temporal-summary retry recovered answer (${evidence.memories.length} memories)`);
        }
      } catch (err) {
        console.warn('[agent] temporal-summary retry failed:', err.message);
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

// T2-1: distill the answer-prompt history tail — the single biggest line item
// (~59% of prompt tokens). Two levers, both accuracy-safe:
//   (1) ASSISTANT turns are stored as the full {response, evidence_used,
//       confidence, gaps} JSON blob. The model only needs the prose reply, so
//       extract `.response` instead of JSON.stringify-ing the whole object.
//   (2) Depth: 4 recent turns is plenty for a fresh factual/temporal question.
//       Keep the FULL 6 only when the current message refers back ("save it",
//       "what about that one", bare pronoun, or a tiny follow-up) — anaphora
//       needs the older turn to resolve. When in doubt we keep more, never less.
// Each turn is start-capped (not mid-truncated) so the model never parses a
// severed JSON fragment.
function _needsDeepHistory(message) {
  const m = String(message || '').trim().toLowerCase();
  if (!m) return true;                              // empty → don't risk it
  if (m.length <= 24) return true;                  // terse follow-up
  if (SAVE_IMPERATIVE_PHRASES.has(m.replace(/[.!?,;:]+$/, ''))) return true;
  const tokens = m.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.some((t) => PRONOUN_PLACEHOLDERS.has(t))) return true;  // "...that one..."
  if (/\b(above|previous|prior|earlier|last (one|time)|the same)\b/.test(m)) return true;
  return false;
}

function distillHistoryTail(history, message, { perTurnCap = 600 } = {}) {
  const depth = _needsDeepHistory(message) ? 6 : 4;
  return (history || [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content)
    .slice(-depth)
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
const WRITE_VERB_RE = /\b(post|send|draft|schedule|message|dm|notify|reply|share|tell|ping|ask|let|inform|remind|announce|broadcast|update|alert|forward|compose|create|make|generate|publish)\b/i;
const SLACK_HINT_RE = /(?:\b(?:slack|channel|@channel|@here|@everyone)\b|(?:^|\s)#[a-z0-9_-]+|(?:^|\s)@[a-z0-9_-]+)/i;
const NOTION_HINT_RE = /\b(notion|wiki|page|database)\b/i;
const GMAIL_HINT_RE = /\b(gmail|email|inbox|mail)\b/i;
const GDOCS_HINT_RE = /\b(google\s*docs?|gdocs?|doc\b|document\b|word\s*doc)\b/i;
const GEMINI_HINT_RE = /\b(gemini|google\s*ai|bard)\b/i;

function detectWriteIntent(message) {
  const m = String(message || '');
  if (!WRITE_VERB_RE.test(m)) return null;
  if (SLACK_HINT_RE.test(m)) return { provider: 'slack' };
  if (NOTION_HINT_RE.test(m)) return { provider: 'notion' };
  if (GMAIL_HINT_RE.test(m)) return { provider: 'gmail' };
  if (GDOCS_HINT_RE.test(m)) return { provider: 'google-docs' };
  if (GEMINI_HINT_RE.test(m)) return { provider: 'google-gemini' };
  return null;
}

// Read-intent detection — even when there's no write verb, references to a
// specific provider should equip its READ tools so the agent can pull live
// data. Returns a list of groups to activate (read-only intent).
function detectReadIntents(message) {
  const m = String(message || '');
  const groups = [];
  if (GMAIL_HINT_RE.test(m)) groups.push('gmail');
  if (GDOCS_HINT_RE.test(m)) groups.push('google-docs');
  if (GEMINI_HINT_RE.test(m)) groups.push('google-gemini');
  if (NOTION_HINT_RE.test(m)) groups.push('notion');
  if (SLACK_HINT_RE.test(m)) groups.push('slack');
  return groups;
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
      if (r?.needs_project_choice) {
        return { tool: 'hivemind_save_memory', args, result_summary: 'needs project choice',
          project_choice: { projects: r.projects || [], draft: r.draft || null } };
      }
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify(args) });
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary: r?.id ? `saved ${(r.id || '').slice(0, 8)}` : 'saved' });
      return { tool: 'hivemind_save_memory', args, result_summary: r?.id ? `saved ${(r.id || '').slice(0, 8)}` : 'saved' };
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
      const summary = r?.id ? `auto-saved ${(r.id || '').slice(0, 8)} (conf=${as.confidence.toFixed(2)})` : 'auto-saved';
      onEvent?.({ type: 'tool_call', name: 'hivemind_save_memory', arguments: JSON.stringify({ ...args, __auto: true }) });
      onEvent?.({ type: 'tool_result', name: 'hivemind_save_memory', summary });
      return { tool: 'hivemind_save_memory', args, result_summary: summary };
    } catch (err) {
      return { tool: 'hivemind_save_memory', args, result_summary: `auto-save error: ${err.message}` };
    }
  }
  return null;
}

// ── Save-classifier rescue ──────────────────────────────────────────────
// The planner (INTERNAL_MODEL, gpt-oss-20b) reliably catches first-person
// narration but misses THIRD-PERSON declarative facts the user teaches
// ("X is now the parent of Y", "we rebranded Z") — a buried field in a
// 20-field JSON is too subtle for a small model, so the agent just recalls
// "no record" instead of SAVING. This is a focused, single-purpose binary
// classifier on the STRONG model, gated by a cheap declarative heuristic so it
// only fires when the planner emitted no save on a statement (not a question).
const QUESTION_LEAD_RE = /^(what|who|whom|whose|when|where|why|how|which|is|are|am|was|were|do|does|did|can|could|would|should|will|shall|tell|show|list|find|search|get|fetch|explain|describe|summari[sz]e|recall|give|look|lookup|any|please)\b/i;
export function looksDeclarativeFact(message) {
  const m = String(message || '').trim();
  if (!m || m.endsWith('?')) return false;          // question
  if (QUESTION_LEAD_RE.test(m)) return false;        // interrogative / recall-command lead
  if (m.split(/\s+/).length < 4) return false;       // too short (bare entity/filename)
  return true;
}

// Mutates plan.auto_save_intent in place when a declarative fact is detected
// that the planner did not already flag for save. Non-fatal + best-effort.
async function rescueAutoSaveIntent({ message, plan, model, apiKey, signal, onEvent }) {
  if (!plan || plan.save_intent || plan.auto_save_intent) return plan; // planner caught it
  if (!looksDeclarativeFact(message)) return plan;
  const prompt = `The user said: "${message}"

Decide ONE thing: is the user TEACHING a new durable fact about THEIR OWN world (their company, org structure, people, products, projects, plans, preferences, events, decisions) that should be remembered — as opposed to (a) asking a question, (b) a recall request, or (c) stating general/external/encyclopedic knowledge unrelated to them?

If YES, extract a self-contained THIRD-PERSON note. If NO, return {"save": false}.
Output JSON only:
{"save": true, "title": "<short noun phrase, NOT 'user said …'>", "content": "<self-contained third-person fact naming the real entities + any dates>", "tags": ["entity:<Name>", "topic:<t>"], "memory_type": "fact|decision|preference|event|goal|lesson", "confidence": 0.0-1.0}
OR {"save": false}`;
  try {
    const { parsed, usage } = await callJsonLLM({ messages: [{ role: 'user', content: prompt }], model, apiKey, maxTokens: 400, signal });
    if (parsed && parsed.save === true && parsed.title && parsed.content && Number(parsed.confidence || 0) >= 0.7) {
      plan.auto_save_intent = {
        title: String(parsed.title).slice(0, 200),
        content: String(parsed.content).slice(0, 2000),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 12) : [],
        memory_type: ['fact', 'decision', 'preference', 'event', 'goal', 'lesson'].includes(parsed.memory_type) ? parsed.memory_type : 'fact',
        confidence: Number(parsed.confidence),
        _rescued: true,
      };
      onEvent?.({ type: 'tool_call', name: 'save_classifier', arguments: JSON.stringify({ rescued: true, title: plan.auto_save_intent.title }) });
    }
    return { plan, usage };
  } catch {
    return { plan };
  }
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
  router,
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY required');
  if (!message) throw new Error('message required');
  // Tool-decision router (per-request `router:'tool'` OR env CHAT_ROUTER=tool).
  // Per-request lets us A/B test safely without flipping the deployment default.
  const useRouter = (router || process.env.CHAT_ROUTER) === 'tool';

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
    // CHAT_ROUTER=tool also bypasses it — the LLM router (STEP 2 ALT) decides
    // greetings/smalltalk in ANY language, so no regex routing is relied upon.
    const gateKind = (useRouter || hasBrowserContext) ? null : quickGateClassify(message);
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

    // STEP 2 — Plan (runs on INTERNAL_MODEL — fast/cheap reasoning).
    // CHAT_ROUTER=tool swaps the big JSON planStep for the tiny-tool routerPlan
    // (language-robust, ~token-cheap). Same { plan, usage } contract → every
    // downstream step is reused unchanged.
    const planResult = (useRouter)
      ? await routerPlan({
          message, history, language, assistantName, orgName,
          model: INTERNAL_MODEL, apiKey, signal: abortCtrl.signal, onEvent,
        })
      : await planStep({
          message, history, language, assistantName, orgName, hasBrowserContext,
          model: INTERNAL_MODEL, apiKey, signal: abortCtrl.signal, onEvent,
        });
    if (planResult.usage) usages.push(planResult.usage);
    const plan = planResult.plan;

    // Router direct-answer short-circuit: the router already wrote a
    // language-correct reply (no tool needed) → skip the extra answerDirectly
    // call + save-rescue. 1 LLM call total for greetings/smalltalk.
    if (useRouter && plan._direct_answer) {
      onEvent?.({ type: 'finish', text: plan._direct_answer });
      return {
        response: plan._direct_answer,
        sources: [], steps, evidence_used: [], confidence: 0.9, gaps: [],
        usage: sumUsage(usages), trace: finalizeTrace(trace, usages),
        assistant_name: assistantName || null,
      };
    }

    // Save-classifier rescue: catch declarative facts the small planner missed
    // (3rd-person "X is now Y" teachings). Runs on the strong answer model, only
    // when no save was already flagged AND the message is a statement (not a
    // question). Populates plan.auto_save_intent for the downstream save path.
    try {
      const rescue = await rescueAutoSaveIntent({ message, plan, model, apiKey, signal: abortCtrl.signal, onEvent });
      if (rescue?.usage) usages.push(rescue.usage);
    } catch { /* non-fatal */ }

    // Write-intent branch (post/send/draft slack message, etc).
    // Runs BEFORE the evidence/recall flow because the user wants to act,
    // not query memory. Planner-emitted action_intent takes priority over
    // the regex detector — the LLM catches indirect phrasing the regex
    // misses ("@team heads up", "ping the eng channel").
    // Read-intent connector activation. When the user explicitly names a
    // provider (Gmail, Google Docs, Gemini, Notion, Slack) without a clear
    // write verb, equip the READ tools so the agent can pull live data
    // alongside memory recall. The provider's group becomes active for
    // THIS turn only; primary system prompt stays small.
    const readIntents = detectReadIntents(message);
    let readToolkit = null;
    if (readIntents.length > 0 && ctx.prisma) {
      try {
        const { buildToolkitForUser } = await import('./toolkit-factory.js');
        readToolkit = await buildToolkitForUser({
          prisma: ctx.prisma,
          userId: ctx.userId,
          orgId: ctx.orgId,
          hivemindTools: [],
          persistentMemoryEngine: ctx.persistentMemoryEngine,
        });
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
          persistentMemoryEngine: ctx.persistentMemoryEngine,
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
            project_choice: sub.project_choice || null,
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
      if (!plan.save_intent.project_hint && !ctx.projectId && accessProjectIds.length >= 1) {
        let projects = [];
        try {
          if (ctx.persistentMemoryStore?.client?.project) {
            projects = await ctx.persistentMemoryStore.client.project.findMany({
              where: { id: { in: accessProjectIds }, orgId: ctx.orgId, status: 'active' },
              select: { id: true, name: true, slug: true, description: true },
              take: 24,
            });
          }
        } catch {}

        // Org memory_save_policy: 'org-wide' | 'ask' | 'private'(auto-classify).
        let policy = 'private';
        try {
          const org = await ctx.persistentMemoryStore?.client?.organization?.findUnique({
            where: { id: ctx.orgId }, select: { memorySavePolicy: true },
          });
          policy = org?.memorySavePolicy || 'private';
        } catch {}

        // Semantic classify against project name + DESCRIPTION (replaces the
        // old name-substring heuristic that ignored descriptions). Confident
        // match → assign silently; ambiguous → ask (suggested floated to top);
        // nothing fits → personal.
        const decision = await resolveProjectForSave({
          text: `${plan.save_intent.title || ''}\n${plan.save_intent.content || ''}\n${message || ''}`,
          projects,
          policy,
        });

        if (decision.decision === 'auto' && decision.projectName) {
          plan.save_intent.project_hint = decision.projectName;
          plan.ask_for_project = false;
          // fall through to the save branch (acks "(project: X)").
        } else if (decision.decision === 'ask') {
          const lang = languageName(language);
          const ordered = decision.suggestedId
            ? [...projects].sort((a, b) => (a.id === decision.suggestedId ? -1 : b.id === decision.suggestedId ? 1 : 0))
            : projects;
          const list = ordered
            .map(p => `• ${p.name}${p.id === decision.suggestedId ? ' (suggested)' : ''}`)
            .join('\n') || '(no projects found)';
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
        // 'personal' / 'org' → fall through to save (personal scope unless a
        // project_hint was just set above).
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
      // Deferred for project choice — ask (the FE renders project buttons),
      // do NOT claim it was saved.
      if (saveStep?.project_choice) {
        const askText = lang === 'German'  ? 'In welches Projekt soll ich das speichern?' :
                        lang === 'Spanish' ? '¿En qué proyecto lo guardo?' :
                        lang === 'French'  ? 'Dans quel projet dois-je l’enregistrer ?' :
                        'Which project should I save this to?';
        onEvent?.({ type: 'finish', text: askText });
        return {
          response: askText, sources: [], steps,
          evidence_used: [], confidence: 1.0, gaps: [],
          usage: sumUsage(usages),
          trace: finalizeTrace(trace, usages),
          assistant_name: assistantName || null,
          project_choice: saveStep.project_choice,
        };
      }
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
              const r = await dispatchTool('hivemind_recall', { query: q, mode: 'fact', limit: 8 }, ctx);
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
            const r = await dispatchTool('hivemind_recall', { query: q, mode: 'fact', limit: 8 }, ctx);
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
    // Save dispatch — fires on either:
    //   (a) explicit save: intent_kind === 'save' + save_intent populated
    //   (b) proactive auto-save: planner detected durable fact with
    //       confidence >= 0.75 in any intent_kind. The function checks
    //       both intents and prefers explicit save when both present.
    let recallProjectChoice = null;
    if ((plan.intent_kind === 'save' && plan.save_intent) || plan.auto_save_intent) {
      const saveStep = await maybeSaveOrUpdate({ plan, ctx, onEvent, message, history });
      if (saveStep) steps.push(saveStep);
      if (saveStep?.project_choice) recallProjectChoice = saveStep.project_choice;
    }

    onEvent?.({ type: 'finish', text: answer.response });

    return {
      project_choice: recallProjectChoice,
      // When a save was deferred for project choice, don't claim it was saved —
      // prompt the user to pick (the FE renders project buttons below).
      response:      recallProjectChoice
        ? 'Which project should I save this to? (pick below)'
        : answer.response,
      // Sources include recall-trace metadata so the FE can render WHY a
      // memory ranked (synth boost, x-cluster overlap, raw score). Helps
      // users trust the answer + spot mis-ranking.
      sources:       evidence.memories.slice(0, 10).map(m => {
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
          // Recall-trace metadata — FE renders chips per memory.
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
      }),
      // Typed graph edges between sources — FE renders edge chips.
      relationships: (evidence.relationships || []).slice(0, 30).map(e => ({
        from_id: e.from_id,
        to_id: e.to_id,
        type: e.type,
        confidence: typeof e.confidence === 'number' ? Number(e.confidence.toFixed(2)) : null,
      })),
      // Synthesis chains (insight-mode only) — FE renders claim + sources tree.
      synthesis_chains: (evidence.synthesis_chains || []).slice(0, 5),
      evidence_packets: (evidence.recall_packets || []).slice(0, 3),
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
