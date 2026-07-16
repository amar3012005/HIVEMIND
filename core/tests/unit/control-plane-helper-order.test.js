import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const sourcePath = new URL('../../src/control-plane-server.js', import.meta.url);

describe('control-plane request helper initialization', () => {
  it('declares shared helpers before the first route uses them', async () => {
    const source = await readFile(sourcePath, 'utf8');
    const handler = source.slice(source.indexOf('async function handleRequest'));

    for (const helper of ['_getTeamStore', '_getAuditLogger']) {
      const declaration = handler.indexOf(`const ${helper} =`);
      const firstCall = handler.indexOf(`${helper}()`);
      assert.ok(declaration >= 0, `${helper} declaration is missing`);
      assert.ok(firstCall > declaration, `${helper} is called before initialization`);
    }
  });
});
