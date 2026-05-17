// LLM-Targeted Memory Scanner
//
// When user types a natural-language instruction at AgentSwarm
// ("delete memories about Solvis", "find facts about pricing I corrected",
// "clean up old benchmark notes from last month"), this module asks an LLM
// to evaluate each candidate memory against that instruction and decide
// whether it should be a proposal.
//
// Replaces brittle keyword/regex heuristics. Each agent's job stays focused:
//   Faraday  — surface candidates that semantically match the user's intent
//   Feynman  — explain WHY each match is relevant + estimate impact
//   Turing   — recommend a safe action (delete / archive / link / leave)
//
// All proposals go to the user for approval. No autonomous writes.

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.SWARM_TARGETED_MODEL || 'llama-3.3-70b-versatile';
const BATCH = parseInt(process.env.SWARM_TARGETED_BATCH || '15', 10);
const MAX_MEMS = parseInt(process.env.SWARM_TARGETED_MAX || '300', 10);

/**
 * @typedef {Object} TargetedMatch
 * @property {string} id            - memory id
 * @property {boolean} match        - LLM says this matches the user's intent
 * @property {number} confidence    - 0..1
 * @property {string} reason        - plain English why it matches
 * @property {string} action        - "delete" | "archive" | "link_update_chain" | "leave"
 */

const SYSTEM_PROMPT = `You evaluate memories against a user's cleanup instruction.

Input: a natural-language instruction + a list of memories (id, title, content snippet, tags).

For each memory output:
{
  "id": <string>,
  "match": <true|false>,
  "confidence": <0..1>,
  "reason": "<one short sentence>",
  "action": "delete" | "archive" | "link_update_chain" | "leave"
}

Rules:
- match=true ONLY when the memory clearly fits the instruction
- confidence reflects how clear the match is
- action follows the safety class:
    instruction asks to delete/remove/purge   → "delete"   (when match)
    instruction asks to archive/clean/tidy    → "archive"  (when match)
    instruction asks to link updates/correct  → "link_update_chain" (when match, and you can identify which other memory it supersedes — leave that for the user)
    no match                                  → "leave"
- Be conservative. When unsure, set match=false. Do NOT match memories
  that only weakly relate. The user will see your reasons.
- reason must be specific (cite content or tag), not generic.

Output JSON: { "evaluations": [<TargetedMatch>, ...] }
ONLY JSON. No markdown, no prose.`;

function snippet(s, n = 240) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function callGroq(goal, batch) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set');
  const userMsg = JSON.stringify({
    instruction: goal,
    memories: batch.map(m => ({
      id: m.id,
      title: m.title || '',
      content: snippet(m.content, 280),
      tags: (m.tags || []).slice(0, 8),
      created_at: m.created_at,
    })),
  });
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.evaluations) ? parsed.evaluations : [];
}

/**
 * Run an LLM evaluator over the candidate memory pool against the user's
 * natural-language instruction. Returns matched evaluations only.
 *
 * @param {string} goal — user's NL instruction (raw)
 * @param {Array} memories — candidate pool, already pre-filtered by tenant
 * @param {Object} [opts]
 * @param {number} [opts.batchSize] — per LLM call
 * @param {number} [opts.maxMemories] — overall cap
 * @returns {Promise<Array<TargetedMatch>>}
 */
export async function evaluateMemoriesAgainstGoal(goal, memories, opts = {}) {
  if (!goal || !Array.isArray(memories) || memories.length === 0) return [];
  if (!GROQ_KEY) {
    console.warn('[llm-targeted] GROQ_API_KEY not set — returning empty');
    return [];
  }
  const pool = memories.slice(0, opts.maxMemories || MAX_MEMS);
  const batchSize = opts.batchSize || BATCH;
  const matches = [];
  for (let i = 0; i < pool.length; i += batchSize) {
    const batch = pool.slice(i, i + batchSize);
    try {
      const evals = await callGroq(goal, batch);
      for (const ev of evals) {
        if (!ev || typeof ev.id !== 'string') continue;
        if (ev.match === true && ev.action && ev.action !== 'leave') {
          matches.push({
            id: ev.id,
            match: true,
            confidence: Number(ev.confidence) || 0.7,
            reason: String(ev.reason || '').slice(0, 280),
            action: ['delete', 'archive', 'link_update_chain'].includes(ev.action) ? ev.action : 'archive',
          });
        }
      }
    } catch (err) {
      console.warn(`[llm-targeted] batch ${i} failed:`, err.message);
    }
  }
  return matches;
}
