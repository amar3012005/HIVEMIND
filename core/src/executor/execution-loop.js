/**
 * Trail Executor — Execution Loop
 * HIVE-MIND Cognitive Runtime
 *
 * The main orchestrator that wires all executor components together
 * into the core select-bind-execute-write cycle. This is the "motor
 * cortex" of the runtime — it orchestrates, does not decide.
 *
 * @module executor/execution-loop
 */

/**
 * @typedef {Object} ExecutionConfig
 * @property {number} maxSteps - Maximum number of steps to execute
 * @property {{ maxTokens?: number, maxCostUsd?: number, maxWallClockMs?: number }} [budget] - Budget constraints
 * @property {import('./types/routing.types.js').RoutingConfig} routing - Routing configuration
 * @property {number} [promotionThreshold] - Confidence threshold for promotion (0-1)
 * @property {string} [promotionRuleId] - Rule ID for promotion mux
 */

/**
 * @typedef {Object} WorkingMemory
 * @property {Record<string, *>} context - Accumulated key-value context
 * @property {import('./types/agent.types.js').Observation[]} observations - Accumulated observations
 * @property {string[]} recentTrailHistory - Trail IDs executed recently
 * @property {boolean} done - Whether the goal is satisfied
 * @property {number} failuresCount - Number of consecutive/total failures
 * @property {string} agentId - Agent executing the loop
 * @property {number} stepIndex - Current step index
 */

/**
 * @typedef {Object} ExecutionResult
 * @property {string} goal - Original goal text
 * @property {string} agentId - Agent that executed
 * @property {number} stepsExecuted - Total steps completed
 * @property {number} eventsLogged - Total events written
 * @property {WorkingMemory} finalState - Final working memory snapshot
 * @property {string[]} trailsUpdated - Unique trail IDs that were executed
 * @property {import('./types/agent.types.js').Observation[]} observationsForEval - Observations for evaluation
 * @property {string|undefined} nextRecommendedGoal - V2: next goal recommendation
 */

export class TrailExecutor {
  /**
   * @param {object} deps
   * @param {import('./trail-selector.js').TrailSelector} deps.trailSelector
   * @param {import('./action-binder.js').ActionBinder} deps.actionBinder
   * @param {import('./tool-runner.js').ToolRunner} deps.toolRunner
   * @param {import('./outcome-writer.js').OutcomeWriter} deps.outcomeWriter
   * @param {import('./lease-manager.js').LeaseManager} deps.leaseManager
   * @param {object} [deps.weightUpdater] - WeightUpdater instance (may be null for V1)
   * @param {object} [deps.promotionMux] - PromotionMux instance (may be null for V1)
   * @param {object} deps.store - GraphStore for loading canonical state
   */
  constructor({
    trailSelector,
    actionBinder,
    toolRunner,
    outcomeWriter,
    leaseManager,
    weightUpdater = null,
    promotionMux = null,
    store,
  }) {
    this.trailSelector = trailSelector;
    this.actionBinder = actionBinder;
    this.toolRunner = toolRunner;
    this.outcomeWriter = outcomeWriter;
    this.leaseManager = leaseManager;
    this.weightUpdater = weightUpdater;
    this.promotionMux = promotionMux;
    this.store = store;
  }

