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
export const DEFAULT_REPORT_SECTION_SCHEMA = Object.freeze([
  { key: 'executive_summary', title: 'Executive Summary', purpose: 'Restate the question and deliver the highest-confidence conclusions in 1-2 short paragraphs.' },
  { key: 'definition_and_scope', title: 'Definition and Scope', purpose: 'Define the topic and clarify what is in scope, out of scope, and assumed.' },
  { key: 'mechanism', title: 'Mechanism: How It Works', purpose: 'Explain the core mechanism first in plain language, then in more technical detail.' },
  { key: 'evidence_and_data', title: 'Evidence and Data', purpose: 'Summarize the strongest empirical evidence, group it by theme, and note data quality or gaps.' },
  { key: 'stakeholders_and_incentives', title: 'Stakeholders and Incentives', purpose: 'Identify the major stakeholder groups and their incentives, fears, and conflicts.' },
  { key: 'timeline_and_trajectory', title: 'Timeline and Trajectory', purpose: 'Describe the past evolution, current state, and short- and medium-term scenarios.' },
  { key: 'comparison_to_alternatives', title: 'Comparison to Alternatives', purpose: 'Compare the topic against relevant alternatives, including the status quo, and explain trade-offs.' },
  { key: 'implications_and_strategy', title: 'Implications and Strategy', purpose: 'Translate the findings into practical recommendations, separating low-regret moves from high-beta bets.' },
  { key: 'contradictions_and_open_questions', title: 'Contradictions and Open Questions', purpose: 'List unresolved contradictions, explain why they matter, and identify the remaining gaps.' },
  { key: 'methodological_notes', title: 'Methodological Notes', purpose: 'Optionally explain how the research was done and what limitations or biases remain.' },
]);

export const DEFAULT_REPORT_SYNTHESIS_PROFILE = Object.freeze({
  domain: 'AI infra / agentic platforms',
  audience: 'principal research analyst',
  role: 'principal research analyst in a top global think tank',
  reportGoal: 'Produce a clear, deeply reasoned, fully cited report that a senior decision-maker can use directly.',
  tone: 'decision-ready, rigorous, concise',
  behaviorConstraints: Object.freeze([
    'Use the provided findings as primary ground truth.',
    'Never hide uncertainty; move weak or conflicting evidence into the contradictions/open questions section.',
    'Always include inline citations right after factual sentences that rely on provided evidence or specific sources.',
    'Do not re-do the research loop; synthesize only from the supplied findings, recalled memories, blueprint context, and trail provenance.',
    'Aim for decision-ready clarity with short paragraphs and at most one key table.',
  ]),
  sectionSchema: DEFAULT_REPORT_SECTION_SCHEMA,
});

function summarizeReportFindingForPrompt(finding, index = 0) {
  const sourceIds = Array.isArray(finding?.sourceIds)
    ? finding.sourceIds.filter(Boolean)
    : finding?.sourceId
      ? [finding.sourceId]
      : [];

  const claimId = finding?.id || `finding-${index + 1}`;
  return [
    `[${index + 1}] ${claimId} (${finding?.type || 'unknown'}) ${finding?.title || 'Untitled'}`,
    `- Sources: ${sourceIds.join(', ') || 'none'}`,
    `- Confidence: ${finding?.confidence ?? 'n/a'}`,
    `- Content: ${(finding?.content || '').slice(0, 320) || 'No content'}`,
  ].join('\n');
}

function summarizeRecalledMemoryForPrompt(memory, index = 0) {
  return [
    `R${index + 1}: ${memory?.id || memory?.sourceId || 'unknown'}`,
    `- Title: ${memory?.title || 'Untitled'}`,
    `- Score: ${memory?.score ?? memory?.confidence ?? 'n/a'}`,
    `- Content: ${(memory?.content || '').slice(0, 260) || 'No content'}`,
  ].join('\n');
}

function buildLegacyReportPrompt(query, findings, gaps, reportGate = null) {
  const sectionSchema = Array.isArray(reportGate?.sectionSchema) && reportGate.sectionSchema.length > 0
    ? reportGate.sectionSchema
    : DEFAULT_REPORT_SECTION_SCHEMA.slice(0, 6);
  const findingTexts = findings.slice(0, 20).map((finding, index) => summarizeReportFindingForPrompt(finding, index)).join('\n\n');
  const recalledMemories = Array.isArray(reportGate?.recalledMemories) ? reportGate.recalledMemories : [];
  const recalledMemoryTexts = recalledMemories.length > 0
    ? recalledMemories.slice(0, 6).map((memory, index) => summarizeRecalledMemoryForPrompt(memory, index)).join('\n\n')
    : '(No recalled memories)';
  const gapTexts = gaps.length > 0
    ? gaps.map(gap => `- ${gap?.gap || gap}`).join('\n')
    : '(No remaining gaps)';

  return [
    `Synthesize a concise research report from the evidence below.`,
    '',
    `Research Question: ${query}`,
    '',
    `Report Sections:`,
    sectionSchema.map((section, index) => `${index + 1}. ${section.title} — ${section.purpose}`).join('\n'),
    '',
    `Blueprint Context:`,
    reportGate?.blueprintSummary || '(No blueprint)',
    '',
    `Findings:`,
    findingTexts || '(No findings provided)',
    '',
    `Recalled Memories:`,
    recalledMemoryTexts,
    '',
    `Remaining Gaps:`,
    gapTexts,
    '',
    `Write markdown with the exact section order above. Use stable ids when referring to evidence. Do not invent evidence. Finish with a concise conclusion and confidence statement.`,
  ].join('\n');
}

export function buildFinalReportSynthesisSpec({
  query,
  findings = [],
  gaps = [],
  reportGate = null,
  synthesisProfile = null,
} = {}) {
  const overrideSectionSchema = Array.isArray(synthesisProfile?.sectionSchema) && synthesisProfile.sectionSchema.length > 0
    ? synthesisProfile.sectionSchema
    : null;
  const overrideBehaviorConstraints = Array.isArray(synthesisProfile?.behaviorConstraints) && synthesisProfile.behaviorConstraints.length > 0
    ? synthesisProfile.behaviorConstraints
    : null;
  const profile = {
    ...DEFAULT_REPORT_SYNTHESIS_PROFILE,
    ...(synthesisProfile || {}),
  };
  profile.sectionSchema = overrideSectionSchema || DEFAULT_REPORT_SYNTHESIS_PROFILE.sectionSchema;
  profile.behaviorConstraints = overrideBehaviorConstraints || DEFAULT_REPORT_SYNTHESIS_PROFILE.behaviorConstraints;
  const sectionSchema = Array.isArray(reportGate?.sectionSchema) && reportGate.sectionSchema.length > 0
    ? reportGate.sectionSchema
    : Array.isArray(profile.sectionSchema) && profile.sectionSchema.length > 0
      ? profile.sectionSchema
      : DEFAULT_REPORT_SECTION_SCHEMA;

  const findingsSummary = findings.slice(0, 20).map((finding, index) => summarizeReportFindingForPrompt(finding, index));
  const recalledMemories = Array.isArray(reportGate?.recalledMemories) ? reportGate.recalledMemories : [];
  const recalledMemorySummary = recalledMemories.slice(0, 10).map((memory, index) => summarizeRecalledMemoryForPrompt(memory, index));
  const gapSummary = gaps.length > 0
    ? gaps.map(gap => `- ${gap?.gap || gap}`).join('\n')
    : '(No remaining gaps)';

  const blueprintSummary = reportGate?.blueprintSummary || '(No blueprint)';
  const trailSummary = [
    `Trail ID: ${reportGate?.trail?.id || 'unknown'}`,
    `Trail Step IDs: ${(reportGate?.trail?.steps || []).map(step => step?.id).filter(Boolean).join(', ') || 'none'}`,
    `Golden Line: ${reportGate?.goldenLine || 'none'}`,
  ].join('\n');

  const systemPrompt = [
    `You are a ${profile.role}.`,
    `Domain: ${profile.domain}`,
    `Audience: ${profile.audience}`,
    `Goal: ${profile.reportGoal}`,
    `Tone: ${profile.tone}`,
  ].join('\n');

  const developerPrompt = [
    `Required sections and order:`,
    sectionSchema.map((section, index) => `${index + 1}. ${section.title} — ${section.purpose}`).join('\n'),
    '',
    `Behavior constraints:`,
    profile.behaviorConstraints.map(rule => `- ${rule}`).join('\n'),
    '',
    'Output rules:',
    '- Use markdown.',
    '- Preserve the exact section order above.',
    '- Use inline citations after factual sentences that rely on the provided evidence.',
    '- Do not add new research, browse, or ask for more information.',
    '- Prefer concise paragraphs over long blocks of prose.',
  ].join('\n');

  const userPrompt = [
    `Research question: ${query}`,
    '',
    `Blueprint context:`,
    blueprintSummary,
    '',
    `Trail provenance:`,
    trailSummary,
    '',
    `Findings:`,
    findingsSummary.length > 0 ? findingsSummary.join('\n\n') : '(No findings provided)',
    '',
    `Recalled memories:`,
    recalledMemorySummary.length > 0 ? recalledMemorySummary.join('\n\n') : '(No recalled memories)',
    '',
    `Remaining gaps:`,
    gapSummary,
    '',
    `Write the final report as a synthesis only. Do not continue the research loop.`,
  ].join('\n');

  return {
    version: '1.0',
    kind: 'deepresearch.final_report_synthesis',
    profile,
    domain: profile.domain,
    audience: profile.audience,
    sectionSchema,
    behaviorConstraints: profile.behaviorConstraints,
    inputs: {
      query,
      findings: findingsSummary,
      recalledMemories: recalledMemorySummary,
      gaps: gaps.map(gap => gap?.gap || gap),
      blueprintSummary,
      trailSummary,
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'developer', content: developerPrompt },
      { role: 'user', content: userPrompt },
    ],
    systemPrompt,
    developerPrompt,
    userPrompt,
  };
}

