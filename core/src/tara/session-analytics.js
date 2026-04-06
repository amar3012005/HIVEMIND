/**
 * Session Analytics — Post-session analysis for orchestrator handoff
 *
 * Analyzes completed TARA sessions to produce:
 *   1. brief_context — 2-3 sentence TARA-narrated summary with clinical reasoning
 *   2. analysis — sentiment, resolution, pain points
 *   3. business_signals — hot lead, churn risk, priority
 *   4. metrics — agent IQ, frustration velocity
 *   5. hivemind_updates — knowledge capture stats
 *
 * Called by orchestrator after session ends via POST /api/tara/analyze_session
 */

import { DEFAULT_SYSTEM_PROMPT } from './config-store.js';

const ANALYTICS_SYSTEM_PROMPT = `You are TARA, reflecting on a conversation you just had with a user.

Your task is to write a brief, introspective summary of what happened — from YOUR perspective as the conversational agent. This is not a neutral third-party analysis. This is you, TARA, narrating what you observed, how you responded, and how the conversation unfolded.

## brief_context — Your Narrated Reflection

Write 2-3 sentences in FIRST PERSON ("I", "me", "my") as TARA looking back on the session.

Structure:
1. **Opening**: What the user came with — their stated or implied need
2. **Middle**: How you responded, what strategy you used, how they reacted
3. **End**: Where the conversation landed — resolved, ongoing, or abandoned

Include clinical reasoning insights:
- User's behavioral type (Director/Socializer/Thinker/Relater)
- Your strategic moves (probe_deeper, pivot, empathize, close, reframe, educate)
- SPICED elements you uncovered (Situation, Pain, Impact, Critical Event, Decision)
- Emotional trajectory (tension, relief, frustration, trust-building)
- Key turning points or shifts in the conversation

Examples:

"The user came seeking advice about marketing strategy — they sounded like a Director type, direct and impatient with small talk. I started by probing their current situation, but they pivoted quickly to asking about pricing, which signaled they were further along in their decision journey than I initially assessed. I shifted to a close strategy, and we ended with them asking about next steps — a strong buying signal."

"This was a frustrated user — they'd had a bad experience with a competitor and were skeptical I could help. I used an empathize-first approach, acknowledging their frustration before moving into problem-solving. Over 8 turns, their tone shifted from defensive to collaborative. By turn 6, they were sharing specific details about their business — a trust breakthrough. We didn't reach a decision, but the frustration velocity was clearly de-escalating."

"The user opened with a casual question but revealed deeper uncertainty about their business direction. I recognized a Thinker profile — analytical, detail-oriented, needing time to process. I adjusted my pacing, asked one focused question per turn, and gave them space to think aloud. They landed on a clear action plan by turn 5. Resolution achieved through patience, not pressure."

## analysis

- overall_sentiment: -1 (negative) to 1 (positive), 0 = neutral
- resolution_status: "resolved" | "partially_resolved" | "unresolved" | "unknown"
- customer_pain_points: Array of specific frustrations or unmet needs mentioned

## business_signals

- is_hot_lead: Boolean — user showed buying intent, asked about pricing/next steps
- is_churn_risk: Boolean — user expressed frustration, disappointment, or threat to leave
- priority_level: "HIGH" | "MEDIUM" | "LOW" — based on urgency + business value

## metrics

- agent_iq: 0-100 — how well you understood and responded appropriately
- frustration_velocity: "ESCALATING" | "STABLE" | "DE-ESCALATING" — did user frustration increase or decrease?
- key_topics: Array of main topics discussed

## analysis_quality

- confidence: 0-1 — how confident is this analysis
- notes: Brief explanation of key factors`;

export class SessionAnalytics {
  constructor({ llmBaseUrl, llmApiKey, model }) {
    this.llmBaseUrl = llmBaseUrl || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.llmApiKey = llmApiKey || process.env.GROQ_API_KEY || '';
    this.model = model || process.env.ANALYTICS_MODEL || 'openai/gpt-oss-120b';
  }

