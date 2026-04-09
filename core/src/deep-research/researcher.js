/**
 * DeepResearcher
 *
 * AgentScope-grade deep research engine with CSI persistence.
 * Runs natively inside HIVEMIND core.
 *
 * Flow:
 *   1. Create research project in CSI graph
 *   2. Decompose query → TaskStack (depth-first, 8 dimensions)
 *   3. For each task, run a ReAct (Reason → Act → Observe) loop:
 *      a. REASON: LLM decides next action (SEARCH_WEB, SEARCH_MEMORY, READ_URL, SYNTHESIZE, FINISH)
 *      b. ACT: Execute the chosen action with LLM-generated queries
 *      c. OBSERVE: Add results to findings, loop back to REASON
 *      d. Up to 6 steps per task for iterative refinement
 *   4. Reflect: sufficient confidence? If not, rephrase & retry
 *   5. Synthesize final report from all findings
 *   6. Save trail + report to CSI graph
 *
 * Every step emits events for real-time frontend updates.
 */

import { randomUUID } from 'node:crypto';
import { TaskStack, DIMENSIONS } from './task-stack.js';
import { TrailStore } from './trail-store.js';
import { BlueprintMiner } from './blueprint-miner.js';
import { extractFacts } from '../memory/fact-extractor.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const MAX_REFLECTION_ROUNDS = 2;

export class DeepResearcher {
  /**
   * @param {Object} deps
   * @param {import('../memory/prisma-graph-store.js').PrismaGraphStore} deps.memoryStore
   * @param {Function} deps.recallFn - recallPersistedMemories function
   * @param {Object} deps.prisma - Prisma client for direct queries
   * @param {string} deps.groqApiKey
   * @param {Object} [deps.browserRuntime] - HIVEMIND BrowserRuntime for web search/crawl
   * @param {Object} [deps.webJobStore] - Web job store for tracking
   * @param {Function} [deps.onEvent] - callback for live progress events
   * @param {TrailStore} [deps.trailStore] - optional trail store for persistence
   * @param {boolean} [deps.autoMineBlueprints] - automatically mine blueprints after completion
   */
  constructor({ memoryStore, recallFn, prisma, groqApiKey, browserRuntime, webJobStore, onEvent, trailStore, autoMineBlueprints = true }) {
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.prisma = prisma;
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY;
    this.browserRuntime = browserRuntime || null;
    this.webJobStore = webJobStore || null;
    this.onEvent = onEvent || (() => {});
    this.trailStore = trailStore || null;
    this.autoMineBlueprints = autoMineBlueprints;
    this.blueprintMiner = new BlueprintMiner({ memoryStore, prisma });
  }

  /**
   * Run a full deep research session.
   * @param {string} query - the research question
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} [options]
   * @param {string} [options.projectId] - optional project ID (uses generated one if not provided)
   * @param {string} [options.sessionId] - optional session ID for event emission
   * @returns {Promise<Object>} ResearchResult
   */
  async research(query, userId, orgId, options = {}) {
    const sessionId = options.sessionId || randomUUID();
    const projectId = options.projectId || `research/${this._slugify(query)}`;
    const startTime = Date.now();

    this._emit('research.started', { sessionId, query, projectId });

    // Step 0: Check for matching blueprints (unless already specified)
    let blueprintUsed = options.blueprintId || null;
    let baseState = options.baseState || null;  // Captured state from "Use as Base"

    if (!blueprintUsed && options.useBlueprints !== false) {
      const suggestions = await this._suggestBlueprint(query);
      if (suggestions.length > 0 && suggestions[0].relevanceScore > 0.6) {
        blueprintUsed = suggestions[0].blueprintId;
        this._emit('research.blueprint_suggested', {
          sessionId,
          blueprintId: blueprintUsed,
          blueprintName: suggestions[0].name,
          relevanceScore: suggestions[0].relevanceScore,
        });
      }
    }

    // Initialize trail store for this session
    const trailStore = this.trailStore || new TrailStore({ memoryStore: this.memoryStore, userId, orgId });
    await trailStore.initTrail(sessionId, query, projectId, {
      blueprintUsed,
      blueprintCandidate: options.blueprintCandidate || false,
      baseState: baseState ? {
        sessionId: baseState.sessionId,
        capturedAt: baseState.capturedAt,
        sourceCount: baseState.sources?.length || 0,
        findingCount: baseState.findings?.length || 0,
      } : null,
    });

    // Track blueprint usage if one was used
    if (blueprintUsed) {
      await this._recordBlueprintUse(blueprintUsed);
    }

    // If we have a base state, pre-load the captured findings as starting point
    const priorFindings = baseState?.findings?.length > 0
      ? baseState.findings.map(f => ({
          id: f.id,
          type: f.type || 'web',
          title: f.title,
          content: f.content,
          source: f.source || 'captured_base',
          sourceId: f.sourceId,
          confidence: f.confidence || 0.7,
          taskQuery: query,
          agent: 'base_state',
        }))
      : await this._checkPriorResearch(query, userId, orgId, projectId);
    if (priorFindings.length >= 5 && !options.forceRefresh) {
      this._emit('research.cached', { sessionId, findingCount: priorFindings.length });
      const report = await this._synthesizeReport(query, priorFindings, []);
      await trailStore.finalizeTrail(sessionId, report);
      return {
        sessionId,
        projectId,
        query,
        report,
        findings: priorFindings,
        fromCache: true,
        durationMs: Date.now() - startTime,
        taskProgress: { total: 0, completed: 0, confidence: 0.9 },
      };
    }

    // Step 1: Decompose into subtasks
    const stack = new TaskStack();
    const root = stack.createRoot(query);

    // Use LLM to pick relevant dimensions
    const dimensions = await this._selectDimensions(query);
    this._emit('research.decomposed', { sessionId, dimensions, taskCount: dimensions.length + 1 });

    if (dimensions.length > 0) {
      stack.decompose(root.id, dimensions);
    }

    // Step 2: Process each task (depth-first)
    let reflectionRound = 0;
    const allFindings = [...priorFindings];
    const allSources = [];

    while (true) {
      const task = stack.next();
      if (!task) break;

      this._emit('task.started', {
        sessionId,
        taskId: task.id,
        query: task.query,
        depth: task.depth,
        dimension: task.dimension,
        progress: stack.getProgress(),
      });

      try {
        const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);

        stack.complete(task.id, {
          findings: result.findings,
          confidence: result.confidence,
          gaps: result.gaps,
        });

        allFindings.push(...result.findings);
        allSources.push(...result.sources);

        // Save findings to CSI graph
        for (const finding of result.findings) {
          await this._saveFindingToCSI(finding, userId, orgId, projectId);
        }

        this._emit('task.completed', {
          sessionId,
          taskId: task.id,
          findingCount: result.findings.length,
          confidence: result.confidence,
          gaps: result.gaps,
          progress: stack.getProgress(),
        });

      } catch (err) {
        stack.fail(task.id, err.message);
        this._emit('task.failed', { sessionId, taskId: task.id, error: err.message });
      }
    }

