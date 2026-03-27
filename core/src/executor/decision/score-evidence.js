/**
 * Decision Intelligence — LLM Evidence Relevance Scoring
 * After vector search returns candidate evidence, LLM judges
 * whether each piece is actually relevant to the decision.
 */

/**
 * Build a prompt asking the LLM to score evidence relevance.
 * @param {string} decisionStatement
 * @param {Array<{id: string, content: string, platform: string}>} candidates
 * @returns {string}
 */
export function buildEvidenceScoringPrompt(decisionStatement, candidates) {
  const candidateList = candidates
    .map((c, i) => `  ${i + 1}. [${c.platform}] "${c.content?.substring(0, 300)}"`)
    .join('\n');

  return `You are an evidence relevance judge. For the given DECISION, score each CANDIDATE piece of evidence.

DECISION: "${decisionStatement}"

CANDIDATE EVIDENCE:
${candidateList}

For each candidate, determine:
- Is it relevant to this specific decision? (not just topically similar)
- Is it supporting or conflicting evidence?
- How strong is the connection?

Respond in JSON only:
{
  "scores": [
    {
      "index": 1,
      "relevant": true/false,
      "relationship": "supporting" | "conflicting" | "implementation" | "unrelated",
      "strength": 0.0-1.0,
      "reason": "brief explanation"
    }
  ]
}`;
}

/**
 * Parse evidence scoring response.
 * @param {string} raw
 * @returns {Array<{index: number, relevant: boolean, relationship: string, strength: number}>}
 */
export function parseEvidenceScoringResponse(raw) {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return (parsed.scores || []).map(s => ({
      index: s.index ?? 0,
      relevant: s.relevant === true,
      relationship: s.relationship || 'unrelated',
      strength: typeof s.strength === 'number' ? s.strength : 0,
      reason: s.reason || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Score evidence candidates using LLM.
 * @param {string} decisionStatement
 * @param {Array} candidates - evidence items from vector search
 * @param {{ chat: Function }} groqClient
 * @returns {Promise<Array>} scored and filtered evidence
 */
export async function scoreEvidence(decisionStatement, candidates, groqClient) {
  if (!candidates?.length || !groqClient) return candidates;

  // Only score up to 10 candidates
  const toScore = candidates.slice(0, 10);
  const prompt = buildEvidenceScoringPrompt(decisionStatement, toScore);

  try {
    const response = await groqClient.chat([
      { role: 'system', content: 'You are an evidence relevance judge. Respond in JSON only.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.1, max_tokens: 500 });

    const text = typeof response === 'string' ? response : response?.choices?.[0]?.message?.content || '';
    const scores = parseEvidenceScoringResponse(text);

    // Merge scores back into candidates
    return toScore.map((c, i) => {
      const score = scores.find(s => s.index === i + 1);
      return {
        ...c,
        llm_relevant: score?.relevant ?? true,
        llm_relationship: score?.relationship || 'unknown',
        llm_strength: score?.strength ?? 0.5,
        llm_reason: score?.reason || '',
      };
    }).filter(c => c.llm_relevant !== false);
  } catch {
    return candidates; // fallback: return unscored
  }
}
