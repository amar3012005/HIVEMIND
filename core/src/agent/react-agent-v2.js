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

import { TOOL_SCHEMAS, dispatchTool } from './tool-registry.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// LLM budgets per step. gpt-oss reasoning models consume hidden
// reasoning_tokens before content tokens; budgets are sized so even
// chatty reasoning leaves room for the actual JSON output.
const PLAN_MAX_TOKENS    = 1500;
const REFLECT_MAX_TOKENS = 1000;
const ANSWER_MAX_TOKENS  = 3000;
const DIRECT_MAX_TOKENS  = 800;
const TURN_BUDGET_MS     = Number(process.env.HIVEMIND_AGENT_TURN_BUDGET_MS || 45_000);

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

Output STRICT JSON (no prose, no code fence):
{
  "intents": ["..."],            // 1-3 short phrases describing what the user actually wants
  "sub_queries": ["..."],        // 1-4 English recall queries, each focused on ONE entity/concept
  "named_entities": ["..."],     // proper nouns the user mentioned (people, projects, files, brands)
  "needs_traverse": false,        // true if recall should follow graph edges to find related memories
  "needs_time_travel": false,     // true ONLY for explicit temporal: "as of X", "before Y", "what changed between"
  "time_travel": { "transaction_time": null, "valid_time": null }, // ISO timestamps if needs_time_travel
  "needs_web": false,             // true ONLY if user explicitly asks for current external info NOT in HIVEMIND
  "save_intent": null,            // {"title": "...", "content": "...", "tags": [...], "project_hint": "..."} if user said "save X". CONTENT MUST be a fully self-contained note — if the user used a pronoun ("save this", "save that"), resolve it by reading the previous turn in conversation history and copy the actual facts into content. NEVER emit save_intent with empty / pronoun-only content. If the referent is unrecoverable, set save_intent to null instead. If the user named a project ("save to Ashley", "in the SOLVIS project"), put that name in project_hint so the server can resolve it to a project_id.
  "ask_for_project": false,       // true if the user asked to save but did NOT specify a project AND no active project is set in the session. Server will respond by asking which project before saving.
  "update_intent": null,          // {"target_hint": "...", "new_value": "..."} if user corrected a prior fact
  "expected_evidence_types": []  // hint: ["fact"], ["decision"], ["preference"], etc
}

