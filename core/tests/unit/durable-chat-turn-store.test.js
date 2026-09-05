import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableChatTurnStore,
  cloudflareEventMetadata,
  createDurableEventSink,
  phaseForChatEvent,
} from '../../src/agent/v2/durable-turn-store.js';

function fakePrisma() {
  const turns = new Map(); const events = []; const checkpoints = new Map();
  const api = {
    durableChatTurn: {
      async findFirst({ where }) {
        return [...turns.values()].find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null;
      },
      async create({ data }) {
        if ([...turns.values()].some((row) => row.orgId === data.orgId && row.idempotencyKey === data.idempotencyKey)) {
          const error = new Error('duplicate'); error.code = 'P2002'; throw error;
        }
        const now = new Date();
        const row = { id: '74fb72fc-08da-41cc-8c56-598eae67bfee', status: 'accepted', currentPhase: 'accepted', createdAt: now, updatedAt: now, completedAt: null, ...data };
        turns.set(row.id, row); return row;
      },
      async update({ where, data }) { Object.assign(turns.get(where.id), data); return turns.get(where.id); },
    },
    durableChatEvent: {
      async create({ data }) {
        if (events.some((row) => row.turnId === data.turnId && row.sequence === data.sequence)) { const error = new Error('duplicate'); error.code = 'P2002'; throw error; }
        const row = { id: BigInt(events.length + 1), createdAt: new Date(), ...data }; events.push(row); return row;
      },
      async findMany({ where, take }) {
        return events.filter((row) => row.turnId === where.turnId && row.sequence > where.sequence.gt).sort((a, b) => a.sequence - b.sequence).slice(0, take);
      },
    },
    durableChatCheckpoint: {
      async upsert({ where, create, update }) {
        const key = `${where.turnId_phase.turnId}:${where.turnId_phase.phase}`;
        const row = checkpoints.has(key) ? Object.assign(checkpoints.get(key), update) : { id: key, ...create };
        checkpoints.set(key, row); return row;
      },
    },
  };
  api.$transaction = (callback) => callback(api);
  return { api, turns, events, checkpoints };
}

test('event phases cover the durable planner, recall, tools, synthesis and terminal lifecycle', () => {
  assert.equal(phaseForChatEvent({ type: 'plan_ready' }), 'planned');
  assert.equal(phaseForChatEvent({ type: 'coverage_assessed' }), 'recall_verified');
  assert.equal(phaseForChatEvent({ type: 'tool_result' }), 'tools_running');
  assert.equal(phaseForChatEvent({ type: 'answer_start' }), 'synthesizing');
  assert.equal(phaseForChatEvent({ type: 'done' }), 'completed');
});

test('Cloudflare mirror receives metadata only', () => {
  const metadata = cloudflareEventMetadata({
    turnId: '74fb72fc-08da-41cc-8c56-598eae67bfee',
    event: { type: 'coverage_assessed', sequence: 4, trace_id: 'private-trace', message: 'secret', evidence: ['secret'] },
    phase: 'recall_verified', status: 'running',
  });
  assert.deepEqual(Object.keys(metadata).sort(), ['causation_id', 'event_id', 'event_type', 'idempotency_key', 'occurred_at', 'phase', 'run_id', 'sequence', 'state', 'status', 'trace_id', 'turn_id']);
  assert.equal(JSON.stringify(metadata).includes('secret'), false);
  assert.equal(metadata.trace_id.length, 32);
});

test('turn admission is idempotent, events resume by cursor, and tenant isolation is enforced', async () => {
  const db = fakePrisma(); const mirrored = [];
  const store = new DurableChatTurnStore({ prisma: db.api, notifier: { open: async (value) => mirrored.push(value), event: async (value) => mirrored.push(value) } });
  const input = {
    orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', userId: '3b56a01a-7caf-4348-964a-566f52d8c437',
    threadId: 'private-thread', idempotencyKey: 'chat:key', mode: 'session',
    requestPayload: { message: 'private customer query' }, scopeSnapshot: { project_ids: [] },
  };
  const first = await store.createOrReuse(input); const second = await store.createOrReuse(input);
  assert.equal(first.created, true); assert.equal(second.created, false); assert.equal(first.turn.id, second.turn.id);

  const sink = createDurableEventSink({ store, turnId: first.turn.id });
  sink.push({ type: 'turn_accepted' });
  sink.push({ type: 'plan_ready' });
  sink.push({ type: 'coverage_assessed' });
  await sink.flush();
  await store.complete(first.turn.id, { response: 'private grounded answer' }, sink.sequence);

  const replay = await store.readAuthorized({ turnId: first.turn.id, orgId: input.orgId, userId: input.userId, after: 1 });
  assert.equal(replay.turn.status, 'completed'); assert.deepEqual(replay.events.map((event) => event.sequence), [2, 3]);
  assert.equal(await store.readAuthorized({ turnId: first.turn.id, orgId: input.orgId, userId: 'e35811aa-4bcd-44bb-b829-a437895a42eb' }), null);
  assert.equal(mirrored.some((value) => JSON.stringify(value).includes('private customer query')), false);
  assert.equal(mirrored.some((value) => JSON.stringify(value).includes('private grounded answer')), false);
});

test('duplicate event delivery reuses the persisted receipt', async () => {
  const db = fakePrisma(); const store = new DurableChatTurnStore({ prisma: db.api });
  const { turn } = await store.createOrReuse({
    orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', userId: '3b56a01a-7caf-4348-964a-566f52d8c437',
    idempotencyKey: 'chat:dup', mode: 'session', requestPayload: {}, scopeSnapshot: {},
  });
  await store.appendEvent(turn.id, { type: 'plan_ready', sequence: 7 });
  assert.equal(await store.appendEvent(turn.id, { type: 'plan_ready', sequence: 7 }), null);
  assert.equal(db.events.length, 1);
});

test('a stalled Cloudflare mirror never blocks local admission or event persistence', async () => {
  const db = fakePrisma();
  const never = () => new Promise(() => {});
  const store = new DurableChatTurnStore({ prisma: db.api, notifier: { open: never, event: never } });
  const admitted = await Promise.race([
    store.createOrReuse({
      orgId: '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f', userId: '3b56a01a-7caf-4348-964a-566f52d8c437',
      idempotencyKey: 'chat:edge-outage', mode: 'full', requestPayload: {}, scopeSnapshot: {},
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('admission blocked')), 50)),
  ]);
  await Promise.race([
    store.appendEvent(admitted.turn.id, { type: 'plan_ready', sequence: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('event blocked')), 50)),
  ]);
  assert.equal(db.events.length, 1);
});
