// LLM Proposal Verifier
//
// Heuristic scanners (graph-hygiene-scanner, Faraday) produce candidate
// proposals quickly. This module re-ranks the top-N candidates with a
// grounded LLM check so users see calibrated confidence + plain English
// reasoning before they approve anything.
//
// Design:
//   • Groq llama-3.3-70b — fast, JSON-mode, free tier
//   • Strict schema response → fails closed (skip verify, keep heuristic)
//   • Budget cap: max LLM_VERIFY_BUDGET candidates per run
//   • Falls back to heuristic confidence on any LLM error
//   • Skips entirely if SWARM_LLM_VERIFY=false
//
// Inputs: array of proposals from the heuristic layer
// Output: same proposals with `confidence` re-scored + `llmReason` added
//         + a `verdict` field ('confirm' | 'drop' | 'low_confidence')

const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.SWARM_VERIFY_MODEL || 'llama-3.3-70b-versatile';
const LLM_VERIFY_BUDGET = parseInt(process.env.SWARM_LLM_VERIFY_BUDGET || '40', 10);
const LLM_VERIFY_ENABLED = process.env.SWARM_LLM_VERIFY !== 'false';

const SYSTEM_PROMPT = `You are a strict memory-quality auditor for HIVEMIND, a company-brain memory engine. You verify that proposed clean-up actions (archive, delete, flag) are correct and would not destroy useful information.

You receive proposed actions with a memory snippet, the heuristic reason, and the suggested action. Reply ONLY with valid JSON matching this exact schema:

{
  "verdict": "confirm" | "drop" | "low_confidence",
  "confidence": <number 0..1>,
  "reason": "<plain English, 1 sentence, max 140 chars, no jargon>"
}

Rules:
- "confirm" = the proposed action is correct (high confidence ≥ 0.75)
- "drop"    = proposed action would destroy useful info (confidence drops below 0.4)
- "low_confidence" = uncertain — show user but flag as needs-review
- NEVER confirm deletion of business facts (contracts, valuations, agreements, decisions, people, financial figures)
- NEVER confirm action on memories with importance > 0.5
- Marketing/newsletter/auto-reply content = safe to confirm archive
- Older versions of evolving facts = link as update chain (confirm)
- Single-line trivia / system pings = safe to confirm noise reduction

Output JSON only — no markdown, no explanation.`;

/**
 * Verify a batch of proposals with the LLM.
 *
 * @param {Array<Proposal>} proposals — heuristic output
 * @returns {Promise<Array<Proposal>>} same array, with confidence + verdict + llmReason
 */
export async function verifyProposals(proposals) {
  if (!LLM_VERIFY_ENABLED || !GROQ_KEY || !Array.isArray(proposals) || proposals.length === 0) {
    return proposals.map(p => ({ ...p, verdict: 'low_confidence', llmReason: null }));
  }

  // Cap: top-N by heuristic confidence to save budget
  const sorted = [...proposals].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const toVerify = sorted.slice(0, LLM_VERIFY_BUDGET);
  const skipped = sorted.slice(LLM_VERIFY_BUDGET);

  const verified = await Promise.all(toVerify.map(p => verifyOne(p)));

  // Anything beyond budget keeps heuristic confidence with low_confidence flag
  const remainder = skipped.map(p => ({ ...p, verdict: 'low_confidence', llmReason: 'Skipped LLM verify (budget cap)' }));

  return [...verified, ...remainder];
}

async function verifyOne(proposal) {
  try {
    const mem = proposal.memories?.[0] || {};
    const userMsg = JSON.stringify({
      suggested_action: proposal.suggestedAction,
      category: proposal.category,
      heuristic_reason: proposal.reason,
      heuristic_confidence: proposal.confidence,
      memory: {
        title: mem.title,
        content_preview: mem.content_preview,
        importance: mem.importance_score,
        recall_count: mem.recall_count,
        tags: mem.tags,
        age_days: mem.created_at
          ? Math.floor((Date.now() - new Date(mem.created_at).getTime()) / 86400000)
          : null,
      },
    });

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      return { ...proposal, verdict: 'low_confidence', llmReason: `LLM HTTP ${res.status}` };
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...proposal, verdict: 'low_confidence', llmReason: 'LLM returned malformed JSON' };
    }

    const verdict = ['confirm', 'drop', 'low_confidence'].includes(parsed.verdict)
      ? parsed.verdict
      : 'low_confidence';
    const llmConf = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : null;
    // Blend: 60% LLM, 40% heuristic — keeps a sanity floor
    const blendedConf = llmConf !== null
      ? Number((llmConf * 0.6 + (proposal.confidence || 0.5) * 0.4).toFixed(2))
      : proposal.confidence;
    const llmReason = typeof parsed.reason === 'string'
      ? parsed.reason.slice(0, 200)
      : null;

    return {
      ...proposal,
      verdict,
      confidence: blendedConf,
      llmReason,
    };
  } catch (err) {
    return { ...proposal, verdict: 'low_confidence', llmReason: `LLM error: ${err.message}` };
  }
}

/**
 * Filter to only verified-pass proposals for the approval queue.
 * Drops 'drop' verdicts entirely; keeps 'confirm' + 'low_confidence'.
 */
export function filterForQueue(verifiedProposals) {
  return verifiedProposals.filter(p => p.verdict !== 'drop');
}
