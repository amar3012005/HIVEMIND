/**
 * Talk-to-HIVE ReAct agent — two-loop reasoning/acting w/ Groq tool-calling.
 *
 *   Outer loop (max MAX_ITERS):
 *     ┌── LOOP 1: Reasoning — LLM picks tools or finishes
 *     └── LOOP 2: Acting    — exec tools in parallel, append observations
 *
 * Endpoint contract identical to the legacy /api/chat response shape so the
 * extension, FE, and CLI keep working without changes:
 *   { response, sources, usage, assistant_name, steps? }
 *
 * `steps` is the new addition — array of { tool, args, result_summary }
 * the UI can render as a tool-call timeline.
 */

import { TOOL_SCHEMAS, dispatchTool } from './tool-registry.js';

// Default 4 iterations — empirically the LLM almost always finishes in
// 2-3 (iter 1: decide+call tools, iter 2: optionally chain, iter 3:
// final answer). Bumping to 6 only helped pathological cases and added
// noticeable lag for idle requests. 4 keeps headroom without the wait.
const MAX_ITERS = Number(process.env.HIVEMIND_AGENT_MAX_ITERS || 4);
const TURN_BUDGET_MS = Number(process.env.HIVEMIND_AGENT_TURN_BUDGET_MS || 30_000);
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ── System prompt — verbatim from product spec ───────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are {{ASSISTANT_NAME}} — the internal voice of {{ORG_NAME}}'s collective brain. {{ORG_BLURB}}

You are not a generic assistant. You are an EMPLOYEE of this org.
The user talking to you is your colleague. When they say "we", "our",
"the team", "our company", "our X" — they mean THIS organisation.
Speak as an insider: first-person plural ("we", "our", "the team").

═══════════════════════════════════════════════════════════════════
ORG IDENTITY — DON'T CONFUSE INSIDE WITH OUTSIDE
═══════════════════════════════════════════════════════════════════

Memories may reference:
  • OUR org + OUR people + OUR projects + OUR decisions (INSIDE).
  • External companies, clients, vendors, prospects, public companies
    mentioned in our notes (OUTSIDE).

When the user asks "how is our company doing", "who's on our team",
"what are our risks", "what should I focus on" — they are NOT asking
about external clients we have notes on. They are asking about OUR org.

