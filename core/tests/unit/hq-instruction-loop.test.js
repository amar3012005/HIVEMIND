import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInstructionKind, getPlatformManagedCapabilities, interpretHqInstruction, normalizeInstructionWorkUnits, normalizePrepareCapabilities } from '../../src/hq-runtime/instruction-loop.js';

test('outreach instruction becomes a location-bound capability todo', () => {
  const result = interpretHqInstruction('I want you to focus on getting me clients in Hannover', {});
  assert.equal(result.intent, 'outreach_growth');
  assert.equal(result.location, 'Hannover');
  assert.deepEqual(result.required_capabilities, ['google-maps']);
  assert.equal(result.skill, 'primary-outreach');
});

test('outreach instruction inherits retained company location', () => {
  const result = interpretHqInstruction('Find qualified prospects for our company', { location: 'Berlin, Germany' });
  assert.equal(result.location, 'Berlin, Germany');
  assert.match(result.objective, /retained company location: Berlin, Germany/);
});

test('general instruction does not demand outreach connectors', () => {
  const result = interpretHqInstruction('Prioritize product onboarding quality', { location: 'Hannover' });
  assert.equal(result.intent, 'operating_focus');
  assert.deepEqual(result.required_capabilities, []);
});

test('Google Maps is platform-managed when the server key is configured', () => {
  const previous = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'server-managed-test-key';
  assert.equal(getPlatformManagedCapabilities().has('google-maps'), true);
  if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previous;
});

test('prepare work cannot be blocked by model-invented connector names', () => {
  assert.deepEqual(normalizePrepareCapabilities(['google-search-console', 'content-management'], 'seo'), []);
  assert.deepEqual(normalizePrepareCapabilities(['google-maps', 'email‑automation'], 'outreach'), ['google-maps']);
  assert.deepEqual(normalizePrepareCapabilities(['utm‑builder', 'social‑scheduler'], 'marketing'), []);
  assert.deepEqual(normalizePrepareCapabilities(['zernio', 'instagram', 'linkedin', 'x_organic'], 'marketing'), []);
  assert.deepEqual(normalizePrepareCapabilities(['document_review'], 'legal_finance'), []);
});

test('semantic outreach variants compile to the canonical outreach work kind', () => {
  assert.equal(canonicalInstructionKind({ room_tag: 'outreach', intent: 'prospect_outreach' }), 'outreach');
  assert.equal(canonicalInstructionKind({ room_tag: 'legal_finance', intent: 'compliance_review' }), 'legal_finance');
});

test('compound outreach compiles into dependent discovery and drafting outcomes', () => {
  const fallback = interpretHqInstruction('Find prospects in Berlin and write personalized emails', { location: 'Berlin' });
  const units = normalizeInstructionWorkUnits({ work_units: [
    { title: 'Find Berlin prospects', objective: 'Find five prospects', room_tag: 'outreach', kind: 'outreach_discovery', target: { quantity: 5 }, completion_requirements: [{ type: 'records_persisted', minimum: 5 }] },
    { title: 'Draft their emails', objective: 'Write one email per accepted prospect', room_tag: 'outreach', kind: 'email_drafting', target: { quantity: 5 }, depends_on: 0, completion_requirements: [{ type: 'email_drafts', minimum: 5 }] },
  ] }, fallback);
  assert.equal(units.length, 2);
  assert.equal(units[0].depends_on, null);
  assert.equal(units[1].depends_on, 0);
  assert.deepEqual(units[1].completion_requirements, [{ type: 'email_drafts', minimum: 5 }]);
});

test('explicit delivery is isolated behind Gmail and execute authority', () => {
  const fallback = interpretHqInstruction('Send the prepared emails', {});
  const [unit] = normalizeInstructionWorkUnits({ work_units: [{
    title: 'Deliver emails', objective: 'Send prepared emails', room_tag: 'outreach',
    kind: 'email_delivery', authority_mode: 'EXECUTE', required_capabilities: [],
    completion_requirements: [{ type: 'external_actions', minimum: 3 }, { type: 'delivery_receipts', minimum: 3 }],
  }] }, fallback);
  assert.equal(unit.authority_mode, 'EXECUTE');
  assert.deepEqual(unit.required_capabilities, ['gmail']);
});
