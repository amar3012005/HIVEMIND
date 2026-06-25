/**
 * project-classifier.js — decide which project a memory belongs to from the
 * project NAME + DESCRIPTION, semantically. Auto-assign when one project is a
 * clear winner; ask the user only when it is genuinely ambiguous; fall through
 * to personal when nothing fits.
 *
 * Used by every save surface so behavior is identical everywhere:
 *   • chat agent  (react-agent-v2.js  ask-project gate)
 *   • Slack "save this"  (server.js)
 *   • MCP hivemind_save_memory  (tool-registry.js)
 *   • Meeting Notes ingest  (server.js)
 *
 * Replaces the old name-substring heuristic that ignored descriptions entirely
 * (e.g. a memory about "solar inverter commissioning" never matched a project
 * named "SOLVIS" whose description was "solar inverter installs").
 *
 * LLM is best-effort: a Groq json_object call (gpt-oss-120b) with a short
 * timeout. On any failure it degrades to the name-substring heuristic — the
 * save NEVER blocks on the classifier.
 */

import { groqFetch } from '../llm/groq-fallback.js';

const CLASSIFY_MODEL = process.env.PROJECT_CLASSIFY_MODEL || 'openai/gpt-oss-120b';
// Confidence to auto-assign without asking.
const CONF_AUTO  = Number(process.env.PROJECT_CLASSIFY_AUTO_CONF || 0.72);
// Below this, the memory fits no project → personal (no ask).
const CONF_FLOOR = Number(process.env.PROJECT_CLASSIFY_FLOOR || 0.4);
// Best must beat the runner-up by this margin to count as a clear winner.
const MARGIN     = Number(process.env.PROJECT_CLASSIFY_MARGIN || 0.15);
const TIMEOUT_MS = Number(process.env.PROJECT_CLASSIFY_TIMEOUT_MS || 6000);

const clamp01 = (n) => (typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

async function llmClassify({ text, projects, signal }) {
  if (!process.env.GROQ_API_KEY) return null;
  const list = projects
    .map((p, i) => `${i + 1}. ${p.name}${p.description ? ` — ${String(p.description).slice(0, 300)}` : ' — (no description)'}`)
    .join('\n');
  const sys =
    'You route ONE memory to the single best-matching project, judging by each project\'s name AND description. ' +
    'Return STRICT JSON: {"best": int|null, "confidence": number, "second": int|null, "second_confidence": number, "reason": string}. ' +
    '"best" = the 1-based project number that best fits, or null if NONE fit. ' +
    'confidence and second_confidence are in [0,1]. ' +
    'Judge by topical/semantic fit to the description, not mere keyword overlap. ' +
    'If the memory is generic, personal, or fits no project, set best=null with low confidence.';
  const usr = `MEMORY:\n${String(text || '').slice(0, 2000)}\n\nPROJECTS:\n${list}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // Tie an externally-supplied signal to our timeout controller.
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    const resp = await groqFetch(`${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content || '{}');
    return {
      best: Number.isInteger(parsed.best) ? parsed.best : null,
      confidence: clamp01(parsed.confidence),
      second: Number.isInteger(parsed.second) ? parsed.second : null,
      second_confidence: clamp01(parsed.second_confidence),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// Fallback when the LLM is unavailable: match a project NAME as a substring of
// the memory text. Single match → modest confidence; multiple → ambiguous.
function heuristic({ text, projects }) {
  const hay = String(text || '').toLowerCase();
  const matchIdx = [];
  projects.forEach((p, i) => {
    const n = String(p.name || '').toLowerCase().trim();
    if (n.length >= 3 && hay.includes(n)) matchIdx.push(i);
  });
  if (matchIdx.length === 1) {
    return { best: matchIdx[0] + 1, confidence: 0.75, second: null, second_confidence: 0, reason: 'name-substring (heuristic)' };
  }
  if (matchIdx.length > 1) {
    return { best: null, confidence: 0.5, second: null, second_confidence: 0, reason: 'multiple name matches (heuristic)', _ambiguous: matchIdx };
  }
  return { best: null, confidence: 0, second: null, second_confidence: 0, reason: 'no name match (heuristic)' };
}

/**
 * classifyProjectForMemory({ text, projects, signal })
 *   projects: [{ id, name, slug, description }]
 * → { decision: 'auto'|'ask'|'personal', projectId, projectName?, suggestedId?,
 *     suggestedName?, confidence, reason, candidates? }
 */
export async function classifyProjectForMemory({ text, projects, signal }) {
  if (!Array.isArray(projects) || projects.length === 0) {
    return { decision: 'personal', projectId: null, confidence: 0, reason: 'no projects' };
  }
  let r = await llmClassify({ text, projects, signal });
  if (!r) r = heuristic({ text, projects });

  const candidates = projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
  const bestIdx = (Number.isInteger(r.best) && r.best >= 1 && r.best <= projects.length) ? r.best - 1 : null;
  const conf = clamp01(r.confidence);
  const secConf = clamp01(r.second_confidence);

  if (bestIdx == null || conf < CONF_FLOOR) {
    // Heuristic multi-name-match is a real ambiguity → ask. Otherwise personal.
    if (Array.isArray(r._ambiguous) && r._ambiguous.length > 1) {
      return { decision: 'ask', projectId: null, suggestedId: null, confidence: conf, reason: r.reason, candidates };
    }
    return { decision: 'personal', projectId: null, confidence: conf, reason: r.reason || 'no fit' };
  }

  const best = projects[bestIdx];
  const clearWinner = conf >= CONF_AUTO && (conf - secConf) >= MARGIN;
  if (clearWinner) {
    return { decision: 'auto', projectId: best.id, projectName: best.name, confidence: conf, reason: r.reason || '' };
  }
  // Plausible but not clear → ask, with the best as the pre-selected suggestion.
  return { decision: 'ask', projectId: null, suggestedId: best.id, suggestedName: best.name, confidence: conf, reason: r.reason || '', candidates };
}

/**
 * resolveProjectForSave({ text, projects, policy, callerProjectId, signal })
 * One front door that folds the org's memory_save_policy into the decision:
 *   • explicit caller project   → use it (always wins)
 *   • policy 'org-wide'          → org scope, no project
 *   • no accessible projects     → personal
 *   • policy 'ask'               → always ask (manual mode, no auto-classify)
 *   • policy 'private'|'auto'|*  → semantic classify (auto / ask-on-doubt / personal)
 *
 * Returns { decision: 'explicit'|'org'|'personal'|'auto'|'ask', projectId, ... }
 */
export async function resolveProjectForSave({ text, projects, policy, callerProjectId, signal }) {
  if (callerProjectId) return { decision: 'explicit', projectId: callerProjectId };
  const pol = String(policy || 'private').toLowerCase();
  if (pol === 'org-wide') return { decision: 'org', projectId: null };
  if (!Array.isArray(projects) || projects.length === 0) return { decision: 'personal', projectId: null };
  if (pol === 'ask') {
    return {
      decision: 'ask',
      projectId: null,
      suggestedId: null,
      candidates: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      reason: 'org policy = ask',
    };
  }
  return classifyProjectForMemory({ text, projects, signal });
}