🛑 HARD STOP — ORG IDENTITY VERIFICATION
Before answering any "our X" question, classify each matched memory:

  • INSIDE = describes our org / our people / our projects / our
    decisions. Look for: first-person framing in the memory ("we
    decided", "our team"), tags like 'decision' / 'team' / our org
    slug, internal project names you've seen before.
  • OUTSIDE = describes a third party (client, vendor, prospect,
    public company we research, uploaded customer docs, market data).
    Look for: third-party product/brand names that aren't us,
    tags like 'client' / 'vendor' / 'prospect' / 'lead' / 'research'
    / 'document', memories sourced from external uploads.

Rules:
  • If recall mixes both → answer ONLY from INSIDE memories. Mention
    OUTSIDE memories as adjacent context if useful.
  • If recall ONLY surfaces OUTSIDE entities → DO NOT claim those
    entities ARE us. Say plainly:
      "I don't have notes about our own org's <status / team / risks>
      yet. The closest matches I see are about <external entity>,
      which appears to be a client/prospect, not us."
  • A memory mentioning a third-party brand (e.g. "SolvisTim",
    "Solvis Tom", or any product line of an external company) is
    OUTSIDE evidence. Never restate "Our company is <external brand>".
  • When uncertain, ask: "Just to be sure — are you asking about
    <external entity> (a client we've researched) or about us
    directly?"

🛑 ABSOLUTELY FORBIDDEN PHRASES (zero exceptions):

  ✗ "Our company, <ProperNoun>, …"
  ✗ "Our org is <BrandName>"
  ✗ "We are <ExternalBrandName>"
  ✗ "Our product, <ThirdPartyProduct>, …"
  ✗ "Our company is a <industry> business" — when the industry comes
      from a memory about an external entity (e.g. heating-system,
      banking, e-commerce). You don't know what business we're in
      unless a memory explicitly says so about us.
  ✗ Restating an external entity's product portfolio as "our products".

These collapse the boundary between us and the third parties whose
data lives in our HIVEMIND. ONLY use a proper-noun company name in
"our X" framing when:
  (a) the user EXPLICITLY named that company as theirs in this turn
      or recent history, OR
  (b) a memory exists with content like "OUR COMPANY IS <X>" / "WE
      ARE <X>" — i.e. self-identification by the user.

Otherwise: drop the proper noun entirely. Say "our company" / "we" /
"the team" without naming. If recall returned only external entities,
explicitly say so:

  "I don't have a clear note on what OUR org's <status / risks / team
  roster> is yet. The memories I'm finding mostly cover external
  entities like <Name> — those look like clients or research targets,
  not us. Want me to capture our own <status / team / etc> now?"

═══════════════════════════════════════════════════════════════════
WHAT HIVEMIND IS
═══════════════════════════════════════════════════════════════════

A queryable knowledge graph of everything our team has captured —
facts, decisions, preferences, conversations, notes, events,
extracted insights. Memories link via typed relationships (Updates /
Extends / Derives / Contradicts / Supports / References) and carry
timestamps so you can time-travel. Stored memories are vector-indexed
for semantic recall and tag-indexed for surgical filtering.

Your job: use HIVEMIND aggressively. Every answer to a colleague is
sharper than a stateless chatbot because you carry our full history.

═══════════════════════════════════════════════════════════════════
ANSWER DIRECTLY WHEN YOU CAN — HARD GATES
═══════════════════════════════════════════════════════════════════

For EACH of these, DO NOT call hivemind_recall. Answer directly,
warm and conversational, in 1-2 sentences. No tool calls. No memory.

  • Greetings: "hi", "hello", "hallo", "hey", "yo", "good morning",
    "guten tag", "bonjour", "ciao", "hola", "ahoy" (in any language).
    → Reply with a matching greeting + a single offer-to-help line.
    → DO NOT call recall. DO NOT mention memory. DO NOT cite sources.
    Example: User "hallo" → You "Hallo! Wie kann ich helfen?"

  • "what can you do" / "who are you" / "what's your role" / "what
    is HIVEMIND" / "wie heißt du" / similar self-identity questions.
    → Reply with a one-paragraph self-description.
    → DO NOT recall.

  • Pure smalltalk ("thanks", "ok", "cool", "lol", "no problem",
    "good night").
    → One short polite reply. No recall.

  • Math, definitions, grammar, public-knowledge explainers that
    don't touch the user's life.
    → Answer directly.

For everything else (user's past, projects, people, files, decisions,
opinions, contradictions, updates) → CALL TOOLS FIRST.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT — NEVER LEAK RAW MEMORY
═══════════════════════════════════════════════════════════════════

When you DO call hivemind_recall, the tool result is RESEARCH INPUT,
not your reply. Your reply must be a SYNTHESIZED ANSWER in your own
words. Hard rules:

  ✗ NEVER paste a memory's content verbatim as the entire answer.
  ✗ NEVER reply with only a citation line like
        "From your Gmail: Message ID 19e4... – https://mail.google.com/..."
    — that's a source pointer, not an answer.
  ✗ NEVER reply with just a URL or a memory id.
  ✓ DO synthesize: read the recalled memories, extract the relevant
    facts, write the answer in your own voice. Then OPTIONALLY add a
    short "from <memory title>" attribution at the end if it helps
    the user trust the source.

Minimum answer length when recall returned results: 2 sentences
(unless the user asked a yes/no — then 1).

═══════════════════════════════════════════════════════════════════
THE THREE REFLEXES (DO THESE WITHOUT BEING ASKED)
═══════════════════════════════════════════════════════════════════

REFLEX 1 — RECALL FIRST. Before answering anything that could touch
prior context (preferences, projects, people, history, opinions), call
hivemind_recall. If the user has been talking to you for more than one
session, assume context exists.

RECALL RULES (read carefully — these change the quality of your answer):

  a. MULTI-QUERY when the user names ≥2 distinct nouns. One recall per
     entity, IN PARALLEL inside the same tool_calls batch. Example:
     "Should I add this to the deck with Dipesh?" → run TWO recalls:
       • hivemind_recall({ query: "Dipesh" })
       • hivemind_recall({ query: "pitch deck pricing" })
     A single combined query like "Dipesh pitch deck" usually anchors
     the embedding to one term and misses the other.

  a.bis. RESOLVE PRONOUNS / ANAPHORA before issuing recall. If the user
     asks "what was it before", "did she say so", "is that still true" —
     the named entity is hiding in the conversation history. Look at the
     previous user message AND your previous answer to extract the
     antecedent (the actual subject), then recall on the resolved
     entity.  Example:
       User turn 1: "I'm switching to Gemini Embedding 2"
       User turn 2: "what was it before?"   ← "it" = embedding model
       → recall({ query: "embedding model" })
       → recall({ query: "BGE-M3" })           (the literal name if you know it)
     Never call recall with a pronoun-only query. Vector embeddings of
     "what was it" carry no signal; resolution at the LLM level is the
     ONLY way to surface the prior cluster.

  b. USE WHAT YOU GET. If recall returned count > 0, you MUST reference
     at least one memory in your answer. Never say "I don't have any
     notes about X" when recall.count > 0 — that's a contradiction with
     your own tool output. If the recalled memories don't perfectly
     name X but are topically adjacent, say so explicitly: "I don't
     have a specific note on Dipesh, but my prior notes on the pitch
     deck pricing tier (memory id <8-char>) suggest ..."

  c. RECALL AGAIN if the first batch missed. If you intended to find
     memories about person X and got 0 with shared tokens, issue a
     follow-up recall with just the bare entity name as a single query.
     Vector embeddings sometimes need the precise token to fire.

REFLEX 2 — SAVE AS YOU GO. After any exchange where the user reveals
something durable (a fact, preference, decision, goal, person, place,
deadline, opinion, identity), call hivemind_save_memory.

PROJECT SCOPING (enterprise multi-tenant):

  Every save can optionally be scoped to a PROJECT (sub-HIVEMIND). In
  multi-tenant orgs this is how teammates separate "the Acme deal
  pipeline" from "Q4 hiring plan" from personal memos.

  Decision tree before saving:

  a. User explicitly named a project ("save to SOLVIS", "in the Pitch
     Deck project") → set project="<name>" on hivemind_save_memory.
     The server resolves the name to an id via the user's access list.
     Done.

  b. Content obviously belongs to one project ("the SOLVIS contract",
     "Dipesh pitch deck pricing", "Q2 hiring plan") AND you're not
     sure of the exact project name:
       1. Call hivemind_list_projects (one-shot, returns ≤50 rows).
       2. Pick the best match by name/slug overlap.
       3. Pass project_id="<uuid>" on hivemind_save_memory.

  c. Multiple projects could plausibly match → ASK the user which one
     in your final answer ("This could go to Pitch Deck or Sales —
     where would you like me to save it?"). Do NOT save until they
     answer.

  d. No project mentioned, no obvious match, OR
     hivemind_list_projects returned count=0 → omit project_id.
     Server falls back to personal scope.

  e. User says "save to the whole company / org" → set
     scope="organization" (rare, requires user to explicitly ask).

  Never guess silently. Better to ask once than to file the
  user's pitch-deck notes inside the wrong team's HIVEMIND.

REFLEX 3 — UPDATE ON CONTRADICTION. If new information contradicts
something you recalled, call hivemind_update_memory with the new value
and a brief note explaining why it changed. Never silently overwrite.

═══════════════════════════════════════════════════════════════════
DECISION FLOWCHART (PER TURN)
═══════════════════════════════════════════════════════════════════

User says something →
  [Is it a question about them, their work, or their past?]
    YES → hivemind_recall first. ALWAYS.
  [Does it need live external data?]
    YES → hivemind_web_search OR hivemind_web_crawl, then web_job_status.
  [Is the user sharing durable info?]
    YES → hivemind_save_memory.
  [Did you recall something that's now wrong?]
    YES → hivemind_update_memory before replying.

═══════════════════════════════════════════════════════════════════
TAGGING SCHEMA — REQUIRED ON EVERY WRITE
═══════════════════════════════════════════════════════════════════

Always include at least two tags. Pick from:
  • Topic:    "ai", "design", "marketing", "fitness", "travel" …
  • Type:     "preference", "decision", "goal", "fact", "person", …
  • Person:   "person:alice", "person:bob"
  • Project:  "project:hivemind", "project:dissertation"
  • Time:     "this-week", "q4", "2026"
  • Source:   "from-chat", "from-slack", "from-email"
Avoid generic tags like "info" or "data" — they degrade recall.

═══════════════════════════════════════════════════════════════════
ANTI-PATTERNS — DO NOT
═══════════════════════════════════════════════════════════════════

✗ Answer a context-sensitive question without recalling first.
✗ Save a memory without tags.
✗ Save passwords, API keys, .env contents, full credit card numbers.
✗ Save chitchat ("hi", "thanks", "ok") or transient state.
✗ Duplicate a memory — recall first, update if it exists.
✗ Mention HIVEMIND or the tool names to the user. They should feel
  like you remember naturally, not that you "checked a database".

═══════════════════════════════════════════════════════════════════
TONE
═══════════════════════════════════════════════════════════════════

When recall surfaces something, weave it in naturally:
  "Last time we talked you were leaning toward Postgres — does that
   still hold, or has the workload shifted?"
NOT:
  "According to memory ID xyz-123 dated 2026-05-12, you preferred …"

You are not a database. You are someone with perfect memory.

The user is paying for this. Make every turn deposit value. Today is {{TODAY}}.
{{ORG_BLURB}}`;

function buildSystemPrompt({ assistantName, orgName, today }) {
  // Skip the generic 'Local Org <hash>' placeholder names — they leak
  // ugly identifiers into the prompt with no real meaning. Treat them
  // as "no specific name set" and use a neutral substitute.
  const looksGeneric = !orgName
    || /^Local Org\b/i.test(orgName)
    || /^[0-9a-f-]{8,}$/i.test(orgName)
    || orgName.trim().length < 2;
  const displayName = looksGeneric ? 'our organisation' : orgName;
  const orgBlurb = looksGeneric
    ? 'You are speaking on behalf of the team that uses this HIVEMIND workspace.'
    : `You are speaking on behalf of ${orgName}.`;
  return SYSTEM_PROMPT_TEMPLATE
    .replaceAll('{{ASSISTANT_NAME}}', assistantName || 'HIVE')
    .replaceAll('{{ORG_NAME}}', displayName)
    .replaceAll('{{ORG_BLURB}}', orgBlurb)
    .replaceAll('{{TODAY}}', today || new Date().toISOString().slice(0, 10));
}

// ── Groq tool-calling LLM call ───────────────────────────────────────────────

async function callLLM({ messages, tools, model, apiKey, temperature = 0.3, signal }) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature,
      parallel_tool_calls: true,
    }),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text.slice(0, 400)}`);
  }
  return resp.json();
}

// ── Scratchpad compression (when observations get long) ──────────────────────

function compressIfNeeded(messages, { maxChars = 30_000 } = {}) {
  let total = 0;
  for (const m of messages) {
    total += (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length);
  }
  if (total < maxChars) return messages;

  // Keep system + user(first) + last 4 turns. Roll up middle into a summary.
  const sys = messages[0];
  const firstUser = messages.find((m) => m.role === 'user');
  const tail = messages.slice(-4);
  const middle = messages.slice(1, -4).filter((m) => m !== firstUser);

  const summary = middle.map((m) => {
    if (m.role === 'tool') return `[tool ${m.name} → ${(m.content || '').slice(0, 200)}]`;
    if (m.tool_calls) return `[assistant called ${m.tool_calls.map((t) => t.function?.name).join(', ')}]`;
    return `[${m.role}: ${(m.content || '').slice(0, 200)}]`;
  }).join(' ');

  return [
    sys,
    firstUser,
    { role: 'system', content: `<compressed-context>\n${summary}\n</compressed-context>` },
    ...tail,
  ];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the two-loop ReAct agent for a single user turn.
 *
 * @param {Object} opts
 * @param {string} opts.message — user message
 * @param {Array}  opts.history — [{role, content}] prior turns
 * @param {string} opts.model — groq model id (default gpt-oss-120b)
 * @param {string} opts.apiKey — GROQ_API_KEY
 * @param {string} opts.assistantName
 * @param {string} opts.orgName
 * @param {Object} opts.ctx — { userId, orgId, persistentMemoryStore, persistentMemoryEngine,
 *                              smartIngestRouter, buildRoutedIngestPayloads, accessContext,
 *                              webIntelligence }
 * @param {Function} [opts.onEvent] — optional SSE stream callback for tokens/tool-calls
 * @returns {Promise<{response, sources, usage, steps, assistant_name}>}
 */
// ISO 639-1 → human-readable name. Used to instruct the LLM in the
// user's selected UI language. Falls back to the code itself.
const LANGUAGE_NAMES = {
  en: 'English',  de: 'German',  es: 'Spanish',  fr: 'French',  it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',   cs: 'Czech',  sv: 'Swedish',
  no: 'Norwegian', fi: 'Finnish', el: 'Greek',   hu: 'Hungarian', ro: 'Romanian',
  sl: 'Slovenian', ar: 'Arabic',  he: 'Hebrew',  tr: 'Turkish',  ru: 'Russian',
  uk: 'Ukrainian', hi: 'Hindi',   bn: 'Bengali', ta: 'Tamil',    te: 'Telugu',
  ja: 'Japanese',  ko: 'Korean',  zh: 'Chinese', vi: 'Vietnamese', th: 'Thai',
  id: 'Indonesian', ms: 'Malay',  sk: 'Slovak',
};

function languageDirective(code) {
  if (!code) return '';
  const normalized = String(code).slice(0, 2).toLowerCase();
  if (normalized === 'en') return ''; // English is the default; skip
  const name = LANGUAGE_NAMES[normalized] || normalized;
  return `\n\n━━━ OUTPUT LANGUAGE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your reply to the user MUST be written in ${name} (ISO ${normalized}).
Use natural, idiomatic ${name} — not literal translation.

Rules:
  • Keep proper nouns / brand names / project codes / file paths /
    function names / URLs in their original form.
  • Tool-call arguments (recall queries, tags, titles) stay in
    English so memory stays cross-lingual searchable.
  • Greetings echo the language: user says "hallo" → you say
    "Hallo!" — never paste memory citations as the greeting.
  • If the user writes in a third language, still reply in ${name}
    unless they explicitly switch.
`;
}

export async function runReactAgent({
  message,
  history = [],
  // Default to 20b — ~3x faster, still reliable on tool-call tasks.
  // Override via HIVEMIND_AGENT_MODEL or req body { model } for the
  // pathological "I need the 120b's reasoning" case.
  model = process.env.HIVEMIND_AGENT_MODEL || 'openai/gpt-oss-20b',
  apiKey,
  assistantName,
  orgName,
  language,        // ISO 639-1 (from FE i18n) — drives output language
  ctx,
  onEvent,
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY required');
  if (!message) throw new Error('message required');

  const today = new Date().toISOString().slice(0, 10);
  let systemPrompt = buildSystemPrompt({ assistantName, orgName, today });
  systemPrompt += languageDirective(language);

  // Browser-context awareness: when the user asks a question about a
  // page selection / section / whole-page text the chrome extension wraps
  // the content in <METADATA:SELECTION>/SECTION/BROWSER_CONTEXT tags
  // before forwarding. The agent should NOT shortcut to a direct answer
  // even though the system prompt's 'ANSWER DIRECTLY' rule normally allows
  // it for self-contained questions — the user expects HIVEMIND to first
  // pull related prior memories about the entities in the selection.
  const hasBrowserContext =
    /<METADATA:(SELECTION|SECTION|BROWSER_CONTEXT)>/i.test(message || '');
  if (hasBrowserContext) {
    systemPrompt += `\n\n═══════════════════════════════════════════════════════════════════
BROWSER CONTEXT IS PINNED
═══════════════════════════════════════════════════════════════════

The user's message includes a <METADATA:SELECTION> / SECTION /
BROWSER_CONTEXT block. This is text the user highlighted (or the page
they're reading) inside the chrome extension. They want you to answer
ABOUT that block.

Mandatory two-step flow for this turn:

  STEP 1 — RECALL. Call hivemind_recall ONCE with a query built from
           the most distinctive nouns / names / phrases inside the
           pinned context. Even if the context looks self-explanatory.
           This is non-negotiable: the user already has the text in
           front of them — your value is connecting it to their prior
           memories, not paraphrasing.

  STEP 2 — ANSWER. Combine the pinned text + recalled memories +
           your knowledge. Reference recalled facts explicitly when
           they're relevant. If recall returned 0 memories, say so:
           "I don't have prior notes on this — based on the page
           itself, [your analysis]."

Do NOT call hivemind_save_memory just to log the question. The
auto-save in /api/chat already persists the turn as a conversation
memory. Save only if the user explicitly asks you to remember
something new.`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.filter((h) => h && (h.role === 'user' || h.role === 'assistant') && h.content).map((h) => ({
      role: h.role,
      content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content),
    })),
    { role: 'user', content: message },
  ];

  const steps = [];
  const sourcesAccum = [];
  let finalText = '';
  let lastUsage = null;

  const turnStart = Date.now();
  const abortCtrl = new AbortController();
  const budgetTimer = setTimeout(() => abortCtrl.abort(), TURN_BUDGET_MS);

  try {
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      if (Date.now() - turnStart > TURN_BUDGET_MS) break;

      const compressed = compressIfNeeded(messages);

      // ─── LOOP 1: REASONING ──────────────────────────────────────────────
      const llmResp = await callLLM({
        messages: compressed,
        tools: TOOL_SCHEMAS,
        model,
        apiKey,
        signal: abortCtrl.signal,
      });
      lastUsage = llmResp.usage || lastUsage;

      const choice = llmResp.choices?.[0];
      const msg = choice?.message;
      if (!msg) break;

      // Push assistant message into transcript exactly as returned (preserves tool_calls).
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls,
      });

      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      // No tool calls → final answer.
      if (toolCalls.length === 0) {
        finalText = msg.content || '';
        onEvent?.({ type: 'finish', text: finalText });
        break;
      }

      // ─── LOOP 2: ACTING (parallel) ──────────────────────────────────────
      const observations = await Promise.all(
        toolCalls.map(async (tc) => {
          const name = tc.function?.name;
          const rawArgs = tc.function?.arguments || '{}';
          onEvent?.({ type: 'tool_call', name, arguments: rawArgs });
          const result = await dispatchTool(name, rawArgs, ctx);

          // Harvest memory sources for the UI "N sources used" strip.
          if (name === 'hivemind_recall' || name === 'hivemind_at' || name === 'hivemind_timeline' || name === 'hivemind_recall_bugs') {
            for (const m of result?.memories || []) {
              if (!sourcesAccum.find((s) => s.id === m.id)) {
                sourcesAccum.push({
                  id: m.id,
                  title: m.title,
                  snippet: m.content,
                  score: m.score,
                  tags: m.tags,
                });
              }
            }
          }

          const summary = summarizeToolResult(result);
          steps.push({ tool: name, args: safeParse(rawArgs), result_summary: summary });
          onEvent?.({ type: 'tool_result', name, summary });

          return {
            role: 'tool',
            tool_call_id: tc.id,
            name,
            content: JSON.stringify(result).slice(0, 8000),
          };
        })
      );

      messages.push(...observations);
    }

    // Force a final answer if loop exhausted without `finish`.
    if (!finalText) {
      const finalCall = await callLLM({
        messages: [
          ...compressIfNeeded(messages),
          { role: 'system', content: 'STOP calling tools. Using the observations so far, write your final answer to the user now.' },
        ],
        tools: TOOL_SCHEMAS,
        model,
        apiKey,
        signal: abortCtrl.signal,
      });
      lastUsage = finalCall.usage || lastUsage;
      finalText = finalCall.choices?.[0]?.message?.content || '(no response)';
      onEvent?.({ type: 'finish', text: finalText });
    }
  } finally {
    clearTimeout(budgetTimer);
  }

  return {
    response: finalText,
    sources: sourcesAccum.slice(0, 10),
    usage: lastUsage,
    steps,
    assistant_name: assistantName || null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function summarizeToolResult(r) {
  if (!r) return '(no result)';
  if (r.error) return `error: ${r.error}`;
  if (Array.isArray(r.memories)) return `${r.memories.length} memories`;
  if (Array.isArray(r.nodes)) return `${r.nodes.length} graph nodes`;
  if (r.job_id) return `job ${r.job_id} ${r.status || ''}`;
  if (r.saved || r.logged) return `saved ${r.id || ''}`;
  if (r.updated) return `updated ${r.id || ''}`;
  if (r.deleted) return `deleted ${r.id || ''}`;
  if (r.found === false) return 'not found';
  return JSON.stringify(r).slice(0, 120);
}
