import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DurableVisualGenerationLifecycle,
  createVisualGenerationJob,
  getVisualGenerationJob,
  listVisualGenerationJobs,
  normalizeVisualGenerationRequest,
} from '../../src/visual-generation/service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';

function fakePrisma() {
  const state = { job: null, events: [], nextEvent: 1n };
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => key === 'id' && value?.gt !== undefined
    ? row.id > value.gt : row[key] === value);
  return {
    state,
    userOrganization: { findFirst: async ({ where }) => where.orgId === ORG && where.userId === USER && where.isActive ? { userId: USER } : null },
    organization: { findUnique: async () => ({ name: 'Acme', slug: 'acme', companyProfile: { sector: 'energy' } }) },
    hyperRoom: { findFirst: async () => null },
    visualIntelligenceRun: { findFirst: async () => ({ id: 'brand-1', artifact: { version: 'brand.v1', visual_generation_brief: { palette: ['blue'] }, evidence: [] }, processingVersion: 1, finishedAt: new Date('2026-09-19T10:00:00Z') }) },
    visualGenerationJob: {
      findUnique: async ({ where }) => where.id ? (state.job?.id === where.id ? state.job : null) : (state.job?.orgId === where.orgId_userId_idempotencyKey.orgId && state.job?.userId === where.orgId_userId_idempotencyKey.userId && state.job?.idempotencyKey === where.orgId_userId_idempotencyKey.idempotencyKey ? state.job : null),
      findFirst: async ({ where }) => state.job && matches(state.job, where) ? state.job : null,
      findMany: async ({ where, take = 12 }) => (state.job && matches(state.job, where) ? [state.job] : []).slice(0, take),
      create: async ({ data }) => (state.job = { id: JOB, contractVersion: 'visual.production.v1', productionSpec: {}, assets: [], error: null, terminalReason: null, workflowInstanceId: null, createdAt: new Date(), updatedAt: new Date(), ...data }),
      update: async ({ where, data }) => { assert.equal(where.id, JOB); state.job = { ...state.job, ...data, updatedAt: new Date() }; return state.job; },
    },
    visualGenerationEvent: {
      upsert: async ({ where, create, update }) => {
        const found = state.events.find((row) => row.jobId === where.jobId_eventKey.jobId && row.eventKey === where.jobId_eventKey.eventKey);
        if (found) { Object.assign(found, update); return found; }
        const row = { id: state.nextEvent++, ...create, createdAt: new Date() }; state.events.push(row); return row;
      },
      findMany: async ({ where, take = 100 }) => state.events.filter((row) => row.jobId === where.jobId && (!where.id?.gt || row.id > where.id.gt)).slice(0, take),
    },
  };
}

test('normalizes a bounded coordinated image set', () => {
  assert.deepEqual(normalizeVisualGenerationRequest({
    instruction: 'Create a launch system for our verified product.',
    use_case: 'campaign_social', output: { mode: 'set', count: 99, aspect_ratios: ['16:9', 'bad', '4:5'] }, quality: 'balanced',
  }), {
    instruction: 'Create a launch system for our verified product.', useCase: 'campaign_social', mode: 'set', count: 8,
    aspectRatios: ['16:9', '4:5'], quality: 'balanced', modelPolicy: 'auto', source: {},
  });
});

test('admits once and safely replays the same visual request', async () => {
  const prisma = fakePrisma(); let calls = 0;
  const previous = { enabled: process.env.VISUAL_GENERATION_WORKFLOW_ENABLED, url: process.env.HIVEMIND_VISUAL_GENERATION_URL, secret: process.env.HIVEMIND_VISUAL_GENERATION_SECRET };
  Object.assign(process.env, { VISUAL_GENERATION_WORKFLOW_ENABLED: 'true', HIVEMIND_VISUAL_GENERATION_URL: 'https://visual.test', HIVEMIND_VISUAL_GENERATION_SECRET: 'secret' });
  try {
    const fetchImpl = async () => { calls += 1; return Response.json({ instance_id: `visual-generation-${JOB}-v1` }, { status: 202 }); };
    const input = { instruction: 'Create a premium product hero image.', idempotency_key: 'turn-1-visual-1' };
    const first = await createVisualGenerationJob({ prisma, orgId: ORG, userId: USER, input, fetchImpl });
    const replay = await createVisualGenerationJob({ prisma, orgId: ORG, userId: USER, input, fetchImpl });
    assert.equal(first.job_id, JOB); assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(calls, 1);
    assert.deepEqual(prisma.state.events.map((event) => event.eventKey), ['queued', 'workflow_queued']);
  } finally {
    if (previous.enabled === undefined) delete process.env.VISUAL_GENERATION_WORKFLOW_ENABLED; else process.env.VISUAL_GENERATION_WORKFLOW_ENABLED = previous.enabled;
    if (previous.url === undefined) delete process.env.HIVEMIND_VISUAL_GENERATION_URL; else process.env.HIVEMIND_VISUAL_GENERATION_URL = previous.url;
    if (previous.secret === undefined) delete process.env.HIVEMIND_VISUAL_GENERATION_SECRET; else process.env.HIVEMIND_VISUAL_GENERATION_SECRET = previous.secret;
  }
});

