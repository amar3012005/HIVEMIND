import assert from 'node:assert/strict';
import test from 'node:test';

import { hyperArtifactsEnabled, validateHyperArtifactHtml } from '../../src/artifacts/hyper-artifacts.js';

const previousPrimary = process.env.Visual_path_In_Hyperrooms;
const previousAlias = process.env.VISUAL_PATH_IN_HYPERROOMS;

test.afterEach(() => {
  if (previousPrimary === undefined) delete process.env.Visual_path_In_Hyperrooms;
  else process.env.Visual_path_In_Hyperrooms = previousPrimary;
  if (previousAlias === undefined) delete process.env.VISUAL_PATH_IN_HYPERROOMS;
  else process.env.VISUAL_PATH_IN_HYPERROOMS = previousAlias;
});

test('visual artifact path is disabled by default and honors the production flag', () => {
  delete process.env.Visual_path_In_Hyperrooms;
  delete process.env.VISUAL_PATH_IN_HYPERROOMS;
  assert.equal(hyperArtifactsEnabled(), false);
  process.env.Visual_path_In_Hyperrooms = 'True';
  assert.equal(hyperArtifactsEnabled(), true);
});

test('static artifact contract accepts self-contained HTML and rejects active external access', () => {
  const safe = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Board</title></head><body><main><h1>Operating board</h1><p>${'Evidence. '.repeat(100)}</p></main></body></html>`;
  assert.deepEqual(validateHyperArtifactHtml(safe), []);
  const cited = safe.replace('</p>', ' <a href="https://example.com/source">Source</a></p>');
  assert.deepEqual(validateHyperArtifactHtml(cited), []);
  const unsafe = safe.replace('</body>', '<script src="https://example.com/a.js"></script><script>fetch("https://example.com")</script></body>');
  const errors = validateHyperArtifactHtml(unsafe).join(' ');
  assert.match(errors, /External scripts/);
  assert.match(errors, /Network APIs/);
  assert.match(errors, /External loaded assets/);
  const stylesheetErrors = validateHyperArtifactHtml(
    safe.replace('</head>', '<link rel="stylesheet" href="https://example.com/a.css"></head>'),
  ).join(' ');
  assert.match(stylesheetErrors, /External loaded assets/);
});
