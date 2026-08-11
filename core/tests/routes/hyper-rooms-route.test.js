import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleHyperTurnStreamRoute,
  handleInternalHyperTurnEventRoute,
} from '../../src/routes/hyper-rooms.js';
import { publishTurnEvent } from '../../src/realtime/hyper-turn-events.js';

function makeStreamRes() {
  const writes = [];
  return {
    writes,
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      writes.push(String(chunk));
    },
    end() {
      this.ended = true;
    },
  };
}

test('hyper turn stream route replays initial lines and live events', async () => {
  const req = {
    headers: {},
    on(event, cb) {
      this._events = this._events || {};
      this._events[event] = cb;
    },
  };
  const res = makeStreamRes();
  const turns = [
    { lines: [{ t: 'router_bootstrap' }], status: 'live', sealedAt: null },
    { lines: [{ t: 'router_bootstrap' }], status: 'live', sealedAt: null },
  ];
  const prisma = {
    hyperRoom: {
      findFirst: async () => ({ id: 'room-1', orgId: 'org-1' }),
    },
    hyperTurn: {
      findFirst: async () => turns[Math.min(turns.length - 1, 0)],
    },
  };
  const jsonResponse = (_res, body, statusCode = 200) => ({ statusCode, body });

  await handleHyperTurnStreamRoute({
    req,
    res,
    prisma,
    roomId: 'room-1',
    turnId: 'turn-1',
    orgId: 'org-1',
    jsonResponse,
  });

  publishTurnEvent('turn-1', { t: 'typing' }, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const output = res.writes.join('');
  assert.equal(res.statusCode, 200);
  assert.match(output, /event: router_bootstrap/);
  assert.match(output, /event: typing/);
  req._events.close?.();
});

test('internal hyper turn event route seals turn events', async () => {
  let sealed = null;
  const result = await handleInternalHyperTurnEventRoute({
    req: {
      headers: { 'x-api-key': 'k' },
    },
    res: {},
    prisma: {},
    jsonResponse: (_res, body, statusCode = 200) => ({ statusCode, body }),
    parseBody: async () => ({ turn_id: 'turn-1', event: { t: 'seal', status: 'complete', cost_tokens: 5 } }),
    hasInternalApiKey: (key) => key === 'k',
    appendTurnEvent: async () => {
      throw new Error('appendTurnEvent should not be called for seal');
    },
    sealTurn: async (_prisma, turnId, payload) => {
      sealed = { turnId, payload };
    },
  });

  assert.equal(result.sealed, true);
  assert.equal(sealed.turnId, 'turn-1');
  assert.equal(sealed.payload.status, 'complete');
});

test('internal hyper turn event route rejects unauthorized callers', async () => {
  const result = await handleInternalHyperTurnEventRoute({
    req: { headers: {} },
    res: {},
    prisma: {},
    jsonResponse: (_res, body, statusCode = 200) => ({ statusCode, body }),
    parseBody: async () => ({}),
    hasInternalApiKey: () => false,
    appendTurnEvent: async () => {},
    sealTurn: async () => {},
  });

  assert.equal(result.statusCode, 401);
  assert.equal(result.body.error, 'Unauthorized');
});

test('internal hyper turn event route rejects a crossed work room identity', async () => {
  const result = await handleInternalHyperTurnEventRoute({
    req: { headers: { 'x-api-key': 'k' } }, res: {},
    prisma: { hyperTurn: { findUnique: async () => ({
      id: 'turn-1', roomId: 'room-1',
      room: { orgId: 'org-1', userId: 'user-1', roomMode: 'work' },
    }) } },
    jsonResponse: (_res, body, statusCode = 200) => ({ statusCode, body }),
    parseBody: async () => ({
      turn_id: 'turn-1',
      execution_identity: {
        contract: 'work-room-execution.v1', execution_id: 'turn-1', turn_id: 'turn-1',
        room_id: 'stale-room', org_id: 'org-1', user_id: 'user-1', epoch: 1,
      },
      event: { t: 'line', content: 'must not append' },
    }),
    hasInternalApiKey: () => true,
    appendTurnEvent: async () => { throw new Error('crossed identity must not append'); },
    sealTurn: async () => {},
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error, 'work_room_execution_identity_mismatch');
});
