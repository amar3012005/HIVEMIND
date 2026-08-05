import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeUploadService } from '../../src/knowledge/upload-service.js';

// The admit-time page estimate must be kind-aware, NEVER a raw bytes/50KB
// heuristic. Measured regression (2026-08-05): a 3 MB image was estimated as
// ~62 pages and a Free-plan org hit a false 402 while well within a 1-page
// image's allowance. An image is one thing = one page; a 3 MB markdown text
// must not be billed as ~62 pages either.

function makeService() {
  return new KnowledgeUploadService({
    prisma: null, queue: null, jobStore: null, planEnforcer: null, storageReady: () => true,
  });
}

const image = (bytes = 5 * 1024 * 1024) => ({
  file: { filename: 'photo.png', contentType: 'image/png', data: Buffer.alloc(bytes) },
  validation: { kind: 'image', ext: 'png' },
});

test('image is always exactly 1 page regardless of byte size', async () => {
  const svc = makeService();
  for (const bytes of [1024, 50_000, 3 * 1024 * 1024, 20 * 1024 * 1024]) {
    const pages = await svc._estimatePages(image(bytes).file, image(bytes).validation);
    assert.equal(pages, 1, `expected 1 page for ${bytes}-byte image`);
  }
});

test('large text/document is not billed as many pages from bytes', async () => {
  const svc = makeService();
  // The old heuristic billed this ~6MB markdown as ~124 pages.
  const pages = await svc._estimatePages(
    { filename: 'notes.md', contentType: 'text/markdown', data: Buffer.alloc(6 * 1024 * 1024) },
    { kind: 'document', ext: 'md' },
  );
  // Unknown pre-parse page count at admit: must not false-block, so a floor of 1.
  assert.equal(pages, 1, `expected 1 (unmeasurable-at-admit) for md, got ${pages}`);
});

test('image via application/octet-stream with image filename is still 1 page', async () => {
  const svc = makeService();
  const pages = await svc._estimatePages(
    { filename: 'scan.jpeg', contentType: 'application/octet-stream', data: Buffer.alloc(1024 * 1024) },
    { kind: 'image', ext: 'jpeg' },
  );
  assert.equal(pages, 1);
});
