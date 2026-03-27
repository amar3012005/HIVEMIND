/**
 * Trail Executor — Action Binder
 * HIVE-MIND Cognitive Runtime
 *
 * Resolves an ActionRef's paramsTemplate against working memory,
 * canonical state (knowledge graph), and observations to produce
 * a fully-bound action ready for execution.
 */

/** @typedef {import('./types/tool.types.js').BoundAction} BoundAction */
/** @typedef {import('./types/agent.types.js').Observation} Observation */

/**
 * @typedef {Object} ActionRef
 * @property {string} tool - Canonical tool name
 * @property {Record<string, *>} paramsTemplate - Parameter template with resolution tokens
 * @property {string} [version] - Optional tool version
 */

/**
 * @typedef {Object} WorkingMemory
 * @property {Record<string, *>} context - Key-value context bag
 * @property {Observation[]} observations - Accumulated observations
 */

/**
 * @typedef {Object} CanonicalState
 * @property {Record<string, *>} facts - Knowledge graph facts (flat key-value)
 */

export class ActionBinder {
  /** @type {import('./tool-registry.js').ToolRegistry} */
  #registry;

  /**
   * @param {import('./tool-registry.js').ToolRegistry} toolRegistry
   */
  constructor(toolRegistry) {
    this.#registry = toolRegistry;
  }

  /**
   * Bind an ActionRef to concrete parameter values.
   *
   * Resolution rules:
   *   - `$ctx.<key>`  → workingMemory.context[key]
   *   - `$kg.<key>`   → canonicalState.facts[key]
   *   - `$obs.<kind>` → latest observation matching kind (.content)
   *   - anything else → literal pass-through
   *
   * @param {ActionRef} actionRef
   * @param {WorkingMemory} workingMemory
   * @param {CanonicalState} canonicalState
   * @returns {Promise<BoundAction>}
   * @throws {Error} when a required param cannot be resolved
   */
  async bind(actionRef, workingMemory, canonicalState) {
    if (!actionRef || typeof actionRef.tool !== 'string') {
      throw new Error('ActionRef requires a non-empty tool name');
    }

    const toolDef = this.#registry.getDefinition(actionRef.tool);
    if (!toolDef) {
      throw new Error(`Unknown tool: "${actionRef.tool}"`);
    }

    const template = actionRef.paramsTemplate || {};
    const resolved = {};

    for (const [key, raw] of Object.entries(template)) {
      resolved[key] = this.#resolveValue(key, raw, workingMemory, canonicalState);
    }

    const timeoutMs = toolDef.timeoutMs ?? 30_000;

    return {
      toolName: actionRef.tool,
      params: resolved,
      timeoutMs,
    };
  }

  /**
   * Resolve a single parameter value.
   *
   * @param {string} paramName - For error messages
   * @param {*} value
   * @param {WorkingMemory} workingMemory
   * @param {CanonicalState} canonicalState
   * @returns {*}
   */
  #resolveValue(paramName, value, workingMemory, canonicalState) {
    if (typeof value !== 'string') return value;

    // $ctx. — resolve from working memory context
    if (value.startsWith('$ctx.')) {
      const ctxKey = value.slice('$ctx.'.length);
      const result = workingMemory?.context?.[ctxKey];
      if (result === undefined) {
        throw new Error(`Cannot resolve param "${paramName}": context key "${ctxKey}" not found`);
      }
      return result;
    }

    // $kg. — resolve from canonical state (knowledge graph)
    if (value.startsWith('$kg.')) {
      const kgKey = value.slice('$kg.'.length);
      const result = canonicalState?.facts?.[kgKey];
      if (result === undefined) {
        throw new Error(`Cannot resolve param "${paramName}": knowledge graph key "${kgKey}" not found`);
      }
      return result;
    }

    // $obs. — resolve from latest observation by kind
    if (value.startsWith('$obs.')) {
      const obsKind = value.slice('$obs.'.length);
      const observations = workingMemory?.observations || [];
      // Find the latest observation matching the kind (observations are ordered, pick last)
      let latest = null;
      for (const obs of observations) {
        if (obs.kind === obsKind) latest = obs;
      }
      if (!latest) {
        throw new Error(`Cannot resolve param "${paramName}": no observation of kind "${obsKind}" found`);
      }
      return latest.content;
    }

    // Literal value
    return value;
  }
}