Rules:
  - sub_queries MUST be in ENGLISH even if user wrote in another language.
    Memory is stored cross-lingual; English queries hit best.
  - One entity per sub_query. "Should I add this to the deck with Dipesh?"
    → ["Dipesh", "pitch deck pricing"], not ["Dipesh pitch deck"].
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
  // Defensive defaults
  const plan = {
    intents:               Array.isArray(parsed.intents) ? parsed.intents.slice(0, 4) : [],
    sub_queries:           Array.isArray(parsed.sub_queries) ? parsed.sub_queries.filter(q => typeof q === 'string' && q.trim()).slice(0, 4) : [],
    named_entities:        Array.isArray(parsed.named_entities) ? parsed.named_entities.slice(0, 6) : [],
    needs_traverse:        !!parsed.needs_traverse,
    needs_time_travel:     !!parsed.needs_time_travel,
    time_travel:           parsed.time_travel || null,
    needs_web:             !!parsed.needs_web,
    save_intent:           parsed.save_intent || null,
    ask_for_project:       !!parsed.ask_for_project,
    update_intent:         parsed.update_intent || null,
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

  // (a) Parallel recall on each sub_query
  if (plan.sub_queries.length > 0) {
    const recallResults = await Promise.all(
      plan.sub_queries.map(async (q) => {
        try {
          const r = await dispatchTool('hivemind_recall', { query: q, mode: 'quick', limit: 5 }, ctx);
          const memCount = r?.memories?.length || 0;
          const liveCount = r?.live_count || 0;
          const evCount = r?.evidence_count || 0;
          const parts = [`${memCount} memories`];
          if (liveCount > 0) parts.push(`${liveCount} live`);
          if (evCount > 0) parts.push(`${evCount} evidence`);
          const summary = parts.join(' + ');
          recordTool('hivemind_recall', { query: q, mode: 'quick' }, summary, r);
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

  // (b) Time-travel
  if (plan.needs_time_travel && plan.time_travel && (plan.time_travel.transaction_time || plan.time_travel.valid_time)) {
    try {
      const args = {
        transaction_time: plan.time_travel.transaction_time || undefined,
        valid_time:       plan.time_travel.valid_time       || undefined,
        memory_query:     plan.sub_queries[0] || undefined,
      };
      const r = await dispatchTool('hivemind_at', args, ctx);
      recordTool('hivemind_at', args, `${(r?.memories?.length || 0)} historical memories`, r);
      for (const m of (r?.memories || [])) {
        if (m?.id && !memoriesById.has(m.id)) memoriesById.set(m.id, m);
      }
    } catch (err) {
      recordTool('hivemind_at', plan.time_travel, `error: ${err.message}`, null);
    }
  }

  // (c) Graph traversal for named entities (one hop per entity, capped)
  if (plan.needs_traverse && plan.named_entities.length > 0 && memoriesById.size > 0) {
    // Pick the top memory whose title/content names the first entity.
    const firstEnt = plan.named_entities[0].toLowerCase();
    const seed = [...memoriesById.values()].find(m => {
      const hay = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
      return hay.includes(firstEnt);
    });
    if (seed?.id) {
      try {
        const args = { memory_id: seed.id, depth: 2, relationship: 'all' };
        const r = await dispatchTool('hivemind_traverse_graph', args, ctx);
        const found = r?.related || r?.memories || [];
        recordTool('hivemind_traverse_graph', args, `${found.length} related`, r);
        for (const m of found.slice(0, 8)) {
          if (m?.id && !memoriesById.has(m.id)) memoriesById.set(m.id, m);
        }
      } catch (err) {
        recordTool('hivemind_traverse_graph', { seed: seed.id }, `error: ${err.message}`, null);
      }
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
   decisions / history in the EVIDENCE block OR the LIVE WORKSPACE block.
   Don't invent. When citing a LIVE WORKSPACE item, reference it naturally
   (e.g. "your last email from X on <date> said…"); don't paste raw IDs.
2. If EVIDENCE is empty or doesn't cover the question, say so plainly
   in the response ("I don't have notes on X yet"). Set confidence low.
3. NEVER paste a memory's content verbatim as the entire answer. NEVER
   reply with just a citation line or URL.
4. NEVER claim a third-party brand mentioned in memories IS us. Use
   first-person plural ("we", "our") only when an evidence row
   self-identifies our org ("we are X" / "our company is X").
5. Write in ${lang}, conversational and fluent. Keep brand names,
   project codes, file paths, URLs in original form.
6. Length: 2-5 sentences typical, longer only if user asked for a list
   or plan. No "Next steps:" / "How would you like to proceed?" boilerplate.
7. If the user message was a pure save/update/log intent (e.g. "save X",
   "remember Y"), acknowledge briefly ("Got it — saved.") in ${lang}
   without restating the saved content.`;
}

async function answerStep({ message, history, evidence, plan, language, assistantName, orgName, model, apiKey, signal }) {
  const sys = answerPrompt({ language, assistantName, orgName });

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
${evidenceLines || '(none)'}${liveLines ? `\n\nLIVE WORKSPACE (${(evidence.live || []).length} fresh items — Gmail / Drive / Calendar):\n${liveLines}` : ''}${evLines ? `\n\nDOCUMENT SEGMENTS (${(evidence.evidence || []).length} non-promoted KB chunks — full source text):\n${evLines}` : ''}

PLANNER INTENT: ${(plan.intents || []).join(' / ') || '(unspecified)'}

USER MESSAGE:
${message}`;

  const { parsed, usage } = await callJsonLLM({
    messages: [{ role: 'system', content: sys }, ...tail, { role: 'user', content: userBlock }],
    model, apiKey, maxTokens: ANSWER_MAX_TOKENS, signal,
  });

  return {
    response:      typeof parsed.response === 'string' ? parsed.response.trim() : '',
    evidence_used: Array.isArray(parsed.evidence_used) ? parsed.evidence_used : [],
    confidence:    Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    gaps:          Array.isArray(parsed.gaps) ? parsed.gaps : [],
    usage,
  };
}

// ── Save / update side-effects (best-effort, async-fire-and-forget) ───

async function maybeSaveOrUpdate({ plan, ctx, onEvent, message, history }) {
  if (plan.save_intent && typeof plan.save_intent === 'object') {
    // Resolve empty / pronoun-only content by harvesting conversation
    // history. User says "save this" → grab the most recent assistant turn
    // (their proposed text) OR the last substantive user message.
    let content = (plan.save_intent.content || '').trim();
    let title   = (plan.save_intent.title   || '').trim();

    const PRONOUN_ONLY = /^(this|that|it|the\s+(?:above|previous|prior))\.?$/i;
    if (!content || PRONOUN_ONLY.test(content)) {
      const turns = Array.isArray(history) ? history.slice(-6) : [];
      // Prefer last assistant draft (often the thing being saved)
      const lastAssistant = [...turns].reverse().find(h => h?.role === 'assistant' && typeof h.content === 'string' && h.content.trim().length > 20);
      const lastUserPrior = [...turns].reverse().find(h => h?.role === 'user' && typeof h.content === 'string' && h.content.trim() !== (message || '').trim() && h.content.trim().length > 20);
      content = (lastAssistant?.content || lastUserPrior?.content || '').trim();
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

  try {
    const hasBrowserContext = /<METADATA:(SELECTION|SECTION|BROWSER_CONTEXT)>/i.test(message || '');

    // STEP 1 — Quick gate (no LLM). Browser context bypasses the gate.
    const gateKind = hasBrowserContext ? null : quickGateClassify(message);
    if (gateKind) {
      onEvent?.({ type: 'gate', kind: gateKind });
      const { response, usage } = await answerDirectly({
        message, gateKind, language, assistantName, orgName, model, apiKey, signal: abortCtrl.signal,
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
        assistant_name: assistantName || null,
      };
    }

    // STEP 2 — Plan
    const planResult = await planStep({
      message, history, language, assistantName, orgName, hasBrowserContext,
      model, apiKey, signal: abortCtrl.signal, onEvent,
    });
    if (planResult.usage) usages.push(planResult.usage);
    const plan = planResult.plan;

    // Save intent without a resolvable project scope → ASK first.
    // Triggered when: planner flagged ask_for_project, no project_hint, no
    // session project (ctx.projectId), and the user's accessContext has
    // multiple projects to choose from. We respond with a question instead
    // of guessing or silently dropping into org scope.
    if (plan.save_intent && (plan.ask_for_project || (!plan.save_intent.project_hint && !ctx.projectId))) {
      const accessProjectIds = (ctx.accessContext?.projectIds) || [];
      if (!plan.save_intent.project_hint && !ctx.projectId && accessProjectIds.length > 1) {
        const lang = languageName(language);
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
          assistant_name: assistantName || null,
        };
      }
    }

    // Pure save intent (no recall needed) — write the memory then ack.
    if (plan.save_intent && plan.sub_queries.length === 0) {
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
        assistant_name: assistantName || null,
      };
    }

    // Direct answer if planner left sub_queries empty AND no side-effects.
    // Skip the evidence-gated answer step — its grounding rules cause
    // the model to refuse / return empty for self-contained questions
    // like '2+2' that have no recall context to lean on.
    if (plan.sub_queries.length === 0 && !plan.save_intent && !plan.needs_web) {
      const { response, usage } = await answerDirectly({
        message, gateKind: 'general', language, assistantName, orgName,
        model, apiKey, signal: abortCtrl.signal,
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
        assistant_name: assistantName || null,
      };
    }

    // STEP 3 — Evidence
    const evidence = await gatherEvidence({ plan, ctx, onEvent });
    steps.push(...evidence.steps);

    // STEP 4 — Reflect (only when evidence sparse + plan asked for stuff)
    if (evidence.memories.length < 2 && plan.sub_queries.length > 0) {
      try {
        const reflect = await reflectStep({
          message, plan, evidence, language, model, apiKey, signal: abortCtrl.signal,
        });
        if (reflect.usage) usages.push(reflect.usage);
        if (reflect.needs_more && reflect.extra_queries.length > 0) {
          onEvent?.({ type: 'reflect', extra_queries: reflect.extra_queries, reason: reflect.reason });
          const extras = await Promise.all(reflect.extra_queries.map(async (q) => {
            try {
              const r = await dispatchTool('hivemind_recall', { query: q, mode: 'quick', limit: 5 }, ctx);
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

    // STEP 5 — Answer
    const answer = await answerStep({
      message, history, evidence, plan, language, assistantName, orgName,
      model, apiKey, signal: abortCtrl.signal,
    });
    if (answer.usage) usages.push(answer.usage);

    // STEP 6 — Save intent fire-and-forget (don't block response)
    if (plan.save_intent) {
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

// Re-export TOOL_SCHEMAS so callers stay agnostic of which agent runs.
export { TOOL_SCHEMAS };
