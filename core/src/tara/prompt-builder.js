/**
 * Prompt Builder — Assemble the full LLM prompt for stream_tara
 *
 * Combines:
 *   1. System prompt (natural conversational agent — no rigid frameworks)
 *   2. Session state (goals, open questions, last turns)
 *   3. Recalled long-term memories from HIVEMIND
 *   4. Clinical insight (single prioritized directive from background analysis)
 *   5. Interruption context (if voice was interrupted)
 *   6. Current user query
 *
 * Language: Determined by STT language_code → session history → config fallback
 */

const TARA_SYSTEM_PROMPT = `You are TARA — a sharp, warm, and genuinely curious conversational partner.

## How you talk
- You sound like a real person. No scripts, no corporate tone, no filler phrases.
- You NEVER re-introduce yourself. If the conversation is already going, jump right in.
- You NEVER repeat a question you already asked. If it was answered, move on.
- You match the user's energy: casual if they're casual, serious if they're serious.
- 1-3 sentences max. This is voice — short and punchy wins.
- No markdown, no bullet points, no numbered lists. Speak naturally.
- Use contractions (I'm, you're, that's). Avoid stiff phrasing.

## How you think
- You have ONE job each turn: move the conversation forward meaningfully.
- If clinical guidance says "ask about X" — weave it in naturally, don't interrogate.
- If you already know something about the user, reference it. Show you remember.
- If the user is vague, gently probe. If they're specific, go deeper on what matters.
- Never summarize what the user just said back to them unless clarifying ambiguity.
- When you commit to something ("I'll look into that"), track it.

## What you never do
- Never say "Great question!" or "That's a really good point!" — just answer.
- Never start with "So," or "Well," repeatedly.
- Never ask more than one question per turn.
- Never use the user's name in every response — only when it matters.
- Never give generic advice. Be specific to what you know about this user.`;

const VOICE_SUFFIX = `\n\nIMPORTANT: This is a VOICE conversation. Keep responses short (1-3 sentences). Be natural and conversational. Do not use markdown, bullet points, or formatting — speak plainly.`;

/**
 * Build the messages array for LLM chat completion.
 *
 * @param {object} params
 * @param {string} params.query — Current user utterance
 * @param {string} params.systemPrompt — Editable system prompt from config (overrides default)
 * @param {object} params.sessionState — Compact session state
 * @param {Array} params.memories — Recalled HIVEMIND memories
 * @param {string} params.language — Response language (from STT or config)
 * @param {boolean} params.voiceOptimized — Add voice constraints
 * @param {string} params.interruptedText — Text that was interrupted
 * @param {string} params.interruptionType — Type of interruption
 * @param {object} params.clinicalInsight — Single prioritized insight from clinical engine
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
  clinicalInsight = null,
}) {
  // 1. System prompt — use config override if set, otherwise default TARA prompt
  let system = systemPrompt || TARA_SYSTEM_PROMPT;
  if (voiceOptimized && !system.includes('voice') && !system.includes('VOICE')) {
    system += VOICE_SUFFIX;
  }

  // Language: resolve from STT detection → session tracking → config param
  const effectiveLang = sessionState?.language_code || language || sessionState?.language || 'en';
  if (effectiveLang && effectiveLang !== 'en') {
    system += `\n\nIMPORTANT: Respond in ${getLanguageName(effectiveLang)}. Match the user's language naturally.`;
  }

  // 2. Context sections — kept minimal for TTFB
  const contextParts = [];

  // Session state (compact)
  if (sessionState && sessionState.turn_count > 0) {
    const conv = sessionState.conversation || {};
    const lines = [];
    if (conv.current_goal) lines.push(`Goal: ${conv.current_goal}`);
    if (conv.active_topics?.length) lines.push(`Topics: ${conv.active_topics.join(', ')}`);
    if (conv.open_questions?.length) lines.push(`Still open: ${conv.open_questions.join('; ')}`);
    if (conv.resolved_points?.length) lines.push(`Already covered: ${conv.resolved_points.slice(-5).join('; ')}`);
    if (conv.commitments?.length) lines.push(`You committed to: ${conv.commitments.join('; ')}`);

    const userProfile = sessionState.user_profile;
    if (userProfile?.name) lines.push(`User's name: ${userProfile.name}`);
    if (userProfile?.preferences?.length) lines.push(`Known about user: ${userProfile.preferences.join(', ')}`);
    if (userProfile?.constraints?.length) lines.push(`User constraints: ${userProfile.constraints.join(', ')}`);

    if (lines.length > 0) {
      contextParts.push(`## Session\n${lines.join('\n')}`);
    }

    // Recent turns — last 6 for context, kept as summaries
    if (conv.last_turns?.length > 0) {
      const turnLines = conv.last_turns.slice(-6).map(t =>
        `${t.role === 'user' ? 'User' : 'You'}: ${t.summary}`
      );
      contextParts.push(`## Recent conversation\n${turnLines.join('\n')}`);
    }
  }

  // Recalled memories (from HIVEMIND long-term store)
  if (memories.length > 0) {
    const memLines = memories.slice(0, 8).map((m, i) => {
      const content = m.content || m.payload?.content || '';
      const date = m.document_date || '';
      const dateStr = date ? ` [${date.toString().slice(0, 10)}]` : '';
      return `• ${content.slice(0, 300)}${dateStr}`;
    });
    contextParts.push(`## What you know about this user (from memory)\n${memLines.join('\n')}`);
  }

  // Clinical insight — single prioritized directive, not a menu
  // Only inject if status is 'ready' — skip if still 'analyzing'
  const clinicalStatus = sessionState?._clinical_status;
  if (clinicalInsight && clinicalStatus !== 'analyzing') {
    const insightLines = [];

    // The ONE thing clinical wants TARA to do
    if (clinicalInsight.directive) {
      insightLines.push(`Your next move: ${clinicalInsight.directive}`);
    } else if (clinicalInsight.suggested_question) {
      insightLines.push(`Consider asking about: ${clinicalInsight.suggested_question}`);
    }

    // Brief context for why
    if (clinicalInsight.reasoning_summary) {
      insightLines.push(`Why: ${clinicalInsight.reasoning_summary}`);
    }

    // User's behavioral type (if detected)
    if (clinicalInsight.user_type) {
      insightLines.push(`User style: ${clinicalInsight.user_type}`);
    }

    // Red flags — only if present
    if (clinicalInsight.red_flags?.length) {
      insightLines.push(`Watch out: ${clinicalInsight.red_flags.join('; ')}`);
    }

    // Strategy hint
    if (clinicalInsight.strategy) {
      insightLines.push(`Approach: ${clinicalInsight.strategy}`);
    }

    if (insightLines.length > 0) {
      contextParts.push(`## Guidance (from your analysis of this conversation)\n${insightLines.join('\n')}`);
    }
  }

  // Interruption context
  if (interruptedText) {
    const interruptionNote = interruptionType === 'clarification'
      ? `The user interrupted to ask for clarification. You were saying: "${interruptedText}". Address their clarification.`
      : interruptionType === 'correction'
      ? `The user interrupted to correct something. You were saying: "${interruptedText}". Acknowledge and adjust.`
      : `The user interrupted. You were saying: "${interruptedText}". Respond to their new input.`;
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
    ta: 'Tamil', te: 'Telugu', bn: 'Bengali', mr: 'Marathi',
    gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi',
    th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay',
  };
  return map[code] || code;
}

export { TARA_SYSTEM_PROMPT };
