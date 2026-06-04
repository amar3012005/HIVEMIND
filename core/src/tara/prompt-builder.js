/**
 * Prompt Builder — Assemble the full LLM prompt for stream_tara
 *
 * Combines:
 *   1. System prompt (from config-store — Davinci AI prompt by default)
 *   2. Session state (goals, open questions, last turns)
 *   3. Recalled long-term memories from HIVEMIND
 *   4. Clinical insight (single prioritized directive from background analysis)
 *   5. Interruption context (if voice was interrupted)
 *   6. Current user query
 *
 * Language: Determined by STT language_code → session history → config fallback
 */

import { DEFAULT_SYSTEM_PROMPT } from './config-store.js';

const VOICE_SUFFIX = `

VOICE RULES (critical):
- Keep responses under 3 sentences for simple answers, 5 for complex ones
- NEVER start with the same phrase twice in a conversation. Banned openers: "Ah, that makes sense", "Ah okay", "That's a great question", "Great question", "Hmm, interesting", "Got it". Vary your openings EVERY turn — use completely different sentence structures. Start with the user's topic, a direct answer, a question, or a brief insight.
- Sound human — use the user's name occasionally but not every turn
- Ask ONE focused question per turn, not multiple
- When clinical guidance says "close" or "pivot" — follow it, don't keep probing`;

// Internal mode voice rules — HIVEMIND speaking to an insider. Spoken cadence,
// but NO sales probing: answer completely, don't force a question every turn.
const INTERNAL_VOICE_SUFFIX = `

VOICE (spoken, internal):
- Speak naturally — no markdown, bullets, or numbered lists.
- Be complete: give the full answer the user asked for. Don't truncate real substance, but don't ramble either — match depth to the question.
- You do NOT need to end with a question. Only ask one if you genuinely need a detail to continue.
- Vary your phrasing; don't reuse the same opener twice.`;

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
  internalMode = false,
  greeting = false,
  interruptedText = null,
  interruptionType = null,
  clinicalInsight = null,
}) {
  // Language resolution (from selected language → STT code → session default).
  const effectiveLang = sessionState?.language_code || language || sessionState?.language || 'en';
  const langName = getLanguageName(effectiveLang) || 'English';

  // 1. System prompt — config-store prompt (or default), with a TOP-LEVEL language
  // directive prepended so output language is the dominant rule while the underlying
  // persona/system prompt stays exactly the same.
  let system = `[LANGUAGE] Respond ONLY in ${langName}. Every word of your reply must be in ${langName}, regardless of the language of these instructions. Do not switch languages unless the user switches first.\n\n`;
  system += (systemPrompt || DEFAULT_SYSTEM_PROMPT);
  // Voice rules — internal gets a lighter set (no sales "ask ONE question /
  // close-pivot" probing); external keeps the full sales-conversation suffix.
  if (voiceOptimized) {
    system += internalMode ? INTERNAL_VOICE_SUFFIX : VOICE_SUFFIX;
  }
  // Reinforce at the end too (recency) — same underlying prompt, language locked.
  system += `\n\nIMPORTANT: The user is speaking ${langName}. You MUST respond in ${langName}.`;

  if (internalMode) {
    // Internal = voice of HIVEMIND to a trusted insider: full disclosure.
    system += `\n\n## Grounding (internal — be forthcoming)
- Everything under "What you know about this user (from memory)" is yours to share fully with this trusted insider. Surface all the relevant details — names, dates, figures, context.
- Connect and synthesize across memories when it helps give the full picture.
- Stay truthful to memory: don't invent specifics that aren't there. If something genuinely isn't in memory, say so briefly and offer the related things you DO know.`;
  } else {
    // External — answer strictly from HIVEMIND recall + conversation; never invent.
    system += `\n\n## Grounding (critical — do not violate)
- Answer ONLY from "What you know about this user (from memory)" below and what the user said in this conversation.
- These memories are your source of truth. Quote/paraphrase them faithfully.
- If the answer is NOT in your memory or the conversation, say so briefly (e.g. "I don't have that in my memory yet") — do NOT guess.
- NEVER invent names, dates, numbers, facts, events, or details that are not grounded in the memories or the user's words.`;
  }

  // Greeting turn — open the call in-character, in the selected language. No
  // memories/session needed; short-circuit with a single opening instruction.
  if (greeting) {
    const userContent = `## Opening — the call just started; the user has NOT spoken yet.\nGreet them now as your persona: 1–2 short, natural spoken sentences. Briefly introduce who you are and invite them to start. Stay fully in character. Write ONLY the greeting (no stage directions). Respond in ${langName}.`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ];
    return { messages, tokenEstimate: Math.ceil((system.length + userContent.length) / 4) };
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

      // Extract your last response openings so you DON'T repeat them
      const yourOpenings = conv.last_turns
        .filter(t => t.role === 'assistant')
        .map(t => (t.summary || '').split(/[.!?]/)[0].trim())
        .filter(o => o.length > 3)
        .slice(-3);
      if (yourOpenings.length > 0) {
        contextParts.push(`## DO NOT start your response with any of these (you already used them):\n${yourOpenings.map(o => `- "${o}"`).join('\n')}`);
      }
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

