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

    // ── Config cache (avoids DB read every turn) ──
    this._configCache = new Map();  // key: tenant:agent → { config, cachedAt }
    this._configCacheTTL = 60_000;  // 60s — config rarely changes mid-call

    // ── Memory stats tracking per session ──
    this._sessionMemoryStats = new Map();  // session_id → { chunks_saved, chunks_candidates, chunks_skipped, turns }
  }

  async handleStream(params, { userId, orgId, res }) {
    const {
      query,
      session_id: sessionId,
      tenant_id: tenantId,
      agent_name: agentName,
      language,
      language_code: sttLanguageCode,  // From STT (Groq Whisper) — forwarded by orchestrator
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

      // Fast KB-only recall — skip tsvector/vector/scoring pipeline entirely
      // Voice needs speed (<100ms), not exhaustive search
      const recallPromise = this._fastKBRecall(query, { userId, orgId })
        .catch(() => []);

      const sessionPromise = this.sessionManager.load(sessionId, { tenantId, userId, orgId, language });

      // All three in parallel — total time = max(config, recall, session)
      const [config, recallResult, sessionState] = await Promise.all([
        configPromise, recallPromise, sessionPromise,
      ]);

      const memories = recallResult;

      // Language priority: current text > session history > orchestrator hint
      const detectedLang = this._detectLanguage(query);
      if (detectedLang) {
        sessionState.language_code = detectedLang;
      } else if (sessionState.language_code) {
        // Ambiguous text ("ja", "ok") — keep previous session language
      } else if (sttLanguageCode) {
        // Last resort: orchestrator hint (often wrong)
        sessionState.language_code = sttLanguageCode;
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
        // Pass the latest clinical insight (single directive, not the full history)
        clinicalInsight: sessionState.clinical_insights || null,
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
          max_tokens: config.max_tokens ?? 2048,  // gpt-oss reasoning models need headroom
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

  // ── Fast KB-only recall — stripped for voice latency ──
  // Vector search only (Qdrant ~30ms) + KB tag filter, no tsvector/scoring pipeline
  // Target: <100ms total recall vs 850ms full pipeline

  async _fastKBRecall(query, { userId, orgId }) {
    if (!query || query.length < 5) return [];

    // Skip recall entirely for greetings / trivial turns
    const trivial = /^(hi|hey|hello|thanks|ok|yes|no|sure|bye|good|great)\b/i.test(query.trim());
    if (trivial) return [];

    try {
      // Path 1: Qdrant vector search with KB filter (fast: embed ~30ms + search ~20ms)
      if (this.qdrantClient) {
        const results = await this.qdrantClient.searchMemories({
          query,
          limit: 5,
          score_threshold: 0.25,
          filter: {
            must: [
              { key: 'user_id', match: { value: userId } },
              { key: 'tags', match: { any: ['knowledge-base'] } },
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
        }));
      }

      // Path 2: Fallback to Prisma ILIKE if Qdrant unavailable
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
            AND 'knowledge-base' = ANY(m.tags)
            AND (${ilikeConditions})
          ORDER BY m.created_at DESC
          LIMIT 5
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
      console.warn('[tara/fast-recall] KB search failed:', err.message);
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
          `lang:${sessionState.language_code || 'en'}`,
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

      // Track successful save
      this._trackMemoryOperation(sessionId, 'saved');

      // 3. Chain turns: link this turn to the previous TURN (not insight)
      if (turnNumber > 1) {
        const { memories: prevTurns } = await this.memoryStore.listMemories({
          user_id: userId,
          org_id: orgId,
          tags: ['tara-turn', `sid:${sessionId}`, `turn:${turnNumber - 1}`],
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
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[tara/stream] Turn memory save failed:', err.message);
      // Never fail the turn because of graph persistence
    }

    // 3. Run clinical reasoning (async background — never blocks)
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
          console.log(`[tara/clinical] Insights ready in ${duration}ms for session ${sessionId.slice(0, 12)}`);

          // 4. Save insight as a visible memory (orange diamond in MemoryGraph)
          try {
            const insightId = crypto.randomUUID();
            const insightLines = [];
            if (insights.directive) insightLines.push(`Directive: ${insights.directive}`);
            if (insights.hypotheses?.length) {
              const hyps = insights.hypotheses.map(h => typeof h === 'string' ? h : `${h.text} (${Math.round((h.probability||0)*100)}%, ${h.status || 'active'})`);
              insightLines.push(`Hypotheses: ${hyps.join('; ')}`);
            }
            if (insights.user_type) insightLines.push(`User type: ${insights.user_type}`);
            if (insights.strategy) insightLines.push(`Strategy: ${insights.strategy}`);
            if (insights.reasoning_summary) insightLines.push(`Reasoning: ${insights.reasoning_summary}`);
            if (insights.psychological_notes) insightLines.push(`Notes: ${insights.psychological_notes}`);
            if (insights.red_flags?.length) insightLines.push(`Red flags: ${insights.red_flags.join('; ')}`);

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

            // Chain insight to previous insight (insight → insight chain in graph)
            if (turnNumber > 1) {
              const { memories: prevInsights } = await this.memoryStore.listMemories({
                user_id: userId, org_id: orgId,
                tags: ['tara-insight', `sid:${sessionId}`, `turn:${turnNumber - 1}`],
                limit: 1,
              });
              if (prevInsights?.length > 0) {
                await this.memoryStore.createRelationship({
                  id: crypto.randomUUID(),
                  from_id: insightId,
                  to_id: prevInsights[0].id,
                  type: 'Extends',
                  confidence: 1.0,
                  metadata: { source: 'tara_clinical_chain', session_id: sessionId },
                  created_by: 'tara-clinical',
                }).catch(() => {});
              }
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
