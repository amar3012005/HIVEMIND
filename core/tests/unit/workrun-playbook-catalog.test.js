import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPlaybook,
  listPlaybooks,
  localPlaybooks,
  organizationPlaybooks,
} from '../../src/employees/playbook-catalog.js';
import { runtimeScopeProjection } from '../../src/employees/work-runs.js';

test('PlaybookList exposes catalog metadata only', () => {
  const catalog = listPlaybooks();
  assert.ok(catalog.length > 0);
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['description', 'id', 'name', 'scope', 'version']);
  assert.ok(catalog.some((playbook) => playbook.id === 'global:prospect-discovery'));
  assert.ok(catalog.every((playbook) => !Object.hasOwn(playbook, 'instructions')));
});

test('PlaybookGet returns the selected playbook body and rejects unknown ids', () => {
  const playbook = getPlaybook('global:prospect-discovery');
  assert.equal(playbook.id, 'global:prospect-discovery');
  assert.match(playbook.instructions, /sourced list of companies/i);
  assert.equal(getPlaybook('global:does-not-exist'), null);
});

test('org playbooks remain compact in list results and load only by returned id', () => {
  const orgPlaybooks = organizationPlaybooks({
    playbooks: [{
      id: 'germany-enterprise',
      name: 'Germany enterprise',
      description: 'Company-specific route for Germany.',
      instructions: 'Use only verified German enterprise evidence.',
    }],
  });
  const catalog = listPlaybooks({ orgPlaybooks });
  assert.deepEqual(catalog.at(-1), {
    id: 'org:germany-enterprise',
    name: 'Germany enterprise',
    description: 'Company-specific route for Germany.',
    scope: 'org',
    version: '1.0.0',
  });
  assert.equal(getPlaybook('org:germany-enterprise', { orgPlaybooks }).instructions,
    'Use only verified German enterprise evidence.');
  assert.equal(getPlaybook('org:missing', { orgPlaybooks }), null);
});

test('local WorkRun playbooks remain isolated from org and global catalog entries', () => {
  const local = localPlaybooks({
    id: 'launch-overlay',
    name: 'Launch overlay',
    description: 'Current launch constraints.',
    instructions: 'Use the current approved launch inputs only.',
  });
  const catalog = listPlaybooks({ localPlaybooks: local });
  assert.deepEqual(catalog.find((entry) => entry.id === 'local:launch-overlay'), {
    id: 'local:launch-overlay',
    name: 'Launch overlay',
    description: 'Current launch constraints.',
    scope: 'local',
    version: '1.0.0',
  });
  assert.deepEqual(getPlaybook('local:launch-overlay', { localPlaybooks: local }), {
    id: 'local:launch-overlay',
    name: 'Launch overlay',
    description: 'Current launch constraints.',
    scope: 'local',
    version: '1.0.0',
    instructions: 'Use the current approved launch inputs only.',
  });
});

test('initial AgentScope context keeps local playbooks metadata-only', () => {
  const projected = runtimeScopeProjection({
    project: 'launch',
    local_playbooks: {
      id: 'launch-overlay',
      name: 'Launch overlay',
      instructions: 'This must never be injected at L0.',
    },
  });
  assert.deepEqual(projected, {
    project: 'launch',
    local_playbooks: [{
      id: 'local:launch-overlay',
      name: 'Launch overlay',
      description: 'WorkRun-local operating guidance.',
      scope: 'local',
      version: '1.0.0',
    }],
  });
  assert.doesNotMatch(JSON.stringify(projected), /never be injected/i);
});
