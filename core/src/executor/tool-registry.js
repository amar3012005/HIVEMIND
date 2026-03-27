/**
 * Trail Executor — Tool Registry
 * HIVE-MIND Cognitive Runtime
 *
 * Strict, typed tool validation and execution registry.
 * Validates bound actions against registered tool definitions,
 * enforcing parameter contracts and budget constraints.
 */

/** @typedef {import('./types/tool.types.js').BoundAction} BoundAction */

/**
 * @typedef {Object} ParamDef
 * @property {'string'|'number'|'boolean'|'object'|'array'} type
 * @property {boolean} [required]
 * @property {string} [description]
 * @property {*} [default]
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - Canonical tool name
 * @property {string} description - Human-readable description
 * @property {Record<string, ParamDef>} params - Parameter schema
 * @property {number} [maxTokens] - Maximum token budget for this tool
 * @property {number} [maxCostUsd] - Maximum cost budget for this tool
 * @property {number} [timeoutMs] - Execution timeout in milliseconds
 * @property {string[]} [requiresPermission] - Required permission scopes
 */

/**
 * @typedef {Object} Budget
 * @property {number} [maxTokens] - Remaining token budget
 * @property {number} [maxCostUsd] - Remaining cost budget in USD
 */

const VALID_PARAM_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

export class ToolRegistry {
  /** @type {Map<string, ToolDefinition>} */
  #tools = new Map();

  /**
   * Register a tool definition.
   * @param {ToolDefinition} toolDef
   * @throws {Error} if definition is invalid
   */
  register(toolDef) {
    if (!toolDef || typeof toolDef.name !== 'string' || !toolDef.name) {
      throw new Error('Tool definition requires a non-empty string name');
    }
    if (typeof toolDef.description !== 'string' || !toolDef.description) {
      throw new Error(`Tool "${toolDef.name}" requires a non-empty description`);
    }
    if (!toolDef.params || typeof toolDef.params !== 'object') {
      throw new Error(`Tool "${toolDef.name}" requires a params object`);
    }

    for (const [paramName, paramDef] of Object.entries(toolDef.params)) {
      if (!VALID_PARAM_TYPES.has(paramDef.type)) {
        throw new Error(
          `Tool "${toolDef.name}" param "${paramName}" has invalid type "${paramDef.type}". ` +
          `Valid types: ${[...VALID_PARAM_TYPES].join(', ')}`
        );
      }
    }

    this.#tools.set(toolDef.name, { ...toolDef });
  }

  /**
   * Validate a BoundAction against registry and budget constraints.
   * @param {BoundAction} action
   * @param {Budget} [budget]
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  validate(action, budget) {
    if (!action || typeof action.toolName !== 'string') {
      return { ok: false, error: 'Action requires a toolName string' };
    }

    const tool = this.#tools.get(action.toolName);
    if (!tool) {
      return { ok: false, error: `Unknown tool: "${action.toolName}"` };
    }

    const params = action.params || {};

    // Check required params are present
    for (const [paramName, paramDef] of Object.entries(tool.params)) {
      if (paramDef.required && !(paramName in params)) {
        return { ok: false, error: `Missing required param: "${paramName}"` };
      }
    }

    // Check param types for provided values
    for (const [paramName, value] of Object.entries(params)) {
      const paramDef = tool.params[paramName];
      if (!paramDef) continue; // allow extra params — tools may be lenient

      if (value === undefined || value === null) {
        if (paramDef.required) {
          return { ok: false, error: `Missing required param: "${paramName}"` };
        }
        continue;
      }

      if (!matchesType(value, paramDef.type)) {
        return {
          ok: false,
          error: `Param "${paramName}" expected type "${paramDef.type}", got "${actualType(value)}"`
        };
      }
    }

    // Budget validation
    if (budget) {
      if (
        typeof tool.maxTokens === 'number' &&
        typeof budget.maxTokens === 'number' &&
        tool.maxTokens > budget.maxTokens
      ) {
        return {
          ok: false,
          error: `Tool "${action.toolName}" requires ${tool.maxTokens} tokens but budget only has ${budget.maxTokens}`
        };
      }
      if (
        typeof tool.maxCostUsd === 'number' &&
        typeof budget.maxCostUsd === 'number' &&
        tool.maxCostUsd > budget.maxCostUsd
      ) {
        return {
          ok: false,
          error: `Tool "${action.toolName}" requires $${tool.maxCostUsd} but budget only has $${budget.maxCostUsd}`
        };
      }
    }

    return { ok: true };
  }

  /**
   * Get a tool definition by name.
   * @param {string} name
   * @returns {ToolDefinition|undefined}
   */
  getDefinition(name) {
    const tool = this.#tools.get(name);
    return tool ? { ...tool } : undefined;
  }

  /**
   * List all registered tool definitions.
   * @returns {ToolDefinition[]}
   */
  listTools() {
    return [...this.#tools.values()].map(t => ({ ...t }));
  }

  /**
   * Check if a tool is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.#tools.has(name);
  }
}

/**
 * Check if a value matches the expected param type.
 * @param {*} value
 * @param {string} expectedType
 * @returns {boolean}
 */
function matchesType(value, expectedType) {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Get a human-readable type label for error messages.
 * @param {*} value
 * @returns {string}
 */
function actualType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}
