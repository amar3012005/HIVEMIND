import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');

describe('WorkRun follow-up contract', () => {
  it('accepts current text and legacy content payloads', () => {
    assert.match(
      source,
      /String\(body\?\.text \|\| body\?\.content \|\| body\?\.goal \|\| ''\)\.trim\(\)/,
    );
  });
});
