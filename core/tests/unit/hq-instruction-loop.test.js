import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalInstructionKind, getPlatformManagedCapabilities, interpretHqInstruction, normalizeInstructionWorkUnits, normalizePrepareCapabilities, shouldDeferInstruction } from '../../src/hq-runtime/instruction-loop.js';

test('instruction ingestion contains no keyword router or domain lifecycle decomposition', async () => {
  const source = await readFile(new URL('../../src/hq-runtime/instruction-loop.js', import.meta.url), 'utf8');
  assert.equal(source.includes('OUTREACH_RE'), false);
  assert.equal(source.includes("provisional.kind === 'email_delivery'"), false);
  assert.equal(source.includes("provisional.kind === 'outreach_discovery'"), false);
  assert.match(source, /playbook Director remains the only lifecycle selector/);
});

test('offline instruction fallback preserves one complete objective without semantic routing', () => {
  const result = interpretHqInstruction('I want you to focus on getting me clients in Hannover', {});
  assert.equal(result.intent, 'operating_instruction');
  assert.equal(result.location, null);
  assert.deepEqual(result.required_capabilities, []);
  assert.equal(result.skill, 'specialist-delegation');
  assert.equal(result.work_units.length, 1);
  assert.match(result.work_units[0].objective, /getting me clients in Hannover/);
});

test('offline instruction fallback adds only retained company location', () => {
  const result = interpretHqInstruction('Find qualified prospects for our company', { location: 'Berlin, Germany' });
  assert.equal(result.location, 'Berlin, Germany');
  assert.match(result.objective, /retained company location: Berlin, Germany/);
});

test('offline fallback never invents connector requirements', () => {
  const result = interpretHqInstruction('Prioritize product onboarding quality', { location: 'Hannover' });
  assert.equal(result.intent, 'operating_instruction');
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
  assert.deepEqual(normalizePrepareCapabilities(['gmail'], 'arbitrary-work-kind'), ['gmail']);
});

test('canonical instruction kind preserves Director intent without room-specific rewriting', () => {
  assert.equal(canonicalInstructionKind({ room_tag: 'outreach', intent: 'prospect_outreach' }), 'prospect_outreach');
  assert.equal(canonicalInstructionKind({ room_tag: 'legal_finance', intent: 'compliance_review' }), 'compliance_review');
});

test('instruction normalization keeps one outcome and leaves stages to the playbook', () => {
  const fallback = interpretHqInstruction('Find prospects in Berlin and write personalized emails', { location: 'Berlin' });
  const units = normalizeInstructionWorkUnits({ work_units: [
    { title: 'Find Berlin prospects', objective: 'Find five prospects', room_tag: 'outreach', kind: 'outreach_discovery', target: { quantity: 5 }, completion_requirements: [{ type: 'records_persisted', minimum: 5 }] },
    { title: 'Draft their emails', objective: 'Write one email per accepted prospect', room_tag: 'outreach', kind: 'email_drafting', target: { quantity: 5 }, depends_on: 0, completion_requirements: [{ type: 'email_drafts', minimum: 5 }] },
  ] }, fallback);
  assert.equal(units.length, 1);
  assert.equal(units[0].depends_on, null);
  assert.deepEqual(units[0].completion_requirements, [{ type: 'records_persisted', minimum: 5 }]);
});

test('instruction normalization does not encode adapter requirements from a task kind', () => {
  const fallback = interpretHqInstruction('Send the prepared emails', {});
  const [unit] = normalizeInstructionWorkUnits({ work_units: [{
    title: 'Deliver emails', objective: 'Send prepared emails', room_tag: 'outreach',
    kind: 'email_delivery', authority_mode: 'EXECUTE', required_capabilities: [],
    completion_requirements: [{ type: 'external_actions', minimum: 3 }, { type: 'delivery_receipts', minimum: 3 }],
  }] }, fallback);
  assert.equal(unit.authority_mode, 'EXECUTE');
  assert.deepEqual(unit.required_capabilities, []);
});

test('single-outcome instructions remain executable before the first broad operating plan', () => {
  assert.equal(shouldDeferInstruction({
    deferTodos: true,
    instruction: { interpreted: { execution_mode: 'single_outcome' } },
  }), false);
  assert.equal(shouldDeferInstruction({
    deferTodos: true,
    instruction: { interpreted: { execution_mode: 'operating_plan' } },
  }), true);
});
