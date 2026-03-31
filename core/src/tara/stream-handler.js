/**
 * Stream Handler — POST /api/tara/stream
 *
 * Ultra-low-latency voice agent pipeline optimized for TTFT < 250ms:
 *
 *   1. Parallel: load session state + recall + config (cached)
 *   2. Build prompt (cached system prompt, compact session, minimal recall)
 *   3. Stream LLM tokens immediately (zero buffering)
 *   4. Async: update session state AFTER stream completes (never blocks tokens)
 *
 * Target timings:
 *   recall + session load:  < 150ms
 *   prompt assembly:        < 5ms
 *   first token (TTFT):     < 100ms from LLM
 *   total TTFT:             < 255ms
 */

import crypto from 'node:crypto';
import { SessionManager } from './session-manager.js';
import { TaraConfigStore } from './config-store.js';
import { buildPrompt } from './prompt-builder.js';
import { ClinicalReasoningEngine } from './clinical-reasoning.js';

export class TaraStreamHandler {
  constructor({ memoryStore, recallFn, llmBaseUrl, llmApiKey, defaultModel }) {
    this.sessionManager = new SessionManager({ memoryStore });
    this.configStore = new TaraConfigStore({ memoryStore });
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.llmBaseUrl = llmBaseUrl || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.llmApiKey = llmApiKey || process.env.GROQ_API_KEY || '';
    this.defaultModel = defaultModel || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    this.clinicalEngine = new ClinicalReasoningEngine({
      llmBaseUrl: this.llmBaseUrl,
      llmApiKey: this.llmApiKey,
      model: process.env.CLINICAL_MODEL || 'openai/gpt-oss-120b',
    });

    // ── Config cache (avoids DB read every turn) ──
    this._configCache = new Map();  // key: tenant:agent → { config, cachedAt }
    this._configCacheTTL = 60_000;  // 60s — config rarely changes mid-call
  }

