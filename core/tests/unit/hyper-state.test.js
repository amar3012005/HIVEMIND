import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersonaContract,
  enrichEmployeeWithHyperState,
  formatPersonaContract,
} from '../../src/employees/hyper-state.js';

test('buildPersonaContract derives a role-specific operating model', () => {
  const contract = buildPersonaContract({
    name: 'Maya Ortiz',
    slug: 'maya-ortiz',
    roleArchetype: 'coordinator',
    scope: 'team',
    peerReviewTargets: ['skeptic', 'investigator'],
    policyRules: {
      persona_contract: {
        stance: 'Keeps the plan and the owners visible.',
      },
    },
  });

  assert.equal(contract.lane, 'Strategist');
  assert.equal(contract.allowed_scope, 'team');
  assert.equal(contract.context_home, 'team');
  assert.equal(contract.stance, 'Keeps the plan and the owners visible.');
  assert.deepEqual(contract.challenge_targets, ['skeptic', 'investigator']);
  assert.ok(contract.quality_gate.length > 0);
  assert.match(formatPersonaContract(contract), /PERSONA CONTRACT/);
});

test('enrichEmployeeWithHyperState exposes persona_contract on both root and hyper', async () => {
  const enriched = await enrichEmployeeWithHyperState({
    name: 'Jonah Price',
    slug: 'jonah-price',
    roleArchetype: 'skeptic',
    scope: 'organization',
    persona: 'You are Jonah Price, a sharp skeptic.',
    policyRules: {
      persona_contract: {
        stance: 'Pushes back on weak assumptions.',
      },
    },
  });

  assert.ok(enriched.hyper);
  assert.ok(enriched.hyper.persona_contract);
  assert.equal(enriched.hyper.persona_contract.lane, 'Skeptic');
  assert.equal(enriched.persona_contract.stance, 'Pushes back on weak assumptions.');
  assert.equal(enriched.hyper.persona_contract.allowed_scope, 'organization');
});
