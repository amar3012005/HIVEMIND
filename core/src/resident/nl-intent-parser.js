// NL Intent Parser
//
// Turns user free-text ("clear all gmail noise from 2024", "find duplicate
// Notion notes", "delete stale meeting summaries") into a structured intent
// the hygiene scanner can consume:
//
//   {
//     categories: ['noise','duplicates','stale','orphans','contradictions','artifacts'],
//     filter: {
//       source_platform: 'gmail' | 'google_drive' | ...,
//       tags: [...],
//       date_from: ISOString,
//       date_to:   ISOString,
//       keywords:  [...],
//     },
//     safety_class: 'read' | 'mutate' | 'destructive',
//     summary: '<plain English of what user asked>'
//   }
//
// Uses Groq llama-3.3-70b w/ JSON-mode. Falls back to keyword regex when
// LLM unavailable so the page still works without a key set.

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.SWARM_INTENT_MODEL || 'llama-3.3-70b-versatile';
const NL_INTENT_ENABLED = process.env.SWARM_NL_INTENT !== 'false';

const ALL_CATEGORIES = ['duplicates', 'noise', 'stale', 'orphans', 'contradictions', 'artifacts'];

const SYSTEM_PROMPT = `You translate user requests about cleaning up a personal memory graph into a structured JSON intent. Reply ONLY with valid JSON matching this exact schema:

{
  "categories": [<subset of: "duplicates","noise","stale","orphans","contradictions","artifacts">],
  "filter": {
    "source_platform": "gmail" | "google_drive" | "google_calendar" | "google_docs" | "slack" | "notion" | "github" | "knowledge" | null,
    "tags": [<lowercase strings>],
    "date_from": "<ISO date or null>",
    "date_to":   "<ISO date or null>",
    "keywords":  [<lowercase strings>]
  },
  "safety_class": "read" | "mutate" | "destructive",
  "summary": "<one short sentence in plain English>"
}

Rules:
- safety_class:
    "read"        = only scan / report
    "mutate"      = archive / suppress / link (reversible)
    "destructive" = delete (hard, irreversible)
- If user says "delete" or "remove permanently" → destructive
- If user says "clean" / "archive" / "tidy" / "dedupe" → mutate
- If user says "find" / "show" / "audit" / "scan" → read
- Categories: include ONLY what the user asks for. "Clean gmail noise" → ["noise"]. "Find duplicates and stale notes" → ["duplicates","stale"]
- Unknown → include ALL categories
- date_from/date_to: ISO 8601 ("2024-01-01T00:00:00Z"). Use null when not specified.
- source_platform: null when not specified.
- summary: rephrase user intent in plain English, max 100 chars

Output JSON only — no markdown, no explanation.`;

const KEYWORD_CATEGORIES = {
  duplicate: 'duplicates',
  duplicates: 'duplicates',
  dupe: 'duplicates',
  dupes: 'duplicates',
  noise: 'noise',
  spam: 'noise',
  newsletter: 'noise',
  unsubscribe: 'noise',
  stale: 'stale',
  old: 'stale',
  outdated: 'stale',
  orphan: 'orphans',
  orphaned: 'orphans',
  disconnect: 'orphans',
  contradiction: 'contradictions',
  conflicting: 'contradictions',
  conflict: 'contradictions',
  artifact: 'artifacts',
  tara: 'artifacts',
  session: 'artifacts',
};

const SOURCE_KEYWORDS = {
  gmail: 'gmail',
  email: 'gmail',
  emails: 'gmail',
  drive: 'google_drive',
  google_drive: 'google_drive',
  docs: 'google_docs',
  google_docs: 'google_docs',
  calendar: 'google_calendar',
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  knowledge: 'knowledge',
  document: 'knowledge',
  documents: 'knowledge',
};

const DESTRUCTIVE_KEYWORDS = /\b(delete|remove permanently|wipe|purge|nuke)\b/i;
const MUTATE_KEYWORDS = /\b(clean|archive|tidy|dedupe|deduplicate|consolidate|suppress|hide|mark.*stale)\b/i;
const READ_KEYWORDS = /\b(find|show|audit|scan|inspect|report|list)\b/i;

/**
 * Build intent from a free-text goal.
 * @param {string} goal — user's NL prompt
 * @returns {Promise<Intent>}
 */
