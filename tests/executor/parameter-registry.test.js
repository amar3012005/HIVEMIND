// tests/executor/parameter-registry.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';
import { ParameterRegistry } from '../../core/src/executor/parameter-registry.js';

describe('ParameterRegistry', () => {
  let store;
  let registry;

  beforeEach(() => {
    store = new InMemoryStore();
    registry = new ParameterRegistry(store);
  });

  it('should return bootstrap default for missing key', async () => {
    const val = await registry.get('routing.temperature');
    expect(val).toBe(1.0);
  });

  it('should return stored value after set', async () => {
    await registry.set('routing.temperature', 0.8, 'admin');
    const val = await registry.get('routing.temperature');
    expect(val).toBe(0.8);
  });

  it('should reject invalid value (below min)', async () => {
    await expect(registry.set('routing.temperature', -1, 'admin')).rejects.toThrow();
  });

  it('should reject invalid value (above max)', async () => {
    await expect(registry.set('routing.temperature', 999, 'admin')).rejects.toThrow();
  });

  it('should reject unknown key', async () => {
    await expect(registry.set('unknown.param', 42, 'admin')).rejects.toThrow();
  });

  it('should rollback to previous value', async () => {
    await registry.set('routing.temperature', 0.5, 'admin');
    await registry.set('routing.temperature', 0.3, 'admin');
    const result = await registry.rollback('routing.temperature');
    expect(result.rolledBackTo).toBe(0.5);
    const val = await registry.get('routing.temperature');
    expect(val).toBe(0.5);
  });

  it('should getAll with current values', async () => {
    await registry.set('routing.temperature', 0.7, 'admin');
    const all = await registry.getAll();
    expect(all['routing.temperature']).toBe(0.7);
    expect(all['routing.forceWeights.goalAttraction']).toBe(1.0); // bootstrap default
  });

  it('should apply multiple changes atomically', async () => {
    const result = await registry.applyRecommendations([
      { param: 'routing.temperature', value: 0.8 },
      { param: 'routing.forceWeights.blueprintPrior', value: 0.2 },
    ], 'meta_eval');
    expect(result.applied).toBe(2);
    expect(await registry.get('routing.temperature')).toBe(0.8);
    expect(await registry.get('routing.forceWeights.blueprintPrior')).toBe(0.2);
  });

  it('should reject entire batch if any change is invalid', async () => {
    await expect(registry.applyRecommendations([
      { param: 'routing.temperature', value: 0.8 },
      { param: 'routing.temperature', value: -999 },
    ], 'admin')).rejects.toThrow();
    // First change should NOT have been applied
    const val = await registry.get('routing.temperature');
    expect(val).toBe(1.0); // still default
  });

  it('should seed bootstrap defaults', async () => {
    await registry.seedDefaults();
    const temp = await registry.get('routing.temperature');
    expect(temp).toBe(1.0);
  });

  it('should not overwrite existing values on seedDefaults', async () => {
    await registry.set('routing.temperature', 0.5, 'admin');
    await registry.seedDefaults();
    const temp = await registry.get('routing.temperature');
    expect(temp).toBe(0.5); // not overwritten
  });
});
