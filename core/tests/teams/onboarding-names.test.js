import test from 'node:test';
import assert from 'node:assert/strict';
import { nameOnboardingTeam } from '../../src/onboarding/employee-names.js';
test('onboarding produces stable distinct single-word names without changing professions', () => {
  const hires = [{ name: 'First Last', title: 'Research' }, { name: 'Other Name', title: 'Quality' }, { name: 'Human Surname', title: 'Lead' }];
  const team = nameOnboardingTeam(hires, 'company');
  assert.equal(new Set(team.map(h => h.name)).size, 3);
  assert.ok(team.every(h => /^[A-Z][a-z]+$/.test(h.name)));
  assert.deepEqual(team.map(h => h.title), hires.map(h => h.title));
  assert.deepEqual(nameOnboardingTeam(hires, 'company'), team);
});
