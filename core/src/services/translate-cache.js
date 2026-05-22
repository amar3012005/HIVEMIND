/**
 * Translate cache — bulk text → target language via Groq, w/ memory cache.
 *
 *   translateBatch({ texts, lang, apiKey }) → string[]
 *
 * Cache key: sha256(text + "::" + lang). Lives in process memory (Map),
 * keyed for the lifetime of the worker. Each unique pair is hit once.
 *
 * No-op when lang === 'en'.
 *
 * Strict JSON output from Groq (response_format: json_object). Model
 * preserves brand names verbatim + interpolation tokens.
 */

import crypto from 'node:crypto';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.HIVEMIND_TRANSLATE_MODEL || 'openai/gpt-oss-120b';

// LRU-ish bounded Map (Map preserves insertion order, evict head on grow).
const MAX_ENTRIES = Number(process.env.HIVEMIND_TRANSLATE_CACHE_SIZE || 50_000);
const cache = new Map();

function cacheKey(text, lang) {
  return crypto.createHash('sha256').update(text + '::' + lang).digest('hex');
}

function cacheGet(text, lang) {
  const k = cacheKey(text, lang);
  if (!cache.has(k)) return null;
  // refresh recency by re-inserting
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v);
  return v;
}

function cacheSet(text, lang, translation) {
  const k = cacheKey(text, lang);
  cache.set(k, translation);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

const LANG_NAMES = {
  de: 'German (Deutsch)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  nl: 'Dutch (Nederlands)',
  pl: 'Polish (Polski)',
  sk: 'Slovak (Slovenčina)',
  cs: 'Czech (Čeština)',
  ro: 'Romanian (Română)',
  uk: 'Ukrainian (Українська)',
  hu: 'Hungarian (Magyar)',
  sv: 'Swedish (Svenska)',
  da: 'Danish (Dansk)',
  fi: 'Finnish (Suomi)',
  no: 'Norwegian Bokmål',
  el: 'Greek (Ελληνικά)',
  tr: 'Turkish (Türkçe)',
  ru: 'Russian (Русский)',
  ar: 'Arabic (العربية, MSA)',
  he: 'Hebrew (עברית)',
  fa: 'Persian (فارسی)',
  hi: 'Hindi (हिन्दी)',
  bn: 'Bengali (বাংলা)',
  id: 'Indonesian (Bahasa Indonesia)',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ไทย)',
  zh: 'Simplified Chinese (简体中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
};

const SYS_PROMPT = (langName) => `You translate short UI strings from English into ${langName}.

RULES — non-negotiable:
1. Output STRICT JSON only. No preamble, no code fence, no comments.
2. Shape: {"translations": ["...", "...", ...]}. SAME order, SAME count as input.
3. Preserve interpolation tokens like {{name}}, {{count}}, <0>…</0>, <strong>…</strong>. Never translate inside double-brace or angle markers.
4. Keep brand names verbatim: HIVEMIND, HIVE, Talk to HIVE, ChatGPT, Claude, Gemini, Perplexity, Slack, Gmail, OAuth, MCP, TARA, Da'vinci.
5. Use natural ${langName} register a SaaS product would use — concise, slightly informal, no marketing fluff.
6. Keep punctuation style of the source. Keep ellipses (…) intact.
7. Acronyms (API, URL, SSO, EU, RTL, MCP, JSON) stay verbatim.`;

async function callGroq(messages, apiKey) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.15,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Groq ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '{}';
}

/**
 * @param {Object} opts
 * @param {string[]} opts.texts
 * @param {string}   opts.lang     — target lang code (de/fr/sk/…)
 * @param {string}   opts.apiKey   — GROQ_API_KEY
 * @returns {Promise<string[]>}
 */
export async function translateBatch({ texts, lang, apiKey }) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!lang || lang === 'en') return [...texts];

  const langName = LANG_NAMES[lang] || lang;
  const out = new Array(texts.length);
  const missingIdx = [];
  const missingTexts = [];

  // Cache pass.
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    if (typeof t !== 'string' || t.length === 0) {
      out[i] = t;
      continue;
    }
    const hit = cacheGet(t, lang);
    if (hit !== null) {
      out[i] = hit;
    } else {
      missingIdx.push(i);
      missingTexts.push(t);
    }
  }

  if (missingTexts.length === 0) return out;

  // Translate the missing ones in one Groq call.
  const raw = await callGroq(
    [
      { role: 'system', content: SYS_PROMPT(langName) },
      { role: 'user', content: JSON.stringify({ translations: missingTexts }) },
    ],
    apiKey
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fall back to returning the source on parse failure.
    for (const i of missingIdx) out[i] = texts[i];
    return out;
  }
  const arr = Array.isArray(parsed.translations) ? parsed.translations : null;
  if (!arr || arr.length !== missingTexts.length) {
    // Shape drift — fall back to source.
    for (const i of missingIdx) out[i] = texts[i];
    return out;
  }
  for (let k = 0; k < arr.length; k++) {
    const idx = missingIdx[k];
    const src = missingTexts[k];
    const dst = typeof arr[k] === 'string' ? arr[k] : src;
    out[idx] = dst;
    cacheSet(src, lang, dst);
  }
  return out;
}

export function clearCache() {
  cache.clear();
}

export function cacheStats() {
  return { size: cache.size, max: MAX_ENTRIES };
}
