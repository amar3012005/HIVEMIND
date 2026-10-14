import test from 'node:test';
import assert from 'node:assert/strict';
import { nameOnboardingTeam } from '../../src/onboarding/employee-names.js';
import { starterAppearance, starterPersonaContract } from '../../src/onboarding/starter-employees.js';
test('all companies receive the fixed starter identities while keeping their domain work', () => {
  const hires = [{title:'Robotics engineer',archetype:'strategist',focus:'control systems'}, {title:'Safety researcher',archetype:'skeptic'}, {title:'Operations analyst',archetype:'investigator'}];
  const team = nameOnboardingTeam(hires, 'any-company');
  assert.deepEqual(team.map(h=>h.name), ['Faraday','Feynmann','Turing']);
  assert.deepEqual(team.map(h=>h.title), hires.map(h=>h.title));
  for (const hire of team) {
    const appearance = starterAppearance(hire.name);
    assert.equal(appearance.provider,'humation');
    assert.equal(appearance.selections.glasses,'hm1-p-000056');
    assert.ok(starterPersonaContract(hire,'Example Robotics').includes(hire.title));
    assert.ok(starterPersonaContract(hire,'Example Robotics').includes('Example Robotics'));
  }
  assert.notEqual(starterAppearance('Faraday').background,starterAppearance('Turing').background);
});

test('partial team restoration does not duplicate an existing starter name', () => {
  assert.deepEqual(nameOnboardingTeam([{title:'Analyst'},{title:'Quality'}],[{name:'Faraday'}]).map(h=>h.name),['Feynmann','Turing']);
});
