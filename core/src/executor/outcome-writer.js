/**
 * Trail Executor — Outcome Writer
 * HIVE-MIND Cognitive Runtime
 *
 * Persists execution results as immutable events and appends
 * compact step summaries to the corresponding trail.
 *
 * @module executor/outcome-writer
 */

import { randomUUID } from 'node:crypto';

/** @typedef {import('./types/event.types.js').ExecutionEvent} ExecutionEvent */
/** @typedef {import('./types/trail.types.js').Trail} Trail */
/** @typedef {import('./types/trail.types.js').TrailStepSummary} TrailStepSummary */

/**
 * Truncate a value to `maxLength` characters.
 * Returns a stringified representation; appends '…' when truncated.
 *
 * @param {*} value
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(value, maxLength = 200) {
  const str = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '\u2026';
}

export class OutcomeWriter {
  /**
   * @param {object} store - Object implementing { writeEvent, appendTrailStep }
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * Write an execution event and append a compact step summary to the trail.
   *
   * @param {Trail} trail - The trail being executed
   * @param {object} action - The action that was executed
   * @param {string} action.toolName - Canonical tool name
   * @param {Record<string, *>} action.params - Resolved parameters
   * @param {string} [action.rationale] - LLM reasoning
   * @param {object} toolResult - Result returned by the tool
   * @param {*} [toolResult.result] - Success payload
   * @param {string|null} [toolResult.error] - Error message (null on success)
   * @param {number} toolResult.latencyMs - Wall-clock duration in ms
   * @param {number} [toolResult.tokensUsed] - Tokens consumed
   * @param {number} [toolResult.estimatedCostUsd] - Estimated cost in USD
   * @param {object|null} routingDecision - ForceVector / routing metadata for explainability
   * @param {object} workingMemory - Current executor working memory
   * @param {string} workingMemory.agentId - Agent executing the trail
   * @param {number} [workingMemory.stepIndex] - Current step index
   * @returns {Promise<ExecutionEvent>}
   */
  async write(trail, action, toolResult, routingDecision, workingMemory) {
    const success = !toolResult.error;
    const now = Date.now();

    // 1. Build the immutable ExecutionEvent
    const event = {
      id: randomUUID(),
      trail_id: trail.id,
      agent_id: workingMemory.agentId,
      step_index: workingMemory.stepIndex ?? trail.steps.length,
      action_name: action.toolName,
      bound_params: action.params ?? {},
      result: success ? toolResult.result : null,
      error: toolResult.error ?? null,
      latency_ms: toolResult.latencyMs,
      success,
      tokens_used: toolResult.tokensUsed ?? null,
      estimated_cost_usd: toolResult.estimatedCostUsd ?? null,
      routing: routingDecision ?? null,
      timestamp: new Date(now).toISOString(),
    };

    // 2. Persist event (append-only, immutable)
    await this.store.writeEvent(event);

    // 3. Append compact step summary to the trail
    /** @type {TrailStepSummary} */
    const step = {
      index: event.step_index,
      status: success ? 'succeeded' : 'failed',
      action: {
        toolName: action.toolName,
        params: action.params ?? {},
        ...(action.rationale ? { rationale: action.rationale } : {}),
      },
      resultSummary: truncate(success ? toolResult.result : toolResult.error),
      tokensUsed: toolResult.tokensUsed ?? 0,
      durationMs: toolResult.latencyMs,
      timestamp: now,
    };

    await this.store.appendTrailStep(trail.id, step);

    // 4. Return the created event
    return event;
  }
}
