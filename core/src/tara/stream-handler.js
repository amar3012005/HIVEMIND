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
import { TaraConfigStore, DEFAULT_INTERNAL_PROMPT } from './config-store.js';
import { buildPrompt } from './prompt-builder.js';
import { ClinicalReasoningEngine } from './clinical-reasoning.js';
import { mapModelToOpenRouter } from '../llm/groq-fallback.js';

export class TaraStreamHandler {
  constructor({ memoryStore, recallFn, llmBaseUrl, llmApiKey, defaultModel, qdrantClient }) {
    this.sessionManager = new SessionManager({ memoryStore });
    this.configStore = new TaraConfigStore({ memoryStore });
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.qdrantClient = qdrantClient || null;
    this.llmBaseUrl = llmBaseUrl || process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    this.llmApiKey = llmApiKey || process.env.GROQ_API_KEY || '';
    this.defaultModel = defaultModel || process.env.TARA_MODEL || 'openai/gpt-oss-20b';

    this.clinicalEngine = new ClinicalReasoningEngine({
      llmBaseUrl: this.llmBaseUrl,
      llmApiKey: this.llmApiKey,
      model: process.env.CLINICAL_MODEL || 'openai/gpt-oss-120b',
    });

    // OpenRouter-primary streaming: the buffered groqFetch fallback cannot replay
    // a stream, so when Groq is down/restricted (LLM_PRIMARY=openrouter) the voice
    // token stream must originate at OpenRouter directly, else every turn 400s.
    this.orPrimary = process.env.LLM_PRIMARY === 'openrouter';
    this.orBaseUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.orApiKey = process.env.OPENROUTER_API_KEY || '';

    // ── Config cache (avoids DB read every turn) ──
    this._configCache = new Map();  // key: tenant:agent → { config, cachedAt }
    this._configCacheTTL = 60_000;  // 60s — config rarely changes mid-call

    // ── Memory stats tracking per session ──
    this._sessionMemoryStats = new Map();  // session_id → { chunks_saved, chunks_candidates, chunks_skipped, turns }
  }

  /**
   * Resolve the streaming LLM endpoint for a model. When OpenRouter is primary
   * and the model has a valid OR slug, stream from OpenRouter (Groq is down);
   * otherwise use the configured (Groq) base. Returns null slug → caller keeps
   * the Groq path.
   * @param {string} model
   * @returns {{ url: string, key: string, model: string, openrouter: boolean }}
   */
  _streamTarget(model) {
    if (this.orPrimary && this.orApiKey) {
      const orModel = mapModelToOpenRouter(model);
      if (orModel) {
        return { url: `${this.orBaseUrl}/chat/completions`, key: this.orApiKey, model: orModel, openrouter: true };
      }
    }
    return { url: `${this.llmBaseUrl}/chat/completions`, key: this.llmApiKey, model, openrouter: false };
  }

