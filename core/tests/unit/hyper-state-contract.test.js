import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersonaContract,
  enrichEmployeeWithHyperState,
  formatPersonaContract,
} from '../../src/employees/hyper-state.js';

test('buildPersonaContract maps role archetypes into stable employee operating contracts', () => {
  const contract = buildPersonaContract({
    name: 'Victor Shah',
    slug: 'victor-shah',
    roleArchetype: 'security',
    scope: 'organization',
    peerReviewTargets: ['builder', 'coordinator'],
    policyRules: {
      persona_contract: {
        stance: 'Protects enterprise readiness without blocking the business.',
        challenge_targets: ['builder'],
        quality_gate: ['Needs a concrete data boundary or access path to evaluate.'],
      },
    },
  });

  assert.equal(contract.lane, 'Skeptic');
  assert.equal(contract.allowed_scope, 'organization');
  assert.equal(contract.context_home, 'org');
  assert.deepEqual(contract.challenge_targets, ['builder']);
  assert.match(contract.stance, /Protects enterprise readiness/);
  assert.ok(formatPersonaContract(contract).includes('PERSONA CONTRACT'));
});

test('enrichEmployeeWithHyperState exposes the contract on both top-level and hyper payloads', async () => {
  const enriched = await enrichEmployeeWithHyperState({
    name: 'Maya Ortiz',
    slug: 'maya-ortiz',
    roleArchetype: 'coordinator',
    peerReviewTargets: ['skeptic'],
    scope: 'team',
    persona: 'You are Maya.',
  });

  assert.ok(enriched.hyper);
  assert.ok(enriched.persona_contract);
  assert.equal(enriched.hyper.persona_contract.role_archetype, 'coordinator');
  assert.equal(enriched.hyper.persona_contract.lane, 'Strategist');
  assert.equal(enriched.hyper.persona_contract.allowed_scope, 'team');
  assert.deepEqual(enriched.hyper.persona_contract.challenge_targets, ['skeptic']);
});
