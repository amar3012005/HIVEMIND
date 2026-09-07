import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalProfileFacts,
  isGenericDisplayName,
  providerDisplayNameForExisting,
} from '../../src/identity/canonical-profile.js';

test('a later identity-provider login cannot overwrite the confirmed account name', () => {
  assert.equal(providerDisplayNameForExisting('Amar Sai Gadde', 'Google Account Name'), 'Amar Sai Gadde');
  assert.equal(providerDisplayNameForExisting('guest mode', 'Google Account Name'), 'Google Account Name');
});

test('canonical database identity replaces stale profile identity', () => {
  const facts = canonicalProfileFacts({
    userName: 'Amar Sai Gadde',
    brainName: 'amar_secondbrain',
    facts: [
      { category: 'static', key: 'name', value: 'guest mode', confidence: 1 },
      { category: 'static', key: 'location', value: 'Hannover', confidence: 1 },
    ],
  });
  assert.deepEqual(facts.map(({ key, value }) => [key, value]), [
    ['name', 'Amar Sai Gadde'],
    ['brain_name', 'amar_secondbrain'],
    ['location', 'Hannover'],
  ]);
});

test('a meaningful maintained name is retained when a legacy database row is generic', () => {
  const facts = canonicalProfileFacts({
    userName: 'guest mode',
    brainName: 'My Brain',
    facts: [{ category: 'static', key: 'name', value: 'Amar Sai Gadde', confidence: 1 }],
  });
  assert.equal(facts.find((fact) => fact.key === 'name')?.value, 'Amar Sai Gadde');
  assert.equal(isGenericDisplayName(facts.find((fact) => fact.key === 'name')?.value), false);
});
