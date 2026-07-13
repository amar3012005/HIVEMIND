import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolkitForUser } from '../../src/agent/toolkit-factory.js';

test('chat toolkit exposes the shared native Google registry only after activation', async () => {
  const prisma = {
    nangoConnection: {
      findMany: async () => [{ providerKey: 'google-calendar' }],
    },
  };
  const toolkit = await buildToolkitForUser({
    prisma, userId: 'user-1', orgId: 'org-1', hivemindTools: [],
  });

  assert.equal(toolkit.hasTool('calendar_list_events'), true);
  assert.equal(toolkit.getActiveToolNames().includes('calendar_list_events'), false);
  toolkit.resetEquippedTools(['google']);
  assert.equal(toolkit.getActiveToolNames().includes('calendar_list_events'), true);
  assert.equal(toolkit.getActiveToolNames().includes('calendar_create_event'), true);
});
