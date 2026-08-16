import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityGranted, stageAuthorityHash } from '../../src/runtime-playbooks/stage-executor.js';

// Recon finding (2026-08-16): a structured, non-LLM mechanism for the harder
// self-correction case — "does new evidence invalidate an already-approved
// draft" — already exists here, distinct from PR #273's authority-revocation
// (which only fires on a NEW USER INSTRUCTION). When a stage declares
// `authority_binding: 'stage_inputs'`, a prior GRANT only still covers the
// CURRENT stage inputs if their hash matches the hash recorded at grant time
// — if an upstream artifact changed since (new evidence, a re-run upstream
// stage, a corrected fact), the grant no longer covers this exact draft and
// the stage falls back to WAITING_AUTHORITY, same as never having been
// granted at all. Zero playbook fixtures currently opt into this binding
// (grepped every fixture), and this exact logic had zero direct unit test
// coverage before this file — both confirmed by recon, not assumed.

function stage({ gate = 'outbound_messages', binding = null, inputRefs = ['artifacts.draft'] } = {}) {
  return { authority_gate: gate, authority_binding: binding, input_refs: inputRefs };
}

function runWithArtifact(content, { grantHash = null, gate = 'outbound_messages', legacyGates = [] } = {}) {
  const artifacts = [{ artifactKey: 'draft', artifactId: 'draft-1', data: content, createdAt: '2026-08-16T00:00:00Z' }];
  const authorityRecords = grantHash ? [{ gate, payload: { input_hash: grantHash } }] : [];
  return { artifacts, authorityRecords, authorityGates: legacyGates, trigger: {}, context: {} };
}

test('a stage with no authority_gate is always granted — nothing to re-validate', () => {
  assert.equal(authorityGranted(runWithArtifact({ body: 'hi' }), stage({ gate: null })), true);
});

test('legacy (non-stage_inputs) binding: once granted, always granted — no re-validation, matches the known gap', () => {
  const run = runWithArtifact({ body: 'Original draft' }, { grantHash: 'irrelevant-legacy-grant', gate: 'outbound_messages' });
  const legacyStage = stage({ binding: null });
  assert.equal(authorityGranted(run, legacyStage), true);
  // Change the underlying artifact after the grant — legacy binding does not care.
  run.artifacts[0].data = { body: 'A completely different, contradicted draft' };
  assert.equal(authorityGranted(run, legacyStage), true, 'legacy binding never re-validates — this IS the gap the loop asked about');
});

test('legacy binding with NO grant at all falls back to the run-level authorityGates allowlist', () => {
  const run = runWithArtifact({ body: 'hi' }, { legacyGates: ['outbound_messages'] });
  assert.equal(authorityGranted(run, stage({ binding: null })), true);
  assert.equal(authorityGranted(run, stage({ gate: 'outbound_calls', binding: null })), false);
});

test('stage_inputs binding: a grant still covers the draft when inputs are UNCHANGED since grant time', () => {
  const stageDef = stage({ binding: 'stage_inputs' });
  const run = runWithArtifact({ body: 'Original draft' });
  const hashAtGrantTime = stageAuthorityHash(run, stageDef);
  run.authorityRecords = [{ gate: 'outbound_messages', payload: { input_hash: hashAtGrantTime } }];
  assert.equal(authorityGranted(run, stageDef), true);
});

test('stage_inputs binding: new evidence changing the draft since grant time invalidates the grant — the harder self-correction case, working today when a playbook opts in', () => {
  const stageDef = stage({ binding: 'stage_inputs' });
  const run = runWithArtifact({ body: 'Original draft, approved on stale evidence' });
  const hashAtGrantTime = stageAuthorityHash(run, stageDef);
  run.authorityRecords = [{ gate: 'outbound_messages', payload: { input_hash: hashAtGrantTime } }];
  assert.equal(authorityGranted(run, stageDef), true, 'sanity: granted before any change');

  // Simulate new evidence rewriting the upstream artifact this stage reads —
  // e.g. a research stage re-ran and corrected a fact the draft depended on.
  run.artifacts[0].data = { body: 'A materially different draft after new evidence arrived' };
  assert.equal(authorityGranted(run, stageDef), false, 'the stale grant must NOT cover a materially changed draft');
});

test('stage_inputs binding with no grant record at all is never granted, regardless of the legacy allowlist', () => {
  const run = runWithArtifact({ body: 'hi' }, { legacyGates: ['outbound_messages'] });
  assert.equal(authorityGranted(run, stage({ binding: 'stage_inputs' })), false);
});

test('stageAuthorityHash is a pure, order-independent function of the resolved inputs — same content, different key order, same hash', () => {
  const stageDef = stage({ inputRefs: ['artifacts.draft'] });
  const runA = runWithArtifact({ a: 1, b: 2 });
  const runB = runWithArtifact({ b: 2, a: 1 });
  assert.equal(stageAuthorityHash(runA, stageDef), stageAuthorityHash(runB, stageDef));
});