export function renderFinalReportSynthesisPrompt(spec) {
  if (!spec?.messages?.length) {
    return '';
  }

  return spec.messages.map((message) => {
    const role = String(message.role || 'message').toUpperCase();
    return `[${role}]\n${message.content || ''}`;
  }).join('\n\n');
}

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
   * @param {Object} [deps.reportSynthesisProfile] - default final-report synthesis profile
   */
  constructor({ memoryStore, recallFn, prisma, groqApiKey, browserRuntime, webJobStore, onEvent, trailStore, autoMineBlueprints = true, reportSynthesisProfile = null }) {
    this.memoryStore = memoryStore;
    this.recallFn = recallFn;
    this.prisma = prisma;
    this.groqApiKey = groqApiKey || process.env.GROQ_API_KEY;
    this.browserRuntime = browserRuntime || null;
    this.webJobStore = webJobStore || null;
    this.onEvent = onEvent || (() => {});
    this.trailStore = trailStore || null;
    this.autoMineBlueprints = autoMineBlueprints;
    this.reportSynthesisProfile = reportSynthesisProfile || null;
    this.blueprintMiner = new BlueprintMiner({ memoryStore, prisma });
    this._llmCallCount = 0;
    this._maxLlmCalls = 40;
    this._abortController = null;
  }

  /**
   * Cancel a running research session.
   * Signals abort to all pending operations.
   */
  cancel() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  get aborted() {
    return this._abortController?.signal?.aborted || false;
  }

  _checkAborted() {
    if (this.aborted) {
      throw new Error('Research cancelled by user');
    }
  }

  /**
   * Run a full deep research session.
   * @param {string} query - the research question
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} [options]
   * @param {string} [options.projectId] - optional project ID (uses generated one if not provided)
   * @param {string} [options.sessionId] - optional session ID for event emission
   * @param {Object} [options.reportSynthesisProfile] - overrides the final synthesis prompt profile
   * @returns {Promise<Object>} ResearchResult
   */
  async research(query, userId, orgId, options = {}) {
    const sessionId = options.sessionId || randomUUID();
    const projectId = options.projectId || `research/${this._slugify(query)}`;
    const startTime = Date.now();

    // Wire up AbortController for cancellation
    this._abortController = new AbortController();

    this._emit('research.started', { sessionId, query, projectId });

    // Step 0: Check for matching blueprints (unless already specified)
    let blueprintUsed = options.blueprintId || null;
    let baseState = options.baseState || null;  // Captured state from "Use as Base"

    if (!blueprintUsed && options.useBlueprints !== false) {
      const suggestions = await this._suggestBlueprint(query);
      if (suggestions.length > 0 && suggestions[0].relevanceScore > 0.85) {
        blueprintUsed = suggestions[0].blueprintId;
        this._emit('research.blueprint_suggested', {
          sessionId,
          blueprintId: blueprintUsed,
          blueprintName: suggestions[0].name,
          relevanceScore: suggestions[0].relevanceScore,
        });
        // Emit blueprint node for graph visualization
        this._emitBlueprintGraphEvent({
          sessionId,
          blueprintId: blueprintUsed,
          blueprintName: suggestions[0].name,
          blueprintDomain: suggestions[0].domain || 'research',
          isUsed: false,
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
      // Emit blueprint as used in graph visualization
      const blueprint = await this._loadBlueprint(blueprintUsed);
      if (blueprint) {
        this._emitBlueprintGraphEvent({
          sessionId,
          blueprintId: blueprintUsed,
          blueprintName: blueprint.name,
          blueprintDomain: blueprint.domain || 'research',
          isUsed: true,
        });
      }
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
      const reportGate = await this._prepareReportGate({
        sessionId,
        query,
        findings: priorFindings,
        gaps: [],
        trailStore,
        blueprintUsed,
        userId,
        orgId,
        projectId,
      });
      const reportSynthesisProfile = options.reportSynthesisProfile || (baseState ? this.reportSynthesisProfile || DEFAULT_REPORT_SYNTHESIS_PROFILE : null);
      const report = await this._synthesizeReport(query, priorFindings, [], reportGate, reportSynthesisProfile);
      const reportProvenance = this._buildReportProvenance({
        sessionId,
        query,
        report,
        findings: priorFindings,
        sources: [],
        trailStore,
        reportGate,
        blueprintUsed,
      });
      await trailStore.finalizeTrail(sessionId, report, reportProvenance);
      return {
        sessionId,
        projectId,
        query,
        report,
        reportProvenance,
        findings: priorFindings,
        fromCache: true,
        durationMs: Date.now() - startTime,
        taskProgress: { total: 0, completed: 0, confidence: 0.9 },
      };
    }

    // Step 1: Decompose into subtasks
    const stack = new TaskStack();
    const root = stack.createRoot(query);

    // If a high-relevance blueprint was found, use its pattern
    let dimensions;
    if (blueprintUsed) {
      const blueprint = await this._loadBlueprint(blueprintUsed);
      if (blueprint?.pattern?.length > 0) {
        for (const phase of blueprint.pattern) {
          const subQuery = (phase.queryTemplate || `${phase.actionType}: ${query}`).replace('{query}', query);
          stack.addSubtask(root.id, subQuery, phase.actionType);
        }
        dimensions = blueprint.pattern.map(p => p.actionType);
        this._emit('research.using_blueprint', { sessionId, blueprintId: blueprintUsed, taskCount: dimensions.length });
      } else {
        dimensions = await this._selectDimensions(query);
        stack.decompose(root.id, dimensions);
      }
    } else {
      dimensions = await this._selectDimensions(query);
      stack.decompose(root.id, dimensions);
    }

    this._emit('research.decomposed', { sessionId, dimensions, taskCount: dimensions.length + 1 });

    // Step 2: Execute tasks in parallel waves
    let reflectionRound = 0;
    const allFindings = [...priorFindings];
    const allSources = [];
    const waves = stack.getTasksByWave();

    for (const waveNum of [1, 2, 3]) {
      this._checkAborted();

      const waveTasks = waves[waveNum];
      if (!waveTasks || waveTasks.length === 0) continue;

      this._emit('research.wave_started', { sessionId, wave: waveNum, taskCount: waveTasks.length });

      for (const task of waveTasks) {
        task.wave = waveNum;
        this._emit('task.started', {
          sessionId, taskId: task.id, query: task.query,
          depth: task.depth, dimension: task.dimension, wave: waveNum,
          progress: stack.getProgress(),
        });
      }

      const results = await Promise.allSettled(
        waveTasks.map(async (task) => {
          try {
            const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
            stack.complete(task.id, { findings: result.findings, confidence: result.confidence, gaps: result.gaps });
            for (const finding of result.findings) {
              await this._saveFindingToCSI(finding, userId, orgId, projectId, {
                sessionId,
                taskId: task.id,
                wave: task.wave ?? waveNum,
                dimension: task.dimension,
              });
            }
            this._emit('task.completed', {
              sessionId, taskId: task.id, findingCount: result.findings.length,
              confidence: result.confidence, gaps: result.gaps, wave: waveNum,
              progress: stack.getProgress(),
            });
            return result;
          } catch (err) {
            stack.fail(task.id, err.message);
            this._emit('task.failed', { sessionId, taskId: task.id, error: err.message, wave: waveNum });
            return { findings: [], sources: [], confidence: 0, gaps: [err.message] };
          }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          allFindings.push(...r.value.findings);
          allSources.push(...(r.value.sources || []));
        }
      }

      this._emit('research.wave_completed', {
        sessionId, wave: waveNum, findingCount: allFindings.length,
        confidence: stack.getAggregateConfidence(),
      });

      // Checkpoint: save partial trail after each wave so interrupted research can be recovered
      this._saveCheckpoint(sessionId, query, stack, allFindings, allSources, userId, orgId, projectId, waveNum).catch(err => {
        console.error('[DeepResearcher] Checkpoint save failed:', err.message);
      });

      // Adaptive depth check after each wave
      if (waveNum < 3) {
        const depthDecision = this._shouldContinueResearch(allFindings, waveNum, stack);
        if (!depthDecision.continue && depthDecision.skipToGaps) {
          this._emit('research.skipping_waves', { sessionId, reason: depthDecision.reason });
          const gapTasks = waves[3] || [];
          for (const gapTask of gapTasks) {
            gapTask.wave = 3;
            this._emit('task.started', { sessionId, taskId: gapTask.id, query: gapTask.query, dimension: gapTask.dimension, progress: stack.getProgress() });
            try {
              const result = await this._executeTask(gapTask, userId, orgId, projectId, sessionId, trailStore);
              stack.complete(gapTask.id, { findings: result.findings, confidence: result.confidence, gaps: result.gaps });
              allFindings.push(...result.findings);
              allSources.push(...(result.sources || []));
              for (const finding of result.findings) {
                await this._saveFindingToCSI(finding, userId, orgId, projectId, {
                  sessionId,
                  taskId: gapTask.id,
                  wave: gapTask.wave ?? 3,
                  dimension: gapTask.dimension,
                });
              }
              this._emit('task.completed', { sessionId, taskId: gapTask.id, findingCount: result.findings.length, confidence: result.confidence, progress: stack.getProgress() });
            } catch (err) {
              stack.fail(gapTask.id, err.message);
              this._emit('task.failed', { sessionId, taskId: gapTask.id, error: err.message });
            }
          }
          break; // Exit the wave loop
        }
      }
    }

    // Process any remaining non-dimension tasks (gap subtasks etc.)
    while (true) {
      this._checkAborted();
      const task = stack.next();
      if (!task) break;
      task.wave = task.wave ?? null;
      this._emit('task.started', { sessionId, taskId: task.id, query: task.query, depth: task.depth, dimension: task.dimension, progress: stack.getProgress() });
      try {
        const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
        stack.complete(task.id, { findings: result.findings, confidence: result.confidence, gaps: result.gaps });
        allFindings.push(...result.findings);
        allSources.push(...(result.sources || []));
        for (const finding of result.findings) {
          await this._saveFindingToCSI(finding, userId, orgId, projectId, {
            sessionId,
            taskId: task.id,
            wave: task.wave,
            dimension: task.dimension,
          });
        }
        this._emit('task.completed', { sessionId, taskId: task.id, findingCount: result.findings.length, confidence: result.confidence, progress: stack.getProgress() });
      } catch (err) {
        stack.fail(task.id, err.message);
        this._emit('task.failed', { sessionId, taskId: task.id, error: err.message });
      }
    }

    // Step 3: Reflect — is confidence sufficient?
    this._checkAborted();
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
        task.wave = task.wave ?? null;
        try {
          const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
          stack.complete(task.id, result);
          allFindings.push(...result.findings);
          allSources.push(...result.sources);
          for (const finding of result.findings) {
            await this._saveFindingToCSI(finding, userId, orgId, projectId, {
              sessionId,
              taskId: task.id,
              wave: task.wave,
              dimension: task.dimension,
            });
          }
          this._emit('task.completed', { sessionId, taskId: task.id, ...result, progress: stack.getProgress() });
        } catch (err) {
          stack.fail(task.id, err.message);
        }
      }
    }

    // Step 4: Synthesize final report
    this._emit('research.synthesizing', { sessionId, findingCount: allFindings.length });
    this._emit('research.report_gate_started', {
      sessionId,
      findingCount: allFindings.length,
      gapCount: stack.getRemainingGaps().length,
      blueprintUsed: blueprintUsed || null,
    });

    const reportGate = await this._prepareReportGate({
      sessionId,
      query,
      findings: allFindings,
      gaps: stack.getRemainingGaps(),
      trailStore,
      blueprintUsed,
      userId,
      orgId,
      projectId,
    });

    this._emit('research.report_gate_completed', {
      sessionId,
      recallCount: reportGate.recalledMemories.length,
      provenanceCount: reportGate.provenanceNodes.length,
      blueprintUsed: reportGate.blueprint?.blueprintId || null,
    });

    const reportSynthesisProfile = options.reportSynthesisProfile || (baseState ? this.reportSynthesisProfile || DEFAULT_REPORT_SYNTHESIS_PROFILE : null);
    const report = await this._synthesizeReport(query, allFindings, stack.getRemainingGaps(), reportGate, reportSynthesisProfile);
    const reportProvenance = this._buildReportProvenance({
      sessionId,
      query,
      report,
      findings: allFindings,
      sources: allSources,
      trailStore,
      reportGate,
      blueprintUsed,
    });

    // Step 5: Finalize trail in CSI via trailStore
    await trailStore.finalizeTrail(sessionId, report, reportProvenance);

    // Step 6: Trigger blueprint mining (non-blocking, after research completes)
    if (this.autoMineBlueprints) {
      this._mineBlueprints(sessionId, userId, orgId, query, stack).catch(err => {
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
      reportProvenance,
      fromCache: false,
      durationMs: Date.now() - startTime,
      taskProgress: stack.getProgress(),
      trail: stack.toJSON(),
    };
  }

  // ─── Internal Methods ──────────────────────────────────────

  async _executeTask(task, userId, orgId, projectId, sessionId, trailStore) {
    task.status = 'active';
    const findings = [];
    const sources = [];
    const maxSteps = 8;
    let step = 0;
    let stepIndex = 0;
    const attachTaskContext = (finding, extra = {}) => ({
      ...finding,
      taskId: task.id,
      wave: task.wave ?? null,
      dimension: task.dimension || null,
      ...extra,
    });

    // Track agent states for real-time visibility
    const agentStates = { explorer: 'idle', analyst: 'idle', verifier: 'idle', synthesizer: 'idle' };
    const updateAgentState = (agent, state, detail = '') => {
      agentStates[agent] = state;
      this._emit('agent.state', { taskId: task.id, agent, state, detail, timestamp: new Date().toISOString() });
    };
    this._emit('agent.states', { taskId: task.id, states: { ...agentStates } });

    // Memory-first retrieval: check CSI before web search
    let maxExplorationSteps = 3;
    const memoryResult = await this._actSearchMemory(task.query, userId, orgId, projectId);
    if (memoryResult?.content && (memoryResult.confidence || 0.5) > 0.80) {
      const finding = attachTaskContext({
        id: randomUUID(),
        type: 'memory',
        title: memoryResult.title || `Memory: ${task.query.slice(0, 50)}`,
        content: memoryResult.content,
        source: 'hivemind_memory',
        sourceId: memoryResult.sourceId,
        confidence: memoryResult.confidence || 0.8,
        taskQuery: task.query,
        agent: 'explorer',
      });
      findings.push(finding);
      await this._recordFinding(trailStore, sessionId, stepIndex++, 'explorer', 'SEARCH_MEMORY', finding, projectId, {
        thought: 'Found high-confidence memory match — using as foundation, reducing web exploration',
        why: 'Memory-first retrieval: existing knowledge compounds across research sessions',
      });
      this._emit('memory.cache_hit', {
        taskId: task.id,
        title: memoryResult.title,
        confidence: memoryResult.confidence,
      });
      maxExplorationSteps = 2;
    }

    while (step < maxSteps) {
      step++;

      // PHASE 1-3: EXPLORATION (Explorer Agent)
      if (step <= maxExplorationSteps) {
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
          const finding = attachTaskContext({
            id: randomUUID(),
            type: result.type || 'web',
            title: result.title || reasoning.query,
            content: result.content,
            source: result.source || 'web',
            sourceId: result.sourceId,
            sourceIds: result.sourceIds || [],
            confidence: result.confidence || 0.6,
            taskQuery: task.query,
            agent: 'explorer',
          });
          findings.push(finding);
          sources.push({ type: result.type, id: result.sourceId, title: result.title });
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'explorer', reasoning.action, finding, projectId, {
            thought: reasoning.thought,
            why: reasoning.thought,
          });

          // Write execution event for real-time graph
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'explorer', 'search_web', {
            findingsCount: findings.length,
            source: result.type,
            sourceIds: result.sourceIds || [],
            taskId: task.id,
            wave: task.wave ?? null,
            phase: 'explore',
          });
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
          const extractedClaimIds = [];

          for (const structuredClaim of analysis.claims) {
            // Map sourceIndices to actual sourceIds
            const sourceIds = [...new Set(
              (structuredClaim.sourceIndices || [])
                .flatMap(i => webFindings[i]?.sourceIds?.length ? webFindings[i].sourceIds : [webFindings[i]?.sourceId || webFindings[i]?.id])
                .filter(Boolean)
            )];

            const finding = attachTaskContext({
              id: randomUUID(),
              type: structuredClaim.isLegacy ? 'claim' : 'structured-claim',
              title: `Claim: ${(structuredClaim.claim || structuredClaim).slice(0, 80)}`,
              content: structuredClaim.claim || structuredClaim,
              source: 'analyst_extraction',
              confidence: structuredClaim.confidence || 0.75,
              taskQuery: task.query,
              agent: 'analyst',
              sourceIds,
              // Store structured data in metadata for CSI persistence
              structured: structuredClaim.isLegacy ? null : {
                subject: structuredClaim.subject,
                predicate: structuredClaim.predicate,
                object: structuredClaim.object,
                entities: structuredClaim.entities,
                sourceIds,
                evidenceSnippets: structuredClaim.evidenceSnippets,
              },
            });
            findings.push(finding);
            extractedClaimIds.push(finding.id);
            await this._recordFinding(trailStore, sessionId, stepIndex++, 'analyst', 'EXTRACT_CLAIM', finding, projectId, {
              thought: structuredClaim.extractionThought || `Extracting structured claims from gathered sources`,
              why: 'Sources have been gathered and now need to be distilled into key claims',
            });
          }
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'analyst', 'extract_claims', {
            claimsCount: analysis.claims.length,
            claimIds: extractedClaimIds,
            taskId: task.id,
            wave: task.wave ?? null,
            phase: 'analysis',
          });
        }
        const memoryFindings = await this._actSearchMemory(task.query, userId, orgId, projectId);
        if (memoryFindings?.content) {
          const finding = attachTaskContext({
            id: randomUUID(),
            type: 'memory',
            title: memoryFindings.title,
            content: memoryFindings.content,
            source: 'hivemind_memory',
            sourceId: memoryFindings.sourceId,
            confidence: memoryFindings.confidence || 0.6,
            taskQuery: task.query,
            agent: 'analyst',
          });
          findings.push(finding);
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'analyst', 'SEARCH_MEMORY', finding, projectId, {
            thought: `Checking existing memory for relevant context`,
            why: 'Prior research in memory may provide additional context or validation',
          });
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'analyst', 'search_memory', {
            hasMemoryContent: true,
            taskId: task.id,
            wave: task.wave ?? null,
            phase: 'analysis',
          });
        }
        updateAgentState('analyst', 'completed');
        this._emit('task.observation', { taskId: task.id, step, agent: 'analyst', type: 'analysis_complete', title: `Extracted ${analysis?.claims?.length || 0} claims` });
        continue;
      }

      // PHASE 5: VERIFICATION (Verifier Agent)
      if (step === 5 && findings.length > 0) {
        updateAgentState('verifier', 'active', 'Verifying findings');
        const verification = await this._actVerify(task.query, findings, trailStore, sessionId);
        const verifiedClaimIds = [...new Set([...(verification.verified || []), ...(verification.rejected || [])].map(f => f?.id).filter(Boolean))];
        const verifierVerdict =
          (verification.contradictions?.length || 0) > 0
            ? 'disputed'
            : (verification.verified?.length || 0) > 0
              ? 'verified'
              : 'uncertain';
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
        await this._writeExecutionEvent(sessionId, projectId, trailStore, 'verifier', 'verify_findings', {
          verified: verification.verified?.length || 0,
          rejected: verification.rejected?.length || 0,
          contradictions: verification.contradictions?.length || 0,
          claimIds: verifiedClaimIds,
          confidence: verification.overallConfidence || 0.7,
          csiStage: 'turing',
          verdict: verifierVerdict,
          summary: `Verified ${verification.verified?.length || 0}, rejected ${verification.rejected?.length || 0}, contradictions ${verification.contradictions?.length || 0}`,
          taskId: task.id,
          wave: task.wave ?? null,
          phase: 'verification',
        });
        if (verification.contradictions?.length > 0) {
          this._emit('verifier.contradiction', { taskId: task.id, count: verification.contradictions.length, details: verification.contradictions });
          let resolved = 0;
          for (const contradiction of verification.contradictions) {
            if (resolved >= 3) break;
            await trailStore?.recordContradiction(sessionId, contradiction);
            const resolution = await this._resolveContradiction(
              contradiction, userId, orgId, projectId, sessionId, trailStore
            );
            if (resolution.resolved) {
              resolved++;
              await trailStore?.recordContradiction(sessionId, contradiction);
            }
          }
          this._emit('verifier.contradictions_summary', {
            sessionId, total: verification.contradictions.length,
            resolved, unresolved: verification.contradictions.length - resolved,
          });
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
          const finding = attachTaskContext({
            id: randomUUID(),
            type: 'synthesis',
            title: `Synthesis: ${task.query.slice(0, 50)}`,
            content: synthesis.content,
            source: 'synthesizer',
            confidence: synthesis.confidence || 0.8,
            taskQuery: task.query,
            agent: 'synthesizer',
          });
          findings.push(finding);
          await this._recordFinding(trailStore, sessionId, stepIndex++, 'synthesizer', 'SYNTHESIZE', finding, projectId, {
            thought: `Combining all gathered findings into a cohesive answer`,
            why: 'All sources and claims have been gathered and verified - now need to produce final synthesis',
          });
          await this._writeExecutionEvent(sessionId, projectId, trailStore, 'synthesizer', 'synthesize', {
            synthesisLength: synthesis.content?.length || 0,
            confidence: synthesis.confidence,
            taskId: task.id,
            wave: task.wave ?? null,
            phase: 'synthesis',
          });
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

    // Emit trail graph event for real-time visualization
    const sourceIds = this._collectSourceIds(finding);
    const claimIds = this._collectClaimIds(finding);
    console.log('[DeepResearcher] Emitting trail graph event:', { sessionId, stepIndex, agent, action, claimIds: claimIds?.length, sourceIds: sourceIds?.length });
    this._emitTrailGraphEvent({
      sessionId,
      stepIndex,
      agent,
      action,
      input: finding.taskQuery,
      output: finding.content.slice(0, 100),
      confidence: finding.confidence,
      claimIds,
      sourceIds,
    });

    // NEW: Write individual observation to CSI for real-time graph updates
    // This ensures graph has data during research, not just after completion
    try {
      const observationId = randomUUID();
      const createdAt = new Date().toISOString();
      const sourceIds = this._collectSourceIds(finding);
      const claimIds = this._collectClaimIds(finding);
      const csiStage = this._inferCsiStage(agent, action, finding);
      const metadata = {
        observationType: 'op/research-observation',
        sessionId,
        stepIndex,
        agent,
        action,
        findingType: finding.type || 'web',
        source: finding.source,
        sourceId: finding.sourceId,
        sourceIds,
        claimIds,
        taskQuery: finding.taskQuery,
        taskId: finding.taskId || null,
        wave: finding.wave ?? null,
        dimension: finding.dimension || null,
        confidence: finding.confidence || 0.7,
        createdAt,
      };
      if (csiStage) {
        metadata.csiStage = csiStage;
        metadata.csiNodeType = csiStage === 'faraday' ? 'csi-observation' : 'csi-hypothesis';
        metadata.csiTitle = `${agent}/${action}: ${finding.title?.slice(0, 80) || 'Observation'}`;
        metadata.summary = finding.content?.slice(0, 280) || '';
      }
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
        metadata,
        created_at: createdAt,
        updated_at: createdAt,
      });
      console.log('[DeepResearcher] Saved observation to CSI:', observationId.slice(0, 20), 'agent:', agent, 'action:', action);
      this._emitObservationGraphEvents({
        sessionId,
        observationId,
        createdAt,
        stepIndex,
        agent,
        action,
        finding,
        sourceIds,
        claimIds,
        csiStage,
      });
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
      const createdAt = new Date().toISOString();
      const stage = output.csiStage || this._inferExecutionStage(agent, action);
      const claimIds = this._normalizeArray(output.claimIds);
      const sourceIds = this._normalizeArray(output.sourceIds);
      const observationIds = this._normalizeArray(output.observationIds);
      const metadata = {
        executionEventType: 'op/research-execution-event',
        sessionId,
        agent,
        action,
        output,
        latency: output.latency || null,
        success: output.success !== false,
        taskId: output.taskId || null,
        wave: output.wave ?? null,
        phase: output.phase || null,
        claimIds,
        sourceIds,
        observationIds,
        confidence: output.confidence ?? null,
        createdAt,
      };
      if (stage) {
        metadata.csiStage = stage;
        metadata.csiNodeType = stage === 'turing' ? 'csi-verdict' : stage === 'feynman' ? 'csi-hypothesis' : 'csi-observation';
      }
      if (output.verdict) metadata.verdict = output.verdict;
      if (output.summary) metadata.summary = output.summary;
      if (output.csiTitle) metadata.csiTitle = output.csiTitle;
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
        metadata,
        created_at: createdAt,
        updated_at: createdAt,
      });
      this._emitExecutionGraphEvents({
        sessionId,
        eventId,
        createdAt,
        agent,
        action,
        output,
        stage,
        claimIds,
        sourceIds,
        observationIds,
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

  /**
   * Resolve a contradiction by searching for a tiebreaker source.
   * Cap: 3 resolutions per session.
   */
  async _resolveContradiction(contradiction, userId, orgId, projectId, sessionId, trailStore) {
    try {
      const searchQuery = await this._llm(
        `Two sources disagree:\n` +
        `Claim A (${contradiction.claimA?.source || 'unknown'}): ${(contradiction.claimA?.content || '').slice(0, 300)}\n` +
        `Claim B (${contradiction.claimB?.source || 'unknown'}): ${(contradiction.claimB?.content || '').slice(0, 300)}\n\n` +
        `Write a specific web search query to find an authoritative tiebreaker source. Return ONLY the search query.`,
        { temperature: 0.3, maxTokens: 200 }
      );
      if (!searchQuery?.trim()) return { resolved: false, reason: 'Empty tiebreaker query' };

      const tiebreaker = await this._actSearchWeb(searchQuery.trim(), userId, orgId, projectId, sessionId, trailStore);
      if (!tiebreaker?.content) {
        contradiction.investigated = true;
        return { resolved: false, reason: 'No tiebreaker source found' };
      }

      const verdictRaw = await this._llm(
        `A factual disagreement exists:\n` +
        `Claim A: ${(contradiction.claimA?.content || '').slice(0, 300)}\n` +
        `Claim B: ${(contradiction.claimB?.content || '').slice(0, 300)}\n\n` +
        `Tiebreaker source says: ${tiebreaker.content.slice(0, 500)}\n\n` +
        `Which claim does the tiebreaker support? Return JSON:\n` +
        `{ "supports": "A" or "B" or "neither", "confidence": 0.0-1.0, "reasoning": "one sentence" }`,
        { temperature: 0.2, maxTokens: 300 }
      );

      const verdict = JSON.parse(verdictRaw);
      contradiction.unresolved = false;
      contradiction.resolution = {
        supports: verdict.supports,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        tiebreakerSource: tiebreaker.source,
        resolvedAt: new Date().toISOString(),
      };

      this._emit('verifier.contradiction_resolved', {
        sessionId,
        dimension: contradiction.dimension,
        supports: verdict.supports,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
      });

      return { resolved: true, ...verdict };
    } catch (err) {
      console.error('[DeepResearcher] Contradiction resolution failed:', err.message);
      return { resolved: false, reason: err.message };
    }
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
    try {
      // Search current project first (most relevant)
      const projectResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        project: projectId,
        max_memories: 5,
      });

      // Also search globally across all projects
      const globalResults = await this.recallFn(this.memoryStore, {
        query_context: query,
        user_id: userId,
        org_id: orgId,
        max_memories: 10,
      });

      // Merge, deduplicate by ID, apply recency decay
      const seen = new Set();
      const merged = [];
      for (const r of [...(projectResults.memories || []), ...(globalResults.memories || [])]) {
        const id = r.id || r.sourceId;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const age = (Date.now() - new Date(r.created_at || 0).getTime()) / (1000 * 60 * 60 * 24);
        const recencyFactor = age > 30 ? Math.max(0.5, 1 - (age - 30) / 365) : 1;
        merged.push({ ...r, confidence: (r.confidence || r.importance_score || r.score || 0.5) * recencyFactor });
      }

      if (merged.length === 0) return null;
      merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      const best = merged[0];
      return {
        content: best.content,
        title: best.title,
        sourceId: best.id,
        confidence: best.confidence,
      };
    } catch (err) {
      console.error('[DeepResearcher] Memory search failed:', err.message);
      return null;
    }
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
      sourceId: savedSources[0]?.id || results[0]?.url,
      sourceIds: savedSources.map(source => source.id).filter(Boolean),
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
      sourceId: savedSources[0]?.id || url,
      sourceIds: savedSources.map(source => source.id).filter(Boolean),
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

  async _synthesizeReport(query, findings, gaps, reportGate = null, synthesisProfile = null) {
    const useWorldClassPrompt = Boolean(synthesisProfile);
    const prompt = useWorldClassPrompt
      ? renderFinalReportSynthesisPrompt(buildFinalReportSynthesisSpec({
          query,
          findings,
          gaps,
          reportGate,
          synthesisProfile,
        }))
      : buildLegacyReportPrompt(query, findings, gaps, reportGate);
    const report = await this._llm(prompt, { temperature: useWorldClassPrompt ? 0.35 : 0.45, maxTokens: 4500 });

    return report;
  }

  async _prepareReportGate({ sessionId, query, findings = [], gaps = [], trailStore, blueprintUsed = null, userId, orgId, projectId }) {
    const trail = trailStore?.getTrail(sessionId) || null;
    const blueprint = blueprintUsed ? await this._loadBlueprint(blueprintUsed) : null;
    const blueprintPattern = Array.isArray(blueprint?.pattern) ? blueprint.pattern : [];
    const blueprintSummary = this._buildBlueprintSummary({ blueprintUsed, blueprint, blueprintPattern, query });
    const sectionSchema = this._buildReportSectionSchema(blueprint, trail);
    const recallQueries = this._buildReportRecallQueries({ query, findings, gaps, blueprint, trail, blueprintPattern });
    const recalledMemories = [];

    this._emit('research.report_gate_recall_started', {
      sessionId,
      queryCount: recallQueries.length,
      blueprintUsed: blueprintUsed || null,
      trailId: trail?.id || null,
    });

    for (const recallQuery of recallQueries) {
      const memories = await this._recallFromCSI(recallQuery, userId, orgId, projectId);
      for (const memory of memories || []) {
        recalledMemories.push({
          ...memory,
          recallQuery,
        });
      }
    }

    if (blueprint?.blueprintId || blueprintUsed) {
      try {
        const blueprintResults = await this.recallFn(this.memoryStore, {
          query_context: blueprintSummary,
          user_id: userId,
          org_id: orgId,
          project: projectId,
          tags: ['blueprint'],
          max_memories: 8,
        });
        for (const memory of blueprintResults?.memories || []) {
          recalledMemories.push({
            ...memory,
            recallQuery: `blueprint:${blueprintUsed || blueprint?.blueprintId}`,
          });
        }
      } catch (err) {
        console.error('[DeepResearcher] Blueprint recall failed:', err.message);
      }
    }

    const dedupedMemories = this._dedupeEvidence(recalledMemories).slice(0, 16);
    const reportId = randomUUID();
    const provenanceNodes = this._buildReportProvenanceNodes({
      reportId,
      sessionId,
      query,
      findings,
      trail,
      blueprint,
      recalledMemories: dedupedMemories,
    });
    const goldenLine = this._buildGoldenLine({
      reportId,
      trail,
      blueprint,
      findings,
      recalledMemories: dedupedMemories,
      provenanceNodes,
    });

    return {
      reportId,
      sessionId,
      query,
      trail,
      blueprint,
      blueprintSummary,
      sectionSchema,
      recallQueries,
      recalledMemories: dedupedMemories,
      provenanceNodes,
      goldenLine,
    };
  }

  _buildBlueprintSummary({ blueprintUsed, blueprint, blueprintPattern, query }) {
    if (!blueprint && !blueprintUsed) {
      return `Query: ${query}`;
    }

    const patternSummary = blueprintPattern.length > 0
      ? blueprintPattern.map((phase, index) => `${index + 1}. ${phase.actionType || 'step'}${phase.queryTemplate ? ` → ${phase.queryTemplate}` : ''}`).join('\n')
      : '(No explicit pattern)';

    return [
      `Blueprint: ${blueprint?.name || blueprintUsed || 'unknown'}`,
      `Domain: ${blueprint?.domain || 'research'}`,
      `Query: ${query}`,
      `Pattern:`,
      patternSummary,
    ].join('\n');
  }

  _buildReportSectionSchema(blueprint, trail) {
    const blueprintSections = blueprint?.reportSections || blueprint?.sections || blueprint?.reportSchema;
    if (Array.isArray(blueprintSections) && blueprintSections.length > 0) {
      return blueprintSections.map((section, index) => ({
        key: section.key || `section_${index + 1}`,
        title: section.title || section.name || `Section ${index + 1}`,
        purpose: section.purpose || section.description || '',
      }));
    }

    if (trail?.metadata?.reportSchema?.length > 0) {
      return trail.metadata.reportSchema.map((section, index) => ({
        key: section.key || `trail_section_${index + 1}`,
        title: section.title || `Section ${index + 1}`,
        purpose: section.purpose || section.description || '',
      }));
    }

    return DEFAULT_REPORT_SECTION_SCHEMA;
  }

  _buildReportRecallQueries({ query, findings, gaps, blueprint, trail, blueprintPattern }) {
    const queries = [query];

    if (blueprint?.name) queries.push(`${query} ${blueprint.name}`);
    if (blueprint?.domain) queries.push(`${query} ${blueprint.domain}`);
    for (const phase of blueprintPattern.slice(0, 4)) {
      if (phase?.queryTemplate) queries.push(phase.queryTemplate.replace('{query}', query));
      else if (phase?.actionType) queries.push(`${phase.actionType} ${query}`);
    }

    for (const finding of findings.slice(-4)) {
      const text = [finding.title, finding.content?.slice(0, 160)].filter(Boolean).join(' ');
      if (text) queries.push(text);
    }

    for (const gap of gaps.slice(0, 3)) {
      const text = gap?.gap || gap;
      if (text) queries.push(String(text));
    }

    if (trail?.steps?.length > 0) {
      const trailFocus = trail.steps.slice(-4).map(step => [step.agent, step.action, step.output].filter(Boolean).join(' ')).join(' | ');
      if (trailFocus) queries.push(trailFocus);
    }

    return [...new Set(queries.map(q => String(q).trim()).filter(Boolean))].slice(0, 10);
  }

  _dedupeEvidence(items) {
    const seen = new Set();
    const deduped = [];
    for (const item of items || []) {
      const id = item?.id || item?.sourceId || item?.memoryId || item?.source_id;
      const key = id || `${item?.title || ''}:${(item?.content || '').slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    return deduped;
  }

  _buildReportProvenanceNodes({ reportId, sessionId, query, findings, trail, blueprint, recalledMemories }) {
    const trailId = trail?.id || `trail-${sessionId}`;
    const claimIds = findings.map(finding => finding.id).filter(Boolean);
    const sourceIds = [...new Set(findings.flatMap(finding => this._collectSourceIds(finding)))];
    const trailStepIds = (trail?.steps || []).map(step => step.id).filter(Boolean);
    const recalledMemoryIds = (recalledMemories || []).map(memory => memory.id || memory.sourceId).filter(Boolean);
    const nodeIds = [
      `report:${reportId}`,
      `trail:${trailId}`,
      ...claimIds.map(id => `claim:${id}`),
      ...sourceIds.map(id => `source:${id}`),
      ...trailStepIds.map(id => `trail-step:${id}`),
      ...recalledMemoryIds.map(id => `memory:${id}`),
      blueprint?.blueprintId ? `blueprint:${blueprint.blueprintId}` : null,
    ].filter(Boolean);

    const edges = [];
    trailStepIds.forEach((stepId, index) => {
      edges.push({
        id: `edge-trail-${trailId}-${stepId}`,
        from: `trail:${trailId}`,
        to: `trail-step:${stepId}`,
        type: 'contains',
        order: index,
      });
    });
    claimIds.forEach((claimId) => {
      edges.push({
        id: `edge-report-claim-${claimId}`,
        from: `report:${reportId}`,
        to: `claim:${claimId}`,
        type: 'uses',
      });
    });
    sourceIds.forEach((sourceId) => {
      edges.push({
        id: `edge-report-source-${sourceId}`,
        from: `report:${reportId}`,
        to: `source:${sourceId}`,
        type: 'uses',
      });
    });
    recalledMemoryIds.forEach((memoryId) => {
      edges.push({
        id: `edge-report-memory-${memoryId}`,
        from: `report:${reportId}`,
        to: `memory:${memoryId}`,
        type: 'recalls',
      });
    });
    if (blueprint?.blueprintId) {
      edges.push({
        id: `edge-report-blueprint-${blueprint.blueprintId}`,
        from: `report:${reportId}`,
        to: `blueprint:${blueprint.blueprintId}`,
        type: 'follows',
      });
    }

    return {
      reportId,
      reportNodeId: `report:${reportId}`,
      sessionId,
      query,
      trailId,
      blueprintId: blueprint?.blueprintId || null,
      claimIds,
      sourceIds,
      trailStepIds,
      recalledMemoryIds,
      nodeIds,
      edgeIds: edges.map(edge => edge.id),
      edges,
      trails: [trailId],
      sources: sourceIds,
      reportNodes: nodeIds,
    };
  }

  _buildGoldenLine({ reportId, trail, blueprint, findings, recalledMemories, provenanceNodes }) {
    const parts = [];
    parts.push(`report:${reportId}`);
    parts.push(`trail:${trail?.id || 'unknown'}`);
    if (blueprint?.blueprintId) parts.push(`blueprint:${blueprint.blueprintId}`);
    for (const claimId of findings.map(f => f.id).filter(Boolean).slice(0, 20)) {
      parts.push(`claim:${claimId}`);
    }
    for (const sourceId of [...new Set(findings.flatMap(f => this._collectSourceIds(f)))].slice(0, 20)) {
      parts.push(`source:${sourceId}`);
    }
    for (const memoryId of (recalledMemories || []).map(m => m.id || m.sourceId).filter(Boolean).slice(0, 20)) {
      parts.push(`memory:${memoryId}`);
    }
    for (const stepId of (trail?.steps || []).map(step => step.id).filter(Boolean).slice(0, 20)) {
      parts.push(`trail-step:${stepId}`);
    }
    for (const edge of provenanceNodes?.edges || []) {
      parts.push(`${edge.from} -[${edge.type}]-> ${edge.to}`);
    }
    return parts.join('\n');
  }

  _buildReportProvenance({ sessionId, query, report, findings, sources = [], trailStore, reportGate = null, blueprintUsed = null }) {
    const trail = reportGate?.trail || trailStore?.getTrail(sessionId) || null;
    const blueprint = reportGate?.blueprint || (blueprintUsed ? { blueprintId: blueprintUsed } : null);
    const reportId = reportGate?.reportId || randomUUID();
    const provenanceNodes = reportGate?.provenanceNodes || this._buildReportProvenanceNodes({
      reportId,
      sessionId,
      query,
      findings,
      trail,
      blueprint,
      recalledMemories: reportGate?.recalledMemories || [],
    });
    const goldenLine = reportGate?.goldenLine || this._buildGoldenLine({
      reportId,
      trail,
      blueprint,
      findings,
      recalledMemories: reportGate?.recalledMemories || [],
      provenanceNodes,
    });
    const sourceIds = [...new Set([
      ...(provenanceNodes.sourceIds || []),
      ...sources.flatMap(source => this._normalizeArray(source?.id || source?.sourceId || source?.url)),
    ])].filter(Boolean);

    return {
      reportId,
      reportNodeId: provenanceNodes.reportNodeId || `report:${reportId}`,
      sessionId,
      query,
      trailId: provenanceNodes.trailId || trail?.id || null,
      blueprintId: provenanceNodes.blueprintId || blueprint?.blueprintId || null,
      sectionSchema: reportGate?.sectionSchema || DEFAULT_REPORT_SECTION_SCHEMA,
      recallQueries: reportGate?.recallQueries || [],
      recalledMemoryIds: (reportGate?.recalledMemories || []).map(memory => memory.id || memory.sourceId).filter(Boolean),
      recalledMemories: reportGate?.recalledMemories || [],
      claimIds: provenanceNodes.claimIds || findings.map(finding => finding.id).filter(Boolean),
      sourceIds,
      trailStepIds: provenanceNodes.trailStepIds || [],
      nodeIds: provenanceNodes.nodeIds || [],
      edgeIds: provenanceNodes.edgeIds || [],
      edges: provenanceNodes.edges || [],
      trails: provenanceNodes.trails || [],
      sources: sourceIds,
      reportNodes: provenanceNodes.reportNodes || [],
      goldenLine,
      reportSummary: typeof report === 'string' ? report.slice(0, 2000) : JSON.stringify(report).slice(0, 2000),
    };
  }

  async _saveFindingToCSI(finding, userId, orgId, projectId, context = {}) {
    try {
      const createdAt = new Date().toISOString();
      const sourceIds = this._collectSourceIds(finding);
      const claimIds = [...new Set([finding.id, ...this._collectClaimIds(finding)].filter(Boolean))];
      const provenance = this._inferClaimProvenance(finding, context);
      const metadata = {
        research_type: finding.type,
        source_url: finding.source,
        source_id: finding.sourceId,
        sourceIds,
        claimIds,
        confidence: finding.confidence,
        structured: finding.structured || null,
        taskId: context.taskId || finding.taskId || null,
        sessionId: context.sessionId || finding.sessionId || null,
        wave: context.wave ?? finding.wave ?? null,
        dimension: context.dimension || finding.dimension || null,
        agent: finding.agent || null,
        relationType: provenance.operation,
        relationEdgeType: provenance.edgeType,
        relationTargetClaimIds: provenance.targetClaimIds,
        createdAt,
      };
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
        metadata,
        created_at: createdAt,
        updated_at: createdAt,
      });
      console.log('[DeepResearcher] Saved finding to CSI:', finding.title?.slice(0, 50), 'project:', projectId);
      this._emit('graph.node_upsert', {
        sessionId: context.sessionId || finding.sessionId || null,
        layer: 'claims',
        nodeId: finding.id,
        node: {
          id: finding.id,
          content: `${finding.title}\n\n${finding.content}`.slice(0, 500),
          confidence: finding.confidence,
          source: finding.source,
          sourceIds,
          claimIds,
          relationType: provenance.operation,
          relationEdgeType: provenance.edgeType,
          relationTargetClaimIds: provenance.targetClaimIds,
          taskId: metadata.taskId,
          wave: metadata.wave,
          dimension: metadata.dimension,
          agent: finding.agent || null,
          createdAt,
          type: finding.structured ? 'structured-claim' : 'plain-claim',
          structured: finding.structured || null,
        },
      });
      sourceIds.forEach((sourceId) => {
        this._emit('graph.edge_upsert', {
          sessionId: context.sessionId || finding.sessionId || null,
          edge: {
            from: `claim-${finding.id}`,
            to: `source-${sourceId}`,
            type: provenance.edgeType,
            confidence: finding.confidence || 0.7,
          },
        });
      });
      (provenance.targetClaimIds || []).forEach((targetClaimId) => {
        this._emit('graph.edge_upsert', {
          sessionId: context.sessionId || finding.sessionId || null,
          edge: {
            from: `claim-${finding.id}`,
            to: `claim-${targetClaimId}`,
            type: provenance.edgeType === 'updates' ? 'updates' : 'extends',
            confidence: finding.confidence || 0.7,
          },
        });
      });
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
        const createdAt = new Date().toISOString();
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
            saved_at: createdAt,
          },
          created_at: createdAt,
          updated_at: createdAt,
        });
        savedSources.push({ id: sourceId, url: src.url, title: src.title });
        console.log('[DeepResearcher] Saved web source to CSI:', src.title?.slice(0, 50), 'url:', src.url?.slice(0, 80));
        this._emit('graph.node_upsert', {
          sessionId,
          layer: 'sources',
          nodeId: sourceId,
          node: {
            id: sourceId,
            title: src.title || src.url,
            url: src.url,
            runtime: 'tavily',
            score: 0.8,
            createdAt,
          },
        });

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

  /**
   * Save a checkpoint of current research state after each wave.
   * Enables recovery of interrupted research sessions.
   */
  async _saveCheckpoint(sessionId, query, stack, findings, sources, userId, orgId, projectId, waveNum) {
    try {
      const checkpointId = `checkpoint-${sessionId}`;
      const progress = stack.getProgress();
      const checkpoint = {
        sessionId,
        query,
        projectId,
        waveCompleted: waveNum,
        findingCount: findings.length,
        sourceCount: sources.length,
        confidence: progress.confidence,
        status: 'running',
        lastCheckpoint: new Date().toISOString(),
        taskProgress: progress,
      };

      // Upsert checkpoint memory — always overwrite with latest state
      try {
        await this.memoryStore.createMemory({
          id: checkpointId,
          user_id: userId,
          org_id: orgId,
          project: projectId,
          content: `Research checkpoint: ${query}\nWave ${waveNum} completed. ${findings.length} findings, confidence ${(progress.confidence * 100).toFixed(0)}%`,
          title: `Checkpoint: ${query.slice(0, 60)}`,
          memory_type: 'event',
          tags: ['research-checkpoint', `session:${sessionId}`, `wave:${waveNum}`],
          is_latest: true,
          importance_score: 0.5,
          metadata: checkpoint,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch (dupErr) {
        // If duplicate, update existing
        if (dupErr.code === 'P2002' || dupErr.message?.includes('unique')) {
          await this.prisma?.memory?.update({
            where: { id: checkpointId },
            data: {
              content: `Research checkpoint: ${query}\nWave ${waveNum} completed. ${findings.length} findings, confidence ${(progress.confidence * 100).toFixed(0)}%`,
              metadata: checkpoint,
              updatedAt: new Date(),
            },
          }).catch(() => {});
        }
      }

      console.log(`[DeepResearcher] Checkpoint saved: wave=${waveNum}, findings=${findings.length}, confidence=${(progress.confidence * 100).toFixed(0)}%`);
    } catch (err) {
      console.error('[DeepResearcher] Checkpoint save failed:', err.message);
    }
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
    if (this._llmCallCount >= this._maxLlmCalls) {
      console.warn('[DeepResearcher] LLM call limit reached:', this._llmCallCount);
      return '{"action":"FINISH","thought":"LLM call budget exhausted"}';
    }
    this._llmCallCount++;
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

  _shouldContinueResearch(findings, currentWave, stack) {
    if (findings.length === 0) return { continue: true, reason: 'no_findings' };

    const avgConfidence = findings.reduce((sum, f) => sum + (f.confidence || 0), 0) / findings.length;
    const contradictions = findings.filter(f => f.type === 'contradiction');

    if (avgConfidence > 0.90 && contradictions.length === 0 && currentWave === 1) {
      this._emit('research.depth_decision', {
        currentWave, avgConfidence,
        decision: 'high_confidence_early_stop', skippedWave: 2,
      });
      return { continue: false, reason: 'high_confidence_early_stop', skipToGaps: true };
    }

    if (avgConfidence < 0.65 && currentWave === 2) {
      this._emit('research.depth_decision', {
        currentWave, avgConfidence,
        decision: 'low_confidence_extension', newMaxDepth: 6,
      });
      stack.maxDepth = 6;
      return { continue: true, reason: 'low_confidence_extension', widen: true };
    }

    return { continue: true, reason: 'normal' };
  }

  _normalizeArray(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value === undefined || value === null || value === '') return [];
    return [value];
  }

  _collectSourceIds(finding = {}) {
    const directSourceIds =
      finding.type === 'web' || finding.type === 'follow_up' || String(finding.source || '').startsWith('http')
        ? this._normalizeArray(finding.sourceId)
        : [];
    return [...new Set(
      [
        ...this._normalizeArray(finding.sourceIds),
        ...this._normalizeArray(finding.structured?.sourceIds),
        ...this._normalizeArray(finding._savedSources?.map(source => source?.id)),
        ...directSourceIds,
      ].filter(Boolean)
    )];
  }

  _collectClaimIds(finding = {}) {
    if (finding.type === 'claim' || finding.type === 'structured-claim') {
      return finding.id ? [finding.id] : [];
    }
    return this._normalizeArray(finding.claimIds);
  }

  _inferClaimProvenance(finding = {}) {
    const targetClaimIds = this._normalizeArray(finding.updatesClaimIds || finding.updatesClaimId || finding.extendsClaimIds || finding.extendsClaimId);
    const sourceIds = this._collectSourceIds(finding);
    const claimIds = this._collectClaimIds(finding);

    if (targetClaimIds.length > 0) {
      return {
        operation: finding.relationType || 'Update',
        edgeType: 'updates',
        targetClaimIds,
        sourceIds,
        claimIds,
      };
    }

    if (finding.type === 'memory' || finding.type === 'web' || finding.type === 'follow_up' || sourceIds.length > 0) {
      return {
        operation: finding.relationType || 'Derive',
        edgeType: 'derived_from',
        targetClaimIds: claimIds,
        sourceIds,
        claimIds,
      };
    }

    return {
      operation: finding.relationType || 'Derive',
      edgeType: 'derived_from',
      targetClaimIds: claimIds,
      sourceIds,
      claimIds,
    };
  }

  _inferCsiStage(agent, action, finding = {}) {
    if (finding.csiStage) return finding.csiStage;
    if (agent === 'explorer') return 'faraday';
    if (agent === 'analyst' && action === 'EXTRACT_CLAIM') return 'feynman';
    return null;
  }

  _inferExecutionStage(agent, action) {
    if (agent === 'verifier' || action === 'verify_findings') return 'turing';
    return null;
  }

  _emitObservationGraphEvents({ sessionId, observationId, createdAt, stepIndex, agent, action, finding, sourceIds, claimIds, csiStage }) {
    const observationNode = {
      id: observationId,
      title: `${action}: ${finding.title?.slice(0, 50) || 'Finding'}`,
      agent,
      action,
      findingType: finding.type || 'web',
      source: finding.source,
      sourceId: finding.sourceId,
      sourceIds,
      claimIds,
      confidence: finding.confidence || 0.7,
      stepIndex,
      taskId: finding.taskId || null,
      wave: finding.wave ?? null,
      dimension: finding.dimension || null,
      csiStage: csiStage || null,
      createdAt,
    };
    this._emit('graph.node_upsert', {
      sessionId,
      layer: 'observations',
      nodeId: observationId,
      node: observationNode,
    });
    sourceIds.forEach((sourceId) => {
      this._emit('graph.edge_upsert', {
        sessionId,
        edge: {
          from: `obs-${observationId}`,
          to: `source-${sourceId}`,
          type: 'observed_from',
          confidence: finding.confidence || 0.7,
        },
      });
    });
    claimIds.forEach((claimId) => {
      this._emit('graph.edge_upsert', {
        sessionId,
        edge: {
          from: `obs-${observationId}`,
          to: `claim-${claimId}`,
          type: 'about_claim',
          confidence: finding.confidence || 0.7,
        },
      });
    });
    if (csiStage) {
      const csiNode = {
        id: observationId,
        type: csiStage === 'faraday' ? 'csi-observation' : 'csi-hypothesis',
        stage: csiStage,
        title: `${agent}/${action}: ${finding.title?.slice(0, 80) || 'Observation'}`,
        summary: finding.content?.slice(0, 280) || '',
        kind: finding.type || action.toLowerCase(),
        verdict: null,
        confidence: finding.confidence || 0.7,
        claimIds,
        sourceIds,
        observationIds: [],
        taskId: finding.taskId || null,
        wave: finding.wave ?? null,
        agent,
        action,
        createdAt,
      };
      this._emit('graph.node_upsert', {
        sessionId,
        layer: 'csi',
        nodeId: observationId,
        node: csiNode,
      });
      sourceIds.forEach((sourceId) => {
        this._emit('graph.edge_upsert', {
          sessionId,
          edge: {
            from: `csi-${observationId}`,
            to: `source-${sourceId}`,
            type: csiStage === 'faraday' ? 'found_source' : 'analyzes',
            confidence: finding.confidence || 0.7,
          },
        });
      });
      claimIds.forEach((claimId) => {
        this._emit('graph.edge_upsert', {
          sessionId,
          edge: {
            from: `csi-${observationId}`,
            to: `claim-${claimId}`,
            type: csiStage === 'faraday' ? 'observes' : 'analyzes',
            confidence: finding.confidence || 0.7,
          },
        });
      });
      this._emit(csiStage === 'faraday' ? 'csi.faraday_observation' : 'csi.feynman_hypothesis', {
        sessionId,
        layer: 'csi',
        nodeId: observationId,
        node: csiNode,
      });
    }
  }

  _emitExecutionGraphEvents({ sessionId, eventId, createdAt, agent, action, output, stage, claimIds, sourceIds, observationIds }) {
    const executionNode = {
      id: eventId,
      title: `Execution: ${agent}/${action}`,
      agent,
      action,
      output,
      success: output.success !== false,
      latency: output.latency || null,
      taskId: output.taskId || null,
      wave: output.wave ?? null,
      phase: output.phase || null,
      sourceIds,
      claimIds,
      observationIds,
      csiStage: stage || null,
      verdict: output.verdict || null,
      confidence: output.confidence ?? null,
      createdAt,
    };
    this._emit('graph.node_upsert', {
      sessionId,
      layer: 'executionEvents',
      nodeId: eventId,
      node: executionNode,
    });
    claimIds.forEach((claimId) => {
      this._emit('graph.edge_upsert', {
        sessionId,
        edge: {
          from: `exec-${eventId}`,
          to: `claim-${claimId}`,
          type: stage === 'turing' ? (output.verdict === 'disputed' ? 'disputes' : output.verdict === 'verified' ? 'supports' : 'reviews') : 'related',
          confidence: output.confidence ?? 0.7,
        },
      });
    });
    observationIds.forEach((observationId) => {
      this._emit('graph.edge_upsert', {
        sessionId,
        edge: {
          from: `exec-${eventId}`,
          to: `obs-${observationId}`,
          type: stage === 'turing' ? 'verifies' : 'analyzes',
          confidence: output.confidence ?? 0.7,
        },
      });
    });
    if (stage) {
      const csiNode = {
        id: eventId,
        type: stage === 'turing' ? 'csi-verdict' : stage === 'feynman' ? 'csi-hypothesis' : 'csi-observation',
        stage,
        title: output.csiTitle || `CSI ${stage}: ${agent}/${action}`,
        summary: output.summary || `${agent}/${action}: ${JSON.stringify(output).slice(0, 240)}`,
        kind: action,
        verdict: output.verdict || null,
        confidence: output.confidence ?? null,
        claimIds,
        sourceIds,
        observationIds,
        taskId: output.taskId || null,
        wave: output.wave ?? null,
        agent,
        action,
        createdAt,
      };
      this._emit('graph.node_upsert', {
        sessionId,
        layer: 'csi',
        nodeId: eventId,
        node: csiNode,
      });
      claimIds.forEach((claimId) => {
        this._emit('graph.edge_upsert', {
          sessionId,
          edge: {
            from: `csi-${eventId}`,
            to: `claim-${claimId}`,
            type: output.verdict === 'disputed' ? 'disputes' : output.verdict === 'verified' ? 'supports' : 'reviews',
            confidence: output.confidence ?? 0.7,
          },
        });
      });
      observationIds.forEach((observationId) => {
        this._emit('graph.edge_upsert', {
          sessionId,
          edge: {
            from: `csi-${eventId}`,
            to: `obs-${observationId}`,
            type: stage === 'turing' ? 'verifies' : 'analyzes',
            confidence: output.confidence ?? 0.7,
          },
        });
      });
      if (stage === 'turing') {
        this._emit('csi.turing_verdict', {
          sessionId,
          layer: 'csi',
          nodeId: eventId,
          node: csiNode,
        });
      }
    }
  }

  /** Emit trail node creation for real-time graph visualization */
  _emitTrailGraphEvent({ sessionId, stepIndex, agent, action, input, output, confidence, claimIds, sourceIds }) {
    const trailNodeId = `trail-${sessionId}-${stepIndex}`;
    const trailNode = {
      id: trailNodeId,
      title: `${agent}/${action}`,
      type: 'trail',
      agent,
      action,
      input,
      output: typeof output === 'string' ? output : JSON.stringify(output).slice(0, 100),
      confidence,
      claimIds: claimIds || [],
      sourceIds: sourceIds || [],
      step: stepIndex,
      createdAt: new Date().toISOString(),
    };
    console.log('[DeepResearcher] Emitting graph.node.created for trail:', trailNodeId);
    this._emit('graph.node.created', {
      sessionId,
      nodeId: trailNodeId,
      title: trailNode.title,
      nodeType: 'trail',
      layer: 'trails',
      content: `${agent}: ${action}`,
      metadata: {
        agentId: agent,
        confidence,
        step: stepIndex,
        sourceIds,
        claimIds,
      },
    });
    // Link to related claims
    (claimIds || []).forEach(claimId => {
      this._emit('graph.edge.created', {
        sessionId,
        source: trailNodeId,
        target: `claim-${claimId}`,
        relationshipType: 'supports',
        confidence: confidence || 0.7,
      });
    });
  }

  /** Emit blueprint node creation for real-time graph visualization */
  _emitBlueprintGraphEvent({ sessionId, blueprintId, blueprintName, blueprintDomain, isUsed = false }) {
    const blueprintNodeId = `blueprint-${blueprintId}`;
    const blueprintNode = {
      id: blueprintNodeId,
      title: blueprintName,
      type: 'blueprint',
      blueprintId,
      domain: blueprintDomain,
      isUsed,
      createdAt: new Date().toISOString(),
    };
    this._emit('graph.node.created', {
      sessionId,
      nodeId: blueprintNodeId,
      title: blueprintNode.title,
      nodeType: 'blueprint',
      layer: 'blueprints',
      content: `${blueprintDomain || 'general'} pattern`,
      metadata: {
        blueprintId,
        domain: blueprintDomain,
        isUsed,
      },
    });
  }

  _emit(type, data) {
    if (type.startsWith('graph.')) {
      console.log('[DeepResearcher] Emitting event:', type, 'sessionId:', data?.sessionId, 'nodeId:', data?.nodeId);
    }
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
   * Load a blueprint by ID.
   * @param {string} blueprintId
   * @returns {Promise<Object|null>}
   * @private
   */
  async _loadBlueprint(blueprintId) {
    try {
      const results = await this.memoryStore.searchMemories({
        query: blueprintId,
        tags: ['blueprint'],
        n_results: 1,
      });
      return results?.[0]?.metadata || null;
    } catch { return null; }
  }

  /**
   * Mine blueprints from completed research.
   * @param {string} sessionId - current research session ID
   * @param {string} userId
   * @param {string} orgId
   * @param {string} query
   * @param {TaskStack} stack
   * @private
   */
  async _mineBlueprints(sessionId, userId, orgId, query, stack) {
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
        // Emit each mined blueprint as a node in graph for discovery
        blueprints.forEach(blueprint => {
          this._emitBlueprintGraphEvent({
            sessionId,
            blueprintId: blueprint.blueprintId,
            blueprintName: blueprint.name,
            blueprintDomain: blueprint.domain || 'research',
            isUsed: false,
          });
        });
      }
    } catch (err) {
      console.error('[DeepResearcher] Blueprint mining error:', err.message);
    }
  }
}
