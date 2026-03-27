/**
 * Trail Executor — Tool Runner
 * HIVE-MIND Cognitive Runtime
 *
 * Executes a BoundAction safely with budget enforcement,
 * timeout handling, and latency tracking.
 */

/** @typedef {import('./types/tool.types.js').BoundAction} BoundAction */
/** @typedef {import('./types/tool.types.js').ToolExecutionResult} ToolExecutionResult */
/** @typedef {import('./tool-registry.js').Budget} Budget */

const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolRunner {
  /** @type {import('./tool-registry.js').ToolRegistry} */
  #registry;

  /** @type {Map<string, (params: Record<string, *>, signal?: AbortSignal) => Promise<*>>} */
  #executors = new Map();

  /**
   * @param {import('./tool-registry.js').ToolRegistry} toolRegistry
   */
  constructor(toolRegistry) {
    this.#registry = toolRegistry;
  }

  /**
   * Register an executor function for a named tool.
   *
   * @param {string} toolName - Canonical tool name (must match registry)
   * @param {(params: Record<string, *>, signal?: AbortSignal) => Promise<*>} executorFn
   */
  register(toolName, executorFn) {
    if (typeof toolName !== 'string' || !toolName) {
      throw new Error('Executor registration requires a non-empty tool name');
    }
    if (typeof executorFn !== 'function') {
      throw new Error(`Executor for "${toolName}" must be a function`);
    }
    this.#executors.set(toolName, executorFn);
  }

  /**
   * Execute a BoundAction with budget enforcement, timeout, and latency tracking.
   *
   * @param {BoundAction} action - Fully-bound action to execute
   * @param {Budget} [budget] - Remaining budget constraints
   * @returns {Promise<ToolExecutionResult>}
   */
  async run(action, budget) {
    // 1. Validate against tool registry (budget-aware)
    const validation = this.#registry.validate(action, budget);
    if (!validation.ok) {
      throw new Error(`Validation failed for "${action.toolName}": ${validation.error}`);
    }

    // 2. Look up executor
    const executor = this.#executors.get(action.toolName);
    if (!executor) {
      return {
        success: false,
        error: `No executor for tool: "${action.toolName}"`,
        durationMs: 0,
        tokensUsed: 0,
        metadata: {},
      };
    }

    // 3. Determine timeout
    const toolDef = this.#registry.getDefinition(action.toolName);
    const timeoutMs = action.timeoutMs ?? toolDef?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 4. Execute with timeout and latency tracking
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();

    try {
      const output = await Promise.race([
        executor(action.params, controller.signal),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error(`Tool "${action.toolName}" timed out after ${timeoutMs}ms`));
          });
        }),
      ]);

      const latencyMs = Math.round(performance.now() - start);

      return {
        success: true,
        output,
        durationMs: latencyMs,
        tokensUsed: output?.tokensUsed ?? 0,
        metadata: {
          estimatedCostUsd: output?.estimatedCostUsd ?? 0,
        },
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start);

      return {
        success: false,
        error: err.message,
        durationMs: latencyMs,
        tokensUsed: 0,
        metadata: {},
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
