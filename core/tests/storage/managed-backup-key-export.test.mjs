import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('managed backup exports the operator key only for the encryption child process', () => {
  const script = fs.readFileSync(new URL('../../../infra/scripts/singulance-backup.sh', import.meta.url), 'utf8');
  const sourceAt = script.indexOf('source "$BACKUP_KEY_FILE"');
  const exportAt = script.indexOf('export STORAGE_BACKUP_ENCRYPTION_KEY');
  const encryptAt = script.indexOf('storage-bundle-crypto.mjs" encrypt');
  const unsetAt = script.indexOf('unset STORAGE_BACKUP_ENCRYPTION_KEY');
  assert.ok(sourceAt >= 0 && sourceAt < exportAt);
  assert.ok(exportAt < encryptAt);
  assert.ok(encryptAt < unsetAt);
});
