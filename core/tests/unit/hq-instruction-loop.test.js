import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretHqInstruction } from '../../src/hq-runtime/instruction-loop.js';

test('outreach instruction becomes a location-bound capability todo', () => {
  const result = interpretHqInstruction('I want you to focus on getting me clients in Hannover', {});
  assert.equal(result.intent, 'outreach_growth');
  assert.equal(result.location, 'Hannover');
  assert.deepEqual(result.required_capabilities, ['google-maps', 'gmail']);
  assert.equal(result.skill, 'primary-outreach');
});

test('outreach instruction inherits retained company location', () => {
  const result = interpretHqInstruction('Find qualified prospects for our company', { location: 'Berlin, Germany' });
  assert.equal(result.location, 'Berlin, Germany');
  assert.match(result.objective, /retained company location: Berlin, Germany/);
});

test('general instruction does not demand outreach connectors', () => {
  const result = interpretHqInstruction('Prioritize product onboarding quality', { location: 'Hannover' });
  assert.equal(result.intent, 'operating_focus');
  assert.deepEqual(result.required_capabilities, []);
});
