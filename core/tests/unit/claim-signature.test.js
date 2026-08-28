import test from 'node:test';
import assert from 'node:assert/strict';
import { extractValueSlots, compareValueSlots, assessClaimRelation } from '../../src/memory/claim-signature.js';

test('extracts quantities with unit normalization (multilingual)', () => {
  const en = extractValueSlots('The tank holds 750 liters and delivers 8.3 kW.');
  const de = extractValueSlots('Der Speicher fasst 750 l und liefert 8,3 kW.');
  assert.deepEqual([...en.quantities.get('l')], [750]);
  assert.deepEqual([...de.quantities.get('l')], [750]);
  assert.deepEqual([...en.quantities.get('kw')], [8.3]);
  assert.deepEqual([...de.quantities.get('kw')], [8.3], 'German decimal comma normalized');
});

test('extracts years, dates, percents and model identifiers', () => {
  const s = extractValueSlots('Founded in 1988; SolvisLea-8.3 achieves 98% efficiency per DIN51603 as of 2026-05-14.');
  assert.ok(s.years.has('1988'));
  assert.ok(s.dates.has('2026-05-14'));
  assert.ok(s.percents.has(98));
  assert.ok(s.modelIds.has('solvislea-8.3'));
  assert.ok(s.modelIds.has('din51603'));
});

test('same values across languages → equal (corroboration evidence)', () => {
  const a = extractValueSlots('The SolvisMax holds 750 liters.');
  const b = extractValueSlots('Der SolvisMax fasst 750 Liter.');
  assert.equal(compareValueSlots(a, b), 'equal');
});

test('changed value → different (replacement evidence)', () => {
  const a = extractValueSlots('The SolvisMax holds 750 liters.');
  const b = extractValueSlots('The SolvisMax holds 650 liters.');
  assert.equal(compareValueSlots(a, b), 'different');
});

test('claims measuring different things → incomparable', () => {
  const a = extractValueSlots('Pellet storage requires 8 m² of dry space.');
  const b = extractValueSlots('The oil tank is inspected every 5 years.');
  assert.equal(compareValueSlots(a, b), 'incomparable');
});

test('model-id subject evidence separates product revisions even without tags', () => {
  const r = assessClaimRelation(
    { tags: [], content: 'The SolvisLea-8.3 Premium has an efficiency rating of A++.' },
    { tags: [], content: 'The SolvisLea-7 Pro has a modulation range of 2.76 kW.' },
  );
  assert.equal(r.relation, 'no-shared-subject');
});

test('cross-language corroboration of the same fact is corroboration, not update', () => {
  const r = assessClaimRelation(
    { tags: ['entity:solvismax'], content: 'The SolvisMax stratified tank holds 750 liters.' },
    { tags: ['entity:solvismax'], content: 'Der SolvisMax Schichtspeicher fasst 750 l.' },
  );
  assert.equal(r.relation, 'corroboration');
});

test('genuine spec change on the same product is an update', () => {
  const r = assessClaimRelation(
    { tags: ['entity:solvismax'], content: 'The SolvisMax now holds 800 liters.' },
    { tags: ['entity:solvismax'], content: 'The SolvisMax holds 750 liters.' },
  );
  assert.equal(r.relation, 'update');
});

test('structured claim identity overrides sparse prose and proves an update', () => {
  const r = assessClaimRelation(
    {
      claim_subject: 'customer-data-retention',
      claim_predicate: 'retention_period',
      claim_qualifiers: { object: '13 months', jurisdiction: 'EU' },
      content: 'The new period applies.',
    },
    {
      claimSubject: 'customer-data-retention',
      claimPredicate: 'retention_period',
      claimQualifiers: { object: '12 months', jurisdiction: 'EU' },
      content: 'The old period applied.',
    },
  );
  assert.equal(r.relation, 'update');
  assert.deepEqual(r.sharedSpecific, ['customer-data-retention']);
});

test('different structured predicates cannot supersede one another', () => {
  const r = assessClaimRelation(
    {
      claim_subject: 'project-zephyr',
      claim_predicate: 'deployment_region',
      claim_qualifiers: { object: 'Berlin' },
      content: 'Berlin.',
    },
    {
      claim_subject: 'project-zephyr',
      claim_predicate: 'budget_owner',
      claim_qualifiers: { object: 'Amar' },
      content: 'Amar.',
    },
  );
  assert.equal(r.relation, 'topical');
  assert.match(r.reason, /different structured predicates/);
});

test('equal structured objects corroborate without creating a new version', () => {
  const r = assessClaimRelation(
    {
      metadata: { claim: { subject: 'project-zephyr', predicate: 'deployment_region', qualifiers: { object: 'Berlin' } } },
      content: 'Deployment is in Berlin.',
    },
    {
      claim_subject: 'project-zephyr',
      claim_predicate: 'deployment_region',
      claim_qualifiers: { object: 'berlin' },
      content: 'Berlin is the deployment region.',
    },
  );
  assert.equal(r.relation, 'corroboration');
});
