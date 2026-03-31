/**
 * Clinical Reasoning Engine — Secondary background analysis loop
 *
 * Runs async after each turn. Produces structured insights that inject
 * into the main loop's prompt on the next turn.
 *
 * Strategy: Hypothetico-Deductive Reasoning
 *   1. Generate hypotheses about the user's REAL need
 *   2. Identify missing information to confirm/deny
 *   3. Suggest the best next question
 *   4. Note psychological signals (hesitation, contradiction, deflection)
 *
 * This NEVER blocks the main response stream.
 * If it fails or is slow, the main loop continues without insights.
 */

const DEFAULT_CLINICAL_PROMPT = `You are a clinical reasoning engine analyzing a live conversation.
You do NOT speak to the user. You advise the main conversational agent.

Your job:
1. Generate hypotheses about the user's REAL underlying need (not just what they said)
2. Identify what information is MISSING to confirm or deny each hypothesis
3. Suggest the ONE most strategic question to ask next
4. Note any psychological signals (hesitation, contradiction, deflection, excitement)
5. Recommend conversation strategy (probe deeper, pivot topic, close, empathize)

Think step by step. Be precise. Output valid JSON only.`;

export class ClinicalReasoningEngine {
  /**
   * @param {object} deps
   * @param {string} deps.llmBaseUrl — LLM API base URL
   * @param {string} deps.llmApiKey — LLM API key
   * @param {string} [deps.model] — Reasoning model (deeper thinking)
   */
  constructor({ llmBaseUrl, llmApiKey, model }) {
    this.llmBaseUrl = llmBaseUrl || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.llmApiKey = llmApiKey || process.env.GROQ_API_KEY || '';
    this.model = model || process.env.CLINICAL_MODEL || 'openai/gpt-oss-120b';
  }

  /**
   * Run clinical reasoning on the conversation so far.
   * Returns structured insights or null if it fails.
   *
   * @param {object} params
   * @param {string} params.clinicalPrompt — Custom clinical reasoning prompt (from config)
   * @param {object} params.sessionState — Full session state with turn history
   * @param {string} params.lastQuery — User's latest utterance
   * @param {string} params.lastResponse — Agent's latest response
   * @param {object} [params.previousInsights] — Insights from previous turn (for continuity)
   * @returns {Promise<object|null>} — Clinical insights or null
   */
  async analyze({ clinicalPrompt, sessionState, lastQuery, lastResponse, previousInsights }) {
    const systemPrompt = clinicalPrompt || DEFAULT_CLINICAL_PROMPT;

    // Build conversation context from session state
    const turns = sessionState?.conversation?.last_turns || [];
    const turnsSummary = turns.map(t =>
      `${t.role === 'user' ? 'User' : 'Agent'}: ${t.summary}`
    ).join('\n');

    const userProfile = sessionState?.user_profile || {};
    const profileContext = [
      userProfile.name ? `Name: ${userProfile.name}` : null,
      userProfile.preferences?.length ? `Preferences: ${userProfile.preferences.join(', ')}` : null,
      userProfile.constraints?.length ? `Constraints: ${userProfile.constraints.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const conversationMeta = [
      sessionState?.conversation?.current_goal ? `Current goal: ${sessionState.conversation.current_goal}` : null,
      sessionState?.conversation?.active_topics?.length ? `Active topics: ${sessionState.conversation.active_topics.join(', ')}` : null,
      sessionState?.conversation?.open_questions?.length ? `Open questions: ${sessionState.conversation.open_questions.join(', ')}` : null,
      sessionState?.conversation?.resolved_points?.length ? `Resolved: ${sessionState.conversation.resolved_points.slice(-5).join(', ')}` : null,
    ].filter(Boolean).join('\n');

    // Build the analysis request
    let userContent = '';

    if (previousInsights) {
      userContent += `## Previous Analysis (your last reasoning)\n${JSON.stringify(previousInsights, null, 2)}\n\n`;
    }

    if (profileContext) {
      userContent += `## User Profile\n${profileContext}\n\n`;
    }

    if (conversationMeta) {
      userContent += `## Conversation State\n${conversationMeta}\n\n`;
    }

    if (turnsSummary) {
      userContent += `## Conversation History\n${turnsSummary}\n\n`;
    }

    userContent += `## Latest Exchange\nUser: ${lastQuery}\nAgent: ${lastResponse}\n\n`;

    userContent += `## Your Task
Analyze this conversation and provide clinical reasoning insights.
Consider: What is the user's REAL need? What are they not saying? What should the agent ask next?

Respond with valid JSON only:
{
  "hypotheses": ["hypothesis 1", "hypothesis 2"],
  "confidence": 0.0-1.0,
  "missing_info": ["what we don't know yet"],
  "suggested_question": "the single best next question",
  "psychological_notes": "observations about user behavior",
  "strategy": "probe_deeper|pivot|empathize|close|educate",
  "reasoning": "brief chain-of-thought explanation"
}`;

    try {
      const resp = await fetch(`${this.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,  // Low temperature for analytical reasoning
          max_tokens: 800,
          // No response_format — some models (GPT-OSS) don't support it
        }),
        signal: AbortSignal.timeout(30000),  // 30s timeout for reasoning models
      });

      if (!resp.ok) {
        console.warn(`[tara/clinical] LLM error: ${resp.status}`);
        return null;
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      // Parse JSON from response — handle reasoning models that output <think>...</think> before JSON
      const parseInsights = (text) => {
        // 1. Try raw JSON
        try { return JSON.parse(text); } catch {}
        // 2. Strip <think>...</think> reasoning tags (GPT-OSS, DeepSeek-R1)
        const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        try { return JSON.parse(stripped); } catch {}
        // 3. Extract from markdown code block
        const codeMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeMatch) { try { return JSON.parse(codeMatch[1].trim()); } catch {} }
        // 4. Find first { ... } block
        const braceMatch = stripped.match(/\{[\s\S]*\}/);
        if (braceMatch) { try { return JSON.parse(braceMatch[0]); } catch {} }
        return null;
      };

      const insights = parseInsights(content);
      if (insights) {
        insights.analyzed_at = new Date().toISOString();
        insights.turn_number = sessionState?.turn_count || 0;
        // Attach token usage for tracking
        const usage = data.usage || data.x_groq?.usage;
        insights._usage = usage || {
          prompt_tokens: Math.ceil(userContent.length / 4),
          completion_tokens: Math.ceil(content.length / 4),
          total_tokens: Math.ceil((userContent.length + content.length) / 4),
        };
        insights._model = this.model;
        return insights;
      }
      console.warn('[tara/clinical] Failed to parse LLM response as JSON. Raw:', content.slice(0, 200));
      return null;
    } catch (err) {
      // Timeout or network error — silently fail
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn('[tara/clinical] Analysis timed out (10s) — skipping');
      } else {
        console.warn('[tara/clinical] Analysis failed:', err.message);
      }
      return null;
    }
  }
}

export { DEFAULT_CLINICAL_PROMPT };
