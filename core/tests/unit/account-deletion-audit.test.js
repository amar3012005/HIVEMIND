import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const sourcePath = new URL('../../src/control-plane-server.js', import.meta.url);

describe('account deletion audit contract', () => {
  it('preserves append-only audit evidence and records the erase request', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const deletionSection = source.slice(
      source.indexOf('async function performAccountDeletion'),
      source.indexOf('async function validateAccountDeletion'),
    );

    assert.doesNotMatch(deletionSection, /auditLog\.updateMany/);
    assert.match(source, /eventType: 'account\.erase_requested'/);
    assert.match(source, /processingBasis: 'GDPR Article 17'/);
  });
});
