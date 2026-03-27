/**
 * Decision Intelligence — Cross-Platform Merge Check
 * LLM-based decision identity resolution: determines if a new candidate
 * is the same decision as an existing one, expressed differently.
 */

/**
 * Build a prompt asking the LLM to check if a new decision matches any existing decisions.
 * @param {string} newStatement - The new decision statement
 * @param {Array<{id: string, decision_statement: string, scope?: object}>} existingDecisions
 * @returns {string}
 */
export function buildMergeCheckPrompt(newStatement, existingDecisions) {
  const existingList = existingDecisions
    .map((d, i) => `  ${i + 1}. [ID: ${d.id}] "${d.decision_statement}"`)
    .join('\n');

  return `You are a decision identity resolver. Determine if a NEW decision is the same as any EXISTING decision, just expressed differently across platforms.

NEW DECISION:
"${newStatement}"

EXISTING DECISIONS:
${existingList}

The same decision may appear as:
- "let's go with Redis" (Slack)
- "Approved: use Redis for caching" (Gmail)
- "Implement Redis cache layer" (GitHub PR)

These are ALL the same decision.

Respond in JSON only:
{
  "is_same_decision": true/false,
  "matches_id": "ID of matching decision or null",
  "relationship": "same_decision" | "implements" | "follows_from" | "unrelated",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

If no match, set is_same_decision=false and matches_id=null.`;
}

/**
 * Parse the LLM merge check response.
 * @param {string} raw
 * @returns {{ is_same_decision: boolean, matches_id: string|null, relationship: string, confidence: number, reasoning: string }}
 */
export function parseMergeCheckResponse(raw) {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      is_same_decision: parsed.is_same_decision === true,
      matches_id: parsed.matches_id || null,
      relationship: parsed.relationship || 'unrelated',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    return { is_same_decision: false, matches_id: null, relationship: 'unrelated', confidence: 0, reasoning: 'parse_failed' };
  }
}

/**
 * Check if a new decision candidate matches any existing decisions using LLM.
 * @param {string} newStatement
 * @param {Array} existingDecisions
 * @param {{ chat: Function }} groqClient
 * @returns {Promise<{ is_same_decision: boolean, matches_id: string|null, relationship: string, confidence: number }>}
 */
export async function checkMerge(newStatement, existingDecisions, groqClient) {
  if (!existingDecisions?.length || !groqClient) {
    return { is_same_decision: false, matches_id: null, relationship: 'unrelated', confidence: 0 };
  }

  // Only check against recent decisions (max 10)
  const candidates = existingDecisions.slice(0, 10);
  const prompt = buildMergeCheckPrompt(newStatement, candidates);

  try {
    const response = await groqClient.chat([
      { role: 'system', content: 'You are a decision identity resolver. Respond in JSON only.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.1, max_tokens: 300 });

    const text = typeof response === 'string' ? response : response?.choices?.[0]?.message?.content || '';
    return parseMergeCheckResponse(text);
  } catch {
    return { is_same_decision: false, matches_id: null, relationship: 'unrelated', confidence: 0 };
  }
}
