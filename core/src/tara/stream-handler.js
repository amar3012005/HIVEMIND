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

export class TaraStreamHandler {
  constructor({ memoryStore, recallFn, llmBaseUrl, llmApiKey, defaultModel }) {
    this.sessionManager = new SessionManager({ memoryStore });
    this.configStore = new TaraConfigStore({ memoryStore });
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.llmBaseUrl = llmBaseUrl || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.llmApiKey = llmApiKey || process.env.GROQ_API_KEY || '';
    this.defaultModel = defaultModel || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

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
      const { messages, tokenEstimate } = buildPrompt({
        query,
        systemPrompt: config.system_prompt,
        sessionState,
        memories,
        language: language || sessionState.language,
        voiceOptimized: config.voice_optimized !== false,
        interruptedText,
        interruptionType,
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
              // Emit both `text` and `content` for client compatibility
              this._writeLine(res, { type: 'text', text: delta, content: delta, is_final: false });
            }
          } catch {
            // Skip malformed chunks
          }
        }
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
      });
      res.end();

      // ── STEP 5: Async post-turn update (NEVER blocks the stream) ──
      this._postTurnUpdate(sessionId, {
        userId, orgId, tenantId,
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

  async _postTurnUpdate(sessionId, { userId, orgId, tenantId, sessionState, query, response }) {
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
        tags: ['tara-turn', `sid:${sessionId}`, `turn:${turnNumber}`],
        memory_type: 'event',
        document_date: new Date().toISOString(),
        metadata: {
          session_id: sessionId,
          turn_number: turnNumber,
          tenant_id: tenantId,
          node_color: 'purple',  // Signal for MemoryGraph visualization
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
