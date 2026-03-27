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
    reputationEngine = null,
    store,
  }) {
    this.trailSelector = trailSelector;
    this.actionBinder = actionBinder;
    this.toolRunner = toolRunner;
    this.outcomeWriter = outcomeWriter;
    this.leaseManager = leaseManager;
    this.weightUpdater = weightUpdater;
    this.promotionMux = promotionMux;
    this.reputationEngine = reputationEngine;
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
    let doneReason = 'budget_exhausted'; // default
    const maxSteps = config.maxSteps ?? 10;
    const budget = config.budget ?? {};
    const promotionThreshold = config.promotionThreshold ?? 0.8;

    // Build context object for trail selector
    const goalId = goal; // Use goal text as goalId for now
    const namespaceId = agentId; // Use agentId as namespace for now

    // Ensure agent exists (auto-create if implicit)
    if (this.store.ensureAgent) {
      try {
        const agent = await this.store.ensureAgent(agentId);
        if (agent.status === 'suspended') {
          return {
            goal, agentId, stepsExecuted: 0, eventsLogged: 0,
            finalState: workingMemory, trailsUpdated: [],
            observationsForEval: [], chainSummary: { doneReason: 'agent_suspended' },
            error: 'Agent is suspended',
          };
        }
      } catch { /* non-fatal */ }
    }

    // Load agent reputation for routing context
    let agentReputation = null;
    if (this.reputationEngine) {
      try {
        agentReputation = await this.reputationEngine.getReputation(agentId);
      } catch { /* non-fatal */ }
    }

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
          reputationContext: agentReputation ? {
            agentScores: { [agentId]: { success_rate: agentReputation.success_rate } },
          } : null,
        };

        const selection = await this.trailSelector.selectNext(
          goal,
          selectorContext,
          agentId,
          config.routing,
        );

        if (!selection) {
          doneReason = 'no_viable_trails';
          break;
        }

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
          // C-F: EXECUTE (branch on trail kind)
          if (trail.kind === 'blueprint' && trail.blueprintMeta?.actionSequence?.length) {
            // ── BLUEPRINT EXECUTION: composite action sequence ──
            let innerSteps = 0;
            let innerSucceeded = 0;
            let innerLatencyMs = 0;
            let blueprintDoneReason = 'all_steps_completed';

            for (const actionRef of trail.blueprintMeta.actionSequence) {
              let boundAction;
              try {
                boundAction = await this.actionBinder.bind(actionRef, workingMemory, canonicalState);
              } catch {
                blueprintDoneReason = 'blueprint_bind_failed';
                workingMemory.failuresCount++;
                break;
              }

              let toolResult;
              try {
                toolResult = await this.toolRunner.run(boundAction, budget);
              } catch (runError) {
                toolResult = {
                  success: false, error: runError.message,
                  output: null, durationMs: 0, tokensUsed: 0, metadata: {},
                };
              }

              innerSteps++;
              innerLatencyMs += toolResult.durationMs ?? 0;

              // Write per-step event (blueprint steps are NOT opaque)
              const outcomeToolResult = {
                result: toolResult.success ? toolResult.output : null,
                error: toolResult.success ? null : (toolResult.error || 'Unknown error'),
                latencyMs: toolResult.durationMs ?? 0,
                tokensUsed: toolResult.tokensUsed ?? 0,
                estimatedCostUsd: toolResult.metadata?.estimatedCostUsd ?? 0,
              };
              workingMemory.stepIndex = step;
              const event = await this.outcomeWriter.write(
                trail, boundAction, outcomeToolResult, routingDecision, workingMemory,
              );
              events.push(event);

              // Update working memory (chain flows between steps)
              if (toolResult.success && toolResult.output) {
                if (typeof toolResult.output === 'object' && toolResult.output !== null) {
                  Object.assign(workingMemory.context, toolResult.output);
                }
                innerSucceeded++;

                if (toolResult.output.done === true) {
                  workingMemory.done = true;
                  doneReason = 'tool_signaled_completion';
                  blueprintDoneReason = 'tool_signaled_completion';
                  break;
                }
              }

              if (!toolResult.success) {
                workingMemory.failuresCount++;
                workingMemory.done = true;
                doneReason = 'blueprint_step_failed';
                blueprintDoneReason = 'blueprint_step_failed';
                break;
              }
            }

            workingMemory.recentTrailHistory.push(trail.id);

            // Store blueprint execution summary
            workingMemory._blueprintExecSummary = {
              blueprintId: trail.id,
              chainSignature: trail.blueprintMeta.chainSignature,
              stepsAttempted: innerSteps,
              stepsSucceeded: innerSucceeded,
              totalLatencyMs: innerLatencyMs,
              doneReason: blueprintDoneReason,
            };

          } else {
            // ── SINGLE-ACTION EXECUTION (existing code) ──

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
                doneReason = 'tool_signaled_completion';
              }
            }

            if (!toolResult.success) {
              workingMemory.failuresCount++;
            }

            workingMemory.recentTrailHistory.push(trail.id);
          }

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

    // Build chain summary — compact record of the tool sequence
    const bpSummary = workingMemory._blueprintExecSummary;
    const chainSummary = {
      toolSequence: events.map((e) => e.action_name),
      trailSequence: events.map((e) => e.trail_id),
      uniqueTrails: trailsUpdated.length,
      successRate: events.length ? events.filter((e) => e.success).length / events.length : 0,
      totalLatencyMs: events.reduce((sum, e) => sum + (e.latency_ms || 0), 0),
      doneReason,
      usedBlueprint: !!bpSummary,
      blueprintId: bpSummary?.blueprintId || null,
      blueprintChainSignature: bpSummary?.chainSignature || null,
      outerSteps: step,
      innerSteps: events.length,
      blueprintExecutionSummary: bpSummary || null,
    };

    // Update reputation from execution outcome (synchronous, non-fatal)
    if (this.reputationEngine) {
      try {
        await this.reputationEngine.updateFromExecution(agentId, {
          chainSummary,
          stepsExecuted: step,
        });
      } catch {
        // Reputation write failed — don't fail the response
      }
    }

    return {
      goal,
      agentId,
      stepsExecuted: step,
      eventsLogged: events.length,
      finalState: { ...workingMemory },
      trailsUpdated,
      observationsForEval: workingMemory.observations,
      chainSummary,
      nextRecommendedGoal: undefined,
    };
  }
}

export default TrailExecutor;
