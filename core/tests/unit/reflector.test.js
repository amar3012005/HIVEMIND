import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '../../src/memory/reflector.js';

describe('Reflector.detectSuperseded', () => {
  it('supersedes older "favorite color is blue" when newer says "favorite color is now green"', () => {
    const reflector = new Reflector();
    const observations = [
      '🟡 [2026-03-20] User favorite color is blue.',
      '🟡 [2026-03-22] User favorite color is now green.',
    ];
    const { current, superseded } = reflector.detectSuperseded(observations);
    assert.equal(superseded.length, 1, 'Should supersede one observation');
    assert.ok(superseded[0].includes('blue'), `Superseded should be the blue one, got: ${superseded[0]}`);
    assert.equal(current.length, 1, 'Should keep one current observation');
    assert.ok(current[0].includes('green'), `Current should be the green one, got: ${current[0]}`);
  });

  it('keeps both when overlap is below 40%', () => {
    const reflector = new Reflector();
    const observations = [
      '🟡 [2026-03-20] User enjoys hiking on weekends.',
      '🟡 [2026-03-21] User prefers TypeScript for large projects.',
    ];
    const { current, superseded } = reflector.detectSuperseded(observations);
    assert.equal(superseded.length, 0, 'Should not supersede unrelated observations');
    assert.equal(current.length, 2, 'Should keep both observations');
  });
});

describe('Reflector.mergeRelated', () => {
  it('merges three observations about graduation on the same date into fewer', () => {
    const reflector = new Reflector();
    const observations = [
      '🔴 [2026-03-20] User graduated from university with honors.',
      '🔴 [2026-03-20] User graduated and received diploma at ceremony.',
      '🔴 [2026-03-20] User graduation ceremony was held at the university.',
    ];
    const { merged, mergeCount } = reflector.mergeRelated(observations);
    assert.ok(mergeCount > 0, `Expected merges, got mergeCount=${mergeCount}`);
    assert.ok(merged.length < observations.length, `Expected fewer observations after merge, got ${merged.length}`);
  });

  it('keeps unrelated observations separate (no merge)', () => {
    const reflector = new Reflector();
    const observations = [
      '🟡 [2026-03-20] User prefers TypeScript.',
      '🟢 [2026-03-21] User enjoys hiking on weekends.',
      '🔴 [2026-03-22] User deployed a new microservice to production.',
    ];
    const { merged, mergeCount } = reflector.mergeRelated(observations);
    assert.equal(mergeCount, 0, 'Should not merge unrelated observations');
    assert.equal(merged.length, observations.length, 'Should keep all unrelated observations');
  });
});

describe('Reflector.reflect — full pipeline', () => {
  it('detects supersession and returns a shorter final list', async () => {
    const reflector = new Reflector();
    const observations = [
      '🟡 [2026-03-18] User favorite color is blue.',
      '🟡 [2026-03-20] User favorite color is now green.',
      '🔴 [2026-03-21] User deployed a new service to production.',
      '🟢 [2026-03-22] User prefers dark mode for coding.',
    ];
    const result = await reflector.reflect(observations);
    assert.ok(Array.isArray(result.observations), 'result.observations should be an array');
    assert.ok(Array.isArray(result.superseded), 'result.superseded should be an array');
    assert.ok(typeof result.merged === 'number', 'result.merged should be a number');
    assert.ok(typeof result.pruned === 'number', 'result.pruned should be a number');
    assert.ok(result.superseded.length >= 1, `Expected at least 1 superseded, got ${result.superseded.length}`);
    assert.ok(
      result.observations.length < observations.length,
      `Expected fewer than ${observations.length} observations, got ${result.observations.length}`
    );
    // The blue observation should be superseded
    const blueInCurrent = result.observations.some(o => o.includes('blue'));
    assert.ok(!blueInCurrent, 'The superseded "blue" observation should not be in current observations');
  });

  it('prunes low-priority observations when total tokens exceed threshold', async () => {
    const reflector = new Reflector({ tokenThreshold: 20 }); // very low threshold
    // Generate enough low-priority observations to exceed threshold
    const observations = [
      '🟢 [2026-03-20] User prefers dark mode.',
      '🟢 [2026-03-21] User uses a standing desk.',
      '🟢 [2026-03-22] User drinks coffee in the morning.',
      '🟢 [2026-03-23] User listens to music while coding.',
    ];
    const result = await reflector.reflect(observations);
    assert.ok(result.pruned > 0, `Expected some pruning with low threshold, got pruned=${result.pruned}`);
  });
});
