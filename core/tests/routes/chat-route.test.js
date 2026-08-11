import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRecallContext } from '../../src/routes/chat.js';

test('chat recall keeps parsed query state when memory is unavailable', async () => {
  const result = await buildChatRecallContext({
    message: 'What do you know about me? <METADATA:page>ignore</METADATA:page>',
    persistentMemoryStore: null,
  });

  assert.equal(result.isQuestion, true);
  assert.equal(result.isMetaQuery, true);
  assert.equal(result.msgTrimmed, 'What do you know about me?');
  assert.deepEqual(result.memories, []);
});
