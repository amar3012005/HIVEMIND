// core/src/executor/decision/classify-decision.js

/**
 * Decision Intelligence — LLM Decision Classifier
 *
 * High-precision confirmation + structured extraction via Groq API.
 * Only called for items that passed heuristic detection.
 *
 * @module executor/decision/classify-decision
 */

/**
 * Build a structured prompt for decision classification.
 * @param {{ content: string, platform: string, context: { signals: string[], thread_context?: string } }} input
 * @returns {string}
 */
export function buildClassificationPrompt({ content, platform, context }) {
  return `You are a decision classifier. Analyze this ${platform} content and determine if it contains a real organizational decision.

CONTENT:
${content}

DETECTION SIGNALS: ${(context.signals || []).join(', ')}
${context.thread_context ? `THREAD CONTEXT:\n${context.thread_context}` : ''}
${context.thread_context ? `\nFull thread context (the trigger message is part of this conversation):\n${context.thread_context}\n\nIMPORTANT: The decision may be spread across multiple messages in this thread. Extract the complete decision, rationale, and participants from the ENTIRE thread, not just the trigger message.\n` : ''}
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "is_decision": true/false,
  "decision_type": "choice"|"approval"|"rejection"|"priority"|"assignment"|"resolution"|"policy",
  "decision_statement": "concise statement of what was decided",
  "rationale": "why this decision was made",
  "alternatives_rejected": ["list of alternatives that were not chosen"],
  "participants": [{"name": "person name", "role": "proposer|approver|reviewer|decider", "platform": "${platform}"}],
  "confidence": 0.0-1.0,
  "needs_more_context": true/false
}

Rules:
- A question is NOT a decision
- A suggestion without agreement is NOT a decision
- An approval or merge IS a decision
- A choice between alternatives IS a decision
- If uncertain, set is_decision=false and needs_more_context=true
- confidence should reflect how certain you are this is a real decision`;
}

/**
 * Parse LLM classification response, handling common format issues.
 * @param {string} raw
 * @returns {object}
 */
export function parseClassificationResponse(raw) {
  const DEFAULT = {
    is_decision: false, decision_type: null, decision_statement: null,
    rationale: null, alternatives_rejected: [], participants: [],
    confidence: 0, needs_more_context: false,
  };

  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);
    return { ...DEFAULT, ...parsed };
  } catch {
    return DEFAULT;
  }
}

/**
 * Classify a decision candidate using an LLM.
 * @param {{ content: string, platform: string, context: object }} input
 * @param {object} groqClient - Groq LLM client with generate() method
 * @returns {Promise<object>}
 */
export async function classifyDecision(input, groqClient) {
  if (!groqClient?.isAvailable()) {
    return { is_decision: false, confidence: 0, error: 'LLM unavailable' };
  }

  const prompt = buildClassificationPrompt(input);
  const raw = await groqClient.generate(prompt, {
    temperature: 0.1,
    maxTokens: 512,
  });

  return parseClassificationResponse(raw);
}
