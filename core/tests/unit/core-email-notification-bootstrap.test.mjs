import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Core configures lifecycle email notification projection for Day 2 delivery', async () => {
  const source = await readFile(new URL('../../src/server.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ createEmailNotificationSink \} from '\.\/workspace\/email-notification-projection\.js';/);
  assert.match(source, /import \{ configureSystemEmailNotificationSink \} from '\.\/email\/email-service\.js';/);
  assert.match(source, /configureSystemEmailNotificationSink\(createEmailNotificationSink\(prisma\)\);/);
});
