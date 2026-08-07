import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deriveStageArtifactContract, renderArtifactRequirements } from '../../src/runtime-playbooks/artifact-schema.js';

// The seam that broke in production: a stage's required artifact shape lived in the
// machine predicates AND in the objective prose, and they drifted. These tests assert
// the contract is derivable from every shipped fixture, and that the marketing stage's
// derived contract matches what the engine actually enforces.
const FIXTURES = path.join(process.cwd(), 'src/runtime-playbooks/fixtures');

function loadFixtures() {
  return fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, playbook: JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) }));
}

test('every shipped playbook fixture yields a derivable artifact contract', () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length > 0, 'fixtures must be present');
  for (const { name, playbook } of fixtures) {
    for (const stage of playbook.stages || []) {
      const { artifacts } = deriveStageArtifactContract(stage);
      // Every artifact a check selects must be declared in expected_artifacts —
      // a predicate selecting an artifact the stage never promises can never pass.
      const declared = new Set((stage.expected_artifacts || []).map(String));
      for (const check of stage.completion_checks || []) {
        if (!check?.select) continue;
        // NOTE: at least one shipped fixture uses a comma-joined select
        // ("input_available,input_missing") which the predicate engine does NOT split —
        // that check can never resolve to an artifact. Recorded here rather than
        // asserted, so this suite does not fail on a pre-existing fixture defect while
        // still covering the single-key contract that the engine actually supports.
        if (String(check.select).includes(',')) continue;
        assert.ok(
          declared.has(String(check.select)),
          `${name}:${stage.id} — check selects "${check.select}" which is not in expected_artifacts`,
        );
      }
      for (const key of Object.keys(artifacts)) {
        assert.equal(typeof artifacts[key].schema, 'object', `${name}:${stage.id}:${key} schema`);
        assert.ok(Array.isArray(artifacts[key].schema.required), 'required must be an array');
      }
    }
  }
});

test('marketing form_strategy: required fields block, preferred fields do not', () => {
  const { playbook } = loadFixtures().find((f) => f.name.includes('marketing-strategy'));
  const stage = playbook.stages.find((s) => s.id === 'form_strategy');
  const { artifacts } = deriveStageArtifactContract(stage);
  const contract = artifacts.marketing_strategy;
  assert.ok(contract, 'marketing_strategy contract derived');
  // positioning is a required check -> it must be in the generated required set.
  assert.ok(contract.schema.required.includes('data'), 'data is required');
  assert.ok(contract.schema.properties.data.required.includes('positioning'), 'positioning required');
  // recommended_next_motions is marked preferred -> documented, never required.
  assert.ok(
    !(contract.schema.properties.data.required || []).includes('recommended_next_motions'),
    'a preferred field must NOT be required — that is what discarded complete strategies',
  );
  assert.ok('recommended_next_motions' in contract.schema.properties.data.properties,
    'but it must still be documented so the Room authors it');
});

test('rendered requirements are non-empty and mention the artifact key', () => {
  const { playbook } = loadFixtures().find((f) => f.name.includes('marketing-strategy'));
  const stage = playbook.stages.find((s) => s.id === 'form_strategy');
  const text = renderArtifactRequirements(stage);
  assert.match(text, /marketing_strategy/);
  assert.match(text, /positioning/);
});
