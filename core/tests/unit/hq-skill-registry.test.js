import test from 'node:test';
import assert from 'node:assert/strict';
import { HqSkillRegistry, HqToolkitRegistry } from '../../src/hq-runtime/skill-registry.js';

test('HQ registry exposes descriptors before loading a skill body', () => {
  const registry = new HqSkillRegistry();
  const descriptors = registry.descriptors();
  assert.ok(descriptors.length >= 9);
  assert.equal('body' in descriptors[0], false);
  const loaded = registry.load('growth-constraint-diagnosis');
  assert.match(loaded.body, /Growth Constraint Diagnosis/);
  assert.equal(loaded.model_policy.model, 'gpt-oss-120b');
  assert.equal(registry.load('baseline-establishment').model_policy.mode, 'deterministic_tools');
  assert.match(registry.directorInstructions(), /persistent operating director/);
});

test('HQ toolkit selection rejects unavailable capabilities', () => {
  const registry = new HqToolkitRegistry();
  assert.equal(registry.select(['growth_plan'])[0].authority, 'internal');
  assert.throws(() => registry.select(['unknown']), /hq_toolkit_unknown/);
  assert.rejects(() => registry.invoke('growth_plan', 'unknown', {}, {}), /hq_toolkit_operation_unknown/);
});
