/**
 * Prompt Builder — Assemble the full LLM prompt for stream_tara
 *
 * Combines:
 *   1. System prompt (editable, from config store)
 *   2. Session state (goals, open questions, last turns)
 *   3. Recalled long-term memories from HIVEMIND
 *   4. Interruption context (if voice was interrupted)
 *   5. Current user query
 */

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. Answer concisely and accurately. This is a voice conversation — keep responses under 3 sentences unless the user asks for detail.`;

const VOICE_SUFFIX = `\n\nIMPORTANT: This is a VOICE conversation. Keep responses short (1-3 sentences). Be natural and conversational. Do not use markdown, bullet points, or formatting — speak plainly.`;

/**
 * Build the messages array for LLM chat completion.
 *
 * @param {object} params
 * @param {string} params.query — Current user utterance
 * @param {string} params.systemPrompt — Editable system prompt from config
 * @param {object} params.sessionState — Compact session state
 * @param {Array} params.memories — Recalled HIVEMIND memories
 * @param {string} params.language — Response language
 * @param {boolean} params.voiceOptimized — Add voice constraints
 * @param {string} params.interruptedText — Text that was interrupted
 * @param {string} params.interruptionType — Type of interruption
 * @returns {{ messages: Array<{role: string, content: string}>, tokenEstimate: number }}
 */
export function buildPrompt({
  query,
  systemPrompt,
  sessionState,
  memories = [],
  language = 'en',
  voiceOptimized = true,
  interruptedText = null,
  interruptionType = null,
  clinicalInsights = null,
}) {
  // 1. System prompt
  let system = systemPrompt || DEFAULT_SYSTEM_PROMPT;
  if (voiceOptimized && !system.includes('voice')) {
    system += VOICE_SUFFIX;
  }
  if (language && language !== 'en') {
    system += `\n\nRespond in ${getLanguageName(language)}.`;
  }

  // 2. Context sections
  const contextParts = [];

  // Session state
  if (sessionState && sessionState.turn_count > 0) {
    const conv = sessionState.conversation || {};
    const lines = [];
    if (conv.current_goal) lines.push(`Current goal: ${conv.current_goal}`);
    if (conv.active_topics?.length) lines.push(`Active topics: ${conv.active_topics.join(', ')}`);
    if (conv.open_questions?.length) lines.push(`Open questions: ${conv.open_questions.join('; ')}`);
    if (conv.resolved_points?.length) lines.push(`Already discussed: ${conv.resolved_points.slice(-5).join('; ')}`);
    if (conv.commitments?.length) lines.push(`Your commitments: ${conv.commitments.join('; ')}`);

    const userProfile = sessionState.user_profile;
    if (userProfile?.name) lines.push(`User's name: ${userProfile.name}`);
    if (userProfile?.preferences?.length) lines.push(`User preferences: ${userProfile.preferences.join(', ')}`);
    if (userProfile?.constraints?.length) lines.push(`User constraints: ${userProfile.constraints.join(', ')}`);

    if (lines.length > 0) {
      contextParts.push(`## Session Context\n${lines.join('\n')}`);
    }

    // Last turns
    if (conv.last_turns?.length > 0) {
      const turnLines = conv.last_turns.slice(-6).map(t =>
        `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.summary}`
      );
      contextParts.push(`## Recent Conversation\n${turnLines.join('\n')}`);
    }
  }

  // Recalled memories
  if (memories.length > 0) {
    const memLines = memories.slice(0, 8).map((m, i) => {
      const content = m.content || m.payload?.content || '';
      const date = m.document_date || '';
      const dateStr = date ? ` [${date.toString().slice(0, 10)}]` : '';
      return `• ${content.slice(0, 300)}${dateStr}`;
    });
    contextParts.push(`## Relevant Knowledge (from memory)\n${memLines.join('\n')}`);
  }

  // Clinical reasoning insights (from background analysis of previous turns)
  if (clinicalInsights && typeof clinicalInsights === 'object') {
    const clinicalLines = [];

    // Hypotheses — support both string[] and object[] formats
    if (clinicalInsights.hypotheses?.length) {
      const hyps = clinicalInsights.hypotheses.map(h =>
        typeof h === 'string' ? h : `${h.text} (${Math.round((h.probability || 0) * 100)}%, ${h.status || 'active'})`
      );
      clinicalLines.push(`Hypotheses: ${hyps.join('; ')}`);
    }

    // SPICED progress
    if (clinicalInsights.spiced_progress) {
      const sp = clinicalInsights.spiced_progress;
      const spicedParts = [];
      if (sp.situation) spicedParts.push(`Situation: ${sp.situation}`);
      if (sp.pain) spicedParts.push(`Pain: ${sp.pain}`);
      if (sp.impact) spicedParts.push(`Impact: ${sp.impact}`);
      if (sp.critical_event) spicedParts.push(`Critical Event: ${sp.critical_event}`);
      if (sp.decision) spicedParts.push(`Decision: ${sp.decision}`);
      if (spicedParts.length > 0) clinicalLines.push(`SPICED: ${spicedParts.join(' | ')}`);
    }

    if (clinicalInsights.missing_info?.length) {
      clinicalLines.push(`Missing information: ${clinicalInsights.missing_info.join('; ')}`);
    }
    if (clinicalInsights.suggested_question) {
      clinicalLines.push(`Suggested next question: ${clinicalInsights.suggested_question}`);
    }
    if (clinicalInsights.psychological_notes) {
      clinicalLines.push(`Psychological notes: ${clinicalInsights.psychological_notes}`);
    }
    if (clinicalInsights.red_flags?.length) {
      clinicalLines.push(`Red flags: ${clinicalInsights.red_flags.join('; ')}`);
    }
    if (clinicalInsights.strategy) {
      clinicalLines.push(`Recommended strategy: ${clinicalInsights.strategy}`);
    }
    if (clinicalLines.length > 0) {
      contextParts.push(`## Clinical Reasoning Insights\n${clinicalLines.join('\n')}`);
    }
  }

  // Interruption context
  if (interruptedText) {
    const interruptionNote = interruptionType === 'clarification'
      ? `The user interrupted your previous response to ask for clarification. Your interrupted response was: "${interruptedText}". Address their clarification.`
      : interruptionType === 'correction'
      ? `The user interrupted to correct something. Your interrupted response was: "${interruptedText}". Acknowledge the correction and adjust.`
      : `The user interrupted your previous response: "${interruptedText}". Respond to their new input.`;
    contextParts.push(`## Interruption\n${interruptionNote}`);
  }

  // 3. Build user message
  let userContent = '';
  if (contextParts.length > 0) {
    userContent += contextParts.join('\n\n') + '\n\n---\n\n';
  }
  userContent += `User: ${query}`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];

  // Rough token estimate (4 chars per token)
  const tokenEstimate = Math.ceil((system.length + userContent.length) / 4);

  return { messages, tokenEstimate };
}

function getLanguageName(code) {
  const map = {
    de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', sv: 'Swedish',
    da: 'Danish', no: 'Norwegian', fi: 'Finnish', ja: 'Japanese',
    ko: 'Korean', zh: 'Chinese', ar: 'Arabic', hi: 'Hindi',
    tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', cs: 'Czech',
  };
  return map[code] || code;
}

export { DEFAULT_SYSTEM_PROMPT };
