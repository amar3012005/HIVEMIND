import test from 'node:test';
import assert from 'node:assert/strict';
import { VISUAL_STAGES, DurableVisualIntelligenceLifecycle, normalizeBrandDnaExtraction, validateVisualAdmission } from '../../src/visual-intelligence/durable-visual-intelligence.js';

const ids = { org_id: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', user_id: '3b56a01a-7caf-4348-964a-566f52d8c437', job_id: '74fb72fc-08da-41cc-8c56-598eae67bfee' };

test('visual intelligence exposes the fixed, checkpointed stage order', () => {
  assert.deepEqual(VISUAL_STAGES, ['admit', 'discover', 'capture', 'store', 'extract', 'verify', 'publish', 'render', 'notify']);
});

test('visual admission rejects cross-boundary input before any browser work', () => {
  assert.doesNotThrow(() => validateVisualAdmission({ ...ids, urls: ['https://example.com'], mode: 'public', deliverable: 'brand_dna_v1', processing_version: 1 }));
  assert.throws(() => validateVisualAdmission({ ...ids, urls: ['http://example.com'], mode: 'public', deliverable: 'brand_dna_v1', processing_version: 1 }), /invalid_visual_urls/);
  assert.throws(() => validateVisualAdmission({ ...ids, urls: ['https://example.com'], mode: 'unbounded', deliverable: 'brand_dna_v1', processing_version: 1 }), /invalid_visual_mode/);
  assert.throws(() => validateVisualAdmission({ ...ids, urls: ['https://example.com'], mode: 'user_takeover', deliverable: 'brand_dna_v1', processing_version: 1 }), /visual_browser_session_required/);
});

test('artifact reader requires the protected worker artifact boundary', async () => {
  const lifecycle = new DurableVisualIntelligenceLifecycle({ prisma: {}, fetchImpl: async () => new Response('') });
  const previous = process.env.HIVEMIND_VISUAL_ARTIFACT_URL;
  delete process.env.HIVEMIND_VISUAL_ARTIFACT_URL;
  await assert.rejects(() => lifecycle._loadArtifactImage('org/x/runs/y/screenshots/0.jpg'), /visual_artifact_reader_unconfigured/);
  if (previous) process.env.HIVEMIND_VISUAL_ARTIFACT_URL = previous;
});

test('visual extraction normalizes a model prose brief without inventing content', () => {
  assert.deepEqual(normalizeBrandDnaExtraction({ visual_generation_brief: 'Use clear hierarchy.' }), { visual_generation_brief: { style: 'Use clear hierarchy.', elements: [] } });
  assert.equal(normalizeBrandDnaExtraction({ visual_generation_brief: '' }).visual_generation_brief, '');
  assert.equal(normalizeBrandDnaExtraction(null), null);
});
