import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixtureUrl = new URL('../../src/runtime-playbooks/fixtures/campaign-awareness-to-learning.v4.json', import.meta.url);
const registryUrl = new URL('../../src/runtime-playbooks/fixtures/registry.json', import.meta.url);

test('campaign v4 treats partial contracts as active repair work instead of an unhandled wait', async () => {
  const playbook = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const prepare = playbook.stages.find((stage) => stage.id === 'prepare_campaign_contract');
  const inspect = playbook.stages.find((stage) => stage.id === 'inspect_campaign_contract');
  const repair = playbook.stages.find((stage) => stage.id === 'wait_for_campaign_repair');

  assert.ok(prepare.waits_for_event.types.includes('campaign.contract_needs_repair'));
  assert.equal(prepare.presentation.waiting.task_status, 'RUNNING');
  assert.ok(inspect.transitions.some((transition) => (
    transition.when?.value === 'needs_repair' && transition.to_stage === 'wait_for_campaign_repair'
  )));
  assert.ok(repair.waits_for_event.types.includes('campaign.contract_ready'));
  assert.ok(repair.waits_for_event.types.includes('campaign.contract_failed'));
  assert.equal(repair.presentation.waiting.task_status, 'RUNNING');
});

test('current campaign and marketing versions are present in the production fixture manifest', async () => {
  const manifest = JSON.parse(await readFile(registryUrl, 'utf8'));
  assert.ok(manifest.includes('campaign-awareness-to-learning.v4.json'));
  assert.ok(manifest.includes('marketing-strategy-to-growth-brief.v8.json'));
});
