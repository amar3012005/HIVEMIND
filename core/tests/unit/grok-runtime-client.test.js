import test from 'node:test';
import assert from 'node:assert/strict';
import { GROK_RUNTIME_MODES, createGrokRealtimeTicket, grokAssignmentWorkflowId, grokModeAtLeast, grokRoomInstanceId, grokWorkflowId, normalizeGrokRuntimeMode } from '../../src/hyperagents/grok-runtime-client.js';

test('runtime modes are cumulative and unknown values fail closed', () => {
  assert.equal(normalizeGrokRuntimeMode('REAL_TOOLS'), 'real_tools');
  assert.equal(normalizeGrokRuntimeMode('unknown'), 'off');
  assert.equal(grokModeAtLeast('collaboration', 'real_tools'), true);
  assert.equal(grokModeAtLeast('persistent_agents', 'durable_assignments'), false);
  assert.equal(GROK_RUNTIME_MODES[0], 'off');
});

test('workflow identity is deterministic by turn and processing version', () => {
  assert.equal(grokWorkflowId('turn-1', 3), 'room-turn-1-v3');
  assert.equal(grokWorkflowId('turn-1', 3), grokWorkflowId('turn-1', 3));
});

test('assignment workflow identity is deterministic by work order', () => {
  assert.equal(grokAssignmentWorkflowId('work-1', 3), 'agent-work-1-v3');
});

test('room gateway identity is tenant-scoped and tickets are short-lived', () => {
  process.env.HYPER_GROK_RUNTIME_ENABLED = 'true';
  process.env.HIVEMIND_LOCAL_MODE = 'true';
  process.env.HYPER_GROK_RUNTIME_ENVIRONMENT = 'local';
  process.env.HYPER_GROK_WORKFLOW_URL = 'https://runtime.example.test';
  process.env.HYPER_GROK_WORKFLOW_SECRET = 'test-secret';
  const first = grokRoomInstanceId('org-a', 'room-1');
  assert.equal(first, grokRoomInstanceId('org-a', 'room-1'));
  assert.notEqual(first, grokRoomInstanceId('org-b', 'room-1'));
  assert.equal(first.includes('org-a'), false);
  const ticket = createGrokRealtimeTicket({ orgId: 'org-a', userId: 'user-a', roomId: 'room-1' });
  assert.equal(ticket.roomInstanceId, first);
  assert.match(ticket.websocketUrl, /^wss:\/\/runtime\.example\.test\/agents\/hyper-room-gateway\/hr-/);
  assert.equal(ticket.expiresIn, 120);
});