  /**
   * Execute the goal by iterating through the select-bind-execute-write cycle.
   *
   * @param {string} goal - Goal description text
   * @param {string} agentId - Agent identity
   * @param {ExecutionConfig} config - Execution configuration
   * @returns {Promise<ExecutionResult>}
   */
  async execute(goal, agentId, config) {
    // ── PHASE 1: Initialization ──────────────────────────────────────────────

    // Load canonical state from store (knowledge graph facts)
    const canonicalState = { facts: {} };
    if (this.store.loadState) {
      try {
        const loaded = await this.store.loadState();
        if (loaded && loaded.facts) {
          canonicalState.facts = loaded.facts;
        }
      } catch {
        // Non-fatal: proceed with empty canonical state
      }
    }

    /** @type {WorkingMemory} */
    const workingMemory = {
      context: {},
      observations: [],
      recentTrailHistory: [],
      done: false,
      failuresCount: 0,
      agentId,
      stepIndex: 0,
    };

    const events = [];
    let step = 0;
    const maxSteps = config.maxSteps ?? 10;
    const budget = config.budget ?? {};
    const promotionThreshold = config.promotionThreshold ?? 0.8;

    // Build context object for trail selector
    const goalId = goal; // Use goal text as goalId for now
    const namespaceId = agentId; // Use agentId as namespace for now

    // ── PHASE 2: Execution Loop ──────────────────────────────────────────────

    while (step < maxSteps && !workingMemory.done) {
      let lease = null;

      try {
        // A. SELECT: choose the next trail to advance
        const selectorContext = {
          goalId,
          namespaceId,
          state: workingMemory.context,
          queueInfo: { depth: step },
          recentTrailHistory: workingMemory.recentTrailHistory || [],
        };

        const selection = await this.trailSelector.selectNext(
          goal,
          selectorContext,
          agentId,
          config.routing,
        );

        if (!selection) break; // No viable trails

        const { trail, decision: routingDecision } = selection;

        // B. ACQUIRE LEASE
        const ttlMs = budget.maxWallClockMs || 30000;
        const leaseResult = await this.leaseManager.acquire(trail.id, agentId, ttlMs);

        if (!leaseResult.acquired) {
          // Trail is leased by another agent — skip and continue
          step++;
          continue;
        }

        lease = leaseResult.lease;

        try {
          // C. BIND: resolve action parameters
          let boundAction;
          try {
            boundAction = await this.actionBinder.bind(
              trail.nextAction,
              workingMemory,
              canonicalState,
            );
          } catch (bindError) {
            // Bind failed — log and continue to next step
            step++;
            continue;
          }

          // D. EXECUTE: run the tool
          let toolResult;
          try {
            toolResult = await this.toolRunner.run(boundAction, budget);
          } catch (runError) {
            toolResult = {
              success: false,
              error: runError.message,
              output: null,
              durationMs: 0,
              tokensUsed: 0,
              metadata: {},
            };
          }

          // E. WRITE EVENT: persist the outcome
          const outcomeToolResult = {
            result: toolResult.success ? toolResult.output : null,
            error: toolResult.success ? null : (toolResult.error || 'Unknown error'),
            latencyMs: toolResult.durationMs ?? 0,
            tokensUsed: toolResult.tokensUsed ?? 0,
            estimatedCostUsd: toolResult.metadata?.estimatedCostUsd ?? 0,
          };

          workingMemory.stepIndex = step;

          const event = await this.outcomeWriter.write(
            trail,
            boundAction,
            outcomeToolResult,
            routingDecision,
            workingMemory,
          );

          events.push(event);

          // F. UPDATE WORKING MEMORY
          if (toolResult.success && toolResult.output) {
            // Incorporate result into context
            if (typeof toolResult.output === 'object' && toolResult.output !== null) {
              Object.assign(workingMemory.context, toolResult.output);
            } else {
              workingMemory.context[`step_${step}_result`] = toolResult.output;
            }

            // Check if done
            if (toolResult.output.done === true) {
              workingMemory.done = true;
            }
          }

          if (!toolResult.success) {
            workingMemory.failuresCount++;
          }

          workingMemory.recentTrailHistory.push(trail.id);

          // G. UPDATE WEIGHT (if weightUpdater available)
          if (this.weightUpdater) {
            try {
              await this.weightUpdater.update({
                trail,
                confidence: trail.confidence ?? 0,
                latencyMs: toolResult.durationMs ?? 0,
                stepStatus: toolResult.success ? 'succeeded' : 'failed',
                tokensUsed: toolResult.tokensUsed ?? 0,
              });
            } catch {
              // Non-fatal: weight update failure should not break the loop
            }
          }

          // H. EMIT PROMOTION (if promotionMux available and confidence > threshold)
          if (this.promotionMux && (trail.confidence ?? 0) > promotionThreshold) {
            try {
              await this.promotionMux.emitCandidate(
                event,
                trail,
                trail.confidence,
                config.promotionRuleId,
                workingMemory.observations,
              );
            } catch {
              // Non-fatal: promotion failure should not break the loop
            }
          }
        } finally {
          // I. RELEASE LEASE: always release in finally block
          if (lease) {
            try {
              await this.leaseManager.release(lease.id);
            } catch {
              // Best-effort release
            }
          }
        }
      } catch (outerError) {
        // Errors in one step should NOT crash the loop — log and continue
        workingMemory.failuresCount++;
      }

      step++;
    }

    // ── PHASE 3: Return ExecutionResult ────────────────────────────────────────

    const trailsUpdated = [...new Set(events.map((e) => e.trail_id))];

    return {
      goal,
      agentId,
      stepsExecuted: step,
      eventsLogged: events.length,
      finalState: { ...workingMemory },
      trailsUpdated,
      observationsForEval: workingMemory.observations,
      nextRecommendedGoal: undefined,
    };
  }
}

export default TrailExecutor;
