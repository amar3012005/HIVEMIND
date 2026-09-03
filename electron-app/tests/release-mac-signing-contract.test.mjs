import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/release-mac.yml', import.meta.url);

test('tagged macOS releases fail closed without Developer ID and notarization credentials', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /MAC_CSC_LINK/);
  assert.match(workflow, /MAC_CSC_KEY_PASSWORD/);
  assert.match(workflow, /APPLE_ID/);
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /APPLE_TEAM_ID/);
  assert.match(workflow, /Missing required Apple release credentials/);
  assert.doesNotMatch(workflow, /UNSIGNED build \(no MAC_CSC_LINK secret\)/);
});
