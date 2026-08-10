import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL('../../src/runtime-playbooks/fixtures/marketing-strategy-to-growth-brief.v5.json', import.meta.url);
const runtimeOwnedFixtureUrl = new URL('../../src/runtime-playbooks/fixtures/marketing-strategy-to-growth-brief.v6.json', import.meta.url);

test('marketing v5 performs one Room synthesis and deterministic materialization', async () => {
  const playbook = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const roomStages = playbook.stages.filter((stage) => stage.execution?.mode === 'room');
  const adapterStages = playbook.stages.filter((stage) => stage.execution?.mode === 'adapter');

  assert.equal(roomStages.length, 1);
  assert.equal(playbook.metadata.first_life_program_builder, true);
  assert.equal(roomStages[0].id, 'form_strategy_program');
  assert.deepEqual(roomStages[0].expected_artifacts, ['marketing_strategy_program']);
  assert.equal(roomStages[0].on_failure, 'ESCALATE');
  assert.equal(roomStages[0].max_attempts, 1);
  assert.equal(adapterStages.length, 1);
  assert.equal(adapterStages[0].execution.adapter_id, 'runtime-task-materializer');
  assert.equal(adapterStages[0].execution.config.input_key, 'marketing_strategy_program');
  assert.equal(adapterStages[0].execution.config.first_life_policy_version, 6);
});

test('marketing v5 requires strategy depth and an executable portfolio in the same artifact', async () => {
  const playbook = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const checks = playbook.stages[0].completion_checks;
  const paths = new Set(checks.map((check) => check.path).filter(Boolean));

  for (const path of [
    'data.evidence_summary', 'data.niche_wedge', 'data.positioning', 'data.audience',
    'data.offer_framing', 'data.messaging_pillars', 'data.channel_mix', 'data.measures', 'data.motions',
  ]) assert.ok(paths.has(path), `missing completion check for ${path}`);
});

test('marketing v6 keeps business proposals provider-neutral for Runtime assignment', async () => {
  const playbook = JSON.parse(await readFile(runtimeOwnedFixtureUrl, 'utf8'));
  const objective = playbook.stages.find((stage) => stage.id === 'form_strategy_program').objective;

  assert.equal(playbook.version, 6);
  assert.equal(playbook.stages.find((stage) => stage.id === 'materialize_strategy_program')
    .execution.config.first_life_policy_version, 8);
  assert.match(objective, /Runtime task proposals/i);
  assert.match(objective, /Do not select a playbook, Company Room, provider, channel, or supported action/i);
});