    // Step 3: Reflect — is confidence sufficient?
    const progress = stack.getProgress();
    if (progress.confidence < 0.75 && reflectionRound < MAX_REFLECTION_ROUNDS) {
      reflectionRound++;
      this._emit('research.reflecting', { sessionId, round: reflectionRound, confidence: progress.confidence });

      const gaps = stack.getRemainingGaps();
      const rephrased = await this._reflectAndRephrase(query, gaps, allFindings);

      for (const newQuery of rephrased.slice(0, 3)) {
        stack.addSubtask(root.id, newQuery, 'gaps');
      }

      // Continue processing newly added tasks
      while (true) {
        const task = stack.next();
        if (!task) break;
        try {
          const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
          stack.complete(task.id, result);
          allFindings.push(...result.findings);
          allSources.push(...result.sources);
          for (const finding of result.findings) {
            await this._saveFindingToCSI(finding, userId, orgId, projectId);
          }
          this._emit('task.completed', { sessionId, taskId: task.id, ...result, progress: stack.getProgress() });
        } catch (err) {
          stack.fail(task.id, err.message);
        }
      }
    }

    // Step 4: Synthesize final report
    this._emit('research.synthesizing', { sessionId, findingCount: allFindings.length });

    const report = await this._synthesizeReport(query, allFindings, stack.getRemainingGaps());

    // Step 5: Finalize trail in CSI via trailStore
    await trailStore.finalizeTrail(sessionId, report);

    // Step 6: Trigger blueprint mining (non-blocking, after research completes)
    if (this.autoMineBlueprints) {
      this._mineBlueprints(userId, orgId, query, stack).catch(err => {
        console.error('[DeepResearcher] Blueprint mining failed:', err.message);
      });
    }

    this._emit('research.completed', {
      sessionId,
      projectId,
      durationMs: Date.now() - startTime,
      findingCount: allFindings.length,
      taskProgress: stack.getProgress(),
      blueprintMined: this.autoMineBlueprints,
    });