test('collapses a burst of identical agent retries onto one durable job', async () => {
  const prisma = fakePrisma(); let admissions = 0;
  const previous = { enabled: process.env.VISUAL_GENERATION_WORKFLOW_ENABLED, url: process.env.HIVEMIND_VISUAL_GENERATION_URL, secret: process.env.HIVEMIND_VISUAL_GENERATION_SECRET };
  Object.assign(process.env, { VISUAL_GENERATION_WORKFLOW_ENABLED: 'true', HIVEMIND_VISUAL_GENERATION_URL: 'https://visual.test', HIVEMIND_VISUAL_GENERATION_SECRET: 'secret' });
  try {
    const fetchImpl = async () => { admissions += 1; await new Promise((resolve) => setTimeout(resolve, 2)); return Response.json({ instance_id: `visual-generation-${JOB}-v1` }, { status: 202 }); };
    const input = { instruction: 'Create a coordinated campaign hero image.', idempotency_key: 'load-burst-visual-1' };
    const results = await Promise.all(Array.from({ length: 50 }, () => createVisualGenerationJob({ prisma, orgId: ORG, userId: USER, input, fetchImpl })));
    assert.deepEqual(new Set(results.map((result) => result.job_id)), new Set([JOB]));
    assert.equal(prisma.state.events.filter((event) => event.eventKey === 'queued').length, 1);
    assert.ok(admissions >= 1, 'at least one workflow admission is expected');
  } finally {
    if (previous.enabled === undefined) delete process.env.VISUAL_GENERATION_WORKFLOW_ENABLED; else process.env.VISUAL_GENERATION_WORKFLOW_ENABLED = previous.enabled;
    if (previous.url === undefined) delete process.env.HIVEMIND_VISUAL_GENERATION_URL; else process.env.HIVEMIND_VISUAL_GENERATION_URL = previous.url;
    if (previous.secret === undefined) delete process.env.HIVEMIND_VISUAL_GENERATION_SECRET; else process.env.HIVEMIND_VISUAL_GENERATION_SECRET = previous.secret;
  }
});

test('hydrates verified Brand DNA, records progress, and accepts only complete tenant-scoped receipts', async () => {
  const prisma = fakePrisma();
  prisma.state.job = { id: JOB, orgId: ORG, userId: USER, roomId: null, status: 'queued', currentStage: 'queued', progress: 0, requestedCount: 1, instruction: 'Create a visual', useCase: 'general', outputMode: 'single', aspectRatios: ['1:1'], quality: 'quality', modelPolicy: 'auto', productionSpec: {}, assets: [], error: null, terminalReason: null, workflowInstanceId: null, startedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const lifecycle = new DurableVisualGenerationLifecycle({ prisma });
  const context = await lifecycle.context({ job_id: JOB, workflow_instance_id: `visual-generation-${JOB}-v1` });
  assert.equal(context.brand_dna.visual_generation_brief.palette[0], 'blue');
  await lifecycle.record({ job_id: JOB, event_key: 'art_direction', stage: 'art_direction', progress: 28, data: { production_spec: { subject: 'verified product' } } });
  const receipt = { asset_id: `${JOB}-0`, r2_key: `org/${ORG}/visual-generation/${JOB}/assets/00.png`, content_hash: 'abc123' };
  const completed = await lifecycle.complete({ job_id: JOB, production_spec: { subject: 'verified product' }, assets: [receipt] });
  assert.equal(completed.status, 'completed'); assert.equal(completed.progress, 100); assert.equal(completed.assets[0].r2_key, receipt.r2_key);
  await assert.rejects(() => getVisualGenerationJob({ prisma, orgId: ORG, userId: OTHER, jobId: JOB }), /not found/);
});

test('lists only the authenticated users durable jobs for one room', async () => {
  const prisma = fakePrisma();
  const roomId = '55555555-5555-4555-8555-555555555555';
  prisma.state.job = {
    id: JOB, orgId: ORG, userId: USER, roomId, contractVersion: 'visual.production.v1',
    instruction: 'Create a premium launch hero.', source: { kind: 'agent', room_id: roomId },
    status: 'running', currentStage: 'critiquing', progress: 70, requestedCount: 1,
    useCase: 'room_visual', outputMode: 'single', aspectRatios: ['16:9'], quality: 'quality',
    modelPolicy: 'auto', productionSpec: {}, assets: [], error: null, terminalReason: null,
    workflowInstanceId: `visual-generation-${JOB}-v1`, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await listVisualGenerationJobs({ prisma, orgId: ORG, userId: USER, roomId });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].instruction, 'Create a premium launch hero.');
  assert.equal(result.jobs[0].source.room_id, roomId);
  await assert.rejects(() => listVisualGenerationJobs({ prisma, orgId: ORG, userId: OTHER, roomId }), /membership/);
});
