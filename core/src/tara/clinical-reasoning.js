/**
 * Clinical Reasoning Engine — Accumulating background analysis loop
 *
 * Runs async after each turn. Receives FULL conversation history + all
 * past insights it has generated. Outputs a single prioritized insight
 * that tells TARA exactly what to do next.
 *
 * Architecture:
 *   Input:  full_turns + past_insights + user_profile + current_exchange
 *   Output: { hypotheses, spiced_progress, suggested_question, strategy, ... }
 *
 * The insight ACCUMULATES understanding — each turn builds on previous
 * analyses rather than starting fresh. This gives TARA progressively
 * deeper understanding of the user.
 *
 * This NEVER blocks the main response stream.
 */

import { DEFAULT_CLINICAL_PROMPT } from './config-store.js';

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
    this.model = model || process.env.CLINICAL_MODEL || 'openai/gpt-oss-20b';
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
    const systemPrompt = clinicalPrompt || DEFAULT_CLINICAL_PROMPT;

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
          max_tokens: 2048,  // gpt-oss models need headroom for reasoning_content + output
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
      // OVH models use reasoning_content, Groq uses reasoning
      const reasoning = message?.reasoning_content || message?.reasoning;

      // OVH gpt-oss models may put JSON output in reasoning_content when content is empty
      // Try content first, then fall back to reasoning_content
      const textToParse = content || reasoning;

      if (!textToParse) return null;

      // Log reasoning if present
      if (reasoning) {
        console.log(`[tara/clinical] Reasoning (${(reasoning.length / 4).toFixed(0)} tokens): ${reasoning.slice(0, 200)}...`);
      }

      // Parse JSON — handle reasoning models that output <think>...</think> before JSON
      const insights = parseInsights(textToParse);
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
      console.warn('[tara/clinical] Failed to parse JSON. Raw:', textToParse.slice(0, 200));
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

