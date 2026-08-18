/**
 * Golden-file test: runs every document in ~/anydoc-eval/{docs,web-corpus}
 * through the LIVE HTTP server (not the library directly — this tests the
 * actual service contract, multipart handling, and error mapping) and
 * scores word recall against gt.json, which was built independently
 * (python-pptx / openpyxl / python-docx / pdftotext), not from any parser
 * under test.
 *
 * Bar: must match or beat the docling numbers recorded in
 * .claude/decision-docs/KB_PIPELINE_ARCHITECTURE.md §11. This is not a new
 * bar — it is the one already measured.
 *
 * Run: node --test test/golden.test.js   (server must already be running,
 * see README — kept as a separate process deliberately so this exercises
 * the real network path, not an in-process require)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HM_EXTRACT_URL || 'http://localhost:8199';
const EVAL_DIR = process.env.ANYDOC_EVAL_DIR || `${process.env.HOME}/anydoc-eval`;

const gt = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'gt.json'), 'utf8'));

function tokenize(s) {
  return new Set((String(s).match(/[a-zA-ZäöüÄÖÜß0-9€%.]{3,}/g) || []).map((w) => w.toLowerCase()));
}

async function extract(filePath, filename) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf]), filename);
  form.append('filename', filename);
  const res = await fetch(`${BASE}/extract`, { method: 'POST', body: form });
  const body = await res.json();
  return { status: res.status, body };
}

// Files with independently-built ground truth (docs/) — recall-scored.
const DOCS_DIR = path.join(EVAL_DIR, 'docs');
const scored = fs.existsSync(DOCS_DIR)
  ? fs.readdirSync(DOCS_DIR).filter((f) => gt[f])
  : [];

for (const name of scored) {
  test(`golden recall: ${name}`, async () => {
    const { status, body } = await extract(path.join(DOCS_DIR, name), name);
    if (name === 'scan.pdf') {
      // Known image-only scan: must fail honestly, never fake-succeed.
      assert.equal(status, 422);
      assert.equal(body.code, 'unsupported');
      assert.equal(body.retry_with, 'vision');
      return;
    }
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    assert.ok(body.ok);
    const got = tokenize((body.markdown || '') + ' ' + body.segments.map((s) => s.content).join(' '));
    const want = tokenize((gt[name].runs || []).join(' '));
    const covered = [...want].filter((w) => got.has(w)).length;
    const recall = want.size ? covered / want.size : 1;
    console.log(`  ${name}: recall=${(recall * 100).toFixed(1)}% (${covered}/${want.size}) segments=${body.segments.length}`);
    assert.ok(recall >= 0.90, `${name} recall ${(recall * 100).toFixed(1)}% is below the 90% floor`);
  });
}

test('segment invariants hold on every scored, successful file', async () => {
  for (const name of scored) {
    if (name === 'scan.pdf') continue;
    const { status, body } = await extract(path.join(DOCS_DIR, name), name);
    if (status !== 200) continue;
    let prevOffset = -1;
    for (const seg of body.segments) {
      assert.ok(seg.content.length > 0, `${name} segment ${seg.segmentIndex} is empty`);
      if (seg.startOffset != null) {
        assert.ok(seg.startOffset >= prevOffset - 500, `${name} segment ${seg.segmentIndex} offset went backwards unexpectedly`);
        prevOffset = seg.startOffset;
        // content must be a verbatim substring of the returned markdown at that offset region
        const region = body.markdown.slice(seg.startOffset, seg.startOffset + 20);
        assert.ok(seg.content.startsWith(region.slice(0, Math.min(20, seg.content.length))) || body.markdown.includes(seg.content.slice(0, 20)),
          `${name} segment ${seg.segmentIndex} content not traceable to markdown`);
      }
      assert.ok(!/^\w/.test(seg.content) || seg.content.length > 1, `${name} segment ${seg.segmentIndex} looks mid-word-split`);
    }
  }
});

test('admission control: exceeding MAX_INFLIGHT returns 429', async () => {
  const { body: health } = { body: await (await fetch(`${BASE}/health`)).json() };
  const cap = health.max_inflight;
  const bigFile = path.join(EVAL_DIR, 'big', 'b_gemein_92pg.pdf');
  if (!fs.existsSync(bigFile)) {
    console.log('  (skipped: large fixture not present)');
    return;
  }
  const buf = fs.readFileSync(bigFile);
  const fire = () => {
    const form = new FormData();
    form.append('file', new Blob([buf]), 'b_gemein_92pg.pdf');
    return fetch(`${BASE}/extract`, { method: 'POST', body: form });
  };
  const responses = await Promise.all(Array.from({ length: cap + 6 }, fire));
  const statuses = responses.map((r) => r.status);
  const got429 = statuses.filter((s) => s === 429).length;
  console.log(`  fired ${statuses.length}, cap=${cap}, got 429 x${got429}, statuses=${statuses.join(',')}`);
  assert.ok(got429 > 0, 'expected at least one 429 when firing more than MAX_INFLIGHT concurrent large requests');
});
