import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPlaybook,
  listPlaybooks,
  organizationPlaybooks,
} from '../../src/employees/playbook-catalog.js';

test('PlaybookList exposes catalog metadata only', () => {
  const catalog = listPlaybooks();
  assert.ok(catalog.length > 0);
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['description', 'id', 'name', 'scope']);
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
  });
  assert.equal(getPlaybook('org:germany-enterprise', { orgPlaybooks }).instructions,
    'Use only verified German enterprise evidence.');
  assert.equal(getPlaybook('org:missing', { orgPlaybooks }), null);
});
