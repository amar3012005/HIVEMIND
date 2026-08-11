import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSupersedingEdge, computeHubEntitySlugs } from '../../src/memory/relationship-semantics.js';

const mem = (tags, content) => ({ tags, content });

test('different products sharing only the org entity cannot update each other (SolvisPia vs SolvisLea)', () => {
  const from = mem(['entity:solvis', 'entity:solvispia'], 'The SolvisPia requires a 200 liter buffer tank.');
  const to = mem(['entity:solvis', 'entity:solvislea'], 'The SolvisLea heat pump has a COP of 4.8.');
  const v = validateSupersedingEdge(from, to, { hubSlugs: ['solvis'] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'only-generic-entity-shared');
});

test('exclusive-subject veto fires even without a hub list', () => {
  const from = mem(['entity:solvis', 'entity:solvispia'], 'SolvisPia buffer sizing rules.');
  const to = mem(['entity:solvis', 'entity:solvislea'], 'SolvisLea COP measurement.');
  const v = validateSupersedingEdge(from, to, {}); // no hubs known
  assert.equal(v.ok, false, 'must be rejected — by subject veto or attribute proxy');
  assert.match(v.reason, /different-subjects|attribute-mismatch/);
});

test('disjoint attributes cannot contradict (pellets vs heating oil)', () => {
  const from = mem(['entity:solvis'], 'Pellet storage requires a dry room with at least 8 square meters.');
  const to = mem(['entity:solvis'], 'The heating oil tank must be inspected every five years by a certified technician.');
  const v = validateSupersedingEdge(from, to, {});
  assert.equal(v.ok, false);
  assert.match(v.reason, /attribute-mismatch/);
});

test('a genuine changed value on the same subject+attribute passes', () => {
  const from = mem(['entity:solvis', 'entity:solvismax'], 'The SolvisMax stratified storage tank holds 750 liters of water.');
  const to = mem(['entity:solvis', 'entity:solvismax'], 'The SolvisMax stratified storage tank holds 650 liters of water.');
  const v = validateSupersedingEdge(from, to, { hubSlugs: ['solvis'] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.sharedSpecific, ['solvismax']);
});

test('no shared entity at all fails', () => {
  const from = mem(['entity:alpha'], 'Alpha released version 2.');
  const to = mem(['entity:beta'], 'Beta released version 3.');
  const v = validateSupersedingEdge(from, to, {});
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no-shared-entity');
});

test('untagged conversational memories fall back to attribute proxy only', () => {
  const from = mem([], 'My favorite deployment target is now Hetzner cloud servers.');
  const to = mem([], 'My favorite deployment target is AWS cloud servers.');
  const v = validateSupersedingEdge(from, to, {});
  assert.equal(v.ok, true, 'high-overlap value change passes without entity tags');
});

test('computeHubEntitySlugs finds the corpus-dominant entity', () => {
  const facts = [
    mem(['entity:solvis', 'entity:solvismax'], ''),
    mem(['entity:solvis', 'entity:solvislea'], ''),
    mem(['entity:solvis', 'entity:solvispia'], ''),
    mem(['entity:solvis'], ''),
  ];
  assert.deepEqual(computeHubEntitySlugs(facts), ['solvis']);
});

test('hub computation refuses to call anything dominant on tiny corpora', () => {
  assert.deepEqual(computeHubEntitySlugs([mem(['entity:solvis'], ''), mem(['entity:solvis'], '')]), []);
});

test('duplicate identical statements pass the validator (corroboration is Extends, not blocked here)', () => {
  // The 1988-style duplicate: same subject, same attribute, same value —
  // validator's job is subject/attribute identity, and these ARE identical.
  // Edge-type choice (Extends vs Updates) is the classifier's call upstream;
  // the validator must not block a true same-fact pair.
  const s = mem(['entity:solvis'], 'SOLVIS was founded in 1988 in Braunschweig.');
  const v = validateSupersedingEdge(s, s, {});
  assert.equal(v.ok, true);
});
