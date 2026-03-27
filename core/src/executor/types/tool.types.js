/**
 * Trail Executor — Tool Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Bound actions, validation, and execution results for the tool layer.
 */

/**
 * A fully-bound action ready for execution.
 * Produced by the action-binding step after LLM output is parsed.
 *
 * @typedef {Object} BoundAction
 * @property {string} toolName - Canonical tool name
 * @property {Record<string, *>} params - Validated and coerced parameters
 * @property {string} [rationale] - LLM-provided reasoning
 * @property {import('./agent.types.js').TrailId} trailId - Trail this action belongs to
 * @property {number} stepIndex - Step index within the trail
 */

/**
 * Result of parameter validation before execution.
 *
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether the action passed validation
 * @property {string[]} errors - List of validation error messages (empty when valid)
 * @property {Record<string, *>} [coerced] - Coerced/normalized params (present when valid)
 */

/**
 * Result returned after a tool has been executed.
 *
 * @typedef {Object} ToolExecutionResult
 * @property {boolean} success - Whether the tool completed without error
 * @property {*} [output] - Arbitrary structured output from the tool
 * @property {string} [error] - Error message when success is false
 * @property {number} durationMs - Wall-clock execution time
 * @property {number} [tokensUsed] - Tokens consumed by the tool (if applicable)
 * @property {Record<string, *>} [metadata] - Optional execution metadata
 */

export const TOOL_TYPES = Symbol.for('hivemind.executor.tool.types');
