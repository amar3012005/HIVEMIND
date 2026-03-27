/**
 * Decision Intelligence — LLM Answer Assembly
 * Synthesizes retrieved decision data into a coherent natural language
 * response with provenance citations.
 */

/**
 * Build a prompt for answer assembly.
 * @param {string} userQuery
 * @param {Array} decisions - retrieved decision objects
 * @returns {string}
 */
export function buildAnswerPrompt(userQuery, decisions) {
  const decisionDetails = decisions.map((d, i) => {
    const evidence = d.evidence?.supporting?.map(e =>
      `    - [${e.platform}] ${e.snippet?.substring(0, 150)}`
    ).join('\n') || '    (no evidence linked)';

    const conflicting = d.evidence?.conflicting?.map(e =>
      `    - [${e.platform}] ${e.snippet?.substring(0, 150)}`
    ).join('\n') || '';

    return `Decision ${i + 1}:
  Statement: "${d.decision_statement}"
  Type: ${d.decision_type || 'unknown'}
  Rationale: "${d.rationale || 'not recorded'}"
  Participants: ${d.participants?.map(p => `${p.name} (${p.role}, ${p.platform})`).join(', ') || 'unknown'}
  Status: ${d.status || 'unknown'}
  Confidence: ${d.confidence || 'unknown'}
  Date: ${d.detected_at || 'unknown'}
  Supporting evidence:
${evidence}${conflicting ? `\n  Conflicting evidence:\n${conflicting}` : ''}`;
  }).join('\n\n');

  return `You are a decision intelligence assistant. Answer the user's question using ONLY the decision data provided. Include provenance (which platform, who was involved, when).

USER QUESTION: "${userQuery}"

RETRIEVED DECISIONS:
${decisionDetails}

RULES:
- Answer in clear, concise natural language
- Cite specific platforms and participants as sources
- If there was disagreement, mention it
- If the decision was superseded, note that
- If confidence is low, say so
- Do NOT invent information not in the data
- End with a "Sources:" section listing platform references`;
}

/**
 * Assemble a natural language answer from retrieved decisions.
 * @param {string} userQuery
 * @param {Array} decisions
 * @param {{ chat: Function }} groqClient
 * @returns {Promise<string>} assembled answer
 */
export async function assembleAnswer(userQuery, decisions, groqClient) {
  if (!decisions?.length) return 'No relevant decisions found.';
  if (!groqClient) {
    // Fallback: structured response without LLM
    const d = decisions[0];
    return `Decision: ${d.decision_statement}\nRationale: ${d.rationale || 'not recorded'}\nStatus: ${d.status}`;
  }

  const prompt = buildAnswerPrompt(userQuery, decisions);

  try {
    const response = await groqClient.chat([
      { role: 'system', content: 'You are a decision intelligence assistant. Answer with provenance.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.3, max_tokens: 500 });

    return typeof response === 'string' ? response : response?.choices?.[0]?.message?.content || decisions[0].decision_statement;
  } catch {
    const d = decisions[0];
    return `Decision: ${d.decision_statement}\nRationale: ${d.rationale || 'not recorded'}`;
  }
}
