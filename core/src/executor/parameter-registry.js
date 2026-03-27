/**
 * Trail Executor — Parameter Registry
 * HIVE-MIND Cognitive Runtime
 *
 * Centralized configuration store with validation, rollback,
 * and bootstrap defaults. The runtime reads config from here.
 *
 * @module executor/parameter-registry
 */

const BOOTSTRAP_DEFAULTS = {
  'routing.temperature': 1.0,
  'routing.forceWeights.goalAttraction': 1.0,
  'routing.forceWeights.affordanceAttraction': 1.0,
  'routing.forceWeights.blueprintPrior': 0.3,
  'routing.forceWeights.social': 0.2,
  'routing.forceWeights.momentum': 0.15,
  'routing.forceWeights.conflictRepulsion': 1.0,
  'routing.forceWeights.congestionRepulsion': 1.0,
  'routing.forceWeights.costRepulsion': 1.0,
  'blueprint.minOccurrences': 3,
  'blueprint.minSuccessRate': 0.9,
  'blueprint.maxAvgLatencyMs': 5000,
  'blueprint.lookbackRuns': 50,
  'blueprint.autoActivate': true,
  'reputation.emaAlpha': 0.1,
  'reputation.minEvidence': 10,
  'reputation.maxConfidenceWithoutEvidence': 0.6,
  'execution.defaultMaxSteps': 10,
  'execution.defaultBudgetMaxTokens': 50000,
  'execution.defaultPromotionThreshold': 0.8,
};

const PARAMETER_SCHEMA = {
  'routing.temperature': { type: 'number', min: 0.01, max: 10.0 },
  'routing.forceWeights.goalAttraction': { type: 'number', min: 0, max: 5.0 },
  'routing.forceWeights.affordanceAttraction': { type: 'number', min: 0, max: 5.0 },
  'routing.forceWeights.blueprintPrior': { type: 'number', min: 0, max: 2.0 },
  'routing.forceWeights.social': { type: 'number', min: 0, max: 2.0 },
  'routing.forceWeights.momentum': { type: 'number', min: 0, max: 2.0 },
  'routing.forceWeights.conflictRepulsion': { type: 'number', min: 0, max: 5.0 },
  'routing.forceWeights.congestionRepulsion': { type: 'number', min: 0, max: 5.0 },
  'routing.forceWeights.costRepulsion': { type: 'number', min: 0, max: 5.0 },
  'blueprint.minOccurrences': { type: 'number', min: 1, max: 100 },
  'blueprint.minSuccessRate': { type: 'number', min: 0, max: 1 },
  'blueprint.maxAvgLatencyMs': { type: 'number', min: 100, max: 60000 },
  'blueprint.lookbackRuns': { type: 'number', min: 5, max: 500 },
  'blueprint.autoActivate': { type: 'boolean' },
  'reputation.emaAlpha': { type: 'number', min: 0.001, max: 1 },
  'reputation.minEvidence': { type: 'number', min: 1, max: 100 },
  'reputation.maxConfidenceWithoutEvidence': { type: 'number', min: 0, max: 1 },
  'execution.defaultMaxSteps': { type: 'number', min: 1, max: 100 },
  'execution.defaultBudgetMaxTokens': { type: 'number', min: 1000, max: 500000 },
  'execution.defaultPromotionThreshold': { type: 'number', min: 0, max: 1 },
};

export class ParameterRegistry {
  constructor(store) {
    this.store = store;
  }

  _validate(key, value) {
    const schema = PARAMETER_SCHEMA[key];
    if (!schema) throw new Error(`Unknown parameter: ${key}`);
    if (schema.type === 'number') {
      if (typeof value !== 'number' || isNaN(value)) throw new Error(`${key} must be a number`);
      if (schema.min != null && value < schema.min) throw new Error(`${key} must be >= ${schema.min}`);
      if (schema.max != null && value > schema.max) throw new Error(`${key} must be <= ${schema.max}`);
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`${key} must be a boolean`);
    }
  }

  async get(key) {
    const stored = await this.store.getParameter(key);
    if (stored) return stored.value;
    if (key in BOOTSTRAP_DEFAULTS) return BOOTSTRAP_DEFAULTS[key];
    return null;
  }

  async getAll() {
    const stored = await this.store.getAllParameters();
    return { ...BOOTSTRAP_DEFAULTS, ...stored };
  }

  async set(key, value, updatedBy = 'system') {
    this._validate(key, value);
    await this.store.setParameter(key, value, updatedBy);
  }

  async applyRecommendations(changes, updatedBy = 'system') {
    // Validate all first (atomic: all or nothing)
    for (const { param, value } of changes) {
      this._validate(param, value);
    }
    // Apply all
    const applied = [];
    for (const { param, value } of changes) {
      const before = await this.get(param);
      await this.store.setParameter(param, value, updatedBy);
      applied.push({ param, from: before, to: value });
    }
    return { applied: applied.length, changes: applied };
  }

  async rollback(key) {
    const result = await this.store.rollbackParameter(key);
    if (!result) throw new Error(`No previous value to rollback for: ${key}`);
    return { param: key, rolledBackFrom: result.from, rolledBackTo: result.to };
  }

  async getHistory(key) {
    const stored = await this.store.getParameter(key);
    if (!stored) return { key, value: BOOTSTRAP_DEFAULTS[key] ?? null, previous_value: null, updated_at: null, updated_by: null };
    return { key, value: stored.value, previous_value: stored.previous_value, updated_at: stored.updated_at, updated_by: stored.updated_by };
  }

  async seedDefaults() {
    for (const [key, value] of Object.entries(BOOTSTRAP_DEFAULTS)) {
      const existing = await this.store.getParameter(key);
      if (!existing) {
        await this.store.setParameter(key, value, 'bootstrap');
      }
    }
  }
}

export { BOOTSTRAP_DEFAULTS, PARAMETER_SCHEMA };