  async handleStream(params, { userId, orgId, res }) {
    const {
      query,
      session_id: sessionId,
      tenant_id: tenantId,
      agent_name: agentName,
      language,
      interrupted_text: interruptedText,
      interruption_type: interruptionType,
    } = params;

    if (!query) {
      this._writeLine(res, { type: 'error', message: 'query is required' });
      this._writeLine(res, { type: 'done', is_final: true });
      res.end();
      return;
    }

    const startMs = Date.now();

    // Set up NDJSON streaming — flush immediately, no buffering
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',  // Disable nginx/proxy buffering
    });

    try {
      // ── STEP 1: Parallel fetch (session + recall + config) ──
      // Config is cached — avoids DB hit on every turn
      const configPromise = this._getCachedConfig(tenantId, agentName, { userId, orgId });

      // Recall with tight limits — voice needs speed, not exhaustive search
      const recallPromise = this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        max_memories: 5,   // Reduced from 8 — fewer memories = faster prompt = faster TTFT
        project: null,
      }).catch(() => ({ memories: [] }));

      const sessionPromise = this.sessionManager.load(sessionId, { tenantId, userId, orgId, language });

      // All three in parallel — total time = max(config, recall, session)
      const [config, recallResult, sessionState] = await Promise.all([
        configPromise, recallPromise, sessionPromise,
      ]);

      const memories = recallResult.memories || [];
      const fetchMs = Date.now() - startMs;
      this._writeLine(res, {
        type: 'status', step: 'context_ready',
        recall_count: memories.length,
        session_turns: sessionState.turn_count,
        ms: fetchMs,
      });

      // ── STEP 2: Build prompt (< 5ms) ──
      const model = config.model || this.defaultModel;
      const hasClinical = !!config.clinical_prompt;

      // Store clinical config in session state for post-turn use
      if (hasClinical) {
        sessionState._clinical_prompt = config.clinical_prompt;
        sessionState._clinical_model = config.clinical_model || null;
      }

      const { messages, tokenEstimate } = buildPrompt({
        query,
        systemPrompt: config.system_prompt,
        sessionState,
        memories,
        language: language || sessionState.language,
        voiceOptimized: config.voice_optimized !== false,
        interruptedText,
        interruptionType,
        clinicalInsights: sessionState.clinical_insights || null,
      });

      this._writeLine(res, {
        type: 'status', step: 'prompt_built',
        tokens: tokenEstimate, model,
        ms: Date.now() - startMs,
      });

      // ── STEP 3: Stream LLM tokens — zero buffering ──
      let fullResponse = '';
      const llmStartMs = Date.now();

      const llmResp = await fetch(`${this.llmBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: config.temperature ?? 0.7,
          max_tokens: config.max_tokens ?? 300,
          stream: true,
        }),
      });

      if (!llmResp.ok) {
        const errText = await llmResp.text();
        this._writeLine(res, { type: 'error', message: `LLM error: ${llmResp.status}`, detail: errText.slice(0, 200) });
        this._writeLine(res, { type: 'done', is_final: true, latency_ms: Date.now() - startMs });
        res.end();
        return;
      }

      let ttfb = null;
      let mainUsage = null; // { prompt_tokens, completion_tokens, total_tokens }
      const reader = llmResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            // Capture usage from final chunk (Groq/OpenAI include it)
            if (chunk.usage) mainUsage = chunk.usage;
            if (chunk.x_groq?.usage) mainUsage = chunk.x_groq.usage;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              if (ttfb === null) {
                ttfb = Date.now() - llmStartMs;
                this._writeLine(res, {
                  type: 'status', step: 'first_token',
                  ttfb_ms: ttfb,
                  ms: Date.now() - startMs,
                });
              }
              fullResponse += delta;
              this._writeLine(res, { type: 'text', text: delta, content: delta, is_final: false });
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }
      // Estimate tokens if usage not returned by model
      if (!mainUsage) {
        mainUsage = {
          prompt_tokens: tokenEstimate,
          completion_tokens: Math.ceil(fullResponse.length / 4),
          total_tokens: tokenEstimate + Math.ceil(fullResponse.length / 4),
        };
      }

      // ── STEP 4: Done event ──
      const totalMs = Date.now() - startMs;
      this._writeLine(res, {
        type: 'done',
        is_final: true,
        text: '',
        content: '',
        full_response: fullResponse,
        latency_ms: totalMs,
        ttfb_ms: ttfb,
        recall_count: memories.length,
        session_turns: sessionState.turn_count + 1,
        model,
        response_length: fullResponse.length,
        usage: mainUsage,
      });
      res.end();

      // ── STEP 5: Async post-turn update (NEVER blocks the stream) ──
      this._postTurnUpdate(sessionId, {
        userId, orgId, tenantId, mainUsage,
        sessionState, query, response: fullResponse,
      }).catch(err => console.warn('[tara/stream] Post-turn update failed:', err.message));

    } catch (err) {
      console.error('[tara/stream] Pipeline error:', err);
      try {
        this._writeLine(res, { type: 'error', message: err.message });
        this._writeLine(res, { type: 'done', is_final: true, latency_ms: Date.now() - startMs });
        res.end();
      } catch { /* Response already ended */ }
    }
  }

  // ── Config cache — avoid DB hit every turn ──

  async _getCachedConfig(tenantId, agentName, { userId, orgId }) {
    const key = `${tenantId || 'default'}:${agentName || 'default'}`;
    const cached = this._configCache.get(key);
    if (cached && Date.now() - cached.cachedAt < this._configCacheTTL) {
      return cached.config;
    }
    const config = await this.configStore.getConfig(tenantId, agentName, { userId, orgId });
    this._configCache.set(key, { config, cachedAt: Date.now() });
    return config;
  }

  // Invalidate cache when config is saved
  invalidateConfigCache(tenantId, agentName) {
    const key = `${tenantId || 'default'}:${agentName || 'default'}`;
    this._configCache.delete(key);
  }

  // ── Post-turn update (async, non-blocking) ──
  // Saves session state + creates a turn memory in the graph (purple, chained)

  async _postTurnUpdate(sessionId, { userId, orgId, tenantId, mainUsage, sessionState, query, response }) {
    if (!sessionId) return;

    const userSummary = query.length > 100 ? query.slice(0, 97) + '...' : query;
    const assistantSummary = response.length > 100 ? response.slice(0, 97) + '...' : response;
    const turnNumber = (sessionState.turn_count || 0) + 1;

    // 1. Update session state memory
    await this.sessionManager.update(sessionId, {
      userId, orgId, tenantId,
      state: sessionState,
      userSummary, assistantSummary,
    });

    // 2. Save this turn as a graph memory (visible in MemoryGraph as purple node)
    try {
      const turnId = crypto.randomUUID();
      const turnContent = `User: ${userSummary}\nAssistant: ${assistantSummary}`;

      await this.memoryStore.createMemory({
        id: turnId,
        user_id: userId,
        org_id: orgId,
        project: `tara/${tenantId || 'default'}`,
        content: turnContent,
        title: `TARA Turn ${turnNumber} — ${sessionId.slice(0, 12)}`,
        tags: [
          'tara-turn', `sid:${sessionId}`, `turn:${turnNumber}`,
          `in:${mainUsage?.prompt_tokens || 0}`,
          `out:${mainUsage?.completion_tokens || 0}`,
          `tokens:${mainUsage?.total_tokens || 0}`,
        ],
        memory_type: 'event',
        document_date: new Date().toISOString(),
        metadata: {
          session_id: sessionId,
          turn_number: turnNumber,
          tenant_id: tenantId,
          node_color: 'purple',
          usage: mainUsage || null,
        },
      });

      // 3. Chain turns: link this turn to the previous one via Extends
      if (turnNumber > 1) {
        // Find the previous turn memory
        const { memories: prevTurns } = await this.memoryStore.listMemories({
          user_id: userId,
          org_id: orgId,
          tags: [`sid:${sessionId}`, `turn:${turnNumber - 1}`],
          limit: 1,
        });

        if (prevTurns?.length > 0) {
          await this.memoryStore.createRelationship({
            id: crypto.randomUUID(),
            from_id: turnId,
            to_id: prevTurns[0].id,
            type: 'Extends',
            confidence: 1.0,
            metadata: { source: 'tara_conversation_chain', session_id: sessionId },
            created_by: 'tara',
          }).catch(() => {}); // Skip if relationship already exists
        }
      }
    } catch (err) {
      console.warn('[tara/stream] Turn memory save failed:', err.message);
      // Never fail the turn because of graph persistence
    }

    // 3. Run clinical reasoning (async background — never blocks)
    //    Try clinical_model first, fall back to main model if it fails
    if (sessionState._clinical_prompt) {
      try {
        const clinicalModel = sessionState._clinical_model || this.clinicalEngine.model;
        const mainModel = this.defaultModel;

        // Try clinical model first
        this.clinicalEngine.model = clinicalModel;
        let insights = await this.clinicalEngine.analyze({
          clinicalPrompt: sessionState._clinical_prompt,
          sessionState, lastQuery: query, lastResponse: response,
          previousInsights: sessionState.clinical_insights || null,
        });

        // Fallback to main model if clinical model failed
        if (!insights && clinicalModel !== mainModel) {
          console.warn(`[tara/clinical] ${clinicalModel} failed, falling back to ${mainModel}`);
          this.clinicalEngine.model = mainModel;
          insights = await this.clinicalEngine.analyze({
            clinicalPrompt: sessionState._clinical_prompt,
            sessionState, lastQuery: query, lastResponse: response,
            previousInsights: sessionState.clinical_insights || null,
          });
        }

        if (insights) {
          sessionState.clinical_insights = insights;
          // Update session manager cache so next turn sees these insights immediately
          this.sessionManager._cache.set(sessionId, { state: { ...sessionState }, updatedAt: Date.now() });

          // 4. Save insight as a visible memory (orange diamond in MemoryGraph)
          try {
            const insightId = crypto.randomUUID();
            const insightLines = [];
            if (insights.hypotheses?.length) {
              const hyps = insights.hypotheses.map(h => typeof h === 'string' ? h : `${h.text} (${Math.round((h.probability||0)*100)}%)`);
              insightLines.push(`Hypotheses: ${hyps.join('; ')}`);
            }
            if (insights.suggested_question) insightLines.push(`Next question: ${insights.suggested_question}`);
            if (insights.strategy) insightLines.push(`Strategy: ${insights.strategy}`);
            if (insights.psychological_notes) insightLines.push(`Notes: ${insights.psychological_notes}`);
            if (insights.red_flags?.length) insightLines.push(`Red flags: ${insights.red_flags.join('; ')}`);
            if (insights.spiced_progress) {
              const sp = insights.spiced_progress;
              insightLines.push(`SPICED: S=${sp.situation||'?'} P=${sp.pain||'?'} I=${sp.impact||'?'} C=${sp.critical_event||'?'} D=${sp.decision||'?'}`);
            }

            await this.memoryStore.createMemory({
              id: insightId,
              user_id: userId,
              org_id: orgId,
              project: `tara/${tenantId || 'default'}`,
              content: insightLines.join('\n'),
              title: `Clinical Insight — Turn ${turnNumber} — ${sessionId.slice(0, 12)}`,
              tags: [
                'tara-insight', `sid:${sessionId}`, `turn:${turnNumber}`,
                `clinical-in:${insights._usage?.prompt_tokens || 0}`,
                `clinical-out:${insights._usage?.completion_tokens || 0}`,
                `clinical-tokens:${insights._usage?.total_tokens || 0}`,
                `clinical-model:${insights._model || 'unknown'}`,
              ],
              memory_type: 'fact',
              document_date: new Date().toISOString(),
              metadata: {
                session_id: sessionId,
                turn_number: turnNumber,
                confidence: insights.confidence,
                strategy: insights.strategy,
                node_color: 'orange',
                clinical_usage: insights._usage || null,
                clinical_model: insights._model || null,
              },
            });

            // Link insight to the turn memory it analyzed
            const { memories: turnMems } = await this.memoryStore.listMemories({
              user_id: userId, org_id: orgId,
              tags: ['tara-turn', `sid:${sessionId}`, `turn:${turnNumber}`],
              limit: 1,
            });
            if (turnMems?.length > 0) {
              await this.memoryStore.createRelationship({
                id: crypto.randomUUID(),
                from_id: insightId,
                to_id: turnMems[0].id,
                type: 'Derives',
                confidence: insights.confidence || 0.7,
                metadata: { source: 'tara_clinical_reasoning', session_id: sessionId },
                created_by: 'tara-clinical',
              }).catch(() => {});
            }
          } catch (err) {
            console.warn('[tara/clinical] Insight memory save failed:', err.message);
          }
        }
      } catch (err) {
        console.warn('[tara/clinical] Background analysis failed:', err.message);
      }
    }
  }

  // ── NDJSON line writer — flush immediately ──

  _writeLine(res, obj) {
    try {
      res.write(JSON.stringify(obj) + '\n');
      // Force flush if available (Node.js writable stream)
      if (typeof res.flush === 'function') res.flush();
    } catch { /* Response may be closed */ }
  }
}