    return {
      sessionId,
      projectId,
      query,
      report,
      findings: allFindings,
      sources: allSources,
      gaps: stack.getRemainingGaps(),
      fromCache: false,
      durationMs: Date.now() - startTime,
      taskProgress: stack.getProgress(),
      trail: stack.toJSON(),
    };
  }

  // ─── Internal Methods ──────────────────────────────────────

  async _executeTask(task, userId, orgId, projectId, sessionId, trailStore) {
    const findings = [];
    const sources = [];
    const maxSteps = 8;
    let step = 0;
    let stepIndex = 0;

    // Track agent states for real-time visibility
    const agentStates = { explorer: 'idle', analyst: 'idle', verifier: 'idle', synthesizer: 'idle' };
    const updateAgentState = (agent, state, detail = '') => {
      agentStates[agent] = state;
      this._emit('agent.state', { taskId: task.id, agent, state, detail, timestamp: new Date().toISOString() });
    };
    this._emit('agent.states', { taskId: task.id, states: { ...agentStates } });

    while (step < maxSteps) {
      step++;

      // PHASE 1-3: EXPLORATION (Explorer Agent)
      if (step <= 3) {
        updateAgentState('explorer', 'active', 'Searching for sources');
        const reasoning = await this._reasonExplore(task.query, findings, step);
        this._emit('task.reasoning', { taskId: task.id, step, agent: 'explorer', action: reasoning.action, thought: reasoning.thought });

        if (reasoning.action === 'FINISH') break;

        let result;
        if (reasoning.action === 'READ_URL') {
          result = await this._actReadUrl(reasoning.url, userId, orgId, projectId, sessionId, trailStore);
        } else {
          result = await this._actSearchWeb(reasoning.query || task.query, userId, orgId, projectId, sessionId, trailStore);
        }

        if (result?.content) {
          const finding = { id: randomUUID(), type: result.type || 'web', title: result.title || reasoning.query, content: result.content, source: result.source || 'web', sourceId: result.sourceId, confidence: result.confidence || 0.6, taskQuery: task.query, agent: 'explorer' };
          findings.push(finding);
          sources.push({ type: result.type, id: result.sourceId, title: result.title });
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'explorer', reasoning.action, finding, projectId, {
            thought: reasoning.thought,
            why: reasoning.thought,
          });

          // Write execution event for real-time graph
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'explorer', 'search_web', { findingsCount: findings.length, source: result.type });
        }
        updateAgentState('explorer', findings.length > 0 ? 'completed' : 'idle');
        continue;
      }

      // PHASE 4: ANALYSIS (Analyst Agent)
      if (step === 4 && findings.length > 0) {
        updateAgentState('analyst', 'active', 'Analyzing findings');
        const analysis = await this._actAnalyze(task.query, findings, userId, orgId, projectId);
        if (analysis?.claims?.length > 0) {
          // Build mapping from analysis sourceIndices back to actual sourceIds from webFindings
          const webFindings = findings.filter(f => f.type === 'web' || f.type === 'follow_up');

          for (const structuredClaim of analysis.claims) {
            // Map sourceIndices to actual sourceIds
            const sourceIds = (structuredClaim.sourceIndices || [])
              .map(i => webFindings[i]?.sourceId || webFindings[i]?.id)
              .filter(Boolean);

            const finding = {
              id: randomUUID(),
              type: structuredClaim.isLegacy ? 'claim' : 'structured-claim',
              title: `Claim: ${(structuredClaim.claim || structuredClaim).slice(0, 80)}`,
              content: structuredClaim.claim || structuredClaim,
              source: 'analyst_extraction',
              confidence: structuredClaim.confidence || 0.75,
              taskQuery: task.query,
              agent: 'analyst',
              // Store structured data in metadata for CSI persistence
              structured: structuredClaim.isLegacy ? null : {
                subject: structuredClaim.subject,
                predicate: structuredClaim.predicate,
                object: structuredClaim.object,
                entities: structuredClaim.entities,
                sourceIds,
                evidenceSnippets: structuredClaim.evidenceSnippets,
              },
            };
            findings.push(finding);
            await this._recordFinding(trailStore, sessionId, stepIndex++, 'analyst', 'EXTRACT_CLAIM', finding, projectId, {
              thought: structuredClaim.extractionThought || `Extracting structured claims from gathered sources`,
              why: 'Sources have been gathered and now need to be distilled into key claims',
            });
          }
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'analyst', 'extract_claims', { claimsCount: analysis.claims.length });
        }
        const memoryFindings = await this._actSearchMemory(task.query, userId, orgId, projectId);
        if (memoryFindings?.content) {
          const finding = { id: randomUUID(), type: 'memory', title: memoryFindings.title, content: memoryFindings.content, source: 'hivemind_memory', sourceId: memoryFindings.sourceId, confidence: memoryFindings.confidence || 0.6, taskQuery: task.query, agent: 'analyst' };
          findings.push(finding);
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'analyst', 'SEARCH_MEMORY', finding, projectId, {
            thought: `Checking existing memory for relevant context`,
            why: 'Prior research in memory may provide additional context or validation',
          });
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'analyst', 'search_memory', { hasMemoryContent: true });
        }
        updateAgentState('analyst', 'completed');
        this._emit('task.observation', { taskId: task.id, step, agent: 'analyst', type: 'analysis_complete', title: `Extracted ${analysis?.claims?.length || 0} claims` });
        continue;
      }

      // PHASE 5: VERIFICATION (Verifier Agent)
      if (step === 5 && findings.length > 0) {
        updateAgentState('verifier', 'active', 'Verifying findings');
        const verification = await this._actVerify(task.query, findings, trailStore, sessionId);
        await trailStore?.recordStep(sessionId, {
          stepIndex: stepIndex++,
          agent: 'verifier',
          action: 'verify_findings',
          input: task.query,
          output: `Verified ${verification.verified?.length || 0}, rejected ${verification.rejected?.length || 0}`,
          confidence: verification.overallConfidence || 0.7,
          rejected: false,
          thought: `Checking claims for quality and contradictions`,
          why: 'Claims need verification to ensure reliability before synthesis',
        });
        await this._writeExecutionEvent(sessionId, projectId, trailStore, 'verifier', 'verify_findings', { verified: verification.verified?.length || 0, rejected: verification.rejected?.length || 0, contradictions: verification.contradictions?.length || 0 });
        if (verification.contradictions?.length > 0) {
          for (const contradiction of verification.contradictions) await trailStore?.recordContradiction(sessionId, contradiction);
          this._emit('verifier.contradiction', { taskId: task.id, count: verification.contradictions.length, details: verification.contradictions });
        }
        updateAgentState('verifier', 'completed', `${verification.verified?.length || 0} verified, ${verification.rejected?.length || 0} rejected`);
        this._emit('task.observation', { taskId: task.id, step, agent: 'verifier', type: 'verification_complete', title: `Found ${verification.contradictions?.length || 0} contradictions` });
        continue;
      }

      // PHASE 6: SYNTHESIS (Synthesizer Agent)
      if (step === 6 && findings.length > 0) {
        updateAgentState('synthesizer', 'active', 'Synthesizing answer');
        const synthesis = await this._actSynthesize(task.query, findings);
        if (synthesis?.content) {
          const finding = { id: randomUUID(), type: 'synthesis', title: `Synthesis: ${task.query.slice(0, 50)}`, content: synthesis.content, source: 'synthesizer', confidence: synthesis.confidence || 0.8, taskQuery: task.query, agent: 'synthesizer' };
          findings.push(finding);
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'synthesizer', 'SYNTHESIZE', finding, projectId, {
            thought: `Combining all gathered findings into a cohesive answer`,
            why: 'All sources and claims have been gathered and verified - now need to produce final synthesis',
          });
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'synthesizer', 'synthesize', { synthesisLength: synthesis.content?.length || 0, confidence: synthesis.confidence });
        }
        updateAgentState('synthesizer', 'completed');
        this._emit('task.observation', { taskId: task.id, step, agent: 'synthesizer', type: 'synthesis_complete', title: 'Synthesis complete' });
        break;
      }

      if (step >= maxSteps - 1) break;
    }

    Object.keys(agentStates).forEach(agent => { if (agentStates[agent] === 'idle') agentStates[agent] = 'not_used'; });
    this._emit('agent.states', { taskId: task.id, states: agentStates, final: true });

    // Extract synthesis as report (final finding from synthesizer agent)
    const synthesisFinding = findings.find(f => f.type === 'synthesis' || f.agent === 'synthesizer');
    const report = synthesisFinding?.content || null;

    const verifiedFindings = findings.filter(f => f.confidence >= 0.6);
    const confidence = verifiedFindings.length > 0 ? Math.min(0.95, verifiedFindings.reduce((sum, f) => sum + f.confidence, 0) / verifiedFindings.length) : (findings.length > 0 ? 0.5 : 0.1);
    const gaps = await this._detectGaps(task.query, findings);

    return { findings, sources, confidence, gaps, agentStates, report };
  }

  async _recordFinding(trailStore, sessionId, stepIndex, agent, action, finding, projectId, reasoning = null) {
    if (!trailStore) return;

    // Build step record with reasoning fields if provided
    const stepRecord = {
      stepIndex,
      agent,
      action: action.toLowerCase(),
      input: finding.taskQuery,
      output: finding.content.slice(0, 500),
      confidence: finding.confidence,
      rejected: false,
    };

    // Add reasoning fields if provided
    if (reasoning) {
      if (reasoning.thought) stepRecord.thought = reasoning.thought;
      if (reasoning.why) stepRecord.why = reasoning.why;
      if (reasoning.alternativeConsidered) stepRecord.alternativeConsidered = reasoning.alternativeConsidered;
    }

    // Write step to trail
    await trailStore.recordStep(sessionId, stepRecord);
    await trailStore.detectContradiction(sessionId, { content: finding.content, source: finding.source, memoryId: finding.id });

    // NEW: Write individual observation to CSI for real-time graph updates
    // This ensures graph has data during research, not just after completion
    try {
      const observationId = randomUUID();
      await this.memoryStore.createMemory({
        id: observationId,
        user_id: trailStore.userId,
        org_id: trailStore.orgId,
        project: projectId,
        content: finding.content.slice(0, 1000),
        title: `${action}: ${finding.title?.slice(0, 50) || 'Finding'}`,
        memory_type: 'event',
        tags: ['research-observation', `agent:${agent}`, `action:${action.toLowerCase()}`, `session:${sessionId}`],
        is_latest: true,
        importance_score: finding.confidence || 0.7,
        metadata: {
          observationType: 'op/research-observation',
          sessionId,
          stepIndex,
          agent,
          action,
          findingType: finding.type || 'web',
          source: finding.source,
          sourceId: finding.sourceId,
          taskQuery: finding.taskQuery,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log('[DeepResearcher] Saved observation to CSI:', observationId.slice(0, 20), 'agent:', agent, 'action:', action);
    } catch (err) {
      console.error('[DeepResearcher] Failed to save observation:', err.message);
    }
  }

  /**
   * Write execution event to CSI for real-time graph tracking.
   * Tracks agent phase completions with latency and outcomes.
   */
  async _writeExecutionEvent(sessionId, projectId, trailStore, agent, action, output) {
    try {
      const eventId = randomUUID();
      await this.memoryStore.createMemory({
        id: eventId,
        user_id: trailStore.userId,
        org_id: trailStore.orgId,
        project: projectId,
        content: `${agent}/${action}: ${JSON.stringify(output)}`,
        title: `Execution: ${agent}/${action}`,
        memory_type: 'event',
        tags: ['research-execution-event', `agent:${agent}`, `action:${action}`, `session:${sessionId}`],
        is_latest: true,
        importance_score: 0.5,
        metadata: {
          executionEventType: 'op/research-execution-event',
          sessionId,
          agent,
          action,
          output,
          latency: output.latency || null,
          success: output.success !== false,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      // Non-critical: execution events are nice-to-have for graph visualization
      console.debug('[DeepResearcher] Failed to save execution event:', err.message);
    }
  }

  async _reasonExplore(query, findings, step) {
    const findingsSummary = findings.length > 0 ? findings.slice(-3).map(f => `[${f.type}] ${f.title}`).join('\n') : '(none yet)';
    const response = await this._llm(`You are the EXPLORER agent. Your job is to gather sources and raw information.\n\nResearch question: "${query}"\n\nCurrent findings: ${findingsSummary}\n\nChoose your NEXT ACTION to gather more sources:\n{\n  "thought": "brief reasoning",\n  "action": "SEARCH_WEB" | "READ_URL" | "FINISH",\n  "query": "specific search query if SEARCH_WEB",\n  "url": "specific URL if READ_URL"\n}\n\nRules:\n- SEARCH_WEB: Use for gathering new web sources\n- READ_URL: Use when you have a specific URL to deep-read\n- FINISH: Use when you have gathered sufficient sources (3-5 good sources)`, { temperature: 0.3 });
    try {
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      return { thought: parsed.thought || '', action: ['SEARCH_WEB', 'READ_URL', 'FINISH'].includes(parsed.action) ? parsed.action : 'SEARCH_WEB', query: parsed.query || query, url: parsed.url || null };
    } catch { return { thought: 'Exploring web', action: 'SEARCH_WEB', query, url: null }; }
  }

  async _actAnalyze(query, findings, userId, orgId, projectId) {
    const webFindings = findings.filter(f => f.type === 'web' || f.type === 'follow_up');
    if (webFindings.length === 0) return { claims: [] };

    // Build source content with indices for attribution
    const sourcesWithContext = webFindings.map((f, i) => `[${i}] ${f.title}: ${f.content?.slice(0, 800) || ''}`).join('\n\n');

    const response = await this._llm(`You are the ANALYST agent. Extract key claims from these sources with structured format and source attribution.

Research question: "${query}"

Sources (with indices):
${sourcesWithContext}

First, provide your reasoning:
- thought: Brief explanation of your analysis approach
- why: Why this approach is appropriate for this query

Then extract 3-5 key claims. For each claim, provide:
- claim: The claim statement (subject-predicate-object format preferred)
- subject: Main subject/entity
- predicate: Action/relationship
- object: Target/outcome
- entities: Array of {name, type} for named entities mentioned (person|org|system|concept)
- sourceIndices: Array of source indices (0-based) that support this claim
- evidenceSnippets: Short quotes from each source supporting the claim
- confidence: 0.0-1.0 confidence score

Return JSON:
{
  "thought": "your reasoning about the analysis approach",
  "why": "why this approach fits the query",
  "claims": [
    {
      "claim": "...",
      "subject": "...",
      "predicate": "...",
      "object": "...",
      "entities": [{"name": "Entity", "type": "person|org|system|concept"}],
      "sourceIndices": [0, 2],
      "evidenceSnippets": ["quote1", "quote2"],
      "confidence": 0.8
    }
  ]
}

If you cannot extract structured data, return a simple array of claim strings: ["claim 1", "claim 2"]`, { temperature: 0.2 });

    try {
      const raw = response.match(/\{[\s\S]*\}/)?.[0] || response.match(/\[[\s\S]*\]/)?.[0] || '[]';
      const parsed = JSON.parse(raw);

      // Handle legacy format: simple array of strings
      if (Array.isArray(parsed)) {
        return { claims: parsed.slice(0, 5), isLegacy: true };
      }

      // Handle new structured format
      if (parsed.claims && Array.isArray(parsed.claims)) {
        const analysisThought = parsed.thought || 'Extracting structured claims from gathered sources';
        const analysisWhy = parsed.why || 'Sources have been gathered and need to be distilled into key claims';

        const structuredClaims = parsed.claims.slice(0, 5).map(claim => {
          // Backward compatibility: if claim is a string, convert to minimal structured format
          if (typeof claim === 'string') {
            return {
              claim,
              subject: '',
              predicate: '',
              object: '',
              entities: [],
              sourceIndices: [],
              evidenceSnippets: [],
              confidence: 0.75,
              isLegacy: true,
              extractionThought: analysisThought,
            };
          }

          // Enrich entities with fact-extractor fallback
          const llmEntities = claim.entities || [];
          const heuristicEntities = extractFacts(claim.claim || '').entities || [];

          // Merge entities, prioritizing LLM-extracted with types
          const mergedEntities = [...llmEntities];
          const seenEntities = new Set(llmEntities.map(e => e.name?.toLowerCase()));

          for (const entity of heuristicEntities) {
            if (!seenEntities.has(entity.toLowerCase()) && mergedEntities.length < 10) {
              mergedEntities.push({ name: entity, type: 'unknown' });
              seenEntities.add(entity.toLowerCase());
            }
          }

          return {
            claim: claim.claim || '',
            subject: claim.subject || '',
            predicate: claim.predicate || '',
            object: claim.object || '',
            entities: mergedEntities,
            sourceIndices: claim.sourceIndices || [],
            evidenceSnippets: claim.evidenceSnippets || [],
            confidence: claim.confidence || 0.75,
            isLegacy: false,
            extractionThought: analysisThought,
          };
        });

        return { claims: structuredClaims, thought: analysisThought, why: analysisWhy };
      }

      return { claims: [] };
    } catch (parseErr) {
      // Fallback: try to parse as simple array
      try {
        const simpleClaims = JSON.parse(response.match(/\[[\s\S]*\]/)?.[0] || '[]');
        return { claims: simpleClaims.slice(0, 5), isLegacy: true };
      } catch {
        return { claims: [] };
      }
    }
  }

  async _actVerify(query, findings, trailStore, sessionId) {
    const claims = findings.filter(f => f.type === 'claim' || f.confidence >= 0.6);
    if (claims.length < 2) return { verified: claims, rejected: [], contradictions: [], overallConfidence: 0.7 };
    const claimsText = claims.map((f, i) => `[${i + 1}] ${f.content.slice(0, 200)} (source: ${f.source})`).join('\n');
    const response = await this._llm(`You are the VERIFIER agent. Check these claims for quality and contradictions.\n\nResearch question: "${query}"\n\nClaims to verify:\n${claimsText}\n\nReturn JSON:\n{\n  "verifiedIndices": [1, 3],\n  "rejectedIndices": [2],\n  "contradictions": [{"claimAIndex": 1, "claimBIndex": 3, "reason": "they disagree"}],\n  "overallConfidence": 0.75\n}`, { temperature: 0.2 });
    try {
      const result = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      const verified = (result.verifiedIndices || []).map(i => claims[i - 1]).filter(Boolean);
      const rejected = (result.rejectedIndices || []).map(i => claims[i - 1]).filter(Boolean);
      const contradictions = (result.contradictions || []).map(c => ({ claimA: { source: claims[c.claimAIndex - 1]?.source, content: claims[c.claimAIndex - 1]?.content, memoryId: claims[c.claimAIndex - 1]?.id }, claimB: { source: claims[c.claimBIndex - 1]?.source, content: claims[c.claimBIndex - 1]?.content, memoryId: claims[c.claimBIndex - 1]?.id }, dimension: 'factual', unresolved: true })).filter(c => c.claimA.content && c.claimB.content);
      return { verified, rejected, contradictions, overallConfidence: result.overallConfidence || 0.7 };
    } catch { return { verified: claims, rejected: [], contradictions: [], overallConfidence: 0.7 }; }
  }

  async _reason(query, findings, step) {
    const findingsSummary = findings.length > 0
      ? findings.slice(-5).map(f => `[${f.type}] ${f.title}: ${f.content?.slice(0, 150)}`).join('\n')
      : '(none yet)';

    const response = await this._llm(`You are a research agent working on this question:
"${query}"

Step ${step}. Findings so far:
${findingsSummary}

Choose your NEXT ACTION. Return JSON:
{
  "thought": "brief reasoning about what to do next",
  "action": "SEARCH_WEB" | "SEARCH_MEMORY" | "READ_URL" | "SYNTHESIZE" | "FINISH",
  "query": "search query if action is SEARCH_WEB or SEARCH_MEMORY",
  "url": "url to read if action is READ_URL"
}

Rules:
- Start with SEARCH_WEB for factual questions about the world
- Use SEARCH_MEMORY only when the question is about the user's own data
- Use READ_URL after finding promising URLs from web search
- Use SYNTHESIZE when you have enough findings to combine
- Use FINISH when the question is well-answered
- Generate specific, focused search queries — not the full research question`, { temperature: 0.3 });

    try {
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] || '{}');
      return {
        thought: parsed.thought || '',
        action: ['SEARCH_WEB', 'SEARCH_MEMORY', 'READ_URL', 'SYNTHESIZE', 'FINISH'].includes(parsed.action)
          ? parsed.action : 'SEARCH_WEB',
        query: parsed.query || query,
        url: parsed.url || null,
      };
    } catch {
      return { thought: 'Fallback to web search', action: step === 1 ? 'SEARCH_WEB' : 'FINISH', query, url: null };
    }
  }

  async _actSearchMemory(query, userId, orgId, projectId) {
    const memories = await this._recallFromCSI(query, userId, orgId, projectId);
    // Only return memories that are ACTUALLY relevant (score > 0.6)
    const relevant = memories.filter(m => (m.score || 0) > 0.6);
    if (relevant.length === 0) return { type: 'memory', content: null };

    const combined = relevant.slice(0, 5).map(m => `- ${m.title || ''}: ${(m.content || '').slice(0, 200)}`).join('\n');
    return {
      type: 'memory',
      title: `Memory recall: ${query.slice(0, 50)}`,
      content: combined,
      source: 'hivemind_memory',
      sourceId: relevant[0]?.id,
      confidence: relevant[0]?.score || 0.6,
    };
  }

  async _actSearchWeb(query, userId, orgId, projectId, sessionId, trailStore) {
    const results = await this._webSearch(query);
    if (results.length === 0) return { type: 'web', content: null };

    // Save individual sources to CSI graph (Layer 1: Sources)
    const savedSources = await this._saveWebSourcesToCSI(results, userId, orgId, projectId, sessionId, trailStore);

    const combined = results.slice(0, 5).map(r =>
      `[${r.title || 'Untitled'}](${r.url || ''}): ${(r.snippet || r.summary || r.content || '').slice(0, 300)}`
    ).join('\n\n');

    return {
      type: 'web',
      title: `Web: ${query.slice(0, 50)}`,
      content: combined,
      source: results[0]?.url || 'web',
      sourceId: results[0]?.url,
      confidence: 0.7,
      _urls: results.map(r => r.url).filter(Boolean),
      _savedSources: savedSources,  // Track saved source IDs
    };
  }

  async _actReadUrl(url, userId, orgId, projectId, sessionId, trailStore) {
    if (!url) return { type: 'follow_up', content: null };

    // Save the URL as a source
    const savedSources = await this._saveWebSourcesToCSI(
      [{ url, title: `Deep read: ${url}`, snippet: '' }],
      userId, orgId, projectId, sessionId, trailStore
    );

    const content = await this._followUpRead(url);
    if (!content) return { type: 'follow_up', content: null };

    return {
      type: 'follow_up',
      title: `Deep read: ${url}`,
      content: content.slice(0, 3000),
      source: url,
      sourceId: url,
      confidence: 0.75,
      _savedSources: savedSources,
    };
  }

  async _actSynthesize(query, findings) {
    if (findings.length === 0) return { type: 'synthesis', content: null };

    const material = findings.slice(0, 10).map(f => f.content?.slice(0, 300) || '').join('\n---\n');
    const synthesis = await this._llm(
      `Synthesize these research findings into a concise summary answering: "${query}"\n\nFindings:\n${material}\n\nWrite a clear, factual summary:`,
      { temperature: 0.4 }
    );

    return {
      type: 'synthesis',
      title: `Synthesis: ${query.slice(0, 50)}`,
      content: synthesis,
      source: 'llm_synthesis',
      confidence: 0.8,
    };
  }

  async _checkPriorResearch(query, userId, orgId, projectId) {
    try {
      const result = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        tags: ['research-finding'],
        max_memories: 10,
      });
      return (result.memories || []).filter(m => (m.score || 0) > 0.5);
    } catch {
      return [];
    }
  }

  async _recallFromCSI(query, userId, orgId, projectId) {
    try {
      // First check project-specific research findings (prior research)
      const projectResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        max_memories: 5,
      });
      const projectMemories = (projectResults.memories || []).filter(m => (m.score || 0) > 0.5);

      // Then check main memory but with HIGH threshold — only borrow if truly relevant
      const mainResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        max_memories: 5,
      });
      // Very strict: only borrow from main memory if score > 0.75
      const mainMemories = (mainResults.memories || []).filter(m => (m.score || 0) > 0.75);

      // Deduplicate
      const seen = new Set(projectMemories.map(m => m.id));
      const combined = [...projectMemories];
      for (const m of mainMemories) {
        if (!seen.has(m.id)) combined.push(m);
      }
      return combined.slice(0, 8);
    } catch {
      return [];
    }
  }

  async _webSearch(query) {
    this._emit('web.searching', { query });

    // Try browserRuntime first (LightPanda)
    if (this.browserRuntime) {
      try {
        const result = await this.browserRuntime.search({ query, domains: [], limit: 5 });
        const results = Array.isArray(result.results) ? result.results : [];
        if (results.length > 0) {
          this._emit('web.results', { query, count: results.length, via: 'lightpanda' });
          return results;
        }
      } catch (err) {
        console.error('[DeepResearcher] Browser search failed:', err.message);
      }
    }

    // Fallback: DuckDuckGo HTML scrape (no browser needed)
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; HivemindResearch/1.0)',
          'Accept': 'text/html',
        },
      });
      if (!res.ok) throw new Error(`DDG ${res.status}`);
      const html = await res.text();

      // Parse results from DDG HTML
      const results = [];
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = resultPattern.exec(html)) !== null && results.length < 5) {
        const url = decodeURIComponent((match[1].match(/uddg=([^&]+)/) || [])[1] || match[1]);
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (url && title && url.startsWith('http')) {
          results.push({ url, title, snippet, summary: snippet });
        }
      }

      // Simpler fallback pattern if the above doesn't match
      if (results.length === 0) {
        const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        while ((match = linkPattern.exec(html)) !== null && results.length < 5) {
          const url = decodeURIComponent((match[1].match(/uddg=([^&]+)/) || [])[1] || match[1]);
          const title = match[2].replace(/<[^>]+>/g, '').trim();
          if (url && title && url.startsWith('http') && !url.includes('duckduckgo.com')) {
            results.push({ url, title, snippet: title, summary: title });
          }
        }
      }

      this._emit('web.results', { query, count: results.length, via: 'duckduckgo' });
      return results;
    } catch (err) {
      this._emit('web.error', { query, error: err.message });
      return [];
    }
  }

  async _followUpRead(url) {
    if (!url) return null;
    this._emit('web.reading', { url });

    // Try browserRuntime first
    if (this.browserRuntime) {
      try {
        const result = await this.browserRuntime.crawl({ urls: [url], depth: 0, pageLimit: 1 });
        const pages = Array.isArray(result.results) ? result.results : [];
        const content = pages[0]?.text || pages[0]?.content || pages[0]?.markdown || null;
        if (content) {
          this._emit('web.read_complete', { url, length: content.length, via: 'lightpanda' });
          return content;
        }
      } catch (err) {
        console.error('[DeepResearcher] Browser search failed:', err.message);
      }
    }

    // Fallback: direct fetch + HTML strip
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HivemindResearch/1.0)', 'Accept': 'text/html' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      // Strip HTML tags, scripts, styles
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Take meaningful content (skip first 200 chars likely nav/header)
      text = text.slice(200, 5000).trim();
      if (text.length > 100) {
        this._emit('web.read_complete', { url, length: text.length, via: 'fetch' });
        return text;
      }
      return null;
    } catch (err) {
      this._emit('web.read_error', { url, error: err.message });
      return null;
    }
  }

  async _selectDimensions(query) {
    try {
      const response = await this._llm(
        `Given this research question, select which research dimensions are most relevant. Return ONLY a JSON array of dimension names.\n\nDimensions: ${DIMENSIONS.join(', ')}\n\nQuestion: ${query}\n\nReturn 3-5 most relevant dimensions as JSON array:`,
        { temperature: 0.3 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return parsed.filter(d => DIMENSIONS.includes(d)).slice(0, 5);
    } catch {
      // Fallback: pick first 4 dimensions
      return DIMENSIONS.slice(0, 4);
    }
  }

  async _detectGaps(query, findings) {
    try {
      // Only include genuinely relevant findings (not random memory noise)
      const relevant = findings.filter(f => f.confidence > 0.5 && f.type !== 'memory');
      const findingSummaries = relevant.length > 0
        ? relevant.slice(0, 8).map(f => f.content.slice(0, 200)).join('\n- ')
        : '(No relevant findings yet)';
      const response = await this._llm(
        `You are identifying research gaps. Given the original research question and findings so far, output specific SUB-QUESTIONS that still need answering.\n\n` +
        `Original question: ${query}\n\n` +
        `Findings so far:\n- ${findingSummaries}\n\n` +
        `Output 1-3 specific, searchable sub-questions as a JSON array of strings. ` +
        `Each sub-question should be a concrete, web-searchable query (not meta-commentary). ` +
        `Example: ["EU AI Act compliance requirements for SaaS 2026", "German data protection GDPR AI Act overlap"]\n` +
        `If the question is well-covered, return [].`,
        { temperature: 0.3 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return Array.isArray(parsed) ? parsed.filter(g => typeof g === 'string' && g.length > 10).slice(0, 3) : [];
    } catch {
      return [];
    }
  }

  async _reflectAndRephrase(query, gaps, findings) {
    if (gaps.length === 0) return [];
    try {
      const gapList = gaps.map(g => g.gap || g).join('\n- ');
      const response = await this._llm(
        `The research on "${query}" has gaps:\n- ${gapList}\n\nRephrase each gap as a specific, searchable sub-question. Return a JSON array of strings.`,
        { temperature: 0.4 }
      );
      const parsed = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]');
      return Array.isArray(parsed) ? parsed.filter(q => typeof q === 'string').slice(0, 3) : [];
    } catch {
      return gaps.map(g => g.gap || String(g));
    }
  }

  async _synthesizeReport(query, findings, gaps) {
    const findingTexts = findings.slice(0, 20).map((f, i) =>
      `[${i + 1}] (${f.type || 'unknown'}) ${f.title}: ${f.content?.slice(0, 300) || 'No content'}`
    ).join('\n\n');

    const gapTexts = gaps.length > 0
      ? `\n\nRemaining gaps:\n${gaps.map(g => `- ${g.gap || g}`).join('\n')}`
      : '';

    const report = await this._llm(
      `Synthesize a comprehensive research report from the findings below.\n\n` +
      `Research Question: ${query}\n\n` +
      `Findings:\n${findingTexts}${gapTexts}\n\n` +
      `Write a well-structured report with:\n` +
      `1. Executive Summary (2-3 sentences)\n` +
      `2. Key Findings (organized by theme)\n` +
      `3. Evidence & Sources (reference finding numbers [1], [2], etc.)\n` +
      `4. Gaps & Limitations\n` +
      `5. Conclusion\n\n` +
      `Use markdown formatting. Be thorough but concise.`,
      { temperature: 0.5, maxTokens: 4000 }
    );

    return report;
  }

  async _saveFindingToCSI(finding, userId, orgId, projectId) {
    try {
      await this.memoryStore.createMemory({
        id: finding.id,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        content: `${finding.title}\n\n${finding.content}`,
        title: finding.title,
        memory_type: 'fact',
        tags: ['research-finding', `source:${finding.type}`, `query:${finding.taskQuery?.slice(0, 50) || 'unknown'}`],
        is_latest: true,
        importance_score: finding.confidence || 0.7,
        metadata: {
          research_type: finding.type,
          source_url: finding.source,
          source_id: finding.sourceId,
          confidence: finding.confidence,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      console.log('[DeepResearcher] Saved finding to CSI:', finding.title?.slice(0, 50), 'project:', projectId);
    } catch (err) {
      console.error('[DeepResearcher] Failed to save finding:', err.message, 'finding:', finding.title?.slice(0, 50));
    }
  }

  /**
   * Save web sources as separate graph nodes (Layer 1: Sources).
   * Called during web search to persist individual URLs before they're combined into findings.
   * @param {Array} sources - Array of { url, title, snippet } from web search
   * @param {string} userId
   * @param {string} orgId
   * @param {string} projectId
   * @param {string} sessionId
   * @param {TrailStore} trailStore
   */
  async _saveWebSourcesToCSI(sources, userId, orgId, projectId, sessionId, trailStore) {
    if (!sources || sources.length === 0) return [];

    const savedSources = [];
    for (const src of sources.slice(0, 10)) {  // Limit to 10 sources per search
      if (!src.url) continue;

      const sourceId = randomUUID();
      try {
        await this.memoryStore.createMemory({
          id: sourceId,
          user_id: userId,
          org_id: orgId,
          project: projectId,
          content: `${src.title || 'Untitled'}\n\n${src.snippet || src.summary || src.content || ''}`,
          title: src.title || src.url,
          memory_type: 'fact',
          tags: ['research-source', 'web-source', `session:${sessionId}`],
          is_latest: true,
          importance_score: 0.8,
          metadata: {
            source_type: 'web',
            url: src.url,
            snippet: src.snippet,
            research_source: 'tavily',
            saved_at: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        savedSources.push({ id: sourceId, url: src.url, title: src.title });
        console.log('[DeepResearcher] Saved web source to CSI:', src.title?.slice(0, 50), 'url:', src.url?.slice(0, 80));

        // Record to trail
        if (trailStore) {
          await trailStore.recordStep(sessionId, {
            stepIndex: -1,
            agent: 'explorer',
            action: 'search_web',
            input: src.url,
            output: src.title || src.url,
            confidence: 0.7,
            rejected: false,
          });
        }
      } catch (err) {
        console.error('[DeepResearcher] Failed to save source:', err.message);
      }
    }
    return savedSources;
  }

  async _saveTrailToCSI(sessionId, query, stack, report, userId, orgId, projectId) {
    try {
      await this.memoryStore.createMemory({
        id: randomUUID(),
        user_id: userId,
        org_id: orgId,
        project: projectId,
        content: `Research Trail: ${query}\n\n${report.slice(0, 1000)}`,
        title: `Research: ${query.slice(0, 80)}`,
        memory_type: 'decision',
        tags: ['research-trail', 'csi-trail', 'research-report'],
        is_latest: true,
        importance_score: 0.9,
        metadata: {
          research_session_id: sessionId,
          task_count: stack.getProgress().total,
          finding_count: stack.getProgress().findingCount,
          confidence: stack.getProgress().confidence,
          trail: stack.toJSON(),
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Non-fatal
    }
  }

  async _llm(prompt, { temperature = 0.5, maxTokens = 2000 } = {}) {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    if (!res.ok) throw new Error(`LLM call failed: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  _emit(type, data) {
    try { this.onEvent({ type, timestamp: new Date().toISOString(), ...data }); } catch (err) {
      console.error('[DeepResearcher] Event emission failed:', err.message);
    }
  }

  _slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60).replace(/-$/, '');
  }

  /**
   * Map action type to agent role.
   * @private
   */
  _mapActionToAgent(action) {
    const mapping = {
      'SEARCH_WEB': 'explorer',
      'SEARCH_MEMORY': 'analyst',
      'READ_URL': 'explorer',
      'SYNTHESIZE': 'synthesizer',
      'FINISH': 'synthesizer',
    };
    return mapping[action] || 'explorer';
  }

  /**
   * Record a contradiction between findings.
   * @param {string} sessionId
   * @param {Object} contradiction
   * @param {Object} contradiction.claimA - { source, content, memoryId }
   * @param {Object} contradiction.claimB - { source, content, memoryId }
   * @param {string} contradiction.dimension - what dimension they conflict on
   * @param {boolean} contradiction.unresolved - is this still debated?
   */
  async _recordContradiction(sessionId, contradiction) {
    if (!this.trailStore) return null;
    return await this.trailStore.recordContradiction(sessionId, contradiction);
  }

  /**
   * Suggest blueprints for a query.
   * @param {string} query
   * @returns {Promise<Array>}
   * @private
   */
  async _suggestBlueprint(query) {
    try {
      const userId = this.trailStore?.userId || 'system';
      const orgId = this.trailStore?.orgId || 'system';

      const suggestions = await this.blueprintMiner.suggestBlueprints(userId, orgId, query);
      return suggestions || [];
    } catch {
      return [];
    }
  }

  /**
   * Record blueprint usage for calibration.
   * @param {string} blueprintId
   * @private
   */
  async _recordBlueprintUse(blueprintId) {
    try {
      const userId = this.trailStore?.userId || 'system';
      const orgId = this.trailStore?.orgId || 'system';

      await this.blueprintMiner.incrementReuseCount(userId, orgId, blueprintId);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Mine blueprints from completed research.
   * @param {string} userId
   * @param {string} orgId
   * @param {string} query
   * @param {TaskStack} stack
   * @private
   */
  async _mineBlueprints(userId, orgId, query, stack) {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const blueprints = await this.blueprintMiner.mine(userId, orgId, {
        minConfidence: stack.getProgress().confidence,
        limit: 5,
      });

      if (blueprints.length > 0) {
        this._emit('research.blueprints_mined', {
          blueprintCount: blueprints.length,
          blueprintIds: blueprints.map(b => b.blueprintId),
        });
      }
    } catch (err) {
      console.error('[DeepResearcher] Blueprint mining error:', err.message);
    }
  }
}
