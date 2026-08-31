import test from 'node:test';
import assert from 'node:assert/strict';
import { GROK_RUNTIME_MODES, grokAssignmentWorkflowId, grokModeAtLeast, grokWorkflowId, normalizeGrokRuntimeMode } from '../../src/hyperagents/grok-runtime-client.js';

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