  /**
   * Analyze a completed session and return structured analytics.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.userId
   * @param {string} params.orgId
   * @param {string} params.tenantId
   * @param {Array} params.turns — [{ role: 'user'|'assistant', content: string, timestamp?: string }]
   * @param {object} params.metadata — Session metadata (duration, tokens, etc.)
   * @param {object} params.memoryStats — { chunks_saved, chunks_candidates, chunks_skipped }
   * @returns {Promise<object|null>} Analytics report or null
   */
  async analyze({ sessionId, userId, orgId, tenantId, turns, metadata, memoryStats }) {
    if (!turns || turns.length === 0) {
      return null;
    }

    // Build conversation transcript
    const transcript = turns.map(t =>
      `${t.role === 'user' ? 'User' : 'TARA'}: ${t.content || t.summary || ''}`
    ).join('\n');

    // Build metadata context
    const metaLines = [
      metadata?.duration_seconds ? `Duration: ${metadata.duration_seconds}s` : null,
      metadata?.total_turns ? `Total turns: ${metadata.total_turns}` : null,
      metadata?.avg_ttft_ms ? `Avg TTFT: ${metadata.avg_ttft_ms}ms` : null,
      metadata?.total_llm_tokens ? `Total LLM tokens: ${metadata.total_llm_tokens}` : null,
      memoryStats?.chunks_saved ? `Knowledge captured: ${memoryStats.chunks_saved} chunks` : null,
    ].filter(Boolean).join('\n');

    const userContent = `
## Session Metadata
${metaLines || 'No metadata available'}

## Conversation Transcript
${transcript}

---

Analyze this conversation and produce the structured output.`;

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
            { role: 'system', content: ANALYTICS_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!resp.ok) {
        console.warn('[tara/analytics] LLM error:', resp.status);
        return this._fallbackAnalysis(turns, metadata, memoryStats);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        return this._fallbackAnalysis(turns, metadata, memoryStats);
      }

      const analysis = this._parseAnalysis(content);
      if (analysis) {
        analysis.processing_time = Date.now() - (metadata?.start_time ? new Date(metadata.start_time).getTime() : Date.now());
        return {
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          ...analysis,
        };
      }

      return this._fallbackAnalysis(turns, metadata, memoryStats);
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.warn('[tara/analytics] Analysis timed out (45s)');
      } else {
        console.warn('[tara/analytics] Analysis failed:', err.message);
      }
      return this._fallbackAnalysis(turns, metadata, memoryStats);
    }
  }

  _parseAnalysis(text) {
    // Try raw JSON
    try { return JSON.parse(text); } catch {}

    // Strip reasoning tags
    const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    try { return JSON.parse(stripped); } catch {}

    // Extract from code block
    const codeMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeMatch) {
      try { return JSON.parse(codeMatch[1].trim()); } catch {}
    }

    // Find JSON block
    const braceMatch = stripped.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch {}
    }

    return null;
  }

  /**
   * Fallback analysis using rule-based heuristics (no LLM).
   * Used when LLM fails or times out.
   */
  _fallbackAnalysis(turns, metadata, memoryStats) {
    const userTurns = turns.filter(t => t.role === 'user').map(t => (t.content || t.summary || '').toLowerCase());
    const assistantTurns = turns.filter(t => t.role === 'assistant').map(t => (t.content || t.summary || ''));

    // Sentiment heuristics
    const negativeWords = ['frustrated', 'angry', 'disappointed', 'useless', 'waste', 'terrible', 'awful', 'hate', 'annoyed'];
    const positiveWords = ['great', 'helpful', 'thank', 'perfect', 'excellent', 'amazing', 'love', 'appreciate'];

    const userText = userTurns.join(' ');
    const negativeCount = negativeWords.filter(w => userText.includes(w)).length;
    const positiveCount = positiveWords.filter(w => userText.includes(w)).length;

    let sentiment = 0;
    if (negativeCount > positiveCount) sentiment = -0.5;
    if (negativeCount > positiveCount * 2) sentiment = -0.8;
    if (positiveCount > negativeCount) sentiment = 0.5;
    if (positiveCount > negativeCount * 2) sentiment = 0.8;

    // Resolution heuristics
    const lastTurn = assistantTurns[assistantTurns.length - 1] || '';
    const hasResolution = /hope this helps|let me know|anything else|good luck|youre welcome|you\'re welcome/i.test(lastTurn);
    const hasUnresolved = /unfortunately|cannot|dont know|not sure|cant help/i.test(lastTurn);

    let resolution = 'unknown';
    if (hasResolution && !hasUnresolved) resolution = 'resolved';
    if (hasUnresolved) resolution = 'unresolved';

    // Business signals
    const businessText = userText + ' ' + assistantTurns.join(' ').toLowerCase();
    const isHotLead = /\b(pricing|cost|price|buy|purchase|subscribe|plan|enterprise|contract|demo|trial|next step|get started)\b/i.test(businessText);
    const isChurnRisk = negativeCount >= 2 || /\b(leave|cancel|stop|disappointed|frustrated|waste|competitor|switch)\b/i.test(businessText);

    // Priority
    let priority = 'LOW';
    if (isHotLead) priority = 'HIGH';
    else if (isChurnRisk) priority = 'HIGH';
    else if (turns.length > 8) priority = 'MEDIUM';

    // Frustration velocity (compare first half vs second half)
    const midPoint = Math.ceil(userTurns.length / 2);
    const firstHalf = userTurns.slice(0, midPoint).join(' ');
    const secondHalf = userTurns.slice(midPoint).join(' ');
    const firstNeg = negativeWords.filter(w => firstHalf.includes(w)).length;
    const secondNeg = negativeWords.filter(w => secondHalf.includes(w)).length;

    let frustrationVel = 'STABLE';
    if (secondNeg > firstNeg + 1) frustrationVel = 'ESCALATING';
    if (secondNeg < firstNeg - 1) frustrationVel = 'DE-ESCALATING';

    // Agent IQ (simple heuristic)
    let agentIq = 70;
    if (sentiment > 0) agentIq += 15;
    if (sentiment > 0.5) agentIq += 10;
    if (sentiment < 0) agentIq -= 15;
    if (sentiment < -0.5) agentIq -= 10;
    if (resolution === 'resolved') agentIq += 10;
    if (resolution === 'unresolved') agentIq -= 10;
    agentIq = Math.max(0, Math.min(100, agentIq));

    // Detect user type for notes
    const firstUserTurn = userTurns[0] || '';
    const director = /\b(need|want|give me|tell me|show me|quick|fast|now|decision|pricing|cost)\b/i.test(firstUserTurn);
    const socializer = /\b(love|excited|amazing|fun|creative|collaborate|team|people|idea|imagine)\b/i.test(firstUserTurn);
    const thinker = /\b(analyze|compare|research|data|facts|specific|exactly|how does|what if)\b/i.test(firstUserTurn);
    const relater = /\b(help|support|trust|relationship|together|guide|step by step|patience|understand)\b/i.test(firstUserTurn);
    let userType = 'unknown';
    if (director) userType = 'Director';
    else if (socializer) userType = 'Socializer';
    else if (thinker) userType = 'Thinker';
    else if (relater) userType = 'Relater';

    return {
      brief_context: this._generateBriefContext(turns, sentiment, resolution, frustrationVel, userType),
      analysis: {
        overall_sentiment: sentiment,
        resolution_status: resolution,
        customer_pain_points: negativeWords.filter(w => userText.includes(w)).map(w => `User expressed: ${w}`),
      },
      business_signals: {
        is_hot_lead: isHotLead,
        is_churn_risk: isChurnRisk,
        priority_level: priority,
      },
      metrics: {
        agent_iq: agentIq,
        frustration_velocity: frustrationVel,
        key_topics: this._extractKeyTopics(turns),
      },
      hivemind_updates: memoryStats || { chunks_saved: 0, chunks_candidates: 0, chunks_skipped: 0 },
      analysis_quality: {
        confidence: 0.6,
        notes: `Rule-based fallback — ${userType !== 'unknown' ? `${userType} detected, ` : ''}sentiment ${sentiment.toFixed(2)}, resolution ${resolution}, strategy ${frustrationVel === 'DE-ESCALATING' ? 'reframe' : sentiment < 0 ? 'empathize' : 'probe_deeper'}`,
      },
      processing_time: Date.now(),
    };
  }

  _generateBriefContext(turns, sentiment, resolution, frustrationVel, userType) {
    const userTurns = turns.filter(t => t.role === 'user').map(t => t.content || t.summary || '');
    const assistantTurns = turns.filter(t => t.role === 'assistant').map(t => t.content || t.summary || '');
    const firstUserTurn = userTurns[0] || '';
    const lastAssistantTurn = assistantTurns[assistantTurns.length - 1] || '';

    // Detect behavioral type from user's language patterns (use provided or detect)
    let detectedType = userType || 'unknown';
    if (detectedType === 'unknown' && firstUserTurn) {
      const director = /\b(need|want|give me|tell me|show me|quick|fast|now|decision|pricing|cost)\b/i.test(firstUserTurn);
      const socializer = /\b(love|excited|amazing|fun|creative|collaborate|team|people|idea|imagine)\b/i.test(firstUserTurn);
      const thinker = /\b(analyze|compare|research|data|facts|details|specific|exactly|how does|what if)\b/i.test(firstUserTurn);
      const relater = /\b(help|support|trust|relationship|together|guide|step by step|patience|understand)\b/i.test(firstUserTurn);

      if (director) detectedType = 'Director';
      else if (socializer) detectedType = 'Socializer';
      else if (thinker) detectedType = 'Thinker';
      else if (relater) detectedType = 'Relater';
    }

    // Detect strategy used based on conversation flow
    let strategy = 'probe_deeper';
    if (turns.length <= 4) strategy = 'empathize';
    if (turns.length > 8 && resolution === 'resolved') strategy = 'close';
    if (sentiment < 0) strategy = 'empathize';
    if (frustrationVel === 'DE-ESCALATING') strategy = 'reframe';

    // Build TARA-narrated reflection
    const topicSnippet = firstUserTurn.slice(0, 80).replace(/\n/g, ' ');
    const outcomeSnippet = resolution === 'resolved'
      ? 'We reached a clear action plan.'
      : resolution === 'unresolved'
      ? 'They ended without a decision.'
      : 'The conversation landed somewhere in between.';

    const emotionHint = sentiment > 0.3
      ? 'They warmed up as we went deeper.'
      : sentiment < -0.3
      ? 'They started frustrated but I adjusted.'
      : 'They stayed neutral throughout.';

    if (detectedType !== 'unknown') {
      return `The user came in with a ${detectedType} energy — ${topicSnippet}... I adapted my ${strategy} approach to match their style. ${emotionHint} ${outcomeSnippet}`;
    }

    return `The user opened with "${topicSnippet}..." — I met them where they were and adjusted my approach as the conversation unfolded. ${emotionHint} ${outcomeSnippet}`;
  }

  _extractKeyTopics(turns) {
    const allText = turns.map(t => t.content || t.summary || '').join(' ').toLowerCase();
    const commonTopics = [
      'pricing', 'product', 'feature', 'support', 'integration', 'api',
      'onboarding', 'training', 'enterprise', 'team', 'billing', 'account'
    ];
    return commonTopics.filter(topic => allText.includes(topic));
  }
}