  async handleStream(params, { userId, orgId, accessContext = null, res }) {
    const {
      session_id: sessionId,
      tenant_id: tenantId,
      agent_name: agentName,
      language,
      language_code: sttLanguageCode,  // From STT (Groq Whisper) — forwarded by orchestrator
      interrupted_text: interruptedText,
      interruption_type: interruptionType,
    } = params;

    // Greeting turn: the call just opened, no user utterance yet. The LLM opens
    // in-character (active skill) + in the selected language. No recall/turn save.
    const greetingMode = params.greeting === true || params.greeting === 'true';
    const query = greetingMode ? (params.query || '__open__') : params.query;

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

      // Fast KB-only recall — skip tsvector/vector/scoring pipeline entirely
      // Voice needs speed (<100ms), not exhaustive search
      const recallPromise = greetingMode
        ? Promise.resolve([])
        : this._fastKBRecall(query, { userId, orgId, accessContext }).catch(() => []);

      const sessionPromise = this.sessionManager.load(sessionId, { tenantId, userId, orgId, language });

      // All three in parallel — total time = max(config, recall, session)
      const [config, recallResult, sessionState] = await Promise.all([
        configPromise, recallPromise, sessionPromise,
      ]);

      const memories = recallResult;

      // Language: the language selected in the voice config (params.language —
      // sent on every turn by the orchestrator) is AUTHORITATIVE and sticky for
      // the whole call. Honor an explicit mid-call switch ONLY when detection
      // confidently finds a DIFFERENT language; ambiguous/short turns ("ok",
      // "ja") keep the selected language so the conversation never drifts.
      if (language) sessionState.selected_language = language;
      const detectedLang = this._detectLanguage(query);
      if (detectedLang && detectedLang !== sessionState.selected_language) {
        sessionState.language_code = detectedLang;            // user switched languages mid-call
      } else {
        sessionState.language_code =
          sessionState.selected_language || detectedLang || sessionState.language_code || sttLanguageCode || 'en';
      }

      const fetchMs = Date.now() - startMs;
      this._writeLine(res, {
        type: 'status', step: 'context_ready',
        recall_count: memories.length,
        session_turns: sessionState.turn_count,
        ms: fetchMs,
      });

      // ── STEP 2: Build prompt (< 5ms) ──
      const model = config.model || this.defaultModel;
      // mode='internal' → direct humanized recall, NO clinical reasoning layer.
      // mode='external' (default) → full current behavior (clinical if configured).
      const internalMode = (params.mode || 'external') === 'internal';
      const hasClinical = !internalMode && !!config.clinical_prompt;

      // Store clinical config in session state for post-turn use
      if (hasClinical) {
        sessionState._clinical_prompt = config.clinical_prompt;
        sessionState._clinical_model = config.clinical_model || null;
      } else if (internalMode) {
        // ensure no stale clinical layer leaks into internal-mode turns
        sessionState._clinical_prompt = null;
      }

      // Internal mode speaks AS HIVEMIND (full disclosure, human) — use the
      // internal voice prompt, not the external sales persona. External keeps
      // the configured primary prompt (+ clinical secondary, injected below).
      const effectiveSystemPrompt = internalMode
        ? (config.internal_prompt || DEFAULT_INTERNAL_PROMPT)
        : config.system_prompt;

      const { messages, tokenEstimate } = buildPrompt({
        query,
        systemPrompt: effectiveSystemPrompt,
        internalMode,
        greeting: greetingMode,
        sessionState,
        memories,
        language: language || sessionState.language,
        voiceOptimized: config.voice_optimized !== false,
        interruptedText,
        interruptionType,
        // Pass the latest clinical insight (single directive, not the full history)
        clinicalInsight: hasClinical ? (sessionState.clinical_insights || null) : null,
      });

      this._writeLine(res, {
        type: 'status', step: 'prompt_built',
        tokens: tokenEstimate, model,
        ms: Date.now() - startMs,
      });

      // ── STEP 3: Stream LLM tokens — zero buffering ──
      let fullResponse = '';
      const llmStartMs = Date.now();

      const tgt = this._streamTarget(model);
      const llmResp = await fetch(tgt.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tgt.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: tgt.model,
          messages,
          temperature: config.temperature ?? 0.7,
          max_tokens: config.max_tokens ?? 2048,  // gpt-oss reasoning models need headroom
          stream: true,
          // OpenRouter: pick the fastest provider that can serve the request and
          // keep its own cross-provider fallback on, so a single provider outage
          // doesn't kill the voice turn.
          ...(tgt.openrouter ? { provider: { sort: 'throughput', allow_fallbacks: true } } : {}),
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
      let chunkCount = 0;
      let emptyChunkCount = 0;

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
            chunkCount++;

            // Capture usage from final chunk (Groq/OpenAI include it)
            if (chunk.usage) mainUsage = chunk.usage;
            if (chunk.x_groq?.usage) mainUsage = chunk.x_groq.usage;

            // Extract delta content — handle both standard and alternative formats
            // Standard: chunk.choices[0].delta.content = "text"
            // Alternative (gpt-oss): chunk.choices[0].delta.content = "" (empty) or missing
            const delta = chunk.choices?.[0]?.delta?.content;

            // Only process if delta is truthy (non-empty string)
            if (delta && delta.length > 0) {
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
            } else {
              emptyChunkCount++;
              // Debug: log empty chunks for gpt-oss models (helps diagnose streaming issues)
              if (model.includes('gpt-oss') && chunkCount <= 3) {
                console.debug(`[tara/stream] ${model} chunk #${chunkCount} has no delta.content. Available keys:`,
                  Object.keys(chunk.choices?.[0]?.delta || {}));
              }
            }
          } catch (err) {
            // Skip malformed chunks but log for gpt-oss
            if (model.includes('gpt-oss')) {
              console.debug(`[tara/stream] ${model} malformed chunk: ${line.slice(0, 100)}`);
            }
          }
        }
      }

      // Diagnostic log for empty responses
      if (model.includes('gpt-oss') && (chunkCount === 0 || fullResponse.trim() === '')) {
        console.warn(`[tara/stream] ${model} streaming diagnostic: chunkCount=${chunkCount}, emptyChunks=${emptyChunkCount}, responseLen=${fullResponse.length}`);
      }
      // Estimate tokens if usage not returned by model
      if (!mainUsage) {
        mainUsage = {
          prompt_tokens: tokenEstimate,
          completion_tokens: Math.ceil(fullResponse.length / 4),
          total_tokens: tokenEstimate + Math.ceil(fullResponse.length / 4),
        };
      }

      // Check for empty response (critical error for gpt-oss models)
      if (!fullResponse || fullResponse.trim() === '') {
        console.warn(`[tara/stream] WARNING: Empty response from ${model}. This usually indicates model streaming failure or malformed chunks.`);
        this._writeLine(res, {
          type: 'error',
          message: `Model ${model} returned empty response`,
          model,
          latency_ms: Date.now() - startMs,
        });
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
      // Skip for greeting turns — no user utterance to record/analyze.
      if (!greetingMode) {
        this._postTurnUpdate(sessionId, {
          userId, orgId, tenantId, mainUsage,
          sessionState, query, response: fullResponse,
        }).catch(err => console.warn('[tara/stream] Post-turn update failed:', err.message));
      }

    } catch (err) {
      console.error('[tara/stream] Pipeline error:', err);
      try {
        this._writeLine(res, { type: 'error', message: err.message });
        this._writeLine(res, { type: 'done', is_final: true, latency_ms: Date.now() - startMs });
        res.end();
      } catch { /* Response already ended */ }
    }
  }

  // ── Recall — parity with MCP hivemind_recall ──
  // Uses the same `recallPersistedMemories` pipeline that backs the MCP
  // hivemind_recall tool and Talk-to-HIVE chat, so a voice turn sees the
  // exact same memories the agent would surface in chat. Previously this
  // was a KB-tag-only Qdrant scan (~50ms) which made TARA see <10% of
  // the corpus and diverge from Talk-to-HIVE.
  //
  // Latency trade-off: full pipeline runs ~150-300ms vs 50ms KB-only.
  // Set TARA_FAST_RECALL=true to fall back to the legacy KB-only path
  // for latency-critical deployments.

  async _fastKBRecall(query, { userId, orgId, accessContext = null }) {
    if (!query || query.length < 5) return [];

    // Skip recall ONLY when the WHOLE utterance is a bare greeting / filler.
    // The check is end-anchored so a greeting PREFIX on a real question
    // ("Hey, hi! So I want to know about Amar") still recalls — the old
    // `^(hey)\b` matched that and wrongly skipped recall, so Tara answered
    // "no record" on questions that merely opened with a hello.
    const trivial = /^(hi+|hey+|hello|hi there|hey there|thanks|thank you|ok(ay)?|yes|no|sure|bye|good|great|cool|nice)[\s.!,'-]*$/i.test(query.trim());
    if (trivial) return [];

    // Strip a leading greeting/filler prefix so the semantic recall query is
    // the substantive ask ("I want to know about Amar"), not the hello noise.
    query = query.replace(/^((hi+|hey+|hello|thanks|thank you|ok(ay)?|sure|so|well|um|uh)[\s,!.]+)+/i, '').trim() || query;

    const useFastPath = String(process.env.TARA_FAST_RECALL || '').toLowerCase() === 'true';

    // ── Default path: full semantic recall (matches MCP) ──
    if (!useFastPath && typeof this.recallFn === 'function' && this.memoryStore) {
      try {
        const recall = await this.recallFn(this.memoryStore, {
          query_context: query,
          user_id: userId,
          org_id: orgId,
          max_memories: 8,
          // Multi-tier scope (projectIds/teamIds) so project/team/org-shared
          // memories surface — parity with /api/recall + Talk-to-HIVE chat.
          access_context: accessContext,
        });
        const rows = recall?.combined || recall?.memories || recall || [];
        return rows.slice(0, 8).map(r => ({
          id: r.id,
          content: r.content || r.text || '',
          title: r.title || '',
          tags: Array.isArray(r.tags) ? r.tags : [],
          memory_type: r.memory_type || r.memoryType || 'fact',
          document_date: r.document_date || r.documentDate,
          created_at: r.created_at || r.createdAt,
          score: r.score || r.score_value || r.relevance,
          source_platform: r.source_metadata?.source_platform || r.source,
        }));
      } catch (err) {
        console.warn('[tara/recall] Full pipeline failed, falling back to Qdrant:', err.message);
        // fall through to Qdrant path
      }
    }

    try {
      // ── Fallback path: Qdrant-only, no KB tag restriction ──
      // Still respects user_id + is_latest so superseded memories don't
      // surface, but otherwise scans the whole personal+project corpus.
      if (this.qdrantClient) {
        const results = await this.qdrantClient.searchMemories({
          query,
          limit: 8,
          score_threshold: 0.22,
          filter: {
            must: [
              { key: 'user_id', match: { value: userId } },
              { key: 'is_latest', match: { value: true } },
            ],
          },
        });

        return results.map(r => ({
          id: r.id,
          content: r.payload?.content || '',
          title: r.payload?.title || '',
          tags: r.payload?.tags || [],
          memory_type: r.payload?.memory_type || 'fact',
          document_date: r.payload?.document_date,
          created_at: r.payload?.created_at,
          score: r.score,
          source_platform: r.payload?.source_platform,
        }));
      }

      // ── Last-resort path: Prisma ILIKE over all memories ──
      if (this.memoryStore?.client) {
        const tokens = query.toLowerCase()
          .replace(/[^a-z0-9äöüß\s]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length >= 3);

        if (tokens.length === 0) return [];
        const searchTerms = tokens.slice(0, 3);
        const ilikeConditions = searchTerms.map(t => `(m.content ILIKE '%${t}%' OR m.title ILIKE '%${t}%')`).join(' OR ');

        const results = await this.memoryStore.client.$queryRawUnsafe(`
          SELECT m.id, m.content, m.title, m.tags, m.memory_type,
                 m.document_date, m.created_at
          FROM memories m
          WHERE m.deleted_at IS NULL
            AND m.user_id = $1::uuid
            AND m.is_latest = true
            AND (${ilikeConditions})
          ORDER BY m.created_at DESC
          LIMIT 8
        `, userId);

        return results.map(r => ({
          id: r.id,
          content: r.content,
          title: r.title,
          tags: r.tags,
          memory_type: r.memory_type || 'fact',
          document_date: r.document_date,
          created_at: r.created_at,
        }));
      }

      return [];
    } catch (err) {
      console.warn('[tara/recall] All paths failed:', err.message);
      return [];
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

    // Extract user profile info from the query (lightweight, no LLM)
    const q = query.toLowerCase();
    // Name detection: "my name is X", "I'm X", "ich bin X", "ich heiße X"
    const nameMatch = query.match(/(?:my name is|i'm|i am|ich bin|ich heiße|this is)\s+([A-Z][a-zäöü]+)/i);
    if (nameMatch && !sessionState.user_profile.name) {
      sessionState.user_profile.name = nameMatch[1];
    }
    // Company detection: "my company is X", "I work at X", "founder of X", "CEO of X"
    const companyMatch = query.match(/(?:my company|i work at|founder of|ceo of|from|bei|von|mein unternehmen)\s+([A-Z][A-Za-zäöü\s.]+?)(?:\.|,|$)/i);
    if (companyMatch) {
      const company = companyMatch[1].trim();
      if (company.length > 2 && !sessionState.user_profile.preferences.includes(`company:${company}`)) {
        sessionState.user_profile.preferences.push(`company:${company}`);
      }
    }
    // Goal detection: "looking for", "I need", "I want to", "ich suche", "ich brauche"
    const goalMatch = query.match(/(?:looking for|i need|i want to|ich suche|ich brauche|ich möchte)\s+(.{10,60})/i);
    if (goalMatch && !sessionState.conversation.current_goal) {
      sessionState.conversation.current_goal = goalMatch[1].replace(/[.!?]$/, '').trim();
    }

    // 1. Update session state memory
    await this.sessionManager.update(sessionId, {
      userId, orgId, tenantId,
      state: sessionState,
      userSummary, assistantSummary,
    });

    // Pre-cache session with "analyzing" status if clinical reasoning is enabled
    // This ensures rapid users can still reference turn metadata even if insights aren't ready yet
    if (sessionState._clinical_prompt) {
      sessionState._clinical_status = 'analyzing';
      sessionState._clinical_started_at = Date.now();
      this.sessionManager._cache.set(sessionId, { state: { ...sessionState }, updatedAt: Date.now() });
      console.log(`[tara/session] Clinical reasoning pending for session ${sessionId.slice(0, 12)}`);
    }

    // NOTE: Per-turn + per-insight graph memories are intentionally NOT written.
    // The full conversation + insights live in the dedicated Postgres tables
    // (tara_calls / tara_turns / tara_insights, written by the AaaS orchestrator)
    // and surface in the /tara Call History tab + a single per-call "call log"
    // summary memory (created at /api/tara/calls/end). Writing one memory per
    // turn + insight polluted recall, Qdrant, and the memory graph with noise.
    this._trackMemoryOperation(sessionId, 'saved');

    // 2. Run clinical reasoning (async background — never blocks). Result is
    // kept ONLY in session state (clinical_insights) to steer the NEXT turn —
    // it is NOT persisted as a graph memory.
    //    Passes FULL turn history + ALL past insights for accumulation
    if (sessionState._clinical_prompt) {
      try {
        const clinicalModel = sessionState._clinical_model || this.clinicalEngine.model;
        const mainModel = this.defaultModel;

        // Accumulated past insights — clinical sees its entire analysis chain
        const pastInsights = sessionState.past_insights || [];

        // Try clinical model first
        this.clinicalEngine.model = clinicalModel;
        let insights = await this.clinicalEngine.analyze({
          clinicalPrompt: sessionState._clinical_prompt,
          sessionState, lastQuery: query, lastResponse: response,
          pastInsights,
        });

        // Fallback to main model if clinical model failed
        if (!insights && clinicalModel !== mainModel) {
          console.warn(`[tara/clinical] ${clinicalModel} failed, falling back to ${mainModel}`);
          this.clinicalEngine.model = mainModel;
          insights = await this.clinicalEngine.analyze({
            clinicalPrompt: sessionState._clinical_prompt,
            sessionState, lastQuery: query, lastResponse: response,
            pastInsights,
          });
        }

        if (insights) {
          // Store as latest insight for TARA's next turn prompt
          sessionState.clinical_insights = insights;
          // ACCUMULATE: append to past_insights so future clinical runs see the full chain
          if (!sessionState.past_insights) sessionState.past_insights = [];
          sessionState.past_insights.push({
            turn_number: insights.turn_number,
            directive: insights.directive,
            strategy: insights.strategy,
            user_type: insights.user_type,
            hypotheses: insights.hypotheses,
            psychological_notes: insights.psychological_notes,
            analyzed_at: insights.analyzed_at,
          });
          sessionState._clinical_status = 'ready';
          sessionState._clinical_completed_at = Date.now();
          // Update cache so next turn sees these insights immediately
          this.sessionManager._cache.set(sessionId, { state: { ...sessionState }, updatedAt: Date.now() });
          const duration = Date.now() - (sessionState._clinical_started_at || 0);
          console.log(`[tara/clinical] Insights ready in ${duration}ms for session ${sessionId.slice(0, 12)} — strategy=${insights.strategy || '?'} user_type=${insights.user_type || '?'}`);
          // Insight is NOT persisted as a graph memory (noise). It lives in
          // session state to steer the next turn; the per-turn psychology +
          // strategy are captured in the call-log summary at call end.
        }
      } catch (err) {
        console.warn('[tara/clinical] Background analysis failed:', err.message);
      }
    }
  }

  // ── Language detection from transcription text ──
  // Detects language directly from user's words, no external dependency

  _detectLanguage(text) {
    if (!text || text.length < 5) return null;
    const lower = text.toLowerCase();

    // Score each language by keyword matches — highest wins
    const langs = {
      en: /\b(the|and|is|are|my|name|looking|for|some|advice|want|need|help|please|would|could|should|about|have|this|that|with|from|what|where|when|how|just|like|also|been|will|your|their|more|very|know|think|work|make|because|really|going|actually|something|anything|everything)\b/g,
      de: /\b(ich|und|der|die|das|ein|eine|nicht|auf|mit|für|ist|sind|wir|haben|werden|auch|kann|über|nach|bei|mein|dein|heiße|brauche|suche|möchte|bitte|danke|warum|wenn|aber|oder|schon|noch|jetzt|hier|dort|ganz|sehr|immer)\b/g,
      fr: /\b(je|tu|nous|vous|les|des|une|est|sont|avec|pour|dans|cette|mais|aussi|peut|bonjour|merci|comment|quoi|parce|très|bien|faire|avoir|être|tout|rien|jamais|toujours|encore)\b/g,
      es: /\b(hola|estoy|tengo|quiero|necesito|puedo|como|donde|cuando|porque|también|pero|esta|este|hacer|puede|somos|soy|todo|nada|siempre|nunca|mucho|bien|gracias)\b/g,
      it: /\b(sono|voglio|posso|come|dove|quando|perché|anche|questo|questa|fare|buongiorno|grazie|ciao|tutto|niente|sempre|molto|bene|essere|avere)\b/g,
      pt: /\b(estou|tenho|quero|preciso|posso|como|onde|quando|porque|também|este|esta|fazer|obrigado|tudo|nada|sempre|muito|bem)\b/g,
      nl: /\b(ik|ben|het|een|van|voor|met|niet|ook|deze|zijn|hebben|kunnen|willen|hallo|dank|goed|alles|niets|altijd|nooit)\b/g,
      tr: /\b(ben|sen|bir|için|ile|ama|bu|ne|nasıl|merhaba|teşekkür|istiyorum|lazım|çok|iyi|her|hiç)\b/g,
    };

    // Script-based detection (unambiguous)
    if (/[\u0600-\u06FF]/.test(text)) return 'ar';
    if (/[\u0900-\u097F]/.test(text)) return 'hi';
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';

    // Count keyword matches per language
    let bestLang = null;
    let bestCount = 0;
    for (const [lang, regex] of Object.entries(langs)) {
      const matches = lower.match(regex);
      const count = matches ? matches.length : 0;
      if (count > bestCount) {
        bestCount = count;
        bestLang = lang;
      }
    }

    // Need at least 2 keyword matches to be confident
    return bestCount >= 2 ? bestLang : null;
  }

  // ── NDJSON line writer — flush immediately ──

  _writeLine(res, obj) {
    try {
      res.write(JSON.stringify(obj) + '\n');
      // Force flush if available (Node.js writable stream)
      if (typeof res.flush === 'function') res.flush();
    } catch { /* Response may be closed */ }
  }

  // ── Memory stats tracking — called after successful turn save ──

  _trackMemoryOperation(sessionId, operation) {
    if (!sessionId) return;
    let stats = this._sessionMemoryStats.get(sessionId);
    if (!stats) {
      stats = { chunks_saved: 0, chunks_candidates: 0, chunks_skipped: 0, turns: [], started_at: Date.now() };
      this._sessionMemoryStats.set(sessionId, stats);
    }
    if (operation === 'saved') stats.chunks_saved++;
    if (operation === 'candidate') stats.chunks_candidates++;
    if (operation === 'skipped') stats.chunks_skipped++;
  }

  // ── Get session data for analytics ──

  async getSessionAnalyticsData(sessionId, { userId, orgId }) {
    if (!sessionId) return null;

    // Get memory stats
    const stats = this._sessionMemoryStats.get(sessionId) || { chunks_saved: 0, chunks_candidates: 0, chunks_skipped: 0 };

    // Fetch turn history from memory
    let turns = [];
    try {
      const { memories } = await this.memoryStore.listMemories({
        user_id: userId,
        org_id: orgId,
        tags: ['tara-turn', `sid:${sessionId}`],
        limit: 50,
      });
      turns = (memories || []).map(m => {
        const content = m.content || '';
        const userMatch = content.match(/User: ([\s\S]*?)(?:\n|$)/);
        const assistantMatch = content.match(/Assistant: ([\s\S]*?)(?:\n|$)/);
        return [
          userMatch ? { role: 'user', content: userMatch[1].trim(), timestamp: m.created_at } : null,
          assistantMatch ? { role: 'assistant', content: assistantMatch[1].trim(), timestamp: m.created_at } : null,
        ].filter(Boolean);
      }).flat();
    } catch (err) {
      console.warn('[tara/analytics] Failed to fetch turns:', err.message);
    }

    // Get session state for metadata
    const sessionState = await this.sessionManager.load(sessionId, { userId, orgId });

    // Build metadata
    const metadata = {
      total_turns: sessionState?.turn_count || Math.floor(turns.length / 2),
      duration_seconds: Math.floor((Date.now() - (stats.started_at || Date.now())) / 1000),
      total_llm_tokens: turns.reduce((sum, t) => {
        // Token estimates from turn content length
        return sum + Math.ceil((t.content?.length || 0) / 4);
      }, 0),
    };

    return {
      session_id: sessionId,
      userId,
      orgId,
      tenantId: sessionState?.tenant_id || 'default',
      turns,
      metadata,
      memory_stats: {
        chunks_saved: stats.chunks_saved,
        chunks_candidates: stats.chunks_candidates,
        chunks_skipped: stats.chunks_skipped,
      },
    };
  }

  // ── Cleanup stats after session ends ──

  cleanupSessionStats(sessionId) {
    this._sessionMemoryStats.delete(sessionId);
  }
}
