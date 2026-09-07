import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOutputJob, prepareOutputJob, renderOutputJob, validateOutputJob, persistOutputJob } from '../../src/artifacts/hyper-output-lifecycle.js';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ids = {
  orgId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  roomId: '33333333-3333-4333-8333-333333333333',
  turnId: '44444444-4444-4444-8444-444444444444',
};
const deck = '<!doctype html><html data-mode="editorial"><head><meta name="viewport" content="width=device-width"><style>@media print{section{break-after:page}}</style></head><body><h1>Deck</h1><section class="slide composition-hero" data-slide>One</section><section class="slide composition-evidence" data-slide>Two</section><section class="slide composition-model" data-slide>Three</section><section class="slide composition-evidence" data-slide>Four</section><section class="slide composition-decision" data-slide>Five</section><button aria-label="Previous slide">Prev</button><button aria-label="Next slide">Next</button></body></html>';

function fixture({ includeDeck = true } = {}) {
  const jobs = [];
  const sourceArtifact = {
    findFirst: async ({ where }) => {
      const job = jobs.find((row) => row.id === where.id || (row.sourcePlatform === where.sourcePlatform && row.sourceId === where.sourceId));
      if (job) return job;
      if (includeDeck && where.sourcePlatform === 'hyper_room_artifact') return {
        checksum: sha(deck), payload: { html: deck, intent: { kind: 'presentation' }, receipt: { rendered: true } },
      };
      return null;
    },
    create: async ({ data }) => { const row = { id: '55555555-5555-4555-8555-555555555555', createdAt: new Date(), ...data }; jobs.push(row); return row; },
    update: async ({ where, data }) => { const row = jobs.find((item) => item.id === where.id); Object.assign(row, data); return row; },
  };
  return { jobs, prisma: {
    hyperTurn: { findFirst: async () => ({ id: ids.turnId, roomId: ids.roomId, status: 'complete', sealedAt: new Date(), lines: [{ t: 'final_report', content: 'Grounded deck summary' }], room: { name: 'Investor Room', goal: 'Raise' } }) },
    visualIntelligenceRun: { findFirst: async () => ({ id: '66666666-6666-4666-8666-666666666666', processingVersion: 1, finishedAt: new Date(), artifact: { artifact_type: 'brand_dna', version: 'visual-intelligence-v1', evidence: [{ page_url: 'https://example.com' }], visual_generation_brief: { style: 'editorial' } } }) },
    sourceArtifact,
  } };
}

test('presentation output reuses a rendered room artifact and carries Brand DNA receipt', async () => {
  const f = fixture();
  const job = await createOutputJob({ prisma: f.prisma, ...ids, request: { family: 'presentation', formats: ['html'] } });
  assert.equal(job.payload.output_contract.brand_reference.run_id, '66666666-6666-4666-8666-666666666666');
  const scoped = { prisma: f.prisma, ...ids, outputJobId: job.id };
  await prepareOutputJob(scoped);
  await renderOutputJob(scoped);
  await validateOutputJob(scoped);
  const receipt = await persistOutputJob(scoped);
  assert.equal(receipt.output_family, 'presentation');
  assert.equal(receipt.brand_reference.version, 'visual-intelligence-v1');
  assert.equal(receipt.artifacts.html, sha(deck));
});

test('presentation output refuses prose substitution when no deck receipt exists', async () => {
  const f = fixture({ includeDeck: false });
  const job = await createOutputJob({ prisma: f.prisma, ...ids, request: { family: 'presentation', formats: ['html'] } });
  const scoped = { prisma: f.prisma, ...ids, outputJobId: job.id };
  await prepareOutputJob(scoped);
  await assert.rejects(renderOutputJob(scoped), /requested_presentation_artifact_missing/);
});
