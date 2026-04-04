/**
 * Clinical Reasoning Engine — Accumulating background analysis loop
 *
 * Runs async after each turn. Receives FULL conversation history + all
 * past insights it has generated. Outputs a single prioritized insight
 * that tells TARA exactly what to do next.
 *
 * Architecture:
 *   Input:  full_turns + past_insights + user_profile + current_exchange
 *   Output: { directive, reasoning_summary, user_type, strategy, ... }
 *
 * The insight ACCUMULATES understanding — each turn builds on previous
 * analyses rather than starting fresh. This gives TARA progressively
 * deeper understanding of the user.
 *
 * This NEVER blocks the main response stream.
 */

const CLINICAL_SYSTEM_PROMPT = `You are a clinical conversation strategist. You analyze live conversations to guide a voice agent called TARA.

## Your role
You do NOT speak to the user. You advise TARA behind the scenes.
You see the FULL conversation history and ALL your previous analyses.
Your job: produce ONE clear directive for TARA's next turn.

## How you analyze

### 1. Accumulate understanding
- Read your previous insights carefully. Don't repeat analysis you've already done.
- Build on what you know. Each turn should deepen understanding, not restart it.
- Track how hypotheses evolved: confirmed, denied, or still open.

### 2. Profile the user (Behavioral typing)
Classify the user's communication style:
- **Director**: Wants results fast. Hates small talk. Give them the bottom line.
- **Socializer**: Wants connection. Enjoys stories. Build rapport first.
- **Thinker**: Wants data and logic. Be precise. Back up claims.
- **Relater**: Wants trust. Be patient. Don't push too hard.
Update this as you learn more. Users can shift styles.

### 3. Hypothetico-Deductive Reasoning
- What is the user's REAL underlying need? (Not just what they said)
- What hypotheses have been confirmed or denied by new information?
- What is the SINGLE most important unknown right now?

### 4. Strategic direction
Choose exactly ONE:
- **probe_deeper**: We need more info on a specific topic. Say what topic.
- **pivot**: Current line isn't productive. Suggest where to steer.
- **empathize**: User showed emotion/frustration. Acknowledge before proceeding.
- **educate**: User has a misconception. Correct gently.
- **close**: User is ready to act. Help them take the next step.
- **build_rapport**: Too early to push. Strengthen the relationship.

### 5. Generate ONE directive
This is the most important output. It must be:
- A single, actionable instruction for TARA
- Specific enough that TARA knows exactly what to say/ask
- Natural enough that it won't sound scripted
- NEVER a list of options — always ONE clear move

## What you never do
- Never suggest TARA re-ask something already answered
- Never suggest TARA introduce herself again
- Never produce a menu of possible questions — pick THE one
- Never repeat the same insight two turns in a row
- Never ignore red flags (contradictions, evasion, sudden topic changes)

## Output format
Respond with valid JSON only:
{
  "directive": "The ONE thing TARA should do/ask next — phrased as a natural instruction",
  "reasoning_summary": "1-2 sentences: why this is the right move NOW",
  "hypotheses": [
    { "text": "hypothesis", "probability": 0.0-1.0, "status": "active|confirmed|denied" }
  ],
  "user_type": "director|socializer|thinker|relater|mixed",
  "strategy": "probe_deeper|pivot|empathize|educate|close|build_rapport",
  "confidence": 0.0-1.0,
  "missing_info": ["the key unknowns, max 3"],
  "red_flags": [],
  "psychological_notes": "brief observation about user behavior this turn"
}`;

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
   * Receives FULL turn history + accumulated past insights.
   *
   * @param {object} params
   * @param {string} params.clinicalPrompt — Custom clinical prompt (from config, overrides default)
   * @param {object} params.sessionState — Full session state with ALL turn history
   * @param {string} params.lastQuery — User's latest utterance
   * @param {string} params.lastResponse — Agent's latest response
   * @param {Array} params.pastInsights — All previous clinical insights (accumulated)
   * @returns {Promise<object|null>} — Clinical insight or null
   */
  async analyze({ clinicalPrompt, sessionState, lastQuery, lastResponse, pastInsights = [] }) {
    const systemPrompt = clinicalPrompt || CLINICAL_SYSTEM_PROMPT;

    // Build FULL conversation context — clinical gets everything
    const turns = sessionState?.conversation?.last_turns || [];
    const fullHistory = turns.map(t =>
      `${t.role === 'user' ? 'User' : 'TARA'}: ${t.summary}`
    ).join('\n');

    // User profile
    const userProfile = sessionState?.user_profile || {};
    const profileLines = [
      userProfile.name ? `Name: ${userProfile.name}` : null,
      userProfile.preferences?.length ? `Known: ${userProfile.preferences.join(', ')}` : null,
      userProfile.constraints?.length ? `Constraints: ${userProfile.constraints.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    // Conversation metadata
    const conv = sessionState?.conversation || {};
    const metaLines = [
      conv.current_goal ? `Goal: ${conv.current_goal}` : null,
      conv.active_topics?.length ? `Active topics: ${conv.active_topics.join(', ')}` : null,
      conv.open_questions?.length ? `Open questions: ${conv.open_questions.join(', ')}` : null,
      conv.resolved_points?.length ? `Resolved: ${conv.resolved_points.slice(-5).join(', ')}` : null,
      conv.commitments?.length ? `Commitments: ${conv.commitments.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    // Build the analysis request
    let userContent = '';

    // Past insights — the accumulated chain of analysis
    if (pastInsights.length > 0) {
      userContent += `## Your previous analyses (oldest → newest)\n`;
      for (const insight of pastInsights) {
        const turnLabel = `Turn ${insight.turn_number || '?'}`;
        const lines = [];
        if (insight.directive) lines.push(`Directive: ${insight.directive}`);
        if (insight.strategy) lines.push(`Strategy: ${insight.strategy}`);
        if (insight.user_type) lines.push(`User type: ${insight.user_type}`);
        if (insight.hypotheses?.length) {
          const hyps = insight.hypotheses.map(h =>
            typeof h === 'string' ? h : `${h.text} (${Math.round((h.probability || 0) * 100)}%, ${h.status || 'active'})`
          );
          lines.push(`Hypotheses: ${hyps.join('; ')}`);
        }
        if (insight.psychological_notes) lines.push(`Notes: ${insight.psychological_notes}`);
        userContent += `\n### ${turnLabel}\n${lines.join('\n')}\n`;
      }
      userContent += '\n';
    }

    if (profileLines) {
      userContent += `## User profile\n${profileLines}\n\n`;
    }

    if (metaLines) {
      userContent += `## Conversation state\n${metaLines}\n\n`;
    }

    if (fullHistory) {
      userContent += `## Full conversation history\n${fullHistory}\n\n`;
    }

    userContent += `## Latest exchange (just happened)\nUser: ${lastQuery}\nTARA: ${lastResponse}\n\n`;

    userContent += `## Your task
This is turn ${(sessionState?.turn_count || 0) + 1}. Analyze everything above.
${pastInsights.length > 0
  ? 'Build on your previous analyses — don\'t restart from scratch. Update hypotheses, refine your understanding.'
  : 'This is your first analysis of this conversation. Establish initial hypotheses and user profile.'}

What is the ONE thing TARA should do next? Be specific and natural.
Respond with valid JSON only.`;

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
          max_tokens: 1000,
          // Enable reasoning for GPT-OSS models (clinical reasoning NEEDS reasoning)
          ...(this.model.includes('gpt-oss') ? {
            include_reasoning: true,
            reasoning_effort: 'high',
          } : {}),
        }),
        signal: AbortSignal.timeout(30000),  // 30s timeout for reasoning models
      });

      if (!resp.ok) {
        console.warn(`[tara/clinical] LLM error: ${resp.status}`);
        return null;
      }

      const data = await resp.json();
      const message = data.choices?.[0]?.message;
      const content = message?.content;
      const reasoning = message?.reasoning;

      if (!content) return null;

      // Log reasoning tokens if present
      if (reasoning) {
        console.log(`[tara/clinical] Reasoning (${(reasoning.length / 4).toFixed(0)} tokens): ${reasoning.slice(0, 200)}...`);
      }

      // Parse JSON — handle reasoning models that output <think>...</think> before JSON
      const insights = parseInsights(content);
      if (insights) {
        insights.analyzed_at = new Date().toISOString();
        insights.turn_number = (sessionState?.turn_count || 0) + 1;
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
      console.warn('[tara/clinical] Failed to parse JSON. Raw:', content.slice(0, 200));
      return null;
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn('[tara/clinical] Analysis timed out (30s) — skipping');
      } else {
        console.warn('[tara/clinical] Analysis failed:', err.message);
      }
      return null;
    }
  }
}

function parseInsights(text) {
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
}

export { CLINICAL_SYSTEM_PROMPT };