export async function parseIntent(goal) {
  if (!goal || typeof goal !== 'string' || goal.trim().length < 3) {
    return defaultIntent('No instruction given');
  }
  const trimmed = goal.trim();

  // Try LLM first
  if (NL_INTENT_ENABLED && GROQ_KEY) {
    try {
      const parsed = await llmParse(trimmed);
      if (parsed) return parsed;
    } catch (err) {
      console.warn('[nl-intent] LLM parse failed (falling back to keyword):', err.message);
    }
  }

  return keywordParse(trimmed);
}

async function llmParse(goal) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: goal },
      ],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);

  return normalizeIntent(parsed, goal);
}

function keywordParse(goal) {
  const lower = goal.toLowerCase();
  const tokens = lower.split(/[^a-z0-9_]+/).filter(Boolean);

  // Categories
  const cats = new Set();
  for (const tok of tokens) {
    const cat = KEYWORD_CATEGORIES[tok];
    if (cat) cats.add(cat);
  }
  if (cats.size === 0) ALL_CATEGORIES.forEach(c => cats.add(c));

  // Source platform
  let source = null;
  for (const tok of tokens) {
    if (SOURCE_KEYWORDS[tok]) { source = SOURCE_KEYWORDS[tok]; break; }
  }

  // Safety class — destructive > mutate > read
  let safety = 'read';
  if (DESTRUCTIVE_KEYWORDS.test(goal)) safety = 'destructive';
  else if (MUTATE_KEYWORDS.test(goal)) safety = 'mutate';
  else if (READ_KEYWORDS.test(goal)) safety = 'read';

  // Date range — match "2024", "last 30 days", "this year"
  const dateRange = extractDateRange(goal);

  return normalizeIntent({
    categories: [...cats],
    filter: {
      source_platform: source,
      tags: [],
      date_from: dateRange.from,
      date_to: dateRange.to,
      keywords: [],
    },
    safety_class: safety,
    summary: goal.slice(0, 100),
  }, goal);
}

function extractDateRange(goal) {
  const lower = goal.toLowerCase();
  const now = new Date();

  // explicit year: 2024, 2025, ...
  const yearMatch = goal.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    return { from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` };
  }

  // "last N days/weeks/months/years"
  const lastMatch = lower.match(/last\s+(\d+)\s+(day|week|month|year)s?/);
  if (lastMatch) {
    const n = parseInt(lastMatch[1], 10);
    const unit = lastMatch[2];
    const ms = { day: 86400000, week: 86400000 * 7, month: 86400000 * 30, year: 86400000 * 365 }[unit];
    return { from: new Date(now - n * ms).toISOString(), to: now.toISOString() };
  }

  // "this year" / "this month"
  if (/this year/i.test(lower)) return { from: `${now.getFullYear()}-01-01T00:00:00Z`, to: now.toISOString() };
  if (/this month/i.test(lower)) {
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return { from: `${now.getFullYear()}-${m}-01T00:00:00Z`, to: now.toISOString() };
  }

  return { from: null, to: null };
}

function normalizeIntent(parsed, original) {
  const cats = Array.isArray(parsed?.categories) && parsed.categories.length > 0
    ? parsed.categories.filter(c => ALL_CATEGORIES.includes(c))
    : ALL_CATEGORIES.slice();
  return {
    categories: cats.length > 0 ? cats : ALL_CATEGORIES.slice(),
    filter: {
      source_platform: parsed?.filter?.source_platform || null,
      tags: Array.isArray(parsed?.filter?.tags) ? parsed.filter.tags.map(t => String(t).toLowerCase()) : [],
      date_from: parsed?.filter?.date_from || null,
      date_to: parsed?.filter?.date_to || null,
      keywords: Array.isArray(parsed?.filter?.keywords) ? parsed.filter.keywords.map(k => String(k).toLowerCase()) : [],
    },
    safety_class: ['read', 'mutate', 'destructive'].includes(parsed?.safety_class) ? parsed.safety_class : 'read',
    summary: parsed?.summary || original.slice(0, 100),
    source: parsed && typeof parsed === 'object' && parsed.categories ? 'llm' : 'keyword',
  };
}

function defaultIntent(reason) {
  return {
    categories: ALL_CATEGORIES.slice(),
    filter: { source_platform: null, tags: [], date_from: null, date_to: null, keywords: [] },
    safety_class: 'read',
    summary: reason,
    source: 'default',
  };
}
